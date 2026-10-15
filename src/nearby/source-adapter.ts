import type { SecureVaultService } from '../security/secure-vault-service';
import type { NearbyIncomingRecord, NearbyLocalBatch } from './local-adoption';
import type { NearbyAcknowledgement } from './native-journal';
import type { NearbyWireData } from './wire-shape';
import { base64ToBytes } from '../security/encoding';

export interface NearbySourceSnapshot {
  sourceHash: string;
  records: { local_id: string; global_id: string; scope: string; guard: string; deleted: boolean; data: NearbyWireData | Record<string, never> }[];
  readAsset: (id: string) => Promise<Uint8Array>;
}
export interface NearbySourceAdapter {
  scope: string;
  /** Native recovery must refresh guards through a complete scan before adoption. */
  native: boolean;
  capture(): Promise<NearbySourceSnapshot>;
  snapshotHash(): Promise<string>;
  recover(expectedOperationId?: string): Promise<NearbyAcknowledgement[]>;
  saved(records: readonly NearbyIncomingRecord[]): Promise<NearbyAcknowledgement[]>;
  groups(records: readonly NearbyIncomingRecord[]): Promise<Array<[string, string]>>;
  adopt(batch: NearbyLocalBatch): Promise<{ sourceHash: string; acknowledgements: NearbyAcknowledgement[] }>;
}
export function localNearbySource(store: Pick<SecureVaultService, 'captureNearbyLocalRecords' | 'nearbyLocalSnapshotHash' | 'nearbySavedAcknowledgements' | 'nearbyPendingPasswordGroups' | 'adoptNearbyLocalTransaction'>,
  sessionId: string, assertActive: () => void): NearbySourceAdapter {
  return {
    scope: 'local', native: false,
    async capture() {
      const source = await store.captureNearbyLocalRecords();
      return { sourceHash: source.sourceHash, records: source.records, async readAsset(id) {
        const asset = source.assets.find(a => a.id === id); if (!asset) throw new Error('Nearby source asset missing');
        return base64ToBytes(asset.dataBase64);
      } };
    },
    snapshotHash: () => store.nearbyLocalSnapshotHash(), recover: async () => [],
    saved: records => store.nearbySavedAcknowledgements(records, sessionId),
    groups: records => store.nearbyPendingPasswordGroups(records, sessionId),
    adopt: batch => store.adoptNearbyLocalTransaction(batch, sessionId, assertActive)
  };
}
