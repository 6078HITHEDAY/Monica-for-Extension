import { parseLosslessJson } from '../../../core/lossless-json';
import { parseMdbx2NativeResponse } from '../native-contract';
import { MdbxBrowserBlockStore, MdbxBrowserStorageError } from './block-store';
import { MdbxBrowserFilesystem, type BrowserFs } from './filesystem';

export interface MdbxBrowserModule {
  FS: BrowserFs;
  HEAPU8: Uint8Array<ArrayBuffer>;
  _mdbx_input(length: number): number;
  _mdbx_dispatch(): void;
  _mdbx_output_ptr(): number;
  _mdbx_output_len(): number;
  _mdbx_clear_output(): void;
  _mdbx_close(): void;
}
export type MdbxBrowserModuleFactory = (options: { print(text: string): void; printErr(text: string): void; onAbort(): void }) => Promise<MdbxBrowserModule>;
export interface MdbxBrowserRequest { protocol: 2; requestId: string; method: string; params: Record<string, unknown> }
export class MdbxBrowserSessionError extends Error {
  constructor(readonly code: string) { super(`Browser database session: ${code}.`); this.name = 'MdbxBrowserSessionError'; }
}
const fail = (code: string) => new MdbxBrowserSessionError(code);

/** One worker/one owner. Responses wait for durable block+catalog commit. A
 * failed engine or storage operation invalidates the entire in-memory session;
 * opening a replacement restores only the last committed generation. */
export class MdbxBrowserSession {
  private module?: MdbxBrowserModule;
  private filesystem?: MdbxBrowserFilesystem;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private closing = false;
  private aborted = false;
  private closePromise?: Promise<void>;
  private constructor(private readonly store: MdbxBrowserBlockStore, private readonly release: () => void) {}

  static open(factory: MdbxBrowserModuleFactory, store = new MdbxBrowserBlockStore(), locks: LockManager = navigator.locks): Promise<MdbxBrowserSession> {
    if (!locks?.request) return Promise.reject(fail('exclusive-lock-unavailable'));
    return new Promise((resolve, reject) => {
      let instance: MdbxBrowserSession | undefined;
      void locks.request(store.lockName, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) { reject(fail('already-open')); return; }
        let release!: () => void;
        const lifetime = new Promise<void>(done => { release = done; });
        instance = new MdbxBrowserSession(store, release);
        try {
          // onAbort can run while Rust holds a RefCell borrow. Never call back
          // into WASM or wipe its active stack until control has unwound.
          instance.module = await factory({ print: () => {}, printErr: () => {}, onAbort: () => { if (instance) instance.aborted = true; } });
          if (instance.aborted) throw fail('engine-start-failed');
          instance.filesystem = new MdbxBrowserFilesystem(instance.module.FS);
          await instance.filesystem.restore(store);
          // Initialize and persist native metadata before exposing this session.
          const hello = await instance.execute({ protocol: 2, requestId: crypto.randomUUID(), method: 'host.hello', params: {} });
          if (!hello.ok) throw fail('engine-start-failed');
          resolve(instance);
          await lifetime;
        } catch (error) { instance.invalidate(); reject(error instanceof MdbxBrowserStorageError || error instanceof MdbxBrowserSessionError ? error : fail('engine-start-failed')); }
      }).catch(() => { instance?.invalidate(); reject(fail('exclusive-lock-failed')); });
    });
  }

  request(request: MdbxBrowserRequest): Promise<unknown> {
    if (this.closed || this.closing) return Promise.reject(fail('closed'));
    if (this.pending >= 32) return Promise.reject(fail('queue-limit'));
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = this.encode(request); } catch { return Promise.reject(fail('invalid-request')); }
    const requestId = request.requestId;
    this.pending++;
    const result = this.tail.then(async () => {
      try { return await this.run(bytes, requestId); } finally { bytes.fill(0); this.pending--; }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private encode(request: MdbxBrowserRequest): Uint8Array<ArrayBuffer> {
    if (!request || request.protocol !== 2 || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(request.requestId) || typeof request.method !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(request.method) || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw fail('invalid-request');
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    if (!bytes.length || bytes.length > 1024 * 1024) { bytes.fill(0); throw fail('request-limit'); }
    return bytes;
  }
  private async execute(request: MdbxBrowserRequest) {
    const bytes = this.encode(request);
    try { return await this.run(bytes, request.requestId); } finally { bytes.fill(0); }
  }
  private async run(bytes: Uint8Array<ArrayBuffer>, requestId: string) {
    if (this.closed || this.closing || !this.module || !this.filesystem) throw fail('closed');
    const module = this.module;
    try {
      const pointer = module._mdbx_input(bytes.length);
      if (!Number.isInteger(pointer) || pointer <= 0 || pointer + bytes.length > module.HEAPU8.length) throw fail('engine-input');
      module.HEAPU8.set(bytes, pointer);
      module._mdbx_dispatch();
      if (this.aborted) throw fail('engine-failed');
      const outputPointer = module._mdbx_output_ptr(), length = module._mdbx_output_len();
      if (!Number.isInteger(outputPointer) || !Number.isInteger(length) || outputPointer <= 0 || length <= 0 || length > 900 * 1024 || outputPointer + length > module.HEAPU8.length) throw fail('engine-output');
      const output = module.HEAPU8.slice(outputPointer, outputPointer + length);
      let response;
      try { response = parseMdbx2NativeResponse(parseLosslessJson(new TextDecoder('utf-8', { fatal: true }).decode(output))); }
      finally { output.fill(0); module._mdbx_clear_output(); }
      if (response.requestId !== requestId) throw fail('response-identity');
      // An RPC error can still have written a durable intent. Preserve it too.
      await this.persist();
      if (this.closed || this.closing) throw fail('closed');
      return response;
    } catch (error) {
      this.invalidate();
      throw error instanceof MdbxBrowserStorageError || error instanceof MdbxBrowserSessionError ? error : fail('engine-failed');
    }
  }
  private async persist(): Promise<void> {
    const plan = await this.filesystem!.prepare();
    if (!plan) return;
    try { await this.store.commit(plan); this.filesystem!.accept(plan); }
    finally { for (const block of plan.blocks) block.data.fill(0); }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.tail;
      if (this.closed) return;
      try { this.module!._mdbx_close(); await this.persist(); }
      finally { this.invalidate(); }
    })();
    return this.closePromise;
  }
  private invalidate(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.aborted) try { this.module?._mdbx_close(); } catch { /* A trapped WASM instance is never reused. */ }
    this.module?.HEAPU8.fill(0);
    this.module = undefined;
    this.filesystem = undefined;
    this.release();
  }
}
