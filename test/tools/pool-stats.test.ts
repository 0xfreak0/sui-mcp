import { describe, it, expect, vi, beforeEach } from "vitest";

const CETUS_PKG = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const POOL = "0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105";

const getObject = vi.fn();
vi.mock("../../src/clients/grpc.js", () => ({ sui: { getObject }, archive: {} }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: vi.fn() }));
vi.mock("../../src/tools/prices.js", () => ({ fetchAftermathPrices: async () => ({}) }));
vi.mock("../../src/protocols/registry.js", () => ({
  prefetchProtocolNames: async () => undefined,
  // The registry names the framework too, so detection alone does not make a pool.
  lookupProtocol: (id: string) =>
    id === CETUS_PKG ? { name: "Cetus" } : id === `0x${"0".repeat(63)}2` ? { name: "Sui Framework" } : undefined,
}));

const { registerPoolTools } = await import("../../src/tools/pools.js");

type Result = { isError?: boolean; content: { text: string }[] };
const tools = new Map<string, (a: Record<string, unknown>) => Promise<Result>>();
registerPoolTools({
  tool: (n: string, _d: string, _s: unknown, h: (a: Record<string, unknown>) => Promise<Result>) => tools.set(n, h),
} as never);
const poolStats = (args: Record<string, unknown>) => tools.get("get_pool_stats")!(args);
const errorOf = (r: Result) => JSON.parse(r.content[0].text).error as string;

/** `getObject` as the SDK returns the Cetus USDC/SUI pool. */
const cetusPool = {
  object: {
    type: `${CETUS_PKG}::pool::Pool<${USDC}, ${SUI}>`,
    json: { coin_a: "2091713055587", coin_b: "1580935710383935", current_sqrt_price: "1", fee_rate: "2500" },
  },
};

describe("get_pool_stats on something that is not a pool", () => {
  beforeEach(() => getObject.mockReset());

  // The framework package answered as a "dex" pool with empty reserves.
  it("refuses a package", async () => {
    getObject.mockResolvedValue({ object: { type: "package", json: null } });
    const r = await poolStats({ pool_id: `0x${"0".repeat(63)}2` });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatch(/is a package, not a pool/);
  });

  it("refuses a Move object no pool parser recognises", async () => {
    getObject.mockResolvedValue({ object: { type: `0x${"0".repeat(63)}2::clock::Clock`, json: { timestamp_ms: "1" } } });
    const r = await poolStats({ pool_id: `0x${"0".repeat(63)}6` });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatch(/2::clock::Clock, which is not a pool this tool can read/);
  });
});

describe("get_pool_stats with a protocol hint", () => {
  beforeEach(() => getObject.mockReset());

  // The hint was taken before detection, so protocol: "nonsense" relabelled
  // a Cetus pool as "nonsense".
  it("refuses a hint that contradicts the detected protocol", async () => {
    getObject.mockResolvedValue(cetusPool);
    const r = await poolStats({ pool_id: POOL, protocol: "nonsense" });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatch(/belongs to cetus, not "nonsense"/);
  });

  it("accepts a hint that agrees with the chain", async () => {
    getObject.mockResolvedValue(cetusPool);
    const r = await poolStats({ pool_id: POOL, protocol: "Cetus" });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text).protocol).toMatch(/^cetus$/i);
  });
});
