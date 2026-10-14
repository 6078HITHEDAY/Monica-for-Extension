# Wi-Fi native metadata and attachments — 2026-10-15

This checkpoint completes browser-side standalone labels and live folder/root attachment adoption. The overall Wi-Fi task remains open. Android folder/root byte adoption is being handled in the main Android chat at the user's request.

## Behavior

Unassigned labels are projected through wire `labels` without parsing away their JSON number lexemes. Ordinary object assignments keep their existing ownership. Root records share a native collection, so each source's labels and attachments are partitioned by the existing root marker's `label_ids` and `device_sync_assets`; unclaimed native content belongs to the vault's own root. Different owners may share a staged byte buffer for identical content but receive distinct mutable native file identities.

Folder metadata uses `monica-device-folder-data-v1`, retaining wire data and attachment mappings. Current native titles/path/tags and labels take precedence while unknown folder, payload and path-node fields survive. Files use the same validated, bounded, atomic adoption writer as object attachments. Renaming or replacing a file keeps its existing native and portable IDs where it still exists. Omitted lists preserve files, explicit lists reconcile only the chosen owner, and root purge removes only that root's contents. Retained root trash preserves its content separately from purge.

Before staging an intent, the planner rejects duplicate portable attachment IDs, malformed native label/relation JSON, reserved ownership-marker injection, zero native payload schema versions, conflicting root ownership and malformed/future folder markers. Errors contain no payload excerpts.

## Acceptance

- 277 affected TypeScript tests across 15 files passed with two workers. Main, interop and strict affected E2E/worker type checks passed.
- Production build, bundled engine provenance and security audit passed: 219 runtime commands, 24 project commands and the dedicated nearby manager port. Native sources/WASM were unchanged; no native rebuild was needed for this checkpoint.
- Four real Edge scenarios passed in 54.8 seconds: native adoption and original journal replay after restart (5.1s), native catalog (4.1s), production local/bundled-MDBX coordinator (35.1s), and metadata assets (7.8s).
- The new asset case used two actual native vaults and the real encrypted local adoption/capture path. Two 280,000-byte folder/root files shared content; a folder file was replaced by 180,000 bytes and renamed. Native → local → native forwarding, actual browser restart, hashes, original attachment IDs, exact label numbers and unknown folder fields passed. Root retained trash/restoration and purge/restoration did not alter the other root owner's label or the folder attachment. Synthetic plaintext scans of encrypted storage passed.
- Production coordinator regression retained 142 items, a 40-record password group, original Passkey signature/counter zero, 600,000-byte object attachment trash/restoration, repeated sync without new writes and two-listener discovery. The independent journal test retained original signing counter 19.

Logs: `.artifacts/nearby-metadata-assets-consolidated-final.log`, `nearby-metadata-assets-build.log`, `nearby-metadata-assets-e2e-types.log`, `nearby-metadata-assets-security.log`, and `nearby-metadata-assets-edge-final.log`. Per-scenario evidence is under `.artifacts/nearby-metadata-assets-edge-final/`. Five Edge profiles from final acceptance were automatically removed. `dist` was rebuilt; public version 0.1.39 was not republished.

## Failed runs and remaining scope

The first added folder-trash case failed in the actual native writer: `DeleteProject` refuses active attachments. No workaround drops the bytes. An explicit planner rejection now prevents staging an uncommittable intent, and actual revision equality verifies that it performs no write. Folder attachment trash/restoration still requires native support; it is not counted as a passing feature. The failed run is retained in `nearby-metadata-assets-edge-hardening.log`. An intermediate unit fixture had both malformed marker data and duplicate ownership; it was corrected to isolate the ownership assertion after marker validation was added.

Remaining work includes that native folder-deletion boundary, collection profiles, unsupported native content/schema archives, Android/F-Droid folder/root byte adoption and their application/UI/multicast acceptance. Wider backend/OneDrive parity remains separate. Existing denied cache deletions were not retried. The main Android chat owns Android changes; this checkpoint changes no Android sources or emulator state.
