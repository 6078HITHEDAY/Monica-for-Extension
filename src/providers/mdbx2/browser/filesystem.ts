import { blockHash, emptyBrowserHead, MDBX_BROWSER_BLOCK_BYTES as BLOCK, MDBX_BROWSER_MAX_BYTES as MAX_BYTES, MDBX_BROWSER_ROOT as ROOT, MdbxBrowserBlockStore, parseBrowserHead, storageFailure, validateBrowserPath, type BrowserBlock, type BrowserCommit, type BrowserDirectory, type BrowserFile, type BrowserHead } from './block-store';

export interface FsNode { id: number; mode: number; usedBytes?: number }
export interface FsStream { node: FsNode; position: number; flags: number; fd: number }
export interface FsStat { size: number; mode: number; mtime: Date }
export interface BrowserFs {
  readdir(path: string): string[];
  lstat(path: string): FsStat;
  lookupPath(path: string): { node: FsNode };
  getPath(node: FsNode): string;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  mkdirTree(path: string): void;
  chmod(path: string, mode: number): void;
  utime(path: string, atime: number, mtime: number): void;
  truncate(path: string, size: number): void;
  writeFile(path: string, bytes: Uint8Array): void;
  open(path: string, flags: string): FsStream;
  close(stream: FsStream): void;
  read(stream: FsStream, bytes: Uint8Array, offset: number, length: number, position: number): number;
  write(stream: FsStream, bytes: Uint8Array, offset: number, length: number, position?: number, canOwn?: boolean): number;
  msync(stream: FsStream, bytes: Uint8Array, offset: number, length: number, flags: number): number;
  doSetAttr(stream: FsStream | null, node: FsNode, attributes: { size?: number; [key: string]: unknown }, ...rest: unknown[]): void;
}

/** Tracks MEMFS writes, mapped writes and truncation. Renames retain their file
 * identity: only catalog paths change. Reads do not serialize or rewrite files. */
export class MdbxBrowserFilesystem {
  private head: BrowserHead = emptyBrowserHead();
  private readonly ids = new Map<number, string>();
  private readonly dirty = new Map<number, Set<number>>();
  private installed = false;
  constructor(private readonly fs: BrowserFs) {}

  async restore(store: MdbxBrowserBlockStore): Promise<void> {
    if (this.installed) storageFailure('already-restored');
    this.head = await store.readHead();
    this.fs.mkdirTree(ROOT);
    for (const directory of [...this.head.directories].sort((a, b) => a.path.length - b.path.length)) this.fs.mkdirTree(directory.path);
    for (const file of this.head.files) {
      this.fs.writeFile(file.path, new Uint8Array());
      this.fs.truncate(file.path, file.size);
      const stream = this.fs.open(file.path, 'r+');
      try {
        for (let first = 0; first < file.hashes.length; first += 32) {
          const blocks = await store.readBlocks(file, first);
          for (const block of blocks) {
            try {
              if (this.fs.write(stream, block.data, 0, block.data.length, block.index * BLOCK, false) !== block.data.length) storageFailure('restore-short-write');
            } finally { block.data.fill(0); }
          }
        }
      } finally { this.fs.close(stream); }
      this.ids.set(this.fs.lookupPath(file.path).node.id, file.id);
      this.fs.chmod(file.path, file.mode & 0o777);
      this.fs.utime(file.path, file.mtime, file.mtime);
    }
    // Creating children changes parent timestamps; restore directory metadata last.
    for (const directory of this.head.directories) { this.fs.chmod(directory.path, directory.mode & 0o777); this.fs.utime(directory.path, directory.mtime, directory.mtime); }
    this.install();
  }

  private mark(node: FsNode, start: number, length: number): void {
    if (!this.fs.isFile(node.mode)) return;
    const path = this.fs.getPath(node);
    if (!path.startsWith(`${ROOT}/`)) return;
    validateBrowserPath(path);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > MAX_BYTES) storageFailure('write-range');
    if (!length) return;
    const blocks = this.dirty.get(node.id) || new Set<number>();
    for (let index = Math.floor(start / BLOCK); index <= Math.floor((start + length - 1) / BLOCK); index++) blocks.add(index);
    this.dirty.set(node.id, blocks);
  }

  private install(): void {
    const fs = this.fs;
    if (typeof fs.write !== 'function' || typeof fs.msync !== 'function' || typeof fs.doSetAttr !== 'function') storageFailure('filesystem-incompatible');
    const write = fs.write.bind(fs), msync = fs.msync.bind(fs), setattr = fs.doSetAttr.bind(fs);
    fs.write = (stream, bytes, offset, length, position, canOwn) => {
      const written = write(stream, bytes, offset, length, position, canOwn);
      this.mark(stream.node, position === undefined ? stream.position - written : position, written);
      return written;
    };
    fs.msync = (stream, bytes, offset, length, flags) => {
      const result = msync(stream, bytes, offset, length, flags);
      if (result === 0) this.mark(stream.node, offset, length);
      return result;
    };
    fs.doSetAttr = (stream, node, attributes, ...rest) => {
      const oldSize = node.usedBytes;
      setattr(stream, node, attributes, ...rest);
      if (attributes.size !== undefined && oldSize !== undefined) this.mark(node, Math.min(oldSize, attributes.size), Math.abs(oldSize - attributes.size));
    };
    this.installed = true;
  }

  async prepare(): Promise<BrowserCommit | null> {
    if (!this.installed) storageFailure('not-restored');
    const directories: BrowserDirectory[] = [], pending: { file: BrowserFile; node: FsNode }[] = [];
    const before = new Map(this.head.files.map(file => [file.id, file]));
    let total = 0, count = 0;
    const walk = (path: string, depth: number) => {
      if (++count > 100_000 || depth > 30) storageFailure('filesystem-limit');
      validateBrowserPath(path);
      const stat = this.fs.lstat(path), node = this.fs.lookupPath(path).node;
      const base = { path, mode: stat.mode, mtime: stat.mtime.getTime() };
      if (this.fs.isDir(stat.mode)) {
        directories.push(base);
        for (const name of this.fs.readdir(path)) if (name !== '.' && name !== '..') walk(`${path}/${name}`, depth + 1);
      } else if (this.fs.isFile(stat.mode)) {
        if (!Number.isSafeInteger(stat.size) || stat.size < 0 || (total += stat.size) > MAX_BYTES) storageFailure('filesystem-limit');
        const id = this.ids.get(node.id) || crypto.randomUUID(); this.ids.set(node.id, id);
        pending.push({ node, file: { ...base, id, size: stat.size, hashes: before.get(id)?.hashes.slice(0, Math.ceil(stat.size / BLOCK)) || [] } });
      } else storageFailure('filesystem-node-unsupported');
    };
    walk(ROOT, 0);
    const blocks: BrowserBlock[] = [];
    for (const { file, node } of pending) {
      const old = before.get(file.id), dirty = new Set(this.dirty.get(node.id));
      const length = Math.ceil(file.size / BLOCK);
      if (!old) for (let index = 0; index < length; index++) dirty.add(index);
      else if (old.size !== file.size && length) dirty.add(Math.floor(Math.min(old.size, file.size - 1) / BLOCK));
      for (let index = file.hashes.length; index < length; index++) dirty.add(index);
      if (!dirty.size) continue;
      const stream = this.fs.open(file.path, 'r');
      try {
        for (const index of [...dirty].sort((a, b) => a - b)) {
          if (index >= length) continue;
          const size = Math.min(BLOCK, file.size - index * BLOCK), data = new Uint8Array(size);
          if (this.fs.read(stream, data, 0, size, index * BLOCK) !== size) storageFailure('snapshot-short-read');
          const hash = await blockHash(data); file.hashes[index] = hash;
          if (hash !== old?.hashes[index]) blocks.push({ id: file.id, index, data }); else data.fill(0);
        }
      } finally { this.fs.close(stream); }
    }
    const compare = (a: BrowserDirectory, b: BrowserDirectory) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    const next = parseBrowserHead({ version: 1, generation: this.head.generation + 1, directories: directories.sort(compare), files: pending.map(item => item.file).sort(compare) });
    if (!blocks.length && JSON.stringify({ ...next, generation: this.head.generation }) === JSON.stringify(this.head)) { this.dirty.clear(); return null; }
    return { previous: this.head, next, blocks };
  }

  accept(plan: BrowserCommit): void {
    if (plan.previous !== this.head || plan.next.generation !== this.head.generation + 1) storageFailure('generation-conflict');
    this.head = plan.next;
    this.dirty.clear();
    for (const block of plan.blocks) block.data.fill(0);
  }
}
