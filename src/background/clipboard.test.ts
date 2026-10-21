import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../providers/mdbx2/browser/runtime',()=>({ensureBrowserDocument:vi.fn(async()=>{})}));
import { ClipboardLifecycle } from './clipboard';
import { CLIPBOARD_PENDING_KEY, CLIPBOARD_PREFERENCES_KEY } from '../security/clipboard-lifecycle';
function fixture() {
  const local:Record<string,unknown>={},session:Record<string,unknown>={};
  const area=(data:Record<string,unknown>)=>({get:vi.fn(async(key:string)=>({[key]:data[key]})),set:vi.fn(async(value:object)=>{Object.assign(data,value);}),remove:vi.fn(async(key:string)=>{delete data[key];})});
  const browser={storage:{local:area(local),session:area(session)},permissions:{contains:vi.fn(async()=>true)},alarms:{create:vi.fn(async()=>{}),clear:vi.fn(async()=>true)},runtime:{sendMessage:vi.fn(async()=>({cleared:true}))}};
  const lifecycle=()=>new ClipboardLifecycle(browser as unknown as typeof chrome,()=>100000);
  return {local,session,browser,lifecycle};
}
beforeEach(()=>vi.clearAllMocks());
describe('background clipboard deadlines',()=>{
  it('does not arm by default or after permission revocation',async()=>{
    const f=fixture();await f.lifecycle().arm('a'.repeat(64));expect(f.session).toEqual({});
    f.local[CLIPBOARD_PREFERENCES_KEY]={enabled:true,seconds:30};f.browser.permissions.contains.mockResolvedValue(false);
    await f.lifecycle().arm('a'.repeat(64));expect(f.session).toEqual({});
  });
  it('retains only metadata and resumes an expired deadline in a new worker instance',async()=>{
    const f=fixture();f.local[CLIPBOARD_PREFERENCES_KEY]={enabled:true,seconds:30};
    await f.lifecycle().arm('a'.repeat(64));
    expect(Object.keys(f.session[CLIPBOARD_PENDING_KEY] as object).sort()).toEqual(['digest','expiresAt','id']);
    (f.session[CLIPBOARD_PENDING_KEY] as {expiresAt:number}).expiresAt=99999;
    await f.lifecycle().expire();expect(f.browser.runtime.sendMessage).toHaveBeenCalledWith({type:'MONICA_CLIPBOARD_CLEAR',digest:'a'.repeat(64)});
    expect(f.session).toEqual({});
  });
  it('replaces older deadlines, cancels on disable, and respects permission loss at expiry',async()=>{
    const f=fixture();f.local[CLIPBOARD_PREFERENCES_KEY]={enabled:true,seconds:60};const lifecycle=f.lifecycle();
    await lifecycle.arm('a'.repeat(64));await lifecycle.arm('b'.repeat(64));
    expect(f.session[CLIPBOARD_PENDING_KEY]).toMatchObject({digest:'b'.repeat(64)});
    await lifecycle.expire();expect(f.browser.runtime.sendMessage).not.toHaveBeenCalled();
    f.browser.permissions.contains.mockResolvedValue(false);await lifecycle.expire(true);
    expect(f.session).toEqual({});expect(f.browser.runtime.sendMessage).not.toHaveBeenCalled();
    f.browser.permissions.contains.mockResolvedValue(true);await lifecycle.arm('c'.repeat(64));await lifecycle.cancel();
    expect(f.session).toEqual({});
  });
});
