export const MDBX_BROWSER_BLOCK_BYTES = 64 * 1024;
export const MDBX_BROWSER_ROOT = '/monica';
export const MDBX_BROWSER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_NODES = 100_000;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export interface BrowserDirectory { path: string; mode: number; mtime: number }
export interface BrowserFile extends BrowserDirectory { id: string; size: number; hashes: string[] }
export interface BrowserHead { version: 1; generation: number; directories: BrowserDirectory[]; files: BrowserFile[] }
export interface BrowserBlock { id: string; index: number; data: Uint8Array<ArrayBuffer> }
export interface BrowserCommit { previous: BrowserHead; next: BrowserHead; blocks: BrowserBlock[] }
export class MdbxBrowserStorageError extends Error {
  constructor(readonly code: string) { super(`Browser database storage: ${code}.`); this.name = 'MdbxBrowserStorageError'; }
}
export function storageFailure(code: string): never { throw new MdbxBrowserStorageError(code); }
export const emptyBrowserHead = (): BrowserHead => ({ version: 1, generation: 0, directories: [], files: [] });
export async function blockHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) storageFailure('invalid-catalog');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) storageFailure('invalid-catalog');
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) storageFailure('invalid-catalog');
  return value;
}
export function validateBrowserPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('\0') || value.includes('\\') || value !== MDBX_BROWSER_ROOT && !value.startsWith(`${MDBX_BROWSER_ROOT}/`)) storageFailure('invalid-path');
  const parts = value.split('/');
  if (parts.length > 32 || parts.slice(1).some(part => !part || part === '.' || part === '..')) storageFailure('invalid-path');
  return value;
}
function node(value: Record<string, unknown>, directory: boolean): BrowserDirectory {
  const mode = integer(value.mode, 0xffff);
  if ((mode & 0xf000) !== (directory ? 0x4000 : 0x8000)) storageFailure('invalid-file-mode');
  return { path: validateBrowserPath(value.path), mode, mtime: integer(value.mtime, 8_640_000_000_000_000) };
}
export function parseBrowserHead(input: unknown): BrowserHead {
  const value = object(input); exact(value, ['version', 'generation', 'directories', 'files']);
  if (value.version !== 1 || !Array.isArray(value.directories) || !Array.isArray(value.files) || value.directories.length + value.files.length > MAX_NODES) storageFailure('unsupported-catalog');
  const generation = integer(value.generation, Number.MAX_SAFE_INTEGER - 1);
  const paths = new Set<string>(), ids = new Set<string>(); let bytes = 0;
  const directories = value.directories.map(raw => { const item = object(raw); exact(item, ['path', 'mode', 'mtime']); return node(item, true); });
  const files = value.files.map(raw => {
    const item = object(raw); exact(item, ['id', 'path', 'mode', 'mtime', 'size', 'hashes']);
    if (typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id)) storageFailure('invalid-file-id'); ids.add(item.id);
    const size = integer(item.size, MDBX_BROWSER_MAX_BYTES); bytes += size;
    if (bytes > MDBX_BROWSER_MAX_BYTES || !Array.isArray(item.hashes) || item.hashes.length !== Math.ceil(size / MDBX_BROWSER_BLOCK_BYTES) || item.hashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))) storageFailure('invalid-file-blocks');
    return { ...node(item, false), id: item.id, size, hashes: item.hashes.slice() as string[] };
  });
  for (const item of [...directories, ...files]) { if (paths.has(item.path)) storageFailure('duplicate-path'); paths.add(item.path); }
  const dirs = new Set(directories.map(item => item.path));
  if ((directories.length || files.length) && !dirs.has(MDBX_BROWSER_ROOT)) storageFailure('missing-root');
  for (const item of [...directories, ...files]) {
    if (item.path !== MDBX_BROWSER_ROOT && !dirs.has(item.path.slice(0, item.path.lastIndexOf('/')))) storageFailure('missing-parent');
    if (item.path === MDBX_BROWSER_ROOT && !directories.includes(item as BrowserDirectory)) storageFailure('invalid-root');
  }
  if (generation === 0 && (directories.length || files.length)) storageFailure('invalid-initial-catalog');
  return { version: 1, generation, directories, files };
}
export function expectedBlockLength(file: BrowserFile, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= file.hashes.length) storageFailure('invalid-block-index');
  return Math.min(MDBX_BROWSER_BLOCK_BYTES, file.size - index * MDBX_BROWSER_BLOCK_BYTES);
}

/** Ciphertext files and non-secret native metadata share one atomic generation.
 * No successful result is observable before transaction.oncomplete. */
export class MdbxBrowserBlockStore {
  constructor(private readonly name = 'monica-extension-mdbx-browser-v1', private readonly factory: IDBFactory = indexedDB) {}
  get lockName(): string { return `monica-mdbx-browser:${this.name}`; }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      let settled = false;
      const failed = (code: string) => { settled = true; reject(new MdbxBrowserStorageError(code)); };
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('catalog')) db.createObjectStore('catalog');
        if (!db.objectStoreNames.contains('blocks')) db.createObjectStore('blocks');
      };
      request.onerror = () => failed('open-failed');
      request.onblocked = () => failed('upgrade-blocked');
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        request.result.onversionchange = () => request.result.close(); resolve(request.result);
      };
    });
  }

  async readHead(): Promise<BrowserHead> {
    const db = await this.open();
    try { return await new Promise<BrowserHead>((resolve, reject) => {
      const tx = db.transaction('catalog'); let value: unknown;
      const request = tx.objectStore('catalog').get('active'); request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => { db.close(); try { resolve(value === undefined ? emptyBrowserHead() : parseBrowserHead(value)); } catch (error) { reject(error); } };
      tx.onabort = () => { db.close(); reject(new MdbxBrowserStorageError('read-failed')); };
    }); } finally { db.close(); }
  }

  async readBlocks(file: BrowserFile, first: number, count = 32): Promise<BrowserBlock[]> {
    if (!ID.test(file.id) || !Number.isInteger(first) || first < 0 || first >= file.hashes.length || !Number.isInteger(count) || count < 1 || count > 32) storageFailure('invalid-block-range');
    const end = Math.min(first + count, file.hashes.length), db = await this.open();
    let blocks: BrowserBlock[];
    try { blocks = await new Promise<BrowserBlock[]>((resolve, reject) => {
      const tx = db.transaction('blocks'); const records: BrowserBlock[] = [];
      for (let index = first; index < end; index++) {
        const request = tx.objectStore('blocks').get([file.id, index]); request.onsuccess = () => { records[index - first] = { id: file.id, index, data: request.result }; };
      }
      tx.oncomplete = () => { db.close(); resolve(records); };
      tx.onabort = () => { db.close(); reject(new MdbxBrowserStorageError('read-failed')); };
    }); } finally { db.close(); }
    try {
    for (const block of blocks) {
      if (!(block.data instanceof Uint8Array) || block.data.byteLength !== expectedBlockLength(file, block.index) || await blockHash(block.data) !== file.hashes[block.index]) storageFailure('block-integrity');
    }
    return blocks;
    } catch (error) {
      for (const block of blocks) if (block?.data instanceof Uint8Array) block.data.fill(0);
      throw error;
    }
  }

  async commit(plan: BrowserCommit): Promise<void> {
    const previous = parseBrowserHead(plan.previous), next = parseBrowserHead(plan.next);
    if (next.generation !== previous.generation + 1) storageFailure('generation-invalid');
    const before = new Map(previous.files.map(file => [file.id, file])), after = new Map(next.files.map(file => [file.id, file]));
    const changed = new Map<string, BrowserBlock>();
    try {
    // Take ownership of every byte before the first asynchronous hash. A
    // caller must not be able to alter a later block while hashing an earlier one.
    for (const block of plan.blocks) {
      const file = after.get(block.id), key = `${block.id}:${block.index}`;
      if (!file || changed.has(key) || !(block.data instanceof Uint8Array) || block.data.byteLength !== expectedBlockLength(file, block.index)) storageFailure('invalid-block-update');
      changed.set(key, { ...block, data: block.data.slice() });
    }
    for (const block of changed.values()) if (await blockHash(block.data) !== after.get(block.id)!.hashes[block.index]) storageFailure('invalid-block-update');
    for (const file of next.files) for (let index = 0; index < file.hashes.length; index++) {
      if (before.get(file.id)?.hashes[index] !== file.hashes[index] && !changed.has(`${file.id}:${index}`)) storageFailure('missing-block-update');
    }
    const db = await this.open();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['catalog', 'blocks'], 'readwrite', { durability: 'strict' });
      let failure: Error | undefined;
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(failure || new MdbxBrowserStorageError('commit-failed')); };
      const catalog = tx.objectStore('catalog'), blocks = tx.objectStore('blocks');
      const request = catalog.get('active');
      request.onsuccess = () => {
        try {
          const current = request.result === undefined ? emptyBrowserHead() : parseBrowserHead(request.result);
          if (JSON.stringify(current) !== JSON.stringify(previous)) storageFailure('generation-conflict');
          for (const file of previous.files) {
            const retained = after.get(file.id);
            if (!retained || retained.hashes.length < file.hashes.length) blocks.delete(IDBKeyRange.bound([file.id, retained?.hashes.length ?? 0], [file.id, Number.MAX_SAFE_INTEGER]));
          }
          for (const block of changed.values()) blocks.put(block.data, [block.id, block.index]);
          catalog.put(next, 'active');
        } catch (error) { failure = error instanceof MdbxBrowserStorageError ? error : new MdbxBrowserStorageError('commit-failed'); tx.abort(); }
      };
    }); } finally { db.close(); }
    } finally { for (const block of changed.values()) block.data.fill(0); }
  }
}
