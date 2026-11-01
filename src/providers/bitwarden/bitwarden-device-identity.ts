/** An installation identifier, never a credential. Persist before requesting a device-bound OTP. */
export const BITWARDEN_DEVICE_ID_KEY = "monica_bitwarden_device_id_v1";

interface DeviceIdentityStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export class BitwardenDeviceIdentity {
  private pending?: Promise<string>;

  constructor(private readonly storage: DeviceIdentityStorage, private readonly createId = () => crypto.randomUUID()) {}

  get(existing?: unknown): Promise<string> {
    // Keep the identity already associated with a connected account, including legacy identifiers.
    if (typeof existing === "string" && existing.trim()) return Promise.resolve(existing);
    this.pending ??= this.load().catch(error => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }

  private async load(): Promise<string> {
    const stored = (await this.storage.get(BITWARDEN_DEVICE_ID_KEY))[BITWARDEN_DEVICE_ID_KEY];
    if (typeof stored === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stored)) return stored;
    const id = this.createId();
    await this.storage.set({ [BITWARDEN_DEVICE_ID_KEY]: id });
    return id;
  }
}
