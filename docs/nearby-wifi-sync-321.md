# Nearby Wi-Fi sync — user-facing integration and Android rendezvous fix

Follows [Nearby production manager ownership](nearby-manager-owner-320.md). That block left nearby with no user-facing page; this block adds the manager page and fixes the connection failures that made Wi-Fi sync with Android unreliable. Android reference: `Monica-Pass/Monica` `21c4d09e8771eee65b82d0fae6404cd1a487f0d9`; its `rust-lan-sync` sources are byte-identical to the vendored core apart from the existing lossless-JSON overlay, so the wire protocol is unchanged.

## Root causes

1. **Both sides listened.** Android's `DeviceSyncCoordinator.maintainConnections` listens when `settings.deviceId > peer.deviceId` and otherwise discovers the peer and dials it. The extension coordinator always listened unless the (non-existent) UI passed an endpoint. Whenever the phone had the greater ID, both devices waited for each other until timeout.
2. **Lost error causes.** `run()` collapsed transport and native-host failures (missing helper, refused connection, listener failure) into `operation-failed`, and failed native progress into `transfer-failed`. Users could not tell what to fix.
3. **Fragile pairing input.** Pasted invitations with whitespace or a trailing newline were rejected as `invalid-peer`; a v1 invitation produced the same opaque code; a host with no private IPv4 interface produced an empty pairing view.
4. **Advertisement mismatch.** The Host advertised the bare snapshot revision. Android parses `revision:settings_version:settings_writer:sync_request` from discovery offers to notice settings changes and explicit sync requests.

## Changes

- `local-coordinator.ts`: mirror Android's role rule. When dialing, run native `discover` (multicast plus a unicast probe to the peer's last authenticated address, which survives Wi-Fi access points that filter multicast), accept only offers whose `device_id`, `session` (pair ID) and `trusted` flag match the saved pairing, and connect using the saved trusted key. Up to three discovery rounds; then `peer-not-found`. Endpoints are capped at the engine's eight-address limit (also in the manager contract).
- Keep fixed engine/host codes via `nearby/errors.ts` (`native-host-not-installed`, `connection-failed`, `listen-failed`, …). Only constant identifiers pass; messages, paths and secrets never do.
- Trim invitations, report `unsupported-protocol` for v1 links and `no-local-network` when there is no reachable interface. Expose native stage and byte counters (`view.transport`) and the connection role for progress display.
- Preferences: optional `address` per saved peer (private IPv4 only, never in the view). New browser identities start with `00`, so against Android's UUID-hex IDs the browser nearly always dials: syncing then needs only outbound connections and no inbound firewall exception. Existing IDs are kept because pairings are bound to them; both roles still work.
- Native Host `nearby.rs`: advertise `revision:settings_version:settings_writer:sync_request` like Android. The device hello and wire format are unchanged.
- Manager page (`NearbySyncPanel.vue`, settings entry “附近设备同步 / Nearby sync”): connection state, pairing QR plus copyable link, pasted-link pairing, paired devices with Sync now / Remove, sync direction, shared frequency, device name, explicit restricted-Passkey review, progress with cancel, actionable error/closed-lease messages, and in-page troubleshooting. `manager-client.ts` speaks the existing `monica-nearby-manager-v1` port; no new runtime commands or raw fields were added.
- Optional automatic rounds run only while the page holds the lease (the existing ownership model). Unreachable phones are retried quietly every 30 s, so tapping Sync now on the phone is picked up without touching the browser; restricted Passkeys still require an explicit confirmation.
- Strings for all eight interface languages.

## Validation (this environment)

- 156 nearby unit tests in 9 files (coordinator, owner, preferences, application codec, transport, Passkey material and the new manager client); the full suite passes 3,711 tests in 302 files. New tests cover both roles, discovery filtering of untrusted/other-pair/public offers, remembered-address probing, native failure codes, native-host/engine error mapping, invitation trimming, v1 links and missing interfaces.
- Host: 12 nearby tests including a new real-UDP discovery test asserting the Android-format advertisement. The full Host suite passes except `windows_hello::status_reports_a_damaged_binding_and_missing_revoke_is_idempotent`, which fails identically on the unmodified tree on Linux; Clippy reports only the existing Windows-only dead-code constants on Linux.
- Project/interop types, icon inventory, Vite build, worker build, extension page verification and the security audit (including the nearby port ownership audit) pass.
- New `tests/e2e/nearby-manager-ui.spec.ts` drives the real manager page, background owner and Native Messaging path in Chromium with no helper registered: the page connects, rejects an invalid link locally, saves the device name through the encrypted store, shows the missing-helper guidance, and releases/reacquires the lease. It passed locally against the preinstalled Chromium.

## Not verified here / release steps

- No Android device, Edge profile or real network was available, so the Android round trip was not re-run. Before release, repeat the two-profile Edge scenario and an Android `NearbyBrowserInteropTest` round, plus a manual pairing on a real Wi-Fi network.
- `native/mdbx2-host/src` changed, so the bundled browser engine's source inventory is stale: rebuild it with `npm run build:mdbx2-browser` (Emscripten) before `npm run build`. The checked-out `kdbx3-demopass.kdbx.b64` fixture also fails `verify-mdbx2-host` on the unmodified tree in this checkout.
- Android only treats the browser as present for automatic sync through mDNS (`_monica-sync._udp`), which the Host does not publish yet. Until it does, the phone side needs Sync now (or its manual window) for each round; the browser's quiet retry makes this a single tap.
