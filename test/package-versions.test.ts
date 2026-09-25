import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { resolveEventTypeFilter } = await import("../src/utils/package-versions.js");

const V1 = `0x${"1".repeat(64)}`;
const V3 = `0x${"3".repeat(64)}`;
const V5 = `0x${"5".repeat(64)}`;

/** Type origins as the service reports them for a package upgraded twice. */
const origins = {
  package: {
    typeOrigins: [
      { module: "pool", struct: "SwapEvent", definingId: V1 },
      { module: "pool", struct: "Pool", definingId: V1 },
      { module: "pool", struct: "FlashLoanEvent", definingId: V3 },
      { module: "vault", struct: "DepositEvent", definingId: V3 },
    ],
  },
};

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockGqlQuery.mockResolvedValue(origins);
});

describe("resolveEventTypeFilter", () => {
  it("rewrites a struct type to the version that defined it, keeping type arguments", async () => {
    const r = await resolveEventTypeFilter(`${V5}::pool::SwapEvent<0x2::sui::SUI>`);
    expect(r.filter).toBe(`${V1}::pool::SwapEvent<0x2::sui::SUI>`);
    expect(r.resolution?.requested).toBe(`${V5}::pool::SwapEvent<0x2::sui::SUI>`);
  });

  it("leaves a type already written with its defining package alone", async () => {
    const r = await resolveEventTypeFilter(`${V3}::vault::DepositEvent`);
    expect(r).toEqual({ filter: `${V3}::vault::DepositEvent` });
  });

  it("names the other defining packages when a module's types span versions", async () => {
    const r = await resolveEventTypeFilter(`${V1}::pool`);
    // The requested package defines some of them, so it is kept.
    expect(r.filter).toBe(`${V1}::pool`);
    expect(r.resolution?.other_defining_packages).toEqual([V3]);
  });

  it("passes a filter through when the package cannot be read", async () => {
    mockGqlQuery.mockResolvedValue({ package: null });
    const r = await resolveEventTypeFilter("0x9999::m::E");
    expect(r).toEqual({ filter: "0x9999::m::E" });
  });
});
