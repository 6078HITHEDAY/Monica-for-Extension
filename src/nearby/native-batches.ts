import { NearbyDataError } from './wire-shape';

/** Only planner/resource-limit failures known to happen before durable staging
 * may shrink a batch. Never retry a write failure with a different operation.
 * Each component is a whole dependency/password group. */
export async function adoptNearbyNativeGroups<T, R>(groups: readonly (readonly T[])[], adopt: (records: T[]) => Promise<R>): Promise<{ result: R; count: number }> {
  let count = groups.length;
  if (!count) throw new Error('Empty native adoption groups');
  for (;;) {
    const records = groups.slice(0, count).flat();
    try { return { result: await adopt(records), count: records.length }; }
    catch (error) {
      if (!(error instanceof NearbyDataError) || !['native-adoption-limit', 'native-metadata-batch-limit', 'native-asset-limit'].includes(error.code) || count === 1) throw error;
      count = Math.ceil(count / 2);
    }
  }
}
