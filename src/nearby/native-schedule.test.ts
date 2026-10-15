import { describe, expect, it } from 'vitest';
import { scheduleNearbyNativeGroups } from './native-schedule';
import { groupNearbyPending } from './pending';
import { adoptNearbyNativeGroups } from './native-batches';
import { NearbyDataError } from './wire-shape';
import type { NearbyIncomingRecord } from './local-adoption';
import type { NearbySourceSnapshot } from './source-adapter';

const node = (id:string,parent:string|null=null) => ({id,title:id,parent});
const path = [node('parent'),node('child','parent')];
function record(id:string,kind='folder',deleted=false,nodes=path):NearbyIncomingRecord {
  return {id,deleted,clockJson:'{"peer":2}',localId:`mdbx:provider:${kind==='folder'?'folder:':''}${id}`,scope:'mdbx:provider',expectedGuard:'a'.repeat(64),
    dataJson:JSON.stringify({title:id,folder:'',entry_type:kind,payload:kind==='folder'?{path:nodes,tags:[]}:{item_data:id},...(kind==='folder'?{}:{folder_path:nodes}),trashed:deleted})};
}
function snapshot(rows:NearbyIncomingRecord[]):NearbySourceSnapshot {
  return {sourceHash:'b'.repeat(64),records:rows.map(row=>({local_id:row.localId!,global_id:row.id,scope:row.scope!,guard:row.expectedGuard!,deleted:row.deleted,data:JSON.parse(row.dataJson)})),readAsset:async()=>new Uint8Array()};
}
const components=(rows:NearbyIncomingRecord[])=>groupNearbyPending(rows,new Map(),new Map(),128,false);
const ids=(groups:NearbyIncomingRecord[][])=>groups.flat().map(row=>row.id);

describe('native hierarchy scheduling across batches',()=>{
  it('restores ancestors before child folders and 301 items without grouping the whole directory',()=>{
    const rows=[...Array.from({length:301},(_,i)=>record(`item${i}`,'note')),record('child'),record('parent','folder',false,path.slice(0,1))];
    const before=snapshot(rows.map(row=>({...row,deleted:true})));
    const first=scheduleNearbyNativeGroups(components(rows),before);
    expect(ids(first).slice(0,2)).toEqual(['parent','child']);expect(first.flat()).toHaveLength(128);expect(first.every(group=>group.length===1)).toBe(true);
  });
  it('deletes child-first after the last content page, including empty bound tombstones',()=>{
    const live=[record('parent','folder',false,path.slice(0,1)),record('child'),...Array.from({length:260},(_,i)=>record(`item${i}`,'note'))],before=snapshot(live);
    let pending=live.map(row=>({...row,deleted:true,dataJson:'{}'}));const applied:string[]=[];
    while(pending.length){const next=scheduleNearbyNativeGroups(components(pending),before);const keys=ids(next);expect(keys.length).toBeGreaterThan(0);applied.push(...keys);pending=pending.filter(row=>!keys.includes(row.id));}
    expect(applied.slice(-2)).toEqual(['child','parent']);expect(new Set(applied).size).toBe(262);
  });
  it('moves a child out before deleting its former parent even when its new path is shallower',()=>{
    const old=record('child'),moved=record('child','folder',false,[node('child')]),parent=record('parent','folder',true,path.slice(0,1));
    expect(ids(scheduleNearbyNativeGroups(components([parent,moved]),snapshot([old,record('parent','folder',false,path.slice(0,1))])))).toEqual(['child','parent']);
  });
  it('resolves hierarchy aliases without splitting a 40-record password project',async()=>{
    const parent=record('canonical-parent','folder',false,[node('canonical-parent')]);
    const rows=Array.from({length:40},(_,i)=>{const row=record(`item${i}`,'note',false,[node('alias-parent')]);const data=JSON.parse(row.dataJson);data.extensions={password_group_id:'project'};return{...row,dataJson:JSON.stringify(data)};});
    const groups=scheduleNearbyNativeGroups(components([...rows,parent]),snapshot([]),new Map([['alias-parent','canonical-parent']]));
    expect(groups.map(group=>group.length)).toEqual([1,40]);
    const attempts:string[][]=[];
    const result=await adoptNearbyNativeGroups(groups,async rows=>{attempts.push(rows.map(row=>row.id));if(rows.length>40)throw new NearbyDataError('native-adoption-limit');return rows.length;});
    expect(result.count).toBe(1);expect(attempts[1]).toEqual(['canonical-parent']);
  });
  it('rejects conflicting ancestry before selecting even an otherwise valid prefix',()=>{
    const a=record('parent','folder',false,[node('child'),node('parent','child')]),b=record('child');
    expect(()=>scheduleNearbyNativeGroups(components([record('independent','note',false,[]),a,b]),snapshot([]),new Map(),1)).toThrow('native-folder-cycle');
  });
});
