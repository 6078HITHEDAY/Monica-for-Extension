import { describe, expect, it, vi } from 'vitest';
import { emptyBrowserHead, MdbxBrowserBlockStore, parseBrowserHead, validateBrowserPath } from './block-store';

const head = () => ({ version: 1, generation: 1, directories: [{ path: '/monica', mode: 0x41c0, mtime: 1 }], files: [{ path: '/monica/file', mode: 0x8180, mtime: 1, id: '12345678-1234-1234-1234-123456789abc', size: 1, hashes: ['a'.repeat(64)] }] });
describe('MDBX browser durable catalog boundary', () => {
  it.each(['/monica/../private', '/monica//file', '/monica/./file', '/other/file', '/monica/unsafe\\file', '/monica/unsafe\0file', '/monica/', '/monica-lookalike/file'])('rejects unsafe path %s', value => {
    expect(() => validateBrowserPath(value)).toThrow();
  });
  it('accepts the initial empty catalog and a valid root-contained file', () => {
    expect(parseBrowserHead(emptyBrowserHead())).toEqual(emptyBrowserHead());
    expect(parseBrowserHead(head())).toEqual(head());
  });
  it('copies catalog arrays so callers cannot mutate the validated snapshot', () => {
    const input = head(), parsed = parseBrowserHead(input); input.files[0].hashes[0] = 'b'.repeat(64); input.directories[0].path = '/bad';
    expect(parsed.files[0].hashes[0]).toBe('a'.repeat(64)); expect(parsed.directories[0].path).toBe('/monica');
  });
  it.each([
    ['symlink', (h: ReturnType<typeof head>) => { h.files[0].mode = 0xa180; }],
    ['orphan', (h: ReturnType<typeof head>) => { h.files[0].path = '/monica/missing/file'; }],
    ['duplicate path', (h: ReturnType<typeof head>) => { h.files.push({ ...h.files[0], id: '22345678-1234-1234-1234-123456789abc' }); }],
    ['duplicate identity', (h: ReturnType<typeof head>) => { h.files.push({ ...h.files[0], path: '/monica/other' }); }],
    ['missing block', (h: ReturnType<typeof head>) => { h.files[0].size = 65537; }],
    ['fractional size', (h: ReturnType<typeof head>) => { h.files[0].size = 0.5; }],
    ['invalid hash', (h: ReturnType<typeof head>) => { h.files[0].hashes[0] = '../invalid'; }],
    ['uninitialized data', (h: ReturnType<typeof head>) => { h.generation = 0; }],
    ['overflow generation', (h: ReturnType<typeof head>) => { h.generation = Number.MAX_SAFE_INTEGER; }],
    ['file root', (h: ReturnType<typeof head>) => { h.directories = []; h.files[0].path = '/monica'; }],
  ] as const)('rejects %s', (_, mutate) => { const value = head(); mutate(value); expect(() => parseBrowserHead(value)).toThrow(); });
  it('closes a late open result after a blocked upgrade was rejected', async () => {
    const close = vi.fn();
    const request = { result: { close }, onblocked: null as (() => void) | null, onsuccess: null as (() => void) | null };
    const factory = { open: () => request } as unknown as IDBFactory;
    const result = new MdbxBrowserBlockStore('synthetic', factory).readHead();
    const rejected = expect(result).rejects.toMatchObject({ code: 'upgrade-blocked' });
    request.onblocked!(); await rejected; request.onsuccess!(); expect(close).toHaveBeenCalledOnce();
  });
});
