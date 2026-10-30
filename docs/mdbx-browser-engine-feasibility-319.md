# Bundled MDBX engine feasibility — 2026-10-14

The existing MDBX engine and native operation implementation can run inside an
extension Worker without Native Messaging. This is a verified development probe,
not the production backend: the current extension still requires its Native Host
for MDBX. No user database, Android source, or browser profile was changed.

The experiment compiles the pinned MDBX FFI, storage, and crypto source unchanged.
A small Cargo manifest builds those same FFI sources as an `rlib`, omitting the
Android `staticlib`/`cdylib` artifacts. It reuses the Host's runtime, cloud sync,
local export, and non-Windows Hello implementation. The probe substitutes a
single-owner, memory-only scratch directory adapter and disables native LAN calls.
These substitutions are not a production ownership or capability policy.

Toolchain findings:

- Emscripten 4.0.18, emsdk commit `eb5eb4b3b2b792f44ded198bfe615c985da5be2c`,
  compiler archive SHA-256
  `c80405bd2898051de00869f31568c3217ebc8d9cba33a18f8c01e8bb3c4b4f7b`.
- Browser compilation uses Rust 1.97.0 (`2d8144b7880597b6e6d3dfd63a9a9efae3f533d3`)
  and `wasm32-unknown-emscripten`. The independent native probe uses Rust 1.86.0.
- Rust 1.86.0's prebuilt browser standard library has an incompatible file-stat
  layout with this SDK: a 1,024-byte file was reported as a timestamp and its file
  type was wrong. A tiny reproduction fails on 1.86.0 and passes on 1.97.0.
  The first limited core-only browser result must not be treated as proof that
  the old toolchain is suitable for the full backend.
- UniFFI's provided single-threaded WASM feature is enabled. ES modules, memory
  growth, filesystem support, and `DYNAMIC_EXECUTION=0` are used. A 2 MiB stack with
  overflow checks passes; the default small stack failed the full runtime probe.
- The diagnostic build is 8,344,194 bytes of WASM plus 225,416 bytes of JS. It
  includes profiling names and is not the final shipping size.

Installed Edge 155.0.4283.45 passed all three isolated Worker runs and two complete
browser restarts:

1. Create a synthetic encrypted database; reject a wrong password; import it via
   the unchanged native chunk interface; write a password and an ES256 Passkey
   fixture; lock it; store the resulting encrypted files in one strict IndexedDB
   transaction. The persisted files contain none of the fixture password strings.
2. Close Edge, reload the stored files in a fresh Worker, reject a wrong password,
   reopen the same database, and reveal the same records. Aborting a separate
   IndexedDB write leaves every previously stored file byte unchanged.
3. Export the database bytes to an independent native FFI executable, read the
   password, add a native field, and create a backup. Import those native-produced
   bytes into the browser fixture, restart again, and read the new field.

Each Worker imported the retrieved original Passkey PKCS#8, checked its SHA-256 and
credential ID, and signed a fresh challenge against the original public key.
The original private bytes and intentional zero counter survived both browser
restarts and the native update. This is cryptographic storage interoperability,
not Android Credential Manager or a website WebAuthn acceptance run.

The final evidence is local at
`.artifacts/mdbx-browser-durable-20261014/e2db34f5-2543-4ca0-b4f4-331e7cd94fb5/evidence.json`.
The repeatable development probes remain under
`.codex-tasks/android-interop-315/raw/browser-mdbx-probe/`.
All isolated Edge contexts were closed. No Native Messaging registration was
needed for this experiment.

Production work still required: persistent Worker lifecycle, exclusive storage
ownership, efficient atomic persistence and failure recovery, sender/command
authorization, honest platform capabilities, local/cloud import and export,
safe coexistence or migration of existing Native Host vault handles and pending
operations, and manager integration. The test's whole-tree snapshot approach is
only a feasibility harness and must not become an unbounded write on every click.
Attachments, large vaults, complete failure injection, and existing user migration
need their own production-backend acceptance before the Host dependency is removed.
