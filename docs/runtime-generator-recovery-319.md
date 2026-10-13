# Runtime startup and generator slider recovery

Validated 2026-10-14, extension development version 0.1.37.

The UI previously surfaced Chromium's `Could not establish connection. Receiving end does not exist.` when its first runtime version probe failed. The client now shares a bounded recovery sequence for the secret-free version probe (100/250/500/1000/2000 ms delays). A status read losing its receiver also rechecks the runtime and retries once. Authentication, writes, OTP counters and interactive prompts are never replayed. Version mismatches and invalidated extension contexts still require reload; persistent connection failure has a localized message. This verifies recovery of the reported failure mode; it does not establish which browser lifecycle event caused the user's original incident.

All three generator sliders passed string-valued min/max/step properties through Vue's custom-element binding. M3E 2.6.1's track calculation adds the minimum; a click at 80% produced 484 instead of 52 because `48 + "4"` concatenated. Dragging uses a different clamping path. Explicit numeric property bindings fix password length, word-password length and segment length, including keyboard controls.

Validation:

- 80 affected unit tests across five files passed: runtime compatibility/recovery/no mutation replay, generator, preferences and locale catalogs. Seven new recovery cases plus the initial reproduction were added.
- Installed Edge 155.0.4283.45, isolated profiles: production-dist generator test passed (3.8 seconds). Actual clicks, drag, Home/End/ArrowRight, generation length, remount/reload persistence, 375px viewport and reduced-motion operation covered.
- Installed Edge, minimal extension bundling the production UI client: actual message listener temporarily removed, exact Chromium error confirmed, startup/status/unlock recovered. Exactly one unlock received. Passed (3.8 seconds). This harness tests the client and real messaging, not the complete production worker's startup timing.
- Project/interop build, strict new E2E types and 218-command security audit passed. `dist` rebuilt. Existing pending nearby protocol work remains separate and is not certified by this batch.
- Local editable M3E Canvas: `docs/design/generator-slider-319.m3e.json` and `.md`; Canvas and production rendering inspected. Local drawings/screenshots excluded from Git.

Evidence in `.artifacts`: `runtime-before-20261013.log`, `slider-repro-20261013.log`, `interaction-unit-20261014.log`, `interaction-build-final-20261013.log`, `interaction-security-20261014.log`, `interaction-e2e-types-20261014.log`, `interaction-edge-final-20261014/`, `slider-edge-verified-20261014/`. Earlier failed attempts retained: environment memory exhaustion before interaction; an E2E JSON import requiring a Node import attribute; an exact navigation label omitting the displayed count. These were not product failures or passes. The icon subset was refreshed after the scanner detected a symbol-like string in pending nearby wire code; no CDN or network font added.

MDBX without a separately installed component remains unfinished. The current engine uses `rusqlite` with bundled SQLite, filesystem/WAL/sidecars, and UniFFI; no browser/WASM feature or engine exists in the pinned source. A browser worker engine must preserve the same format/crypto and provide durable storage and atomic export before Native Host can become optional for database operations. Shipping the EXE inside the extension would not satisfy that requirement. Windows Hello and raw LAN transport are separate platform capabilities and cannot be silently represented as browser-supported APIs.
