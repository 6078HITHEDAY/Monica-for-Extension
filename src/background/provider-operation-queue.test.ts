import { expect, it } from 'vitest';
import { ProviderOperationQueue } from './provider-operation-queue';

it('reserves overlapping sets atomically, while independent providers progress', async () => {
  const queue = new ProviderOperationQueue(), events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = queue.run('a', async () => { events.push('first'); await gate; });
  const both = queue.runMany(['b', 'a', 'b'], async () => { events.push('both'); });
  const reversed = queue.runMany(['a', 'b'], async () => { events.push('reversed'); throw new Error('failure'); });
  const failed = expect(reversed).rejects.toThrow('failure');
  const last = queue.run('b', async () => { events.push('last'); });
  await queue.run('c', async () => { events.push('independent'); });
  expect(events).toEqual(['first', 'independent']);
  release(); await Promise.all([first, both, failed, last]);
  expect(events).toEqual(['first', 'independent', 'both', 'reversed', 'last']);
  await expect(queue.runMany(['a','b'], async () => 'retry')).resolves.toBe('retry');
});
