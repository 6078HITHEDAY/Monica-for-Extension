import { describe, expect, it, vi } from "vitest";
import { BITWARDEN_DEVICE_ID_KEY, BitwardenDeviceIdentity } from "./bitwarden-device-identity";

function fixture(initial?: string) {
  const values: Record<string, unknown> = initial ? { [BITWARDEN_DEVICE_ID_KEY]: initial } : {};
  return {
    get: vi.fn(async () => ({ ...values })),
    set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); })
  };
}

describe("Bitwarden device-bound login identity", () => {
  it("keeps one identity across concurrent login, OTP and email-code requests", async () => {
    const storage = fixture();
    const ids = new BitwardenDeviceIdentity(storage);
    const results = await Promise.all(Array.from({ length: 20 }, () => ids.get()));
    expect(new Set(results).size).toBe(1);
    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(await ids.get()).toBe(results[0]);
  });

  it("preserves the identifier across background-worker restarts", async () => {
    const storage = fixture();
    const first = await new BitwardenDeviceIdentity(storage).get();
    expect(await new BitwardenDeviceIdentity(storage).get()).toBe(first);
    expect(storage.set).toHaveBeenCalledTimes(1);
  });

  it("retains an existing account identity without modifying it", async () => {
    const storage = fixture();
    expect(await new BitwardenDeviceIdentity(storage).get("legacy-device-1")).toBe("legacy-device-1");
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("does not start an unpersisted identity when storage fails and allows explicit retry", async () => {
    const storage = fixture();
    storage.set.mockRejectedValueOnce(new Error("synthetic-storage-failure"));
    const ids = new BitwardenDeviceIdentity(storage);
    await expect(ids.get()).rejects.toThrow("synthetic-storage-failure");
    const recovered = await ids.get();
    expect(await new BitwardenDeviceIdentity(storage).get()).toBe(recovered);
  });

  it("replaces only malformed installation metadata", async () => {
    const storage = fixture("invalid");
    const id = await new BitwardenDeviceIdentity(storage).get();
    expect(id).not.toBe("invalid");
    expect(storage.set).toHaveBeenCalledWith({ [BITWARDEN_DEVICE_ID_KEY]: id });
  });
});
