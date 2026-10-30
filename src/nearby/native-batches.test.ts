import { describe, expect, it } from 'vitest';
import { adoptNearbyNativeGroups } from './native-batches';
import { groupNearbyPending } from './pending';
import { NearbyDataError } from './wire-shape';
import type { NearbyIncomingRecord } from './local-adoption';

describe('native component batching', () => {
  const record = (id: string, target?: string): NearbyIncomingRecord => ({ id, deleted: false, clockJson: '{"peer":1}',
    dataJson: JSON.stringify({ title: id, folder: '', entry_type: 'note', payload: { item_data: id, ...(target ? { bound_password_entry_id: target } : {}) } }) });
  it('accepts a 40-record connected project without the old 32-record cutoff', async () => {
    const records = Array.from({length:40},(_,i)=>record(`item${i}`,i?'item0':undefined));
    const components = groupNearbyPending(records, new Map(), new Map(), 128, false);
    expect(components).toHaveLength(1);
    expect((await adoptNearbyNativeGroups(components,async rows=>rows.length)).result).toBe(40);
  });
  it('retries an oversized plan using whole components and commits only the accepted prefix', async () => {
    const components = groupNearbyPending([record('a','b'),record('b'),record('c','d'),record('d'),record('e')],new Map(),new Map(),128,false);
    const attempted: string[][]=[], committed: string[][]=[];
    const result=await adoptNearbyNativeGroups(components,async rows=>{
      attempted.push(rows.map(r=>r.id));
      if(rows.length>2)throw new NearbyDataError('native-adoption-limit');
      committed.push(rows.map(r=>r.id));return 'receipt';
    });
    expect(attempted.map(r=>r.length)).toEqual([5,4,2]);expect(committed).toEqual([['a','b']]);expect(result).toEqual({result:'receipt',count:2});
  });
  it.each(['native-source-changed','native-asset-hash','native-journal-receipt'])('never retries %s with another plan',async code=>{
    let attempts=0;await expect(adoptNearbyNativeGroups([[1],[2]],async()=>{attempts++;throw new NearbyDataError(code);})).rejects.toThrow(code);expect(attempts).toBe(1);
  });
  it('rejects an oversized connected component instead of partially writing it',async()=>{
    let attempts=0;await expect(adoptNearbyNativeGroups([[1,2,3]],async()=>{attempts++;throw new NearbyDataError('native-adoption-limit');})).rejects.toThrow('native-adoption-limit');expect(attempts).toBe(1);
  });
});
