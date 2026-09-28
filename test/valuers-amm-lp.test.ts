import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "./helpers/mock-grpc.js";
import type { ObjectState } from "../src/utils/valuers/common.js";
import type { HistoricalPrices } from "../src/utils/valuation.js";

const mockSui = createMockClient();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
const gqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: (q: string, v: unknown) => gqlQuery(q, v) }));
vi.mock("../src/protocols/package-roots.js", async (orig) => ({
  ...(await orig<typeof import("../src/protocols/package-roots.js")>()),
  prefetchPackageRoots: vi.fn(async () => undefined),
}));
const readObjects = vi.fn<(ids: string[], at?: string) => Promise<Map<string, ObjectState>>>();
const priceCoinTypes = vi.fn<(types: string[]) => Promise<HistoricalPrices>>();
vi.mock("../src/utils/valuers/common.js", async (orig) => ({
  ...(await orig<typeof import("../src/utils/valuers/common.js")>()),
  readObjects: (ids: string[], at?: string) => readObjects(ids, at),
  priceCoinTypes: (types: string[]) => priceCoinTypes(types),
}));

// Imported after the mocks above, whose factories close over these fixtures.
const amm = await import("../src/utils/valuers/amm-lp.js");
const { valueObjects, valuePositions } = await import("../src/utils/position-value.js");
const { shareOfReserves, isqrt, uniswapV2FeeMint, lpCoinFamily, flowxPairFieldId, aftermathReserves } = amm;

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const OWNER = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const TOKEN = "0x00000000000000000000000000000000000000000000000000000000000000b1";
const POOL = "0x00000000000000000000000000000000000000000000000000000000000000c1";
const BAG = "0x00000000000000000000000000000000000000000000000000000000000000d1";
const AF_LP = "0x00000000000000000000000000000000000000000000000000000000000000e1::af_lp::AF_LP";
const FLOWX_LP = `${amm.FLOWX_V2_PACKAGE}::pair::LP<${SUI},${USDC}>`;

function state(id: string, type: string, json: Record<string, unknown>, current = false): ObjectState {
  return { object_id: id, version: "7", type, json, current };
}

function prices(entries: Array<[string, number]>): HistoricalPrices {
  return {
    points: new Map(entries.map(([t, price]) => [t, { price, publishTime: 1_700_000_000, source: "pyth" as const }])),
    unpriced: [],
  };
}

describe("share-of-reserves math", () => {
  it("scales every reserve by lp / supply and rounds down", () => {
    expect(shareOfReserves(1n, 3n, [10n, 11n, 2n])).toEqual([3n, 3n, 0n]);
    expect(shareOfReserves(5n, 5n, [7n, 9n])).toEqual([7n, 9n]);
    expect(() => shareOfReserves(1n, 0n, [1n])).toThrow(RangeError);
  });

  it("takes floor square roots", () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 36n - 1n, 10n ** 36n, (1n << 128n) - 1n]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
  });

  it("adds the protocol-fee LP a Uniswap-v2 pair mints before a burn", () => {
    // k grew from 100^2 to 400 * 100 (sqrt 200): 1000 * (200 - 100) / (5 * 200 + 100) = 90.
    expect(uniswapV2FeeMint(1000n, 400n, 100n, 10_000n, true)).toBe(90n);
    expect(uniswapV2FeeMint(1000n, 400n, 100n, 10_000n, false)).toBe(0n);
    expect(uniswapV2FeeMint(1000n, 400n, 100n, 0n, true)).toBe(0n);
    expect(uniswapV2FeeMint(1000n, 100n, 100n, 10_000n, true)).toBe(0n);
  });

  it("reads Aftermath balances divided by their decimal scalars", () => {
    const r = aftermathReserves({
      type_names: [SUI.slice(2), USDC.slice(2)],
      normalized_balances: ["2500000000000000000000", "7000000000000000000000"],
      decimal_scalars: ["1000000000", "1000000000000"],
      lp_supply: { value: "100" },
    });
    expect(r).toEqual({ coins: [SUI, USDC], reserves: [2_500_000_000_000n, 7_000_000_000n], supply: 100n, feeMint: 0n });
  });

  it("recognises LP coin types by family", () => {
    expect(lpCoinFamily(AF_LP)).toBe("aftermath");
    expect(lpCoinFamily(FLOWX_LP)).toBe("flowx_v2");
    expect(lpCoinFamily(SUI)).toBeNull();
    expect(lpCoinFamily(`0x00000000000000000000000000000000000000000000000000000000000000f9::pair::LP<${SUI},${USDC}>`)).toBeNull();
  });

  it("derives a FlowX pair's bag entry id as the chain does", () => {
    // The mainnet factory bag's entry for SUI/SUIPUMP.
    expect(
      flowxPairFieldId(
        "0xd15e209f5a250d6055c264975fee57ec09bf9d6acdda3b5f866f76023d1563e6",
        SUI,
        "0xe5daee556ce679f811eb4638f49b773b796da2a8418400b88d4f8cc143439678::suipump::SUIPUMP",
      ),
    ).toBe("0xc832efc70d513a246e4f0eb96ecb63809167d4f7c593679f7e9bb5903ef7aa85");
  });
});

const KRIYA_TOKEN_TYPE = `${amm.KRIYA_LP_TOKEN_TYPE}<${SUI}, ${USDC}>`;
const KRIYA_POOL_TYPE = `${amm.KRIYA_V2_PACKAGE}::spot_dex::Pool<${SUI}, ${USDC}>`;

describe("amm_lp valuer", () => {
  beforeEach(() => {
    readObjects.mockReset();
    gqlQuery.mockReset();
    priceCoinTypes.mockReset();
    priceCoinTypes.mockResolvedValue(prices([[SUI, 2], [USDC, 1]]));
  });

  it("values a Kriya LP token with its pool read at the checkpoint", async () => {
    readObjects.mockImplementation(async (ids, at) => {
      expect(at).toBe("900");
      return new Map(ids.includes(POOL) ? [[POOL, state(POOL, KRIYA_POOL_TYPE, { token_x: "3000000000", token_y: "9000000", lsp_supply: { value: "3000" } })]] : []);
    });
    const r = await valueObjects(
      [{ object_id: TOKEN, type: KRIYA_TOKEN_TYPE, json: { pool_id: POOL, lsp: { balance: "1000" } } }],
      { owner: OWNER, atCheckpoint: "900" },
    );
    expect(r.unread).toEqual([]);
    const p = r.positions[0];
    expect(p.kind).toBe("lp");
    expect(p.object_id).toBe(TOKEN);
    expect(p.assets.map((a) => [a.coin_type, a.amount])).toEqual([[SUI, "1000000000"], [USDC, "3000000"]]);
    expect(p.usd_net).toBeCloseTo(2 + 3, 9);
    // An object-held share is not also a coin balance.
    expect(p.detail?.receipt_coin_types).toBeUndefined();
  });

  it("values an Aftermath LP coin through the pool of that LP and names the receipt coin", async () => {
    gqlQuery.mockImplementation(async (_q: string, vars: Record<string, string>) => {
      expect(vars.t0).toBe(`${amm.AFTERMATH_AMM_PACKAGE}::pool::Pool<${AF_LP}>`);
      return { p0: { nodes: [{ address: POOL }] } };
    });
    readObjects.mockImplementation(async () =>
      new Map([
        [
          POOL,
          state(POOL, `${amm.AFTERMATH_AMM_PACKAGE}::pool::Pool<${AF_LP}>`, {
            type_names: [SUI.slice(2), USDC.slice(2)],
            normalized_balances: ["4000000000000000000", "8000000000000000000"],
            decimal_scalars: ["1000000000", "1000000000000"],
            lp_supply: { value: "400" },
          }),
        ],
      ]),
    );
    const r = await valueObjects([{ object_id: TOKEN, type: `0x2::coin::Coin<${AF_LP}>`, json: { balance: "100" } }], { owner: OWNER });
    const p = r.positions[0];
    expect(p.assets.map((a) => a.amount)).toEqual(["1000000000", "2000000"]);
    expect(p.detail?.receipt_coin_types).toEqual([AF_LP]);
  });

  it("lists an Aftermath LP coin with no pool as unread", async () => {
    gqlQuery.mockResolvedValue({ p0: { nodes: [] } });
    readObjects.mockResolvedValue(new Map());
    const r = await valueObjects([{ object_id: TOKEN, type: `0x2::coin::Coin<${AF_LP}>`, json: { balance: "100" } }], { owner: OWNER });
    expect(r.positions).toEqual([]);
    expect(r.unread.map((u) => u.what)).toEqual([TOKEN]);
  });

  it("values FlowX LP balances with the fee mint and leaves an unpriced coin's net null", async () => {
    priceCoinTypes.mockResolvedValue(prices([[SUI, 2]]));
    mockSui.listBalances.mockResolvedValue({
      balances: [
        { coinType: FLOWX_LP, balance: "100" },
        { coinType: SUI, balance: "5" },
      ],
      hasNextPage: false,
      cursor: null,
    });
    mockSui.listOwnedObjects.mockResolvedValue({ objects: [], hasNextPage: false, cursor: null });
    const field = flowxPairFieldId(BAG, SUI, USDC);
    readObjects.mockImplementation(async (ids) => {
      const m = new Map<string, ObjectState>();
      if (ids.includes(amm.FLOWX_V2_CONTAINER)) {
        m.set(amm.FLOWX_V2_CONTAINER, state(amm.FLOWX_V2_CONTAINER, "Container", { pairs: { id: BAG }, treasury: { treasurer: OWNER } }));
      }
      if (ids.includes(field)) {
        m.set(field, state(field, "Field", { value: { id: POOL, reserve_x: { balance: "400" }, reserve_y: { balance: "100" }, k_last: "10000", lp_supply: { value: "1000" } } }));
      }
      return m;
    });
    const r = await valuePositions({ owner: OWNER }, ["amm_lp"]);
    expect(r.unread).toEqual([]);
    const p = r.positions[0];
    // Supply 1000 plus the 90 LP minted to the fee recipient first.
    expect(p.assets.map((a) => a.amount)).toEqual([String((100n * 400n) / 1090n), String((100n * 100n) / 1090n)]);
    expect(p.detail).toMatchObject({ pool: POOL, lp_supply: "1090", pending_fee_mint: "90", receipt_coin_types: [FLOWX_LP] });
    expect(p.usd_net).toBeNull();
    expect(p.unpriced_reason).toContain(USDC);
  });

  it("values owned Kriya tokens as they stood at the checkpoint and skips ones not readable then", async () => {
    const gone = "0x00000000000000000000000000000000000000000000000000000000000000b2";
    mockSui.listBalances.mockResolvedValue({ balances: [], hasNextPage: false, cursor: null });
    mockSui.listOwnedObjects.mockResolvedValue({
      objects: [
        { objectId: TOKEN, version: "9", type: KRIYA_TOKEN_TYPE, json: { pool_id: POOL, lsp: { balance: "1" } } },
        { objectId: gone, version: "9", type: KRIYA_TOKEN_TYPE, json: { pool_id: POOL, lsp: { balance: "1" } } },
      ],
      hasNextPage: false,
      cursor: null,
    });
    readObjects.mockImplementation(async (ids) => {
      const m = new Map<string, ObjectState>();
      if (ids.includes(TOKEN)) m.set(TOKEN, state(TOKEN, KRIYA_TOKEN_TYPE, { pool_id: POOL, lsp: { balance: "1500" } }));
      if (ids.includes(gone)) m.set(gone, state(gone, KRIYA_TOKEN_TYPE, { pool_id: POOL, lsp: { balance: "1" } }, true));
      if (ids.includes(POOL)) m.set(POOL, state(POOL, KRIYA_POOL_TYPE, { token_x: "3000", token_y: "6000", lsp_supply: { value: "3000" } }));
      return m;
    });
    const r = await valuePositions({ owner: OWNER, atCheckpoint: "77" }, ["amm_lp"]);
    expect(r.positions.map((p) => p.assets.map((a) => a.amount))).toEqual([["1500", "3000"]]);
    expect(r.unread.map((u) => u.what)).toEqual([gone]);
  });
});
