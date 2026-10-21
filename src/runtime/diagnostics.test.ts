import { expect, it } from 'vitest';
import { diagnosticReport } from './diagnostics';
import { runtimeInfo } from './version';
it('exports only whitelisted status and rejects untrusted version text',()=>{
  const report=diagnosticReport({...runtimeInfo,version:'https://private.test/token'}, {availability:'ready',runtimeBackend:'browser',message:'secret path',capabilities:{hostVersion:'../../private'}} as never, {native:{available:true,supported:true,reason:'private'},vaultEnrolled:true,bindingConsistent:true,bindingId:'secret'} as never);
  const json=JSON.stringify(report);
  expect(json).not.toMatch(/private|secret|https|bindingId/);
  expect(report.background?.compatible).toBe(false);
  expect(diagnosticReport(runtimeInfo).background?.compatible).toBe(true);
});
