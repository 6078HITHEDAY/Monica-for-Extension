import { describe, expect, it } from 'vitest';
import { currentFrameDocument } from './document-target';
const id='12345678-1234-1234-1234-123456789abc';
describe('current navigation document boundary',()=>{
  it('accepts Firefox native current identity without inventing lifecycle state',()=>{
    expect(currentFrameDocument({documentId:id},id,true)).toBe(true);
    expect(currentFrameDocument({documentId:id},id,false)).toBe(false);
    expect(currentFrameDocument({documentId:id,documentLifecycle:'active'},id,false)).toBe(true);
  });
  it.each([true,false])('rejects stale, missing, cached, errored and malformed identities for Firefox=%s',firefox=>{
    for(const frame of [null,undefined,{}, {documentId:'bad'}, {documentId:id,documentLifecycle:'cached'}, {documentId:id,documentLifecycle:'prerender'}, {documentId:id,errorOccurred:true}])
      expect(currentFrameDocument(frame,id,firefox)).toBe(false);
    expect(currentFrameDocument({documentId:id,documentLifecycle:'active'},'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',firefox)).toBe(false);
  });
});
