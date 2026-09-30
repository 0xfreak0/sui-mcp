import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "./helpers/mock-grpc.js";
import type { ObjectState } from "../src/utils/valuers/common.js";
import type { HistoricalPrices } from "../src/utils/valuation.js";

const mockSui = createMockClient();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
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
const clmm = await import("../src/utils/valuers/clmm.js");
const { valueObjects, valuePositions } = await import("../src/utils/position-value.js");
const { sqrtPriceAtTick, amountsForLiquidity, deltaA, deltaB, i32FromBits, positionInfoId } = clmm;

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const CETUS_PKG = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const OWNER = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const POS = "0x00000000000000000000000000000000000000000000000000000000000000b1";
const POOL = "0x00000000000000000000000000000000000000000000000000000000000000c1";
const TABLE = "0x00000000000000000000000000000000000000000000000000000000000000d1";

/** I32 `{bits}` as Move JSON renders it. */
const bits = (n: number) => ({ bits: n >>> 0 });

function state(id: string, type: string, json: Record<string, unknown>, current = false): ObjectState {
  return { object_id: id, version: "7", type, json, current };
}

function prices(entries: Array<[string, number]>): HistoricalPrices {
  return {
    points: new Map(entries.map(([t, price]) => [t, { price, publishTime: 1_700_000_000, source: "pyth" as const }])),
    unpriced: [],
  };
}

describe("tick math", () => {
  // Values returned by the Cetus clmm `tick_math::get_sqrt_price_at_tick` on mainnet.
  const ON_CHAIN: Array<[number, bigint]> = [
    [-443636, 4295048016n],
    [-200000, 837899702510258n],
    [-66990, 647624222608707833n],
    [-12345, 9950957148631419635n],
    [-1, 18445821805675392311n],
    [0, 1n << 64n],
    [1, 18447666387855959850n],
    [12345, 34195943348800206620n],
    [71051, 643717693770585267595n],
    [200000, 406113483393643373014939n],
    [443636, 79226673515401279992447579055n],
  ];

  it.each(ON_CHAIN)("tick %i gives the on-chain sqrt price", (tick, expected) => {
    expect(sqrtPriceAtTick(tick)).toBe(expected);
  });

  it("the tick bounds give the module's min and max sqrt price", () => {
    expect(sqrtPriceAtTick(clmm.MIN_TICK)).toBe(clmm.MIN_SQRT_PRICE);
    expect(sqrtPriceAtTick(clmm.MAX_TICK)).toBe(clmm.MAX_SQRT_PRICE);
  });

  it("rejects ticks outside the bounds", () => {
    expect(() => sqrtPriceAtTick(443637)).toThrow(RangeError);
    expect(() => sqrtPriceAtTick(-443637)).toThrow(RangeError);
  });

  it("reads I32 bits as two's complement", () => {
    expect(i32FromBits({ bits: 4294967295 })).toBe(-1);
    expect(i32FromBits({ bits: 4294523716 })).toBe(-443580);
    expect(i32FromBits({ bits: 443580 })).toBe(443580);
    expect(i32FromBits({ bits: -1 })).toBeNull();
    expect(i32FromBits("5")).toBeNull();
  });
});

describe("amounts for liquidity", () => {
  // Pool state and amounts from mainnet remove-liquidity events, pool read at the transaction's input version.
  it("inside the range: both coins (Cetus RemoveLiquidityEvent)", () => {
    expect(amountsForLiquidity(-33840, -33780, -33812, 3402078650830783210n, 12446692601956672n)).toEqual({
      a: 106932520219898n,
      b: 3243865602858n,
    });
  });

  it("below the range: all coin A (Magma RemoveLiquidityEvent)", () => {
    const pool = sqrtPriceAtTick(84192);
    expect(amountsForLiquidity(92596, 92600, 84192, pool, 4274205642739n)).toEqual({ a: 8341116n, b: 0n });
  });

  it("at or above the upper tick: all coin B (FlowX ModifyLiquidity)", () => {
    expect(amountsForLiquidity(-69660, -67440, -67013, 646881994653121126n, 4030410441n)).toEqual({ a: 0n, b: 14534615n });
    // The upper tick itself is outside the range.
    const atUpper = amountsForLiquidity(-10, 10, 10, sqrtPriceAtTick(10), 1_000_000_000n);
    expect(atUpper.a).toBe(0n);
    expect(atUpper.b).toBe(deltaB(sqrtPriceAtTick(-10), sqrtPriceAtTick(10), 1_000_000_000n));
  });

  it("the lower tick itself is inside the range", () => {
    const r = amountsForLiquidity(-10, 10, -10, sqrtPriceAtTick(-10), 1_000_000_000n);
    expect(r.b).toBe(0n);
    expect(r.a).toBe(deltaA(sqrtPriceAtTick(-10), sqrtPriceAtTick(10), 1_000_000_000n));
  });

  it("rounds down unless asked to round up", () => {
    const a = sqrtPriceAtTick(-100);
    const b = sqrtPriceAtTick(100);
    expect(deltaA(a, b, 12345n, true)).toBe(deltaA(a, b, 12345n) + 1n);
    expect(deltaB(a, b, 12345n, true)).toBe(deltaB(a, b, 12345n) + 1n);
    expect(deltaB(0n, 1n << 64n, 7n)).toBe(7n);
    expect(deltaB(0n, 1n << 64n, 7n, true)).toBe(7n);
  });

  it("zero liquidity is worth nothing and an empty range is refused", () => {
    expect(amountsForLiquidity(0, 10, 5, sqrtPriceAtTick(5), 0n)).toEqual({ a: 0n, b: 0n });
    expect(() => amountsForLiquidity(10, 10, 5, sqrtPriceAtTick(5), 1n)).toThrow(RangeError);
  });
});

const CETUS_POOL_TYPE = `${CETUS_PKG}::pool::Pool<${SUI}, ${USDC}>`;

function cetusPool(tick: number, extra: Record<string, unknown> = {}) {
  return {
    current_sqrt_price: sqrtPriceAtTick(tick).toString(),
    current_tick_index: bits(tick),
    rewarder_manager: { rewarders: [{ reward_coin: SUI.slice(2) }] },
    position_manager: { positions: { id: TABLE } },
    ...extra,
  };
}

function cetusPosition(liquidity: string) {
  return { id: POS, pool: POOL, tick_lower_index: bits(-100), tick_upper_index: bits(100), liquidity };
}

function cetusRecord(liquidity: string) {
  return {
    name: POS,
    value: {
      value: {
        position_id: POS,
        liquidity,
        tick_lower_index: bits(-100),
        tick_upper_index: bits(100),
        fee_owned_a: "5",
        fee_owned_b: "0",
        rewards: [{ amount_owned: "9" }],
      },
    },
  };
}

describe("clmm valuer", () => {
  beforeEach(() => {
    readObjects.mockReset();
    priceCoinTypes.mockReset();
    priceCoinTypes.mockResolvedValue(prices([[SUI, 2], [USDC, 1]]));
  });

  it("takes only the checked families' position types", async () => {
    readObjects.mockResolvedValue(new Map());
    const unchecked = "0x00000000000000000000000000000000000000000000000000000000000000f9::position::Position";
    const r = await valueObjects(
      [
        { object_id: "0x1", type: CETUS_POOL_TYPE, json: {} },
        { object_id: "0x2", type: unchecked, json: {} },
        { object_id: POS, type: clmm.MOMENTUM_POSITION_TYPE, json: {} },
      ],
      { owner: OWNER },
    );
    expect(r.unhandled).toEqual(["0x1", "0x2"]);
    expect(r.unread.map((u) => u.what)).toEqual([POS]);
  });

  it("values a position with the pool read at the checkpoint and the pool's own record", async () => {
    const infoId = positionInfoId(TABLE, POS);
    readObjects.mockImplementation(async (ids, at) => {
      expect(at).toBe("1234");
      const m = new Map<string, ObjectState>();
      if (ids.includes(POOL)) m.set(POOL, state(POOL, CETUS_POOL_TYPE, cetusPool(0)));
      if (ids.includes(infoId)) m.set(infoId, state(infoId, "0x2::dynamic_field::Field", cetusRecord("900000000")));
      return m;
    });
    const r = await valueObjects(
      [{ object_id: POS, type: clmm.CETUS_POSITION_TYPE, json: cetusPosition("1000000000") }],
      { owner: OWNER, atCheckpoint: "1234" },
    );
    expect(r.unread).toEqual([]);
    const p = r.positions[0];
    expect(p.kind).toBe("clmm");
    expect(p.protocol).toBe("Cetus");
    // The pool's record (900000000) is what the pool removes, not the object's 1000000000.
    const want = amountsForLiquidity(-100, 100, 0, sqrtPriceAtTick(0), 900000000n);
    expect(p.assets.filter((a) => a.side === "liquidity").map((a) => a.amount)).toEqual([want.a.toString(), want.b.toString()]);
    expect(p.assets.filter((a) => a.side === "reward")).toMatchObject([
      { coin_type: SUI, amount: "5", side: "reward", usd: 2 * 5e-9 },
      { coin_type: SUI, amount: "9", side: "reward", usd: 2 * 9e-9 },
    ]);
    expect(p.detail).toMatchObject({ liquidity: "900000000", position_object_liquidity: "1000000000", tick_lower_index: -100, tick_upper_index: 100 });
    expect(p.usd_net).toBeCloseTo(Number(want.a) * 2e-9 + Number(want.b) * 1e-6 + 28e-9, 12);
  });

  it("falls back to the object's liquidity and lists the fees unread when the pool's record is missing", async () => {
    readObjects.mockImplementation(async (ids) => new Map(ids.includes(POOL) ? [[POOL, state(POOL, CETUS_POOL_TYPE, cetusPool(500))]] : []));
    const r = await valueObjects([{ object_id: POS, type: clmm.CETUS_POSITION_TYPE, json: cetusPosition("1000") }], { owner: OWNER });
    expect(r.positions[0].assets.map((a) => a.amount)).toEqual(["0", amountsForLiquidity(-100, 100, 500, sqrtPriceAtTick(500), 1000n).b.toString()]);
    expect(r.unread.map((u) => u.what)).toEqual([`${POS} owed fees`]);
  });

  it("leaves unread a position whose liquidity claims more than the pool holds", async () => {
    readObjects.mockImplementation(async (ids) =>
      new Map(ids.includes(POOL) ? [[POOL, state(POOL, CETUS_POOL_TYPE, cetusPool(0, { coin_a: "10", coin_b: "10" }))]] : []),
    );
    const r = await valueObjects([{ object_id: POS, type: clmm.CETUS_POSITION_TYPE, json: cetusPosition("1000000000000") }], { owner: OWNER });
    expect(r.positions).toEqual([]);
    expect(r.unread.map((u) => u.what)).toContain(POS);
  });

  it("an unreadable pool leaves the position unread rather than valued", async () => {
    readObjects.mockResolvedValue(new Map());
    const r = await valueObjects([{ object_id: POS, type: clmm.CETUS_POSITION_TYPE, json: cetusPosition("1000") }], { owner: OWNER });
    expect(r.positions).toEqual([]);
    expect(r.unread.map((u) => u.what)).toEqual([POS]);
  });

  it("a coin without a price leaves the net unpriced", async () => {
    priceCoinTypes.mockResolvedValue(prices([[SUI, 2]]));
    readObjects.mockImplementation(async (ids) => new Map(ids.includes(POOL) ? [[POOL, state(POOL, CETUS_POOL_TYPE, cetusPool(0))]] : []));
    const r = await valueObjects([{ object_id: POS, type: clmm.CETUS_POSITION_TYPE, json: cetusPosition("1000000000") }], { owner: OWNER });
    const p = r.positions[0];
    expect(p.usd_net).toBeNull();
    expect(p.unpriced_reason).toContain(USDC);
    expect(p.assets.find((a) => a.coin_type === USDC && a.side === "liquidity")?.usd).toBeNull();
  });

  it("reads Bluefin's field names and owed fees stored on the position", async () => {
    const pool = "0x00000000000000000000000000000000000000000000000000000000000000c2";
    const type = `0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool<${SUI}, ${USDC}>`;
    readObjects.mockImplementation(async () =>
      new Map([[pool, state(pool, type, { current_sqrt_price: sqrtPriceAtTick(-200).toString(), current_tick_index: bits(-200), reward_infos: [{ reward_coin_type: USDC.slice(2) }] })]]),
    );
    const json = { pool_id: pool, lower_tick: bits(-100), upper_tick: bits(100), liquidity: "1000000", token_a_fee: "3", token_b_fee: "4", reward_infos: [{ coins_owed_reward: "6" }] };
    const r = await valueObjects([{ object_id: POS, type: clmm.BLUEFIN_POSITION_TYPE, json }], { owner: OWNER });
    const p = r.positions[0];
    expect(p.protocol).toBe("Bluefin");
    expect(p.assets.map((a) => [a.coin_type, a.amount, a.side])).toEqual([
      [SUI, deltaA(sqrtPriceAtTick(-100), sqrtPriceAtTick(100), 1000000n).toString(), "liquidity"],
      [USDC, "0", "liquidity"],
      [SUI, "3", "reward"],
      [USDC, "4", "reward"],
      [USDC, "6", "reward"],
    ]);
  });

  it("follows a Turbos NFT to the position object it names", async () => {
    const inner = "0x00000000000000000000000000000000000000000000000000000000000000e1";
    const pool = "0x00000000000000000000000000000000000000000000000000000000000000c3";
    const fee = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::fee3000bps::FEE3000BPS";
    const type = `0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::Pool<${SUI}, ${USDC}, ${fee}>`;
    readObjects.mockImplementation(async () =>
      new Map([
        [pool, state(pool, type, { sqrt_price: sqrtPriceAtTick(300).toString(), tick_current_index: bits(300), reward_infos: [] })],
        [inner, state(inner, "0x91bf::position_manager::Position", { tick_lower_index: bits(-60), tick_upper_index: bits(60), liquidity: "5000", tokens_owed_a: "0", tokens_owed_b: "0" })],
      ]),
    );
    const r = await valueObjects([{ object_id: POS, type: clmm.TURBOS_POSITION_NFT_TYPE, json: { pool_id: pool, position_id: inner } }], { owner: OWNER });
    expect(r.positions[0].assets.map((a) => a.amount)).toEqual(["0", deltaB(sqrtPriceAtTick(-60), sqrtPriceAtTick(60), 5000n).toString()]);
  });

  it("lists owned positions, reports a truncated type and CLMM-shaped positions of unchecked families", async () => {
    const other = "0x00000000000000000000000000000000000000000000000000000000000000f1";
    mockSui.listOwnedObjects.mockImplementation(async ({ type }: { type?: string }) => {
      if (type === clmm.CETUS_POSITION_TYPE) {
        return { objects: [{ objectId: POS, version: "1", type: clmm.CETUS_POSITION_TYPE, json: cetusPosition("1000") }], hasNextPage: true, cursor: null };
      }
      if (type) return { objects: [], hasNextPage: false, cursor: null };
      return {
        objects: [
          { objectId: POS, type: clmm.CETUS_POSITION_TYPE },
          { objectId: other, type: "0x00000000000000000000000000000000000000000000000000000000000000f9::position::Position" },
        ],
        hasNextPage: false,
        cursor: null,
      };
    });
    readObjects.mockImplementation(async (ids) => {
      const m = new Map<string, ObjectState>();
      if (ids.includes(POOL)) m.set(POOL, state(POOL, CETUS_POOL_TYPE, cetusPool(0)));
      const infoId = positionInfoId(TABLE, POS);
      if (ids.includes(infoId)) m.set(infoId, state(infoId, "0x2::dynamic_field::Field", cetusRecord("1000")));
      if (ids.includes(other)) m.set(other, state(other, "0xf9::position::Position", { pool_id: POOL, tick_lower_index: bits(0), tick_upper_index: bits(10), liquidity: "1" }));
      return m;
    });
    const r = await valuePositions({ owner: OWNER }, ["clmm"]);
    expect(r.positions.map((p) => p.object_id)).toEqual([POS]);
    expect(r.unread.map((u) => u.what)).toEqual([clmm.CETUS_POSITION_TYPE, other]);
  });

  it("values the owner's positions as they stood at the checkpoint and skips ones not readable then", async () => {
    const gone = "0x00000000000000000000000000000000000000000000000000000000000000b2";
    mockSui.listOwnedObjects.mockImplementation(async ({ type }: { type?: string }) =>
      type === clmm.CETUS_POSITION_TYPE
        ? {
            objects: [
              { objectId: POS, version: "9", type: clmm.CETUS_POSITION_TYPE, json: cetusPosition("1") },
              { objectId: gone, version: "9", type: clmm.CETUS_POSITION_TYPE, json: cetusPosition("1") },
            ],
            hasNextPage: false,
            cursor: null,
          }
        : { objects: [], hasNextPage: false, cursor: null },
    );
    const infoId = positionInfoId(TABLE, POS);
    readObjects.mockImplementation(async (ids, at) => {
      const m = new Map<string, ObjectState>();
      if (ids.includes(POS)) m.set(POS, state(POS, clmm.CETUS_POSITION_TYPE, cetusPosition("777"), at === undefined));
      if (ids.includes(gone)) m.set(gone, state(gone, clmm.CETUS_POSITION_TYPE, cetusPosition("1"), true));
      if (ids.includes(POOL)) m.set(POOL, state(POOL, CETUS_POOL_TYPE, cetusPool(0, { position_manager: {} })));
      if (ids.includes(infoId)) throw new Error("no record expected without a table");
      return m;
    });
    const r = await valuePositions({ owner: OWNER, atCheckpoint: "50" }, ["clmm"]);
    expect(r.positions.map((p) => p.detail?.liquidity)).toEqual(["777"]);
    expect(r.unread.map((u) => u.what)).toEqual([gone]);
  });
});
