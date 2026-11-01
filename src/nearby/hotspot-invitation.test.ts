import { describe, expect, it } from 'vitest';
import { parseNearbyHotspotInvitation as parse } from './hotspot-invitation';
const encode = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pairing = `monica-lan:2:192.168.43.1:43210:${'a'.repeat(43)}`;
const envelope = (ssid = 'Monica 测试', password = 'synthetic-only', link = pairing) => `monica-hotspot:1:${encode(ssid)}:${encode(password)}:${encode(link)}`;
describe('Android hotspot invitation envelope', () => {
  it('decodes the exact v1 UTF-8 envelope and retains only the enclosed LAN authentication link', () => {
    expect(parse(` ${envelope()}\n`)).toEqual({ ssid: 'Monica 测试', passphrase: 'synthetic-only', pairing });
  });
  it.each([
    envelope('字'.repeat(11)), envelope('line\nfeed'), envelope('valid', 'short'), envelope('valid', '密码密码密码密码'),
    envelope('valid', 'synthetic-only', pairing.replace(':2:', ':1:')), envelope('valid', 'synthetic-only', pairing+'\n'),
    envelope()+'=', envelope().replace(':1:', ':2:'), 'monica-hotspot:1:_w:c3ludGhldGljLW9ubHk:'+encode(pairing),
    'monica-hotspot:1:'+encode('valid')+':'+encode('x'.repeat(64))+':'+encode(pairing),
  ])('rejects malformed, padded, invalid UTF-8, unsupported and oversized credentials without network access', value => {
    expect(parse(value)).toBeUndefined();
  });
  it('does not interpret an ordinary LAN invitation as Wi-Fi credentials', () => { expect(parse(pairing)).toBeUndefined(); });
});
