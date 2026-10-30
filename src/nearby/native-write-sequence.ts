import { parseLosslessJson } from '../core/lossless-json';
import type { Mdbx2ContentCommand, Mdbx2ContentWriteInput } from '../providers/mdbx2/content-write';
import { mdbx2TransferUuid } from '../providers/mdbx2/mdbx2-transfer-identity';
import { invalidNearby, wireObject } from './wire-shape';

/** One fully validated metadata record, separated at native transaction
 * boundaries. Ownership markers become visible only after all files/profiles
 * exist. The caller must persist the complete sequence before the first write. */
export async function partitionNearbyMetadataWrite(write: Mdbx2ContentWriteInput, existingFileSizes: ReadonlyMap<string, number>): Promise<Omit<Mdbx2ContentWriteInput, 'writeRevision'>[]> {
  const initial: Mdbx2ContentCommand[] = [], profile: Mdbx2ContentCommand[] = [], final: Mdbx2ContentCommand[] = [];
  for (const command of write.plan.commands) {
    if (command.kind.startsWith('object-') || command.kind.startsWith('relation-') || command.kind === 'label-assign' || command.kind === 'label-unassign')
      invalidNearby('native-adoption-limit');
    const marker = (command.kind === 'label-create' || command.kind === 'label-update')
      && ['monica-device-folder-data-v1', 'monica-device-root-tags-v2'].includes(wireObject(parseLosslessJson(command.payloadJson)).kind as string);
    if (marker || command.kind === 'collection-trash') final.push(command);
    else if (command.kind === 'collection-profile-set' || command.kind === 'collection-presentation') profile.push(command);
    else initial.push(command);
  }
  const plans: Mdbx2ContentWriteInput['plan'][] = [
    { commands: initial, attachments: [] }, ...write.plan.attachments.map(attachment => ({ commands: [], attachments: [attachment] })),
    { commands: profile, attachments: [] }, { commands: final, attachments: [] }
  ].filter(plan => plan.commands.length + plan.attachments.length);
  if (plans.length < 2 || plans.length > 68) invalidNearby('native-adoption-limit');
  const assets = new Map(write.assets.map(a => [a.id, a]));
  const result: Omit<Mdbx2ContentWriteInput, 'writeRevision'>[] = [];
  for (const [index, plan] of plans.entries()) {
    const used = new Set<string>(); let copies = 0;
    for (const command of [...plan.commands, ...plan.attachments]) if ('assetId' in command) {
      const asset = assets.get(command.assetId); if (!asset) invalidNearby('native-asset-unavailable');
      used.add(asset.id); copies += asset.bytes.length;
    }
    for (const command of plan.attachments) if (!('assetId' in command)) copies += existingFileSizes.get(command.attachmentId) ?? 0;
    if (copies > 1024 * 1024 || new TextEncoder().encode(JSON.stringify(plan)).length > 32 * 1024) invalidNearby('native-adoption-limit');
    result.push({ operationId: index === 0 ? write.operationId : await mdbx2TransferUuid(write.operationId, `nearby-content-step:${index}`),
      plan, assets: write.assets.filter(a => used.has(a.id)) });
  }
  return result;
}
