import { describe, expect, it, vi } from 'vitest';
import { BitwardenTransferAttachmentSource } from './bitwarden-transfer-attachments';
import { BitwardenAttachmentDownloadService } from './bitwarden-attachments';
import { encryptBitwardenString } from './bitwarden-crypto';
import { bitwardenTransferFixture } from '../../../tests/fixtures/bitwarden-transfer-attachment';

describe('Bitwarden transfer attachment source', () => {
  async function setup(options: Parameters<typeof bitwardenTransferFixture>[0] = {}) {
    const fixture = await bitwardenTransferFixture(options);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith(fixture.session.apiUrl)
      ? Response.json({ id: 'mafile-transfer', url: 'https://objects.example.test/file' }) : new Response(fixture.body.slice()));
    const downloads = new BitwardenAttachmentDownloadService({ fetcher: fetcher as typeof fetch, transportPolicy: { maxAttempts: 1 } });
    const contexts: ReturnType<typeof fixture.context>[] = [];
    const saveSession = vi.fn(async () => {});
    const source = new BitwardenTransferAttachmentSource(downloads, async () => {
      const ctx = fixture.context(); contexts.push(ctx); return ctx;
    }, saveSession);
    return { ...fixture, source, downloads, contexts, saveSession, fetcher };
  }

  it.each(['', '#fido2:credential', '#totp'])('reads a parent Cipher maFile for projection %s', async suffix => {
    const fixture = await setup({ suffix, organization: true });
    const attachments = await fixture.source.list(fixture.account, fixture.item);
    expect(attachments[0].sizeBytes).toBe(fixture.body.length);
    expect(attachments[0].sizeBytes).not.toBe(fixture.plaintext.length);
    const bytes = await fixture.source.read(fixture.account, fixture.item, attachments[0]);
    expect(bytes).toEqual(fixture.plaintext); bytes.fill(0);
    expect(fixture.saveSession).toHaveBeenCalledTimes(2);
    expect(fixture.contexts.every(ctx => [...ctx.organizationKeys.values()].every(key =>
      key.encKey.every(byte => byte === 0) && key.macKey.every(byte => byte === 0)))).toBe(true);
    expect((fixture.downloads as unknown as { retainedPlaintextBytes: number }).retainedPlaintextBytes).toBe(0);
  });

  it.each([false, true])('authenticates unknown ciphertext size, empty=%s', async empty => {
    const fixture = await setup({ unknownSize: true, empty });
    const [attachment] = await fixture.source.list(fixture.account, fixture.item);
    expect(attachment.sizeBytes).toBe(0);
    const bytes = await fixture.source.read(fixture.account, fixture.item, attachment);
    expect(bytes).toEqual(fixture.plaintext); bytes.fill(0);
  });

  it.each(['missing-revision', 'different-revision', 'deleted', 'different-cipher'])('rejects %s before any download', async mode => {
    const fixture = await setup();
    if (mode === 'missing-revision') delete fixture.item.providerRefs[0].revision;
    if (mode === 'different-revision') fixture.item.providerRefs[0].revision = '2026-10-10T00:00:00.000Z';
    if (mode === 'deleted') fixture.rawCipher.DeletedDate = '2026-10-11T00:00:00.000Z';
    if (mode === 'different-cipher') fixture.rawCipher.Id = 'someone-else';
    await expect(fixture.source.list(fixture.account, fixture.item)).rejects.toThrow(/版本|已变化/);
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it('never returns unauthenticated attachment plaintext', async () => {
    const fixture = await setup();
    const [attachment] = await fixture.source.list(fixture.account, fixture.item);
    fixture.body[20] ^= 1;
    await expect(fixture.source.read(fixture.account, fixture.item, attachment)).rejects.toThrow();
    expect((fixture.downloads as unknown as { retainedPlaintextBytes: number }).retainedPlaintextBytes).toBe(0);
  });

  it('preserves recovery downloads but refuses to copy an unreadable filename as fallback UI text', async () => {
    const fixture = await setup();
    (fixture.rawCipher.Attachments as Record<string, unknown>[])[0].FileName = await encryptBitwardenString('original.maFile',
      { encKey: new Uint8Array(32).fill(60), macKey: new Uint8Array(32).fill(61) });
    const fallback = await fixture.downloads.listAttachments(fixture.context());
    expect(fallback.items[0].fileName).toBe('Bitwarden 加密附件');
    await expect(fixture.source.list(fixture.account, fixture.item)).rejects.toThrow('文件名无法解密');
    await expect(fixture.source.read(fixture.account, fixture.item, fallback.items[0])).rejects.toThrow('文件名无法解密');
    expect((fixture.downloads as unknown as { retainedPlaintextBytes: number }).retainedPlaintextBytes).toBe(0);
  });

  it('accepts the same server timestamp after codec millisecond normalization and rejects invalid revisions', async () => {
    const fixture = await setup();
    fixture.rawCipher.RevisionDate = '2026-10-11T00:00:00.1234567Z';
    fixture.item.providerRefs[0].revision = '2026-10-11T00:00:00.123Z';
    expect(await fixture.source.list(fixture.account, fixture.item)).toHaveLength(1);
    fixture.rawCipher.RevisionDate = 'invalid';
    await expect(fixture.source.list(fixture.account, fixture.item)).rejects.toThrow('已变化');
  });

  it.each(['renamed', 'session-save-failure', 'invalid-chunk'])('releases downloads and keys on %s', async mode => {
    const fixture = await setup({ organization: true });
    const [attachment] = await fixture.source.list(fixture.account, fixture.item);
    if (mode === 'renamed') attachment.fileName = 'unexpected.maFile';
    if (mode === 'session-save-failure') fixture.saveSession.mockRejectedValueOnce(new Error('Synthetic locked vault'));
    let returnedChunk: Uint8Array | undefined;
    if (mode === 'invalid-chunk') {
      const original = fixture.downloads.readChunk.bind(fixture.downloads);
      vi.spyOn(fixture.downloads, 'readChunk').mockImplementation((...args) => {
        const chunk = original(...args); returnedChunk = chunk.bytes;
        return { ...chunk, nextOffset: chunk.nextOffset + 1 };
      });
    }
    await expect(fixture.source.read(fixture.account, fixture.item, attachment)).rejects.toThrow();
    expect((fixture.downloads as unknown as { retainedPlaintextBytes: number }).retainedPlaintextBytes).toBe(0);
    if (returnedChunk) expect(returnedChunk.every(byte => byte === 0)).toBe(true);
    expect(fixture.contexts.every(ctx => [...ctx.organizationKeys.values()].every(key => key.encKey.every(byte => byte === 0)))).toBe(true);
  });
});
