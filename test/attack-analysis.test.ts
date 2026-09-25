import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { GrpcTypes } from "@mysten/sui/grpc";
import {
  aggregateIncident,
  oracleTouches,
  pairFlashLegs,
  poolFlows,
  readSwap,
  typeArgsOf,
  valueDeltas,
  type AttackCall,
  type AttackEvent,
  type AttackTx,
} from "../src/utils/attack-analysis.js";
import { fromGrpcTransaction } from "../src/utils/attack-read.js";

/**
 * The Cetus exploit, DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x, as the
 * mainnet archive returned it over gRPC: every command and input, the first two
 * events, the pool and position objects and the balance changes.
 */
const CETUS_GRPC = JSON.parse(readFileSync(new URL("./fixtures/cetus-exploit-grpc.json", import.meta.url), "utf8"), (_k, v) =>
  v && typeof v === "object" && "$bigint" in v
    ? BigInt(v.$bigint)
    : v && typeof v === "object" && "$bytes" in v
      ? new Uint8Array(Buffer.from(v.$bytes, "base64"))
      : v,
) as GrpcTypes.ExecutedTransaction;

const POOL = "0x871d8a227114f375170f149f7e9d45be822dd003eba225e83c05ac80828596bc";
const CONFIG = "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f";
const CLOCK = `0x${"0".repeat(63)}6`;
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const HASUI = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI";
const ATTACKER = "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06";
const CETUS_EV = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::";

/** The four liquidity events the exploit emitted after the swap, as decoded on mainnet. */
const LIQUIDITY_EVENTS: AttackEvent[] = [
  { index: 2, type: `${CETUS_EV}AddLiquidityEvent`, json: { pool: POOL, amount_a: "1", amount_b: "0", liquidity: "10365647984364446732462244378333008" } },
  { index: 3, type: `${CETUS_EV}RemoveLiquidityEvent`, json: { pool: POOL, amount_a: "10024321275017082", amount_b: "0" } },
  { index: 4, type: `${CETUS_EV}RemoveLiquidityEvent`, json: { pool: POOL, amount_a: "1", amount_b: "0" } },
  { index: 5, type: `${CETUS_EV}RemoveLiquidityEvent`, json: { pool: POOL, amount_a: "10024321275017081", amount_b: "0" } },
];

const cetus = fromGrpcTransaction(CETUS_GRPC);
const cetusFull: AttackTx = { ...cetus, events: [...cetus.events, ...LIQUIDITY_EVENTS] };

describe("fromGrpcTransaction", () => {
  it("keeps every command, resolves object arguments and decodes event JSON", () => {
    expect(cetus.digest).toBe("DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x");
    expect(cetus.success).toBe(true);
    expect(cetus.timestampMs).toBe(Date.parse("2025-05-22T10:30:50.476Z"));
    expect(cetus.checkpoint).toBe("148114818");
    expect(cetus.commandKinds).toHaveLength(25);
    expect(cetus.commandKinds[24]).toBe("TransferObjects");
    const flash = cetus.calls.find((c) => c.function === "flash_swap")!;
    expect(flash.command).toBe(0);
    expect(flash.objectArgs).toEqual(expect.arrayContaining([CONFIG, POOL]));
    expect(flash.typeArguments).toEqual([HASUI, SUI]);
    expect(cetus.events[0].json).toMatchObject({ pool: POOL, atob: true, amount_out: "5765124790450508" });
    expect(cetus.objects.find((o) => o.objectId === POOL)?.objectType).toContain("::pool::Pool<");
  });
});

describe("pairFlashLegs", () => {
  it("pairs Cetus flash_swap with repay_flash_swap on the same pool, ignoring the Clock", () => {
    const legs = pairFlashLegs(cetus.calls, cetus.events);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      kind: "flash_swap",
      basis: "calls",
      borrow: { command: 0 },
      repay: { command: 14 },
      related_events: [0],
    });
    expect(legs[0].objects).toContain(POOL);
    expect(legs[0].objects).not.toContain(CLOCK);
  });

  const call = (command: number, fn: string, objectArgs: string[], module = "py", pkg = "0xnemo"): AttackCall => ({
    command,
    package: pkg,
    module,
    function: fn,
    typeArguments: [],
    objectArgs,
  });

  it("pairs a borrow repaid later in the PTB (Nemo's borrow_pt_amount / repay_pt_amount)", () => {
    // Object ids from the Nemo exploit, 19Zkat1xArMTMvPCB4e4QtM5HstpYiKvgPjbvkLUAw9.
    const PY = "0xc6840365f500bee8732a3a256344a11343936b864c144b7e9de5bb8c54224fbe";
    const MARKET = "0x7472959314b24ebfbd4da49cc36abb3da29f722746019c692407aaf6b47e9a08";
    const legs = pairFlashLegs(
      [call(1, "borrow_pt_amount", [PY, CLOCK]), call(3, "swap_exact_pt_for_sy", [MARKET, CLOCK], "market"), call(208, "repay_pt_amount", [PY])],
      [],
    );
    expect(legs).toEqual([expect.objectContaining({ kind: "borrow_repay", borrow: expect.objectContaining({ command: 1 }), repay: expect.objectContaining({ command: 208 }), objects: [PY] })]);
  });

  it("repays each borrow from the market it came from, not from whichever repay comes first", () => {
    const A = `0x${"a1".repeat(32)}`;
    const B = `0x${"b2".repeat(32)}`;
    const legs = pairFlashLegs(
      [
        call(0, "flash_loan", [A, CLOCK], "lending"),
        call(1, "flash_loan", [B, CLOCK], "lending"),
        call(5, "flash_repay", [B, CLOCK], "lending"),
        call(6, "flash_repay", [A, CLOCK], "lending"),
      ],
      [],
    );
    expect(legs.map((l) => [l.borrow.command, l.repay?.command])).toEqual([
      [0, 6],
      [1, 5],
    ]);
  });

  it("does not call an ordinary borrow a flash leg when nothing repays it", () => {
    expect(pairFlashLegs([call(0, "borrow", ["0xobligation"], "lending_market")], [])).toEqual([]);
  });

  it("pairs flash events by pool when a wrapper made the calls", () => {
    const legs = pairFlashLegs(
      [call(0, "h8b64d", [], "h86261", "0xwrapper")],
      [
        { index: 0, type: "0xcetus::pool::FlashSwapEvent", json: { pool: POOL } },
        { index: 1, type: "0xcetus::pool::SwapEvent", json: { pool: POOL } },
        { index: 2, type: "0xcetus::pool::RepayFlashSwapEvent", json: { pool: POOL, paid_a: "5" } },
      ],
    );
    expect(legs).toEqual([
      expect.objectContaining({ kind: "flash_swap", basis: "events", borrow: expect.objectContaining({ event: 0 }), repay: expect.objectContaining({ event: 2 }), objects: [POOL] }),
    ]);
  });
});

describe("readSwap", () => {
  it("reads the Cetus exploit swap's price collapse from its sqrt prices", () => {
    const s = readSwap(cetus.events[0])!;
    expect(s).toMatchObject({ pool: POOL, a_to_b: true, amount_in: "10024321275017082", amount_out: "5765124790450508", price_basis: "sqrt_price" });
    // (18425720184762886 / 18956530795606879104)^2 - 1
    expect(s.price_change_pct).toBeCloseTo(-99.999906, 5);
    expect(s.price_before).toBeCloseTo(1.05603, 4);
  });

  it("reads a Turbos swap's ticks as signed 32-bit, so a negative tick is not four billion", () => {
    const s = readSwap({
      index: 0,
      type: "0xturbos::pool::SwapEvent",
      json: { pool: POOL, a_to_b: false, amount_a: "10", amount_b: "20", tick_pre_index: { bits: 4294967196 }, tick_current_index: { bits: 100 } },
    })!;
    // -100 → 100: price × 1.0001^200.
    expect(s.price_change_pct).toBeCloseTo((1.0001 ** 200 - 1) * 100, 6);
    expect([s.amount_in, s.amount_out]).toEqual(["20", "10"]);
  });

  it("gives no impact for a swap event that does not carry the price", () => {
    const s = readSwap({ index: 0, type: "0xnemo::market::SwapEvent<0xs::s::S>", json: { market_state_id: "0x1", pt_amount: { value: "1", positive: false } } })!;
    expect(s.price_change_pct).toBeNull();
    expect(s.pool).toBeNull();
  });
});

describe("poolFlows", () => {
  it("nets the Cetus pool's reserves to exactly what the attacker walked out with", () => {
    const flows = poolFlows(cetusFull);
    expect(flows).toHaveLength(1);
    const f = flows[0];
    expect(f.pool).toBe(POOL);
    expect(f.deltas.get(HASUI)).toBe(-10024321275017081n);
    expect(f.deltas.get(SUI)).toBe(-5765124790450508n);
    // The OpenPositionEvent names the pool and moves nothing.
    expect(f.undecoded_events).toEqual([]);
    expect(f.events).toEqual([0, 2, 3, 4, 5]);
  });

  it("keys amounts A/B rather than inventing coin names when the pool type is unknown", () => {
    const f = poolFlows({ events: LIQUIDITY_EVENTS.slice(0, 1), objects: [] })[0];
    expect([...f.deltas]).toEqual([
      ["A", 1n],
      ["B", 0n],
    ]);
  });

  it("lists a pool event with amounts it cannot read instead of guessing", () => {
    const f = poolFlows({ events: [{ index: 7, type: "0xdex::pool::Rebalanced", json: { pool: POOL, amount: "5" } }], objects: [] })[0];
    expect(f.undecoded_events).toEqual([7]);
    expect(f.deltas.size).toBe(0);
  });
});

describe("oracleTouches", () => {
  it("groups repeated oracle calls and decodes a Pyth price update", () => {
    const calls: AttackCall[] = Array.from({ length: 3 }, (_, i) => ({
      command: 2 + i * 2,
      package: "0xee1f",
      module: "scallop",
      function: "get_price_voucher_from_x_oracle",
      typeArguments: [],
      objectArgs: [],
    }));
    const pyth: AttackEvent = {
      index: 0,
      type: "0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91::event::PriceFeedUpdateEvent",
      json: {
        price_feed: {
          price_identifier: { bytes: [0x23, 0xd7] },
          price: { price: { magnitude: "416000000", negative: false }, conf: "1", expo: { magnitude: "8", negative: true }, timestamp: "1747909850" },
        },
      },
    };
    const out = oracleTouches(calls, [pyth]);
    expect(out[0]).toMatchObject({ kind: "call", count: 3, first: 2 });
    expect(out[1]).toMatchObject({ kind: "event", count: 1, decoded: [{ feed_id: "0x23d7", price: 4.16, publish_time: 1747909850 }] });
  });
});

describe("valueDeltas", () => {
  it("values priced coins, keeps unpriced ones with a null, and never counts them as zero", () => {
    const v = valueDeltas(
      new Map([
        [SUI, 5765124463062928n],
        ["0xdead::meme::MEME", 10n ** 12n],
        [HASUI, 0n],
      ]),
      new Map([[SUI, { price: 4.16, publishTime: 0, source: "defillama" as const }]]),
    );
    expect(v.coins.map((c) => [c.coin_type, c.usd])).toEqual([
      [SUI, Number((5765124.463062928 * 4.16).toFixed(2))],
      ["0xdead::meme::MEME", null],
    ]);
    expect(v.unpriced).toEqual(["0xdead::meme::MEME"]);
    expect(v.usd_net).toBeCloseTo(5765124.463062928 * 4.16, 1);
  });
});

describe("aggregateIncident", () => {
  const tx = (digest: string, pool: string, amount: string, success = true): AttackTx => ({
    digest,
    sender: ATTACKER,
    success,
    timestampMs: 0,
    checkpoint: null,
    commandKinds: [],
    calls: [],
    events: success ? [{ index: 0, type: `${CETUS_EV}SwapEvent`, json: { pool, atob: true, amount_in: "1", amount_out: amount } }] : [],
    balanceChanges: [
      { address: ATTACKER, coinType: SUI, amount: success ? amount : "-1000" },
      { address: "0xvictim", coinType: SUI, amount: "-1" },
    ],
    objects: [],
  });

  it("groups the attacker's gains by the pool each transaction drained", () => {
    const agg = aggregateIncident([tx("d1", POOL, "100"), tx("d2", "0xb", "7"), tx("d3", POOL, "50"), tx("f1", POOL, "0", false)]);
    const byPool = new Map(agg.groups.map((g) => [g.pools.join("+"), g]));
    expect(byPool.get(POOL)?.digests).toEqual(["d1", "d3"]);
    expect(byPool.get(POOL)?.attacker_deltas.get(SUI)).toBe(150n);
    // Pool side from events: swap out of coin B, keyed B without a pool type.
    expect(byPool.get(POOL)?.pool_deltas.get("B")).toBe(-150n);
    // A failed transaction still cost gas, so it counts in totals and in no pool.
    expect(agg.failed).toEqual(["f1"]);
    expect(agg.totals.get(SUI)).toBe(157n - 1000n);
    expect(agg.senders).toEqual([ATTACKER]);
  });

  it("files a successful transaction that names no pool as unattributed", () => {
    const t = { ...tx("d9", POOL, "5"), events: [] };
    expect(aggregateIncident([t]).unattributed).toEqual(["d9"]);
  });
});

describe("typeArgsOf", () => {
  it("splits at top-level commas only", () => {
    expect(typeArgsOf("0x1::pool::Pool<0x2::a::A, 0x3::lp::LP<0x4::b::B, 0x5::c::C>, 0x6::fee::F>")).toEqual([
      "0x2::a::A",
      "0x3::lp::LP<0x4::b::B, 0x5::c::C>",
      "0x6::fee::F",
    ]);
    expect(typeArgsOf("0x2::sui::SUI")).toEqual([]);
  });
});
