import type { VaultEnvelope } from "./vault-crypto";
import { nextRecoveryCopies, type VaultRecoveryCopy } from './vault-recovery';

export interface VaultEnvelopeStorage {
  read(): Promise<VaultEnvelope | null>;
  write(envelope: VaultEnvelope): Promise<void>;
  clear(): Promise<void>;
  recoveryCopies?(): Promise<VaultRecoveryCopy[]>;
  clearRecoveryCopies?(): Promise<void>;
}

export class IndexedDbVaultStorage implements VaultEnvelopeStorage {
  private readonly databaseName = "monica-extension-secure-vault";
  private readonly storeName = "vault";
  private readonly recordKey = "primary";

  async read(): Promise<VaultEnvelope | null> {
    return this.withStore<VaultEnvelope | null>("readonly", (store, resolve, reject) => {
      const request = store.get(this.recordKey);
      request.onsuccess = () => resolve((request.result as VaultEnvelope | undefined) || null);
      request.onerror = () => reject(request.error);
    });
  }

  async write(envelope: VaultEnvelope): Promise<void> {
    const commit = (retain: boolean) => this.withStore<void>('readwrite', (store, resolve, reject) => {
      const previous = store.get(this.recordKey), history = store.get('recovery');
      let loaded = 0;
      const ready = () => {
        if (++loaded !== 2) return;
        try {
          const copies = retain ? nextRecoveryCopies(previous.result, envelope, history.result || []) : [];
          store.put(copies, 'recovery');
          const request = store.put(envelope, this.recordKey);
          request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
        } catch (error) {
          // Exceptions in request callbacks do not reach withStore's initial
          // try/catch. Abort both writes and preserve the precise retry reason.
          store.transaction.abort(); reject(error);
        }
      };
      previous.onsuccess = ready; history.onsuccess = ready;
      previous.onerror = () => reject(previous.error); history.onerror = () => reject(history.error);
    });
    try { await commit(true); }
    catch (error) {
      if ((error as DOMException)?.name !== 'QuotaExceededError') throw error;
      // Checkpoints must not make an otherwise valid primary write impossible.
      await commit(false);
    }
  }

  async recoveryCopies(): Promise<VaultRecoveryCopy[]> {
    return this.withStore<VaultRecoveryCopy[]>('readonly', (store, resolve, reject) => {
      const request = store.get('recovery'); request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error);
    });
  }
  async clearRecoveryCopies(): Promise<void> {
    return this.withStore<void>('readwrite', (store, resolve, reject) => {
      const request = store.delete('recovery'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    });
  }

  async clear(): Promise<void> {
    await this.withStore<void>("readwrite", (store, resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void): Promise<T> {
    const database = await this.openDatabase();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(this.storeName, mode);
      let result: T;
      let failed = false;
      const capture = (value: T) => { result = value; };
      const fail = (reason?: unknown) => {
        if (failed) return;
        failed = true;
        database.close();
        reject(reason);
      };
      try {
        action(transaction.objectStore(this.storeName), capture, fail);
      } catch (error) {
        try { transaction.abort(); } catch { /* transaction may already be inactive */ }
        fail(error);
      }
      transaction.oncomplete = () => {
        database.close();
        if (!failed) resolve(result!);
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error || new Error("Vault transaction aborted"));
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

export class MemoryVaultStorage implements VaultEnvelopeStorage {
  envelope: VaultEnvelope | null = null;
  copies: VaultRecoveryCopy[] = [];

  async read(): Promise<VaultEnvelope | null> {
    return this.envelope ? structuredClone(this.envelope) : null;
  }

  async write(envelope: VaultEnvelope): Promise<void> {
    this.copies = structuredClone(nextRecoveryCopies(this.envelope || undefined, envelope, this.copies));
    this.envelope = structuredClone(envelope);
  }

  async recoveryCopies(): Promise<VaultRecoveryCopy[]> { return structuredClone(this.copies); }
  async clearRecoveryCopies(): Promise<void> { this.copies = []; }

  async clear(): Promise<void> {
    this.envelope = null;
    this.copies = [];
  }
}
