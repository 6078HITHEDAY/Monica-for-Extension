export interface VaultDeviceKeyStore {
  read(keyId: string): Promise<string | null>;
  write(keyId: string, rawKey: string): Promise<void>;
  remove(keyId: string): Promise<void>;
  isAutoUnlockSuspended(): Promise<boolean>;
  setAutoUnlockSuspended(suspended: boolean): Promise<void>;
}

export class ChromeVaultDeviceKeyStore implements VaultDeviceKeyStore {
  private readonly prefix = "monica.secureVault.deviceKey.v1.";
  private readonly suspendedKey = "monica.secureVault.deviceKey.suspended.v1";
  private migration?: Promise<void>;

  constructor() {
    // Migrate even when the current vault no longer uses a device key. Old
    // interrupted operations may have left keys in content-readable storage.
    void this.migrateLegacyKeys().catch(() => undefined);
  }

  async read(keyId: string): Promise<string | null> {
    await this.migrateLegacyKeys();
    const result = await this.withStore<unknown>('readonly', store => store.get(keyId));
    return typeof result === 'string' ? result : null;
  }

  async write(keyId: string, rawKey: string): Promise<void> {
    await this.migrateLegacyKeys();
    await this.withStore('readwrite', store => store.put(rawKey, keyId));
  }

  async remove(keyId: string): Promise<void> {
    await this.migrateLegacyKeys();
    await this.withStore('readwrite', store => store.delete(keyId));
  }

  private migrateLegacyKeys(): Promise<void> {
    if (!this.migration) {
      this.migration = this.moveLegacyKeys().catch(error => { this.migration = undefined; throw error; });
    }
    return this.migration;
  }

  private async moveLegacyKeys(): Promise<void> {
    const legacy = await chrome.storage.local.get(null);
    const entries = Object.entries(legacy).filter(([name, value]) => name.startsWith(this.prefix) && typeof value === 'string');
    if (!entries.length) return;
    await this.withStore('readwrite', store => {
      for (const [name, value] of entries) {
        const keyId = name.slice(this.prefix.length);
        const existing = store.get(keyId);
        // Never replace an already migrated key using content-readable input.
        existing.onsuccess = () => { if (existing.result === undefined) store.put(value, keyId); };
      }
    });
    // Only remove the old copy after the IndexedDB transaction commits. If this
    // cleanup fails, the next attempt can finish it without replacing any key.
    await chrome.storage.local.remove(entries.map(([name]) => name));
  }

  private async withStore<T = unknown>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest | void): Promise<T> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('monica-extension-device-keys', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('设备密钥存储无法打开。'));
    });
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction('keys', mode);
      let result: T;
      transaction.oncomplete = () => { database.close(); resolve(result); };
      transaction.onerror = transaction.onabort = () => { database.close(); reject(new Error('设备密钥存储操作失败。')); };
      try {
        const request = action(transaction.objectStore('keys'));
        if (request) request.onsuccess = () => { result = request.result as T; };
      } catch {
        transaction.abort();
      }
    });
  }

  async isAutoUnlockSuspended(): Promise<boolean> {
    const result = await chrome.storage.session.get(this.suspendedKey);
    return result[this.suspendedKey] === true;
  }

  async setAutoUnlockSuspended(suspended: boolean): Promise<void> {
    if (suspended) await chrome.storage.session.set({ [this.suspendedKey]: true });
    else await chrome.storage.session.remove(this.suspendedKey);
  }
}

export class MemoryVaultDeviceKeyStore implements VaultDeviceKeyStore {
  readonly keys = new Map<string, string>();
  suspended = false;

  async read(keyId: string): Promise<string | null> { return this.keys.get(keyId) || null; }
  async write(keyId: string, rawKey: string): Promise<void> { this.keys.set(keyId, rawKey); }
  async remove(keyId: string): Promise<void> { this.keys.delete(keyId); }
  async isAutoUnlockSuspended(): Promise<boolean> { return this.suspended; }
  async setAutoUnlockSuspended(suspended: boolean): Promise<void> { this.suspended = suspended; }
}
