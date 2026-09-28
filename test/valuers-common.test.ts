import { describe, it, expect, vi, beforeEach } from "vitest";

const priceUsdAtTime = vi.fn();
vi.mock("../src/utils/valuation.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  priceUsdAtTime,
  prefetchCoinScale: async () => undefined,
}));

const gqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

// Imported after the mocks above, which the factories close over.
const { priceCoinTypes, readObjects } = await import("../src/utils/valuers/common.js");

const A = `0x${"a".repeat(64)}::a::A`;
const B = `0x${"b".repeat(64)}::b::B`;

beforeEach(() => {
  priceUsdAtTime.mockReset();
  priceUsdAtTime.mockImplementation(async (coins: string[]) => ({
    points: new Map(coins.filter((c) => c === A).map((c) => [c, { price: 2, publishTime: 1, source: "defillama" }])),
    unpriced: coins.filter((c) => c !== A).map((c) => ({ coin_type: c, code: "not_listed", reason: "none" })),
  }));
});

describe("priceCoinTypes with a memo", () => {
  it("asks for each coin once per time across one call's valuations", async () => {
    const memo = new Map<string, Promise<unknown>>();
    const ctx = { owner: "0x1", atTime: 100, memo };
    await priceCoinTypes([A], ctx);
    const second = await priceCoinTypes([A, B], ctx);

    expect(priceUsdAtTime.mock.calls.map((c) => c[0])).toEqual([[A], [B]]);
    expect(second.points.get(A)?.price).toBe(2);
    expect(second.unpriced.map((u) => u.coin_type)).toEqual([B]);
  });

  it("asks again at a different time", async () => {
    const memo = new Map<string, Promise<unknown>>();
    await priceCoinTypes([A], { owner: "0x1", atTime: 100, memo });
    await priceCoinTypes([A], { owner: "0x1", atTime: 200, memo });
    expect(priceUsdAtTime).toHaveBeenCalledTimes(2);
  });

  it("asks again after a failed request", async () => {
    priceUsdAtTime.mockResolvedValueOnce({ points: new Map(), unpriced: [{ coin_type: A, code: "request_failed", reason: "down" }] });
    const memo = new Map<string, Promise<unknown>>();
    const first = await priceCoinTypes([A], { owner: "0x1", atTime: 100, memo });
    const second = await priceCoinTypes([A], { owner: "0x1", atTime: 100, memo });

    expect(first.points.has(A)).toBe(false);
    expect(second.points.get(A)?.price).toBe(2);
  });
});

describe("readObjects batching", () => {
  it("sends reads asked for in the same tick, at different checkpoints, as one request", async () => {
    gqlQuery.mockReset();
    gqlQuery.mockImplementation(async (_q: string, vars: { keys: Array<{ address: string; atCheckpoint?: number }> }) => ({
      multiGetObjects: vars.keys.map((k) => ({ address: k.address, version: k.atCheckpoint ?? 0, asMoveObject: { contents: { type: { repr: "0x1::p::P" }, json: {} } } })),
    }));
    const P = `0x${"d".repeat(64)}`;
    const Q = `0x${"e".repeat(64)}`;
    const [a, b] = await Promise.all([readObjects([P], "100"), readObjects([Q], "200")]);
    expect(gqlQuery).toHaveBeenCalledTimes(1);
    expect(a.get(P)?.version).toBe("100");
    expect(b.get(Q)?.version).toBe("200");
  });
});

describe("readObjects with a memo", () => {
  it("reads each object once per checkpoint across one call", async () => {
    const POOL = `0x${"c".repeat(64)}`;
    gqlQuery.mockReset();
    gqlQuery.mockImplementation(async (_q: string, vars: { keys: Array<{ address: string }> }) => ({
      multiGetObjects: vars.keys.map((k) => ({ address: k.address, version: 7, asMoveObject: { contents: { type: { repr: "0x1::p::P" }, json: { v: 1 } } } })),
    }));
    const memo = new Map<string, Promise<unknown>>();
    const first = await readObjects([POOL], "100", memo);
    const second = await readObjects([POOL], "100", memo);
    await readObjects([POOL], "101", memo);

    expect(first.get(POOL)?.json).toEqual({ v: 1 });
    expect(second.get(POOL)?.version).toBe("7");
    expect(gqlQuery).toHaveBeenCalledTimes(2);
  });
});
