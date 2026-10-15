import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { advanceMdbx2ContentWriteAnchor, readMdbx2ContentWriteAnchor, validateMdbx2ContentWriteAnchor, type Mdbx2ContentWriteAnchor } from './content-write-anchor';

function fixture() {
  const handle = randomUUID(), anchor: Mdbx2ContentWriteAnchor = {
    writeRevision: { vaultId: randomUUID(), revisionSha256: '' },
    branches: ['历史🔑', 'main'].map(branchName => ({ branchId: randomUUID(), branchName, headCommitId: randomUUID() }))
  };
  anchor.writeRevision.revisionSha256 = referenceHash(anchor);
  const client = {
    hello: vi.fn().mockResolvedValue({ supportsContentWriteAnchor: true, supportsContentWrite: true, supportsVaultWriteRevision: true }),
    request: vi.fn().mockResolvedValue(anchor)
  };
  return { handle, anchor, client };
}
function referenceHash(anchor: Mdbx2ContentWriteAnchor) {
  const hash = createHash('sha256');
  const branches = [...anchor.branches].sort((a, b) => a.branchId.localeCompare(b.branchId));
  for (const text of ['monica-extension-write-revision-v1', anchor.writeRevision.vaultId, ...branches.flatMap(b => [b.branchId, b.branchName, b.headCommitId])]) {
    const bytes = Buffer.from(text), length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(bytes.length)); hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}
describe('native content write sequence anchor', () => {
  it('verifies the complete Unicode branch inventory against the native revision', async () => {
    const f = fixture(), original = structuredClone(f.anchor);
    const result = await readMdbx2ContentWriteAnchor(f.client, f.handle, f.anchor.writeRevision);
    expect(result.writeRevision).toEqual(original.writeRevision);
    expect(f.client.request).toHaveBeenCalledWith('content.write.anchor', { vaultHandle: f.handle }, 15_000);
    expect(f.anchor).toEqual(original);
  });
  it('predicts only its own main-branch commit and preserves every other branch', async () => {
    const f = fixture(), before = structuredClone(f.anchor), commit = randomUUID();
    const result = await advanceMdbx2ContentWriteAnchor(f.anchor, commit);
    expect(result.branches.find(b => b.branchName === 'main')!.headCommitId).toBe(commit);
    expect(result.branches.find(b => b.branchName !== 'main')).toEqual(before.branches.find(b => b.branchName !== 'main'));
    expect(result.writeRevision.revisionSha256).toBe(referenceHash(result));
    expect(f.anchor).toEqual(before);
  });
  it('preserves distinct non-main branch identities even when their names match', async () => {
    const f = fixture();
    f.anchor.branches.push({ ...f.anchor.branches[0], branchId: randomUUID(), headCommitId: randomUUID() });
    f.anchor.writeRevision.revisionSha256 = referenceHash(f.anchor);
    const result = await advanceMdbx2ContentWriteAnchor(f.anchor, randomUUID());
    expect(result.branches.filter(b => b.branchName !== 'main')).toHaveLength(2);
    expect(result.writeRevision.revisionSha256).toBe(referenceHash(result));
  });
  it('does not adopt a new live baseline after a lost reply or independent edit', async () => {
    const f = fixture(), predicted = await advanceMdbx2ContentWriteAnchor(f.anchor, randomUUID());
    for (const branch of f.anchor.branches) {
      const later = structuredClone(predicted); later.branches.find(b => b.branchId === branch.branchId)!.headCommitId = randomUUID();
      later.writeRevision.revisionSha256 = referenceHash(later); f.client.request.mockResolvedValue(later);
      await expect(readMdbx2ContentWriteAnchor(f.client, f.handle, predicted.writeRevision)).rejects.toMatchObject({ code: 'content-write-stale' });
    }
  });
  it('snapshots caller state before asynchronous validation and keeps output independent', async () => {
    const f = fixture(), original = structuredClone(f.anchor), commit = randomUUID();
    const pending = advanceMdbx2ContentWriteAnchor(f.anchor, commit);
    f.anchor.branches[0].branchName = 'modified'; f.anchor.writeRevision.vaultId = randomUUID();
    const result = await pending;
    expect(result.writeRevision.vaultId).toBe(original.writeRevision.vaultId);
    expect(result.branches.some(b => b.branchName === 'modified')).toBe(false);
  });
  it.each(['hash', 'vault', 'head', 'name', 'duplicate id', 'duplicate main', 'missing main', 'too many', 'oversized name', 'invalid Unicode', 'unknown field', 'aggregate size'])(
    'rejects corrupt %s before supplying a continuation', async change => {
      const f = fixture(), value = structuredClone(f.anchor);
      if (change === 'hash') value.writeRevision.revisionSha256 = 'f'.repeat(64);
      if (change === 'vault') value.writeRevision.vaultId = randomUUID();
      if (change === 'head') value.branches[0].headCommitId = randomUUID();
      if (change === 'name') value.branches[0].branchName = 'altered';
      if (change === 'duplicate id') value.branches[0].branchId = value.branches[1].branchId;
      if (change === 'duplicate main') value.branches[0].branchName = 'main';
      if (change === 'missing main') value.branches = value.branches.filter(b => b.branchName !== 'main');
      if (change === 'too many') value.branches = Array(1025).fill(value.branches[0]);
      if (change === 'oversized name') value.branches[0].branchName = '中'.repeat(1366);
      if (change === 'invalid Unicode') value.branches[0].branchName = '\ud800';
      if (change === 'unknown field') Object.assign(value.branches[0], { allowRecovery: true });
      if (change === 'aggregate size') value.branches.push(...Array.from({ length: 140 }, (_, i) => ({ branchId: randomUUID(), branchName: 'x'.repeat(4000) + i, headCommitId: randomUUID() })));
      await expect(validateMdbx2ContentWriteAnchor(value)).rejects.toMatchObject({ code: 'content-write-anchor-invalid' });
    });
  it('requires capability support and checks cancellation before and after reads', async () => {
    const f = fixture(); f.client.hello.mockResolvedValue({ supportsContentWrite: true, supportsVaultWriteRevision: true });
    await expect(readMdbx2ContentWriteAnchor(f.client, f.handle, f.anchor.writeRevision)).rejects.toMatchObject({ code: 'content-write-host-update-required' });
    expect(f.client.request).not.toHaveBeenCalled();
    const abort = new AbortController(); abort.abort();
    await expect(readMdbx2ContentWriteAnchor(f.client, f.handle, f.anchor.writeRevision, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const second = fixture(), later = new AbortController(); second.client.request.mockImplementation(async () => { later.abort(); return second.anchor; });
    await expect(readMdbx2ContentWriteAnchor(second.client, second.handle, second.anchor.writeRevision, later.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
