/** Serialize source writes without letting a failed operation poison later retries. */
export class ProviderOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(providerId: string, execute: () => Promise<T>): Promise<T> {
    return this.runMany([providerId], execute);
  }

  /** Reserve every tail synchronously; nested single-provider locks can deadlock. */
  runMany<T>(providerIds: readonly string[], execute: () => Promise<T>): Promise<T> {
    const ids = [...new Set(providerIds)].sort();
    const result = Promise.all(ids.map(id => this.tails.get(id))).then(execute);
    const settled = result.then(() => undefined, () => undefined);
    for (const id of ids) this.tails.set(id, settled);
    void settled.then(() => { for (const id of ids) if (this.tails.get(id) === settled) this.tails.delete(id); });
    return result;
  }
}
