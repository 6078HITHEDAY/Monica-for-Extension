# Android Wi-Fi metadata attachment gap — 1.0.320

Read-only inspection on 2026-10-15. This is a source finding, not a completed Android fix or device acceptance.

## Reproducing path

1. Send a folder or vault-metadata record with an `assets` descriptor and its authenticated file bytes.
2. `DevicePasswordSyncProvider.apply` sends local root metadata directly to `DeviceRoomVaultMetadata.applyRootMetadata`; folders go to `applyLocalFolder`.
3. Both save JSON without calling `readIncomingAsset` or persisting the file. Root snapshots and folder snapshots have empty `DevicePasswordSnapshot.assets`, so the next export cannot include those bytes.
4. Native Android has the same gap: `Mdbx2Repository.applyDeviceSyncPassword` returns from the root/folder branches before its object attachment handler. Native folder exports reconstruct only title/path/tags, losing other folder fields. `DeviceNativeRootMetadata.apply` also reconstructs markers without the additional ownership fields.

Affected paths in `Monica-main/Monica for Android/app/src/main/java/takagi/ru/monica/`:

- `lansync/DevicePasswordSyncProvider.kt`: root/folder apply and snapshot construction.
- `lansync/DeviceRoomVaultMetadata.kt`: encrypted metadata persistence without attachment storage.
- `lansync/DeviceNativeRootMetadata.kt`: root ownership and marker preservation.
- `repository/Mdbx2Repository.kt`: native folder/root export and atomic adoption.

## Proposed repair scope

Preserve standalone labels, folder/root wire extensions and file bytes in both local Room and native MDBX storage. Partition root files/labels by source owner. Validate hash/size before committing, store local bytes encrypted, retain original portable attachment IDs, and include actual byte sources on later exports. Native updates must use the existing composite transaction. Omitted asset lists preserve existing files; explicit empty lists remove only the selected owner's files. Test deletion, restoration, rollback, restart and forwarding to a third device. Apply the same LAN-only fixes to ordinary Android and F-Droid without adding cloud/Play dependencies.

Passkey signing, credential IDs, original key material and counter policy are outside this repair. No APK delivery or release is required.

## Authorization boundary

The existing task SPEC limits Android production changes to the earlier Passkey repair and says: “Other Android changes remain outside this authorization.” On 2026-10-15 the user explicitly assigned this Android repair to the main Android chat (`01a12386-524e-7331-a939-c0b208cf5ade`). The repair request and contract were sent there; that chat confirmed the assignment and started work. This extension chat does not edit Android production files.

## Additional native deletion limit

Actual bundled MDBX testing reproduced `DeleteProject` rejecting a folder that still owns active attachments. The storage `ensure_project_empty` check enforces this. A retained folder attachment cannot be safely supported merely by saving a descriptor or deleting the file first. The extension currently rejects this operation before staging an encrypted native intent (`native-folder-attachment-trash-unavailable`), preserving the original revision. Native folder attachment trash/restore remains unfinished. This limitation was also sent to the Android chat. Root metadata trash/restore and owner-isolated root purge were verified separately.
