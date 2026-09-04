import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { fetchActiveValidators, findValidatorByAddress } = await import(
  "../src/utils/validators.js"
);

/** One page of the connection, shaped the way the service actually answers. */
const page = (
  addresses: string[],
  hasNextPage: boolean,
  endCursor: string | null = null,
) => ({
  epoch: {
    epochId: 700,
    validatorSet: {
      activeValidators: {
        pageInfo: { hasNextPage, endCursor },
        nodes: addresses.map((a) => ({
          atRisk: 0,
          contents: { json: { metadata: { sui_address: a, name: `v-${a}` } } },
        })),
      },
      contents: { json: { total_stake: "1000" } },
    },
  },
});

beforeEach(() => mockGqlQuery.mockReset());

describe("fetchActiveValidators", () => {
  it("never requests a page larger than the service allows", async () => {
    // The bug this replaces: three call sites asked for `first: 200`, which
    // mainnet rejects outright with "Page size is too large: 200 > 50". The
    // old tests passed because their mocks answered a query the real service
    // refuses, so a completely broken feature looked healthy.
    mockGqlQuery.mockResolvedValue(page(["0xa"], false));
    await fetchActiveValidators();

    for (const call of mockGqlQuery.mock.calls) {
      expect(call[1].first).toBeLessThanOrEqual(50);
    }
  });

  it("walks every page, because mainnet has more validators than fit in one", async () => {
    // Clamping to 50 instead of paginating would silently omit validators,
    // turning "is this a validator" into a coin flip.
    mockGqlQuery
      .mockResolvedValueOnce(page(["0xa", "0xb"], true, "cur1"))
      .mockResolvedValueOnce(page(["0xc"], false));

    const set = await fetchActiveValidators();
    expect(set.validators).toHaveLength(3);
    expect(mockGqlQuery).toHaveBeenCalledTimes(2);
    expect(mockGqlQuery.mock.calls[1][1].after).toBe("cur1");
    expect(set.truncated).toBe(false);
  });

  it("carries epoch and total stake through pagination", async () => {
    mockGqlQuery
      .mockResolvedValueOnce(page(["0xa"], true, "cur1"))
      .mockResolvedValueOnce(page(["0xb"], false));
    const set = await fetchActiveValidators();
    expect(set.epochId).toBe(700);
    expect(set.totalStake).toBe("1000");
  });

  it("stops and flags truncation rather than looping forever", async () => {
    // A service that always claims another page must not spin.
    mockGqlQuery.mockResolvedValue(page(["0xa"], true, "cur"));
    const set = await fetchActiveValidators();
    expect(set.truncated).toBe(true);
    expect(mockGqlQuery.mock.calls.length).toBeLessThanOrEqual(20);
  });

});

describe("findValidatorByAddress", () => {
  it("matches on the validator's sui_address", async () => {
    mockGqlQuery.mockResolvedValue(page(["0xa", "0xb"], false));
    const set = await fetchActiveValidators();
    expect(findValidatorByAddress(set, "0xb")?.contents?.json.metadata?.name).toBe("v-0xb");
    expect(findValidatorByAddress(set, "0xzz")).toBeNull();
  });
});
