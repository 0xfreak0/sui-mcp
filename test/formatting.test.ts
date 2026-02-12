import { describe, it, expect } from "vitest";
import {
  formatOwner,
  formatGas,
  formatStatus,
  bigintToString,
  timestampToIso,
} from "../src/utils/formatting.js";
import { GrpcTypes } from "@mysten/sui/grpc";

describe("formatOwner", () => {
  it("returns 'unknown' for undefined", () => {
    expect(formatOwner(undefined)).toBe("unknown");
  });

  it("formats address owner", () => {
    const owner = {
      kind: GrpcTypes.Owner_OwnerKind.ADDRESS,
      address: "0xabc123",
    } as GrpcTypes.Owner;
    expect(formatOwner(owner)).toBe("address:0xabc123");
  });

  it("formats object owner", () => {
    const owner = {
      kind: GrpcTypes.Owner_OwnerKind.OBJECT,
      address: "0xobj456",
    } as GrpcTypes.Owner;
    expect(formatOwner(owner)).toBe("object:0xobj456");
  });

  it("formats immutable owner", () => {
    const owner = {
      kind: GrpcTypes.Owner_OwnerKind.IMMUTABLE,
    } as GrpcTypes.Owner;
    expect(formatOwner(owner)).toBe("immutable");
  });
});

describe("formatGas", () => {
  it("returns null for undefined", () => {
    expect(formatGas(undefined)).toBeNull();
  });

  it("formats gas summary", () => {
    const gas = {
      computationCost: 1000n,
      storageCost: 2000n,
      storageRebate: 500n,
      nonRefundableStorageFee: 100n,
    } as GrpcTypes.GasCostSummary;
    const result = formatGas(gas);
    expect(result).toEqual({
      computation_cost: "1000",
      storage_cost: "2000",
      storage_rebate: "500",
      non_refundable_storage_fee: "100",
    });
  });
});

describe("formatStatus", () => {
  it("returns 'unknown' for undefined", () => {
    expect(formatStatus(undefined)).toBe("unknown");
  });

  it("returns 'success' for success status", () => {
    const status = { success: true } as GrpcTypes.ExecutionStatus;
    expect(formatStatus(status)).toBe("success");
  });

  it("returns failure with command for error", () => {
    const status = {
      success: false,
      error: { command: 2 },
    } as unknown as GrpcTypes.ExecutionStatus;
    expect(formatStatus(status)).toContain("failure");
  });
});

describe("bigintToString", () => {
  it("returns undefined for undefined", () => {
    expect(bigintToString(undefined)).toBeUndefined();
  });

  it("converts bigint to string", () => {
    expect(bigintToString(12345n)).toBe("12345");
  });

  it("handles zero", () => {
    expect(bigintToString(0n)).toBe("0");
  });
});

describe("timestampToIso", () => {
  it("returns undefined for undefined", () => {
    expect(timestampToIso(undefined)).toBeUndefined();
  });

  it("converts timestamp to ISO string", () => {
    const result = timestampToIso({ seconds: 1700000000n, nanos: 0 });
    expect(result).toBe("2023-11-14T22:13:20.000Z");
  });

  it("handles nanoseconds", () => {
    const result = timestampToIso({ seconds: 1700000000n, nanos: 500_000_000 });
    expect(result).toBe("2023-11-14T22:13:20.500Z");
  });
});
