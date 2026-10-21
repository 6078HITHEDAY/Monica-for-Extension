import {describe,it,expect} from 'vitest';
import {CliRecovery} from './recovery';
function storage():Storage {
 const values=new Map<string,string>();return {get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v);},removeItem:k=>{values.delete(k);},clear:()=>values.clear()};
}
describe('public CLI recovery identities',()=>{
 it('survives remount without storing executable arguments or secrets',()=>{
  const disk=storage(),first=new CliRecovery(disk);const pending=first.begin('vault-id','public-path','create_password');
  expect(new CliRecovery(disk).list()).toEqual([pending]);expect(Object.keys(JSON.parse(disk.getItem(disk.key(0)!)!)).sort()).toEqual(['created','database','id','operation','vault']);
  first.forget(pending.id);expect(new CliRecovery(disk).list()).toEqual([]);
 });
 it('ignores malformed identities and refuses to silently evict unconfirmed writes',()=>{
  const disk=storage();disk.setItem('monica.cli.operation.bad','{"id":"bad","operation":"replay"}');const recovery=new CliRecovery(disk);expect(recovery.list()).toEqual([]);
  for(let i=0;i<64;i++)recovery.begin('vault','path','delete');expect(()=>recovery.begin('vault','path','delete')).toThrow();expect(recovery.list()).toHaveLength(64);
 });
});
