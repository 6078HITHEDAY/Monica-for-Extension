import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRuntimeCommands } from './runtime-command-audit.mjs';

const files = {
  entry: '../src/background/index.ts', executor: '../src/background/command-router.ts',
  access: '../src/background/request-access.ts', attachments: '../src/background/attachment-runtime.ts',
  sends: '../src/background/bitwarden-send-runtime.ts', sync: '../src/background/provider-sync-runtime.ts', messages: '../src/runtime/messages.ts'
};
const sources = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(new URL(path, import.meta.url), 'utf8')])));

test('all declared commands have exactly one wired handler', () => {
  const result = auditRuntimeCommands(sources);
  assert.equal(result.handlers.size, result.declaredTypes.size);
  assert.ok(result.handlers.size >= 230);
});

for (const [name, key, before, after] of [
  ['default denial', 'executor', 'assertExtensionPage(sender);', 'void sender;'],
  ['native move recovery guard', 'executor', 'await service.assertNoBitwardenMdbxMove(nativeProvider);', 'void nativeProvider;'],
  ['native nearby recovery guard', 'executor', 'await service.assertNoNearbyNativeSequence(nativeProvider);', 'void nativeProvider;'],
  ['manager restriction', 'attachments', 'assertManagerPage(sender);', 'void sender;'],
  ['synchronization manager restriction', 'sync', 'assertManagerPage(sender);', 'void sender;'],
  ['deletion confirmation', 'attachments', 'request.confirmed !== true', 'false'],
  ['attachment return wiring', 'entry', 'if (attachmentHandler) return attachmentHandler', 'if (false) return attachmentHandler'],
  ['internal write executor', 'attachments', 'return executeCommand(request, sender, handler);', 'return handler(request, sender);'],
  ['command coverage', 'attachments', '"PROVIDER_ATTACHMENT_LIST":', '"REMOVED_ATTACHMENT_LIST":'],
  ['duplicate command', 'attachments', '"PROVIDER_ATTACHMENT_LIST":', '"PROVIDER_ATTACHMENT_READ_BEGIN":']
]) {
  test(`fails closed when ${name} is removed, even with the old correct code in a dead function`, () => {
    assert.ok(sources[key].includes(before), `fixture missing ${before}`);
    const broken = { ...sources, [key]: sources[key].replace(before, after) + `\nfunction unusedCorrectCode() { /* ${before} */ }\n` };
    assert.throws(() => auditRuntimeCommands(broken));
  });
}
