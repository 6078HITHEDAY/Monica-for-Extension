import type { BitwardenPasskeyPreservationCopy, BitwardenPasskeyPreservationPlan } from './bitwarden-passkey-preservation';
import { bitwardenRemovalSnapshotSha256 } from './bitwarden-project-removal-transaction';

export interface BitwardenPasskeyPreservationJournal {
  version: 1;
  revision: number;
  plan: BitwardenPasskeyPreservationPlan;
  copies: Array<{ copyId: string; stage: 'ready' | 'attempted' | 'verified'; remoteId?: string }>;
}
export interface BitwardenPasskeyPreservationStore {
  read(): Promise<BitwardenPasskeyPreservationJournal>;
  /** Persist the entire immutable plan and progress in encrypted storage. */
  update(expectedRevision: number, journal: BitwardenPasskeyPreservationJournal): Promise<void>;
}
export interface BitwardenPasskeyPreservationRemote {
  readSource(): Promise<Record<string, unknown> | null>;
  /** Uncached, complete search for the encrypted operation marker; a failed or
   * partial scan must throw, never return an apparent empty result. */
  findCopies(copy: BitwardenPasskeyPreservationCopy): Promise<Record<string, unknown>[]>;
  createCopy(copy: BitwardenPasskeyPreservationCopy): Promise<Record<string, unknown>>;
  verifyCopy(copy: BitwardenPasskeyPreservationCopy, raw: Record<string, unknown>): Promise<unknown>;
}
const invalid = () => new Error('Bitwarden Passkey 保留日志无效或已变化，原始凭据已保留。');
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validateBitwardenPasskeyPreservationJournal(journal: BitwardenPasskeyPreservationJournal): void {
  const plan = journal?.plan;
  if (!journal || journal.version !== 1 || !Number.isSafeInteger(journal.revision) || journal.revision < 1 || plan?.version !== 1
    || !id(plan.operationId) || !id(plan.sourceCipherId) || !hash(plan.sourceSha256)
    || !Array.isArray(plan.copies) || plan.copies.length > 100 || !Array.isArray(journal.copies) || journal.copies.length !== plan.copies.length) throw invalid();
  const ids = new Set<string>(), credentials = new Set<string>(), remoteIds = new Set<string>();
  for (let index = 0; index < plan.copies.length; index++) {
    const copy = plan.copies[index], progress = journal.copies[index];
    if (!copy || !hash(copy.copyId) || ids.has(copy.copyId) || !id(copy.credentialId) || credentials.has(copy.credentialId)
      || !id(copy.sourceRemoteId) || !copy.sourceRemoteId.startsWith(`${plan.sourceCipherId}#fido2:`) || !hash(copy.credentialSha256)
      || typeof copy.payloadJson !== 'string' || !copy.payloadJson || copy.payloadJson.length > 1024 * 1024
      || !progress || progress.copyId !== copy.copyId || !['ready', 'attempted', 'verified'].includes(progress.stage)
      || progress.stage === 'verified' && (!id(progress.remoteId) || progress.remoteId === plan.sourceCipherId || remoteIds.has(progress.remoteId))
      || progress.stage !== 'verified' && progress.remoteId !== undefined) throw invalid();
    ids.add(copy.copyId); credentials.add(copy.credentialId); if (progress.remoteId) remoteIds.add(progress.remoteId);
  }
}

export function assertBitwardenPasskeyPreservationTransition(before: BitwardenPasskeyPreservationJournal, after: BitwardenPasskeyPreservationJournal): void {
  validateBitwardenPasskeyPreservationJournal(before); validateBitwardenPasskeyPreservationJournal(after);
  if (after.revision !== before.revision + 1 || JSON.stringify(before.plan) !== JSON.stringify(after.plan)) throw invalid();
  let changes = 0;
  before.copies.forEach((copy, index) => {
    const next = after.copies[index];
    if (JSON.stringify(copy) === JSON.stringify(next)) return;
    if (copy.copyId !== next.copyId || copy.stage === 'verified'
      || !(copy.stage === 'ready' && ['attempted', 'verified'].includes(next.stage) || copy.stage === 'attempted' && next.stage === 'verified')) throw invalid();
    changes++;
  });
  if (changes !== 1) throw invalid();
}

/** Copy-only transaction. It cannot delete or alter a source or another copy.
 * The caller supplies a durably saved plan and holds the provider queue.
 */
export class BitwardenPasskeyPreservationTransaction {
  private active?: Promise<BitwardenPasskeyPreservationJournal>;
  constructor(private readonly store: BitwardenPasskeyPreservationStore, private readonly remote: BitwardenPasskeyPreservationRemote) {}
  resume(): Promise<BitwardenPasskeyPreservationJournal> {
    return this.active ??= this.run().finally(() => { this.active = undefined; });
  }
  private async source(plan: BitwardenPasskeyPreservationPlan) {
    const source = await this.remote.readSource();
    if (!source || (source.id ?? source.Id) !== plan.sourceCipherId || (source.deletedDate ?? source.DeletedDate)
      || await bitwardenRemovalSnapshotSha256(source) !== plan.sourceSha256)
      throw new Error('保留期间原密码已变化，原始凭据与已创建副本均已保留，请重新核对。');
  }
  private async update(journal: BitwardenPasskeyPreservationJournal, index: number, stage: 'attempted' | 'verified', remoteId?: string) {
    const next = { ...journal, revision: journal.revision + 1,
      copies: journal.copies.map((copy, position) => position === index ? { ...copy, stage, ...(remoteId ? { remoteId } : {}) } : copy) };
    assertBitwardenPasskeyPreservationTransition(journal, next);
    await this.store.update(journal.revision, next); return next;
  }
  private async run(): Promise<BitwardenPasskeyPreservationJournal> {
    let journal = await this.store.read(); validateBitwardenPasskeyPreservationJournal(journal);
    for (let index = 0; index < journal.copies.length; index++) {
      await this.source(journal.plan);
      const copy = journal.plan.copies[index], progress = journal.copies[index];
      const matches = await this.remote.findCopies(copy);
      if (!Array.isArray(matches) || matches.length > 1) throw new Error('Passkey 保留副本不唯一，已停止并保留原始凭据。');
      let raw = matches[0];
      if (!raw) {
        if (progress.stage !== 'ready') throw new Error('Passkey 副本创建结果未确认，已停止重复创建，请检查恢复记录。');
        journal = await this.update(journal, index, 'attempted');
        raw = await this.remote.createCopy(copy);
      }
      await this.remote.verifyCopy(copy, raw);
      const remoteId = raw.id ?? raw.Id;
      if (!id(remoteId) || remoteId === journal.plan.sourceCipherId || progress.stage === 'verified' && progress.remoteId !== remoteId) throw invalid();
      if (journal.copies[index].stage !== 'verified') journal = await this.update(journal, index, 'verified', remoteId);
    }
    await this.source(journal.plan);
    return journal;
  }
}
