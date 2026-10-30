import { describe, expect, it, vi } from "vitest";
import {
  assertMdbx2TransferOperationId,
  mdbx2TransferOperationScope,
  mdbx2TransferUuid
} from "./mdbx2-transfer-identity";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

describe("MDBX2 transfer identities", () => {
  it.each([false, true])('clears the encoded secret snapshot after hashing (failure=%s)', async fail => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let retained: Uint8Array | undefined;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      retained = data as Uint8Array;
      if (fail) throw new Error('synthetic digest failure');
      return digest(algorithm, data);
    });
    try {
      const result = mdbx2TransferOperationScope({ password: 'synthetic snapshot secret' });
      if (fail) await expect(result).rejects.toThrow('synthetic digest failure'); else await result;
      expect(retained!.length).toBeGreaterThan(0);
      expect(retained!.every(value => value === 0)).toBe(true);
    } finally { spy.mockRestore(); }
  });
  it("derives stable standard UUIDv5 identities", async () => {
    const first = await mdbx2TransferUuid(OPERATION_ID, "item:source-1");
    const repeated = await mdbx2TransferUuid(OPERATION_ID, "item:source-1");
    const second = await mdbx2TransferUuid(OPERATION_ID, "item:source-2");

    expect(first).toBe(repeated);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(second).not.toBe(first);
  });

  it("hashes canonical operation data into the Native Client scope", async () => {
    const left = await mdbx2TransferOperationScope({ operationId: OPERATION_ID, input: { b: 2, a: 1 } });
    const right = await mdbx2TransferOperationScope({ input: { a: 1, b: 2 }, operationId: OPERATION_ID });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects non-standard operation IDs and non-canonical values", async () => {
    expect(() => assertMdbx2TransferOperationId("transfer:1")).toThrow("标准小写 UUID");
    await expect(mdbx2TransferOperationScope({ value: Number.NaN })).rejects.toThrow("无效数字");
  });
});
