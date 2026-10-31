# Phone hotspot LAN discovery

Date: 2026-10-29. Unreleased native host changes.

The shared native discovery layer now sends probes to directed broadcasts reported by actual private IPv4 interfaces. It keeps multicast and known-address discovery, limits the candidate count and discovery window, and does not scan a subnet or send to the global broadcast address. Discovery replies remain hints; the subsequent Noise handshake verifies the device before vault transfer.

Verification:

- Vendored LAN transport: 37 native tests passed, including actual directed-broadcast discovery with multicast disabled, wrong-identity rejection, encrypted content transfer and receive-only protections.
- The Windows native host Release build passed when run by itself. An earlier run overlapping the Android build exhausted host memory; the serial retry succeeded.
- The directed-broadcast test ran on the host's existing private IPv4 interfaces. No two-device wireless phone-hotspot test was performed.

Android's additional foreground UDP presence and per-socket Wi-Fi network binding are implemented in the Android distributions. The browser host changes here cover native directed-broadcast discovery. Existing pairing, encryption and confirmation requirements remain in effect. No extension publication, repository push or installer delivery was performed.

## 2026-10-30 build provenance completion

The already implemented hotspot sources initially failed the extension's full build because the LAN provenance record had not been updated. The verifier was kept enabled. `extension-lan-hotspot.patch` now records the existing four modified files and new `network.rs`; the original HEAD source hashes were checked against the old record, and reverse patch application passed `--check`.

The host verifier now validates the explicitly recorded added-file hashes and the complete vendored source inventory. Negative controls proved that an altered network source and an unrecorded source file are rejected; both controls were then restored. The WASM source inventory is unchanged and its existing verification passed. All **37 native LAN tests** passed again in 8.70 seconds, and the complete extension build and asset checks passed. This completes provenance for the earlier implementation; it does not add a two-device wireless-hotspot result.
