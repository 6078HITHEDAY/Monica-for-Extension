# Native nearby object adoption

Verified 2026-10-14 against the bundled browser engine. This completes the
supported-object planner, not the production nearby coordinator or user entry
point. Android sources and the native engine were unchanged.

`src/nearby/native-adoption.ts` turns authenticated pending records into one
revision-guarded `content.write` transaction. It checks the source snapshot,
per-record binding and guard, record type, clocks, target identities and resolved
references before returning a writable plan. New non-UUID record identities get
a deterministic native UUID; returned bindings retain the portable record ID.
An existing native object is never matched by title or overwritten without its
authenticated binding.

The plan combines parent-first folder creation, object create/update/move,
labels and assignments, relations, attachment replacement/rename and deletion.
Relations are created after their target records. Shared labels remain in use;
obsolete private label copies are removed after unassignment. A move with an
omitted label list preserves the exact labels in the new collection. Folder
deletions are ordered after object operations.

Passwords keep expanded fields and history. Passkey merging verifies identity
and public-key compatibility, retains the original private key and credential
strings, preserves intentional zero counters and never lowers positive history.
Incoming reference-only metadata cannot erase a matching local portable key.
Retained trash is distinct from purge; inaccessible existing deleted payloads
are rejected rather than overwritten without comparison.

Attachment bytes are checked against size and SHA-256 before staging, with
64 MiB total bytes/copies and 64 attachment-command limits. Portable attachment
IDs and unknown descriptor fields survive replacements. Known image references
map to the new native attachment identity; password strings are untouched.
Omitted assets preserve existing attachment mappings. Plans own their decoded
byte buffers and clear them on failure or explicit disposal. They are never
written to a plaintext staging file.

The record projection now uses `storedSize` for current content length.
`originalSize` is creation metadata retained by the native engine after a
replacement, so different values are valid. The native source inventory still
retains both. Native disclosure continues to verify bytes, content hash,
ownership and revision.

## Acceptance

- Consolidated affected run: 169 tests in nine files. Three later regressions
  added size-replacement and omitted label/asset coverage; 172 distinct cases
  passed overall. Final affected run: 61 tests in three files.
- Actual Edge 155.0.4283.45: final scenario passed in 8.3 seconds, 12.3 seconds
  including runner. Created a password project, linked note and portable
  Passkey; retained precise label/relation payloads and a 280,000-byte attachment.
  Moved the project, replaced its attachment with 180,000 bytes under the same
  native and portable identity, renamed it and retained unrelated content.
- Deliberately invalid native content returned an uncertain-outcome error;
  independent recapture showed an unchanged revision. A stale plan was refused.
  After a real browser restart, replay of the original transaction returned its
  original durable receipt without reverting the later update.
- Original Passkey key/credential bytes still produced a valid signature with
  counter 19 after reference-only input carrying counter zero. Unit coverage
  separately checks deliberate counter zero. Persisted block scanning found no
  synthetic password, key or protected-field sentinels.
- Final projections contained no blockers for this accepted dataset. Engine
  attachment downloads confirmed the replacement hash and owner.
- Main/interop and strict E2E/worker types, production build, bundled provenance
  and static security audit passed: 219 runtime commands, 24 manager-only
  project commands, plus the nearby manager port. No native rebuild was needed.
- Test profiles were automatically deleted after each run. Existing personal
  browser profiles, accounts, databases and Android installations were untouched.

The initial real-browser run exposed the incorrect original/current attachment
size check; the initial final-build attempt exposed a test-helper optional-field
typing issue. Both failures and subsequent passing logs remain in
`.artifacts/nearby-native-adoption-*.log`. Final browser evidence is in
`.artifacts/nearby-native-adoption-edge-closeout/*/isolated/evidence.json`.

```text
npx vitest run src/nearby src/providers/mdbx2/content-write.test.ts --maxWorkers=2
npx vitest run src/nearby/native-adoption.test.ts src/nearby/native-records.test.ts src/nearby/native-metadata.test.ts --maxWorkers=2
npm run build
npx tsc -p .artifacts/nearby-native-adoption-e2e.tsconfig.json --pretty false
node scripts/security-audit.mjs
npx playwright test tests/e2e/nearby-native-adoption.spec.ts --workers=1
```

## Still required

The planner returns bindings, not synchronization acknowledgements. Persist the
exact encrypted operation intent, recover uncertain native outcomes, validate
the adopted state and save acknowledgements before connecting it to the
production coordinator. Do not recompute a different operation after an
uncertain finish. Full native archives/unsupported types, retained deleted
payload policy, metadata assets, title-only legacy folder paths and complete
folder profiles remain unfinished. Unknown top-level fields without a native
representation are refused, not silently dropped. The existing 16 MiB encoded
core delta limit also remains in force. Nearby UI/scheduling and actual current
Android/F-Droid/backend acceptance are still pending; no release was published.
