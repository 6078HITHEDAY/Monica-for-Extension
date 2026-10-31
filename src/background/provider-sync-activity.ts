/** Shared ownership for synchronization, Passkey refresh and project recovery.
 * Releasing an old operation must never remove a replacement operation. */
export class ProviderSyncActivity {
  private readonly owners = new Map<string, AbortController>();

  isBusy(providerId: string): boolean { return this.owners.has(providerId); }

  owns(providerId: string, signal: AbortSignal): boolean {
    return this.owners.get(providerId)?.signal === signal;
  }

  reserve(providerId: string, owner: AbortController): void {
    if (this.isBusy(providerId)) throw new Error('此密码源正在处理其他操作，请稍后重试。');
    this.owners.set(providerId, owner);
  }

  release(providerId: string, owner: AbortController): void {
    if (this.owners.get(providerId) === owner) this.owners.delete(providerId);
  }

  abort(providerId: string, reason: unknown): boolean {
    const owner = this.owners.get(providerId);
    owner?.abort(reason);
    return Boolean(owner);
  }

  abortAll(reason: unknown): void {
    for (const owner of this.owners.values()) owner.abort(reason);
    this.owners.clear();
  }
}
