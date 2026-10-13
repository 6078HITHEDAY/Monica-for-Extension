# Nearby JSON preservation — 2026-10-14

This extends the internal transport foundation in `nearby-native-transport-319.md`.
Nearby synchronization is still not connected to vault adoption or manager UI.
Android sources and user vaults were not modified.

The real Edge acceptance found two distinct serialization defects: Chromium parses
Native Messaging numbers before extension JavaScript sees them; Rust serde can
interpret literal `$serde_json::private::Number` and `RawValue` object keys as its
own internal tags. Serde value-building can also normalize negative zero and
exponent spelling. An invalid marker value failed the original real native test.

The Native Host transport capability is now version 2. Small replies carry a JSON
string; large replies keep the bounded, hashed byte chunks. Inputs containing
genuine lossless numeric tokens use the byte path even when small. Ordinary unsafe
JavaScript integers and older Hosts are rejected. Invalid reply details stay
sanitized. The escaped reply envelope is included in the size limit.

The pinned Android LAN core has an explicit extension-only parsing overlay.
Containers are parsed as raw members, number tokens are validated before preserving
their spelling, and replica record deserialization and response construction avoid
serde marker interpretation or number re-parsing. The encrypted replica and Noise
wire formats remain unchanged. `LAN-PROVENANCE.json` retains all original upstream
hashes, records the patch and resulting hashes, and is checked by the Host verifier.
This is not a claim that Android's current application accepts every opaque field.

Validation:

- 19 transport TypeScript tests, 81 full Host tests, and 36 LAN core tests passed.
- Project and interop types, production build, Host provenance, Clippy with warnings
  denied, and the 218-command runtime security audit passed.
- Installed Edge 155.0.4283.45: actual Native Messaging and Noise transfer, a large
  password project, a 600,000-byte attachment, encrypted pending state across full
  browser/Host restart, trusted retry, and synthetic adoption passed in 15 seconds.
- `9007199254740993`, `1.00000000000000001`, `1e999`, `-0`, `__proto__`, and literal
  serde marker fields survived. The original Passkey key still verified against
  its original public key. Zero and positive counters remained 0 and 19; positive
  credentials stayed at the source under the existing sending policy.

Evidence is local under `.artifacts/nearby-v2-*20261014*`. Test profiles were closed
and temporary Native Messaging registration restored. No real accounts, Android
runtime, user Chrome, release, tag, or push was involved.
