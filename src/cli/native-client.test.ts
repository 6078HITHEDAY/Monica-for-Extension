import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, CliNativeClient,validateHello } from './native-client';

function fixture() {
  const messages = new Set<(value: unknown) => void>(), disconnects = new Set<() => void>();
  const port = {
    postMessage: vi.fn(), disconnect: vi.fn(),
    onMessage:{addListener:(listener:any)=>messages.add(listener),removeListener:(listener:any)=>messages.delete(listener)},
    onDisconnect:{addListener:(listener:any)=>disconnects.add(listener),removeListener:(listener:any)=>disconnects.delete(listener)}
  };
  const closed=vi.fn();
  const client=new CliNativeClient(()=>port as any,closed);
  const reply=(reply:unknown)=>messages.forEach(listener=>listener(reply));
  const ready=async()=>{const pending=client.request({op:'hello'});reply({id:1,ok:true,data:{protocol:2,version:'1.0.101',integration_revision:2,capabilities:['snapshots','mutation_receipts'],databases:[]}});await pending;port.postMessage.mockClear();};
  return {client,port,closed,reply,ready};
}
afterEach(()=>vi.useRealTimers());
describe('CLI Native Messaging human manager',()=>{
  it('bounds UTF-8 input before sending it to the native host',async()=>{
    const {client,port,ready}=fixture();await ready();
    await expect(client.request({op:'create_password',fields:'密'.repeat(30000)})).rejects.toMatchObject({code:'input_too_large'});
    expect(port.postMessage).not.toHaveBeenCalled();client.close();
  });
  it('uses matching request IDs and never retries mutations',async()=>{
    const {client,port,reply,ready}=fixture();await ready();
    const result=client.request({op:'create_password',fields:'synthetic-secret'});
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    reply({id:2,ok:true,data:{saved:true}});
    await expect(result).resolves.toEqual({saved:true});client.close();
  });
  it('rejects concurrent operations and clears pending requests when closed',async()=>{
    const {client,port,ready}=fixture();await ready();
    const pending=client.request({op:'snapshot'});
    await expect(client.request({op:'delete'})).rejects.toMatchObject({code:'busy'});
    const rejection=expect(pending).rejects.toMatchObject({code:'closed'});client.close();await rejection;
    expect(port.disconnect).toHaveBeenCalledOnce();
  });
  it('fails closed on wrong IDs instead of accepting stale responses',async()=>{
    const {client,reply,closed,ready}=fixture();await ready();const pending=client.request({op:'snapshot'});
    const rejection=expect(pending).rejects.toMatchObject({code:'invalid_reply'});
    reply({id:99,ok:true,data:{}});await rejection;expect(closed).toHaveBeenCalled();
  });
  it('bounds waiting and does not retry an unknown write outcome',async()=>{
    vi.useFakeTimers();const {client,port,ready}=fixture();await ready();const pending=client.request({op:'delete'});
    const rejection=expect(pending).rejects.toMatchObject({code:'timeout'});await vi.advanceTimersByTimeAsync(70000);await rejection;
    expect(port.postMessage).toHaveBeenCalledTimes(1);expect(port.disconnect).toHaveBeenCalledOnce();
  });
  it('returns only fixed error codes without reflecting secret-bearing errors',async()=>{
    const {client,reply,ready}=fixture();await ready();const pending=client.request({op:'unlock'});
    const rejection=expect(pending).rejects.toEqual(new CliError('operation_failed',true));
    reply({id:2,ok:false,error:'sensitive material with spaces'});await rejection;client.close();
  });
  it('blocks unlock and writes until a supported host negotiates',async()=>{
    const {client,port}=fixture();await expect(client.request({op:'unlock'})).rejects.toMatchObject({code:'host_not_negotiated',sent:false});expect(port.postMessage).not.toHaveBeenCalled();
    for(const value of [{protocol:1,version:'1.0.101'},{protocol:2,version:'1.0.100',integration_revision:2,capabilities:['snapshots','mutation_receipts'],databases:[]},{protocol:2,version:'1.0.101',integration_revision:2,capabilities:['snapshots'],databases:[]}])expect(()=>validateHello(value)).toThrow();
  });
  it('rechecks negotiation after a disconnect and marks sent writes unknown',async()=>{
    const {client,port,ready}=fixture();await ready();const pending=client.request({op:'create_category',operation_id:'synthetic-id'});
    const result=expect(pending).rejects.toMatchObject({sent:true});client.close('host_exited');await result;
    await expect(client.request({op:'snapshot'})).rejects.toMatchObject({code:'host_not_negotiated'});expect(port.postMessage).toHaveBeenCalledTimes(1);
  });
});
