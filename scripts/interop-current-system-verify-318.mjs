import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.tmp/android-current-system-final-318');
const read = async file => JSON.parse(await readFile(join(out, file), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tags = ['flags-be-true-bs-false', 'flags-be-false-bs-false', 'original-edge-rsa',
  'system-cancel', 'monica-cancel'];
const result = spawnSync(process.execPath, ['scripts/interop-317-android-cm-verify.mjs', ...tags], {
  cwd: root, windowsHide: true, encoding: 'utf8', env: { ...process.env, MONICA_CM_EVIDENCE_DIR: out,
    MONICA_CM_BACKENDS: '0', MONICA_CM_REPAIRS: '0' },
});
assert.equal(result.status, 1, 'Strict RP positive-history rejection must remain visible');
const proofs = JSON.parse(result.stdout);
const acceptance = await read('system-acceptance.json');
assert.deepEqual(proofs, acceptance.proofs);
assert.match(await readFile(join(out, 'instrumentation.log'), 'utf8'), /OK \(1 test\)/);
const unknownRequest = await read('unknown-allow-list-request.json');
assert.deepEqual(unknownRequest.allowCredentials, [{ type: 'public-key', id: 'AAAAAAAAAAAAAAAAAAAAAA' }]);
const unknown = await read('unknown-allow-list-result.json');
assert.equal(unknown.response, undefined);
assert.ok(['android.credentials.GetCredentialException.TYPE_NO_CREDENTIAL',
  'android.credentials.GetCredentialException.TYPE_USER_CANCELED'].includes(unknown.error));
const empty = await read('unknown-empty-proof.json');
assert.equal(empty.noMatchingMonicaEntries, true);
assert.ok(empty.newProviderLines.some(line => line.includes('Resolved passkeys count=0, rpId=passkey-interop.example.test')));
const emptyXml = await readFile(join(out, `${empty.ui}.xml`), 'utf8');
assert.ok(emptyXml.includes('使用其他登录方式'));
const ready = await read('ready.json');
for (const record of ready.records) assert.ok(!emptyXml.includes(record.userName));
const observations = await read('ui-observations.json');
const wrong = observations.find(row => row.tag === 'actual-wrong-password-error');
assert.ok(wrong); assert.ok((await readFile(join(out, wrong.xml), 'utf8')).includes('密码错误'));
const before = await read('before-flags/storage-evidence.json');
const after = await read('after-flags/storage-evidence.json');
const unchangedStages = ['after-wrong-password', 'after-unknown-allow-list', 'final-room'];
for (const snapshot of [before, after, ...await Promise.all(unchangedStages.map(tag => read(`${tag}/storage-evidence.json`)))]) {
  assert.deepEqual(snapshot.integrity, [{ integrity_check: 'ok' }]);
  assert.equal(snapshot.schemaVersion, 80); assert.equal(snapshot.rows.length, 5);
  for (const row of snapshot.rows) assert.match(row.protectedKeyReferenceSha256, /^[a-f0-9]{64}$/);
}
assert.deepEqual((await read('after-wrong-password/storage-evidence.json')).rows, before.rows,
  'Wrong password must not change any recorded identity, flags, counters, usage or key reference');
for (const tag of ['after-unknown-allow-list', 'final-room']) {
  assert.deepEqual((await read(`${tag}/storage-evidence.json`)).rows, after.rows,
    `${tag}: unsuccessful authentication must not mutate credentials`);
}
const expected = JSON.parse(await readFile(acceptance.expectedSource, 'utf8'));
const used = new Set();
for (const proof of proofs.filter(proof => proof.credentialId)) {
  const source = expected.find(row => row.credentialId === proof.credentialId);
  for (const [check, passed] of Object.entries(proof.checks)) {
    if (check !== 'preservedCounterHistory') assert.equal(passed, true, `${proof.tag}: ${check}`);
  }
  assert.equal(proof.count, 0);
  assert.equal(proof.rpAcceptance, source.signCount === 0 ? 'pass' : 'fail');
  assert.equal(proof.checks.preservedCounterHistory, source.signCount === 0);
  const original = before.rows.find(row => row.credential_id === proof.credentialId);
  const final = after.rows.find(row => row.id === original.id);
  // This original Edge fixture predates explicit backup fields. NULL already
  // signs as BE=true/BS=true; require that exact legacy storage representation.
  if (proof.tag === 'original-edge-rsa') {
    assert.equal(original.backup_eligible, null); assert.equal(original.backup_state, null);
    assert.equal(source.backupEligible, true); assert.equal(source.backupState, true);
  } else {
    assert.equal(original.backup_eligible, source.backupEligible ? 1 : 0);
    assert.equal(original.backup_state, source.backupState ? 1 : 0);
  }
  assert.equal(final.sign_count, 0); assert.equal(final.use_count, original.use_count + 1);
  assert.deepEqual({ ...final, sign_count: original.sign_count, use_count: original.use_count }, original);
  used.add(original.credential_id);
}
assert.equal(used.size, 3);
assert.deepEqual(proofs.filter(proof => proof.credentialId).map(proof => proof.flags).sort((a, b) => a - b), [5, 13, 29]);
for (const row of before.rows.filter(row => !used.has(row.credential_id))) {
  assert.deepEqual(after.rows.find(final => final.id === row.id), row);
}
for (const proof of proofs.filter(proof => !proof.credentialId)) assert.equal(proof.rpAcceptance, 'pass', proof.tag);
const baseline = await read('baseline.json');
for (const entries of [baseline.sourceHashes, baseline.testSources, baseline.evidenceFiles]) {
  for (const [file, expectedHash] of Object.entries(entries)) assert.equal(hash(await readFile(file)), expectedHash, `Changed: ${file}`);
}
assert.equal(hash(await readFile(baseline.app)), baseline.appSha256);
const verification = { checkedAt: new Date().toISOString(), status: 'passed-with-documented-counter-limitation',
  actualSystemSignatures: 3, flags: [5, 13, 29], zeroCounterSignaturesAccepted: 2,
  wrongPasswordNoMutation: true, allowListRejectsUnknown: true, systemAndMonicaCancelNoMutation: true,
  unknownRequestResult: { providerReturnedZeroEntries: true, platformError: unknown.error,
    platformAlternateDevicePromptDismissed: true },
  preservedAllFiveIdentitiesAndKeyReferences: true, androidSourcesUnchanged: true, androidZeroCounterPolicyUnchanged: true,
  fullRpAcceptance: false, positiveHistoryLimitation: 'Original count43 -> deliberate Android count0; strict RP rejection retained',
  originalAcceptanceSha256: hash(await readFile(join(out, 'system-acceptance.json'))) };
await writeFile(join(out, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
console.log(JSON.stringify(verification, null, 2));
