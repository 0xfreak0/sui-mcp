import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { GrpcTypes } from "@mysten/sui/grpc";
import {
  aggregateIncident,
  callerValueWrites,
  maxLiquidity,
  oracleTouches,
  pairFlashLegs,
  poolFlows,
  poolOfEvent,
  readSwap,
  reconcileValue,
  reconciliationAnomaly,
  recordedChanges,
  sharedObjectsOf,
  stateLossOf,
  tradeAnomalies,
  typeArgsOf,
  valueDeltas,
  type ArgRef,
  type AttackCall,
  type AttackEvent,
  type AttackInput,
  type AttackTx,
} from "../src/utils/attack-analysis.js";
import { fromGrpcTransaction, pureValues, readPureArg } from "../src/utils/attack-read.js";
import type { StateSnapshot } from "../src/utils/state-delta.js";

/**
 * Transaction DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x, as the
 * mainnet archive returned it over gRPC: every command and input, the first two
 * events, the pool and position objects and the balance changes.
 */
const CETUS_GRPC = JSON.parse(readFileSync(new URL("./fixtures/cetus-exploit-grpc.json", import.meta.url), "utf8"), (_k, v) =>
  v && typeof v === "object" && "$bigint" in v
    ? BigInt(v.$bigint)
    : v && typeof v === "object" && "$bytes" in v
      ? new Uint8Array(Buffer.from(v.$bytes, "base64"))
      : v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data)
        ? Uint8Array.from(v.data)
        : v,
) as GrpcTypes.ExecutedTransaction;

const POOL = "0x871d8a227114f375170f149f7e9d45be822dd003eba225e83c05ac80828596bc";
const CONFIG = "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f";
const CLOCK = `0x${"0".repeat(63)}6`;
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const HASUI = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI";
const ATTACKER = "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06";
const CETUS_EV = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::";

/** The four liquidity events the transaction emits after the swap, as mainnet decodes them. */
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

  it("keeps each argument as a reference and the integers each pure input carries, so a value can be followed into a call", () => {
    const add = cetus.calls.find((c) => c.function === "add_liquidity")!;
    expect(add.args).toEqual([{ input: 0 }, { input: 1 }, { result: 10 }, { input: 10 }, { input: 5 }]);
    // Input 4: a u128 sqrt-price limit, 16 bytes little-endian.
    expect(cetus.inputs?.[4]).toEqual({ objectId: null, bytes: 16, values: [(80n + 59n * 256n + 1n * 65536n + 1n * 2n ** 32n).toString()] });
    // The pool is a shared input taken mutably, so events naming it are attributed to it.
    expect(cetus.objects.find((o) => o.objectId === POOL)?.shared).toBe(true);
  });

  it("reads a vector<u64> or vector<u128> pure input's elements", () => {
    const vec = Uint8Array.from([2, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(pureValues(vec)).toEqual(["1", "2"]);
    expect(pureValues(Uint8Array.from([7, 0, 0, 0, 0, 0, 0, 0]))).toEqual(["7"]);
    expect(pureValues(new TextEncoder().encode("\u0005hello"))).toEqual([]);
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
    pureArgs: [],
    args: [],
  });

  it("pairs a borrow repaid later in the PTB (Nemo's borrow_pt_amount / repay_pt_amount)", () => {
    // Object ids from transaction 19Zkat1xArMTMvPCB4e4QtM5HstpYiKvgPjbvkLUAw9.
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
      new Map([[POOL, null]]),
    );
    expect(legs).toEqual([
      expect.objectContaining({ kind: "flash_swap", basis: "events", borrow: expect.objectContaining({ event: 0 }), repay: expect.objectContaining({ event: 2 }), objects: [POOL] }),
    ]);
  });
});

describe("readSwap", () => {
  it("reads the Cetus exploit swap's price collapse from its sqrt prices", () => {
    const s = readSwap(cetus.events[0], sharedObjectsOf(cetus))!;
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
  });

  it("reads Typus's coin-named swap: what the pool took in and paid out, and in which coins", () => {
    // Event 3 of 6KJvWtmr… as mainnet returns it.
    const s = readSwap({
      index: 3,
      type: "0xe27969a70f93034de9ce16e6ad661b480324574e68d15a64b513fd90eb2423e5::lp_pool::SwapEvent",
      json: {
        from_token_type: "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
        from_amount: "1",
        to_token_type: "876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC",
        actual_to_amount: "60000000",
        oracle_price_from_token: "651548270",
        oracle_price_to_token: "1",
      },
    })!;
    expect(s).toMatchObject({
      amount_in: "1",
      amount_out: "60000000",
      coin_in: SUI,
      coin_out: "0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC",
    });
  });

  describe("Nemo market swaps (signed Q64.64 amounts)", () => {
    const SY = "0x53a8c1ffcdac36d993ce3c454d001eca57224541d1953d827ef96ac6d7f8142e::sSUI::SSUI";
    const MARKET_STATE = "0x7472959314b24ebfbd4da49cc36abb3da29f722746019c692407aaf6b47e9a08";
    const nemoSwap = (syPositive: boolean, pt: string, sy: string): AttackEvent => ({
      index: 0,
      type: `0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4::market::SwapEvent<${SY}>`,
      json: {
        market_state_id: "0x7472959314b24ebfbd4da49cc36abb3da29f722746019c692407aaf6b47e9a08",
        pt_amount: { value: pt, positive: false },
        sy_amount: { value: sy, positive: syPositive },
      },
    });

    it("reads a PT sale as PT in and SY out when the market's SY change is negative", () => {
      // Event 0 of 19Zkat1x…: 1,500 PT sold.
      const s = readSwap(nemoSwap(false, "27670116110564327424000000000000", "25143389490131640358055777316401"), new Map([[MARKET_STATE, null]]))!;
      expect(s).toMatchObject({
        pool: "0x7472959314b24ebfbd4da49cc36abb3da29f722746019c692407aaf6b47e9a08",
        coin_in: `PT<${SY}>`,
        amount_in: "1500000000000",
        coin_out: SY,
        amount_out: "1363025875442",
      });
    });

    it("reads a PT purchase as SY in and PT out when the market's SY change is positive, though pt_amount is negative too", () => {
      // Event 7 of AGNrep24…: router::swap_exact_sy_for_pt.
      const s = readSwap(nemoSwap(true, "578110112547648518281670688768", "3541773759688589196650002465834"))!;
      expect(s).toMatchObject({ coin_in: SY, amount_in: "191999940235", coin_out: `PT<${SY}>`, amount_out: "31339411998" });
    });

    it("nets the market's own PT and SY across its swaps, with PT kept apart from coins and never priced", () => {
      const flows = poolFlows({
        events: [
          nemoSwap(false, "27670116110564327424000000000000", "25143389490131640358055777316401"),
          { ...nemoSwap(false, "27670116110564327424000000000000", "25143389490131640358055777316401"), index: 1 },
        ],
        objects: [{ objectId: MARKET_STATE, objectType: null, shared: true }],
      });
      expect(flows).toHaveLength(1);
      expect(flows[0].deltas.get(`PT<${SY}>`)).toBe(3000000000000n);
      expect(flows[0].deltas.get(SY)).toBe(-2726051750884n);
      const v = valueDeltas(flows[0].deltas, new Map([[SY, { price: 3, publishTime: 0, source: "defillama" as const }]]));
      expect(v.unpriced).toEqual([`PT<${SY}>`]);
      expect(v.coins.find((c) => c.coin_type === `PT<${SY}>`)?.usd).toBeNull();
      expect(v.usd_net).toBeLessThan(0);
    });
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
    const f = poolFlows({ events: LIQUIDITY_EVENTS.slice(0, 1), objects: [{ objectId: POOL, objectType: null, shared: true }] })[0];
    expect([...f.deltas]).toEqual([
      ["A", 1n],
      ["B", 0n],
    ]);
  });

  it("lists a pool event with amounts it cannot read instead of guessing", () => {
    const f = poolFlows({ events: [{ index: 7, type: "0xdex::pool::Rebalanced", json: { pool: POOL, amount: "5" } }], objects: [{ objectId: POOL, objectType: null, shared: true }] })[0];
    expect(f.undecoded_events).toEqual([7]);
    expect(f.deltas.size).toBe(0);
  });

  // BlueMove's drain 8pMKBovv… on pool 0xc74e2fac…: an add of 57,205,071 MIST
  // and a removal of 7,022,208,298,020, keyed by side and direction in their
  // field names; and a swap from Auzj4Qzk….
  const BM_POOL = "0xc74e2faca55745620d801fa46f1c7f29907e85483b78951712dba9b84c5a85c7";
  const MEME = "0xae24ae86fdc507ff4ee375679ae379b40f045ce8435a7bf9458d60b8f1bd7e34::aaameme::AAAMEME";
  const BM = "0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9::swap::";
  const bmPool = [{ objectId: BM_POOL, objectType: `${BM}Pool<${SUI}, ${MEME}>`, shared: false, parent: `0x${"93".repeat(32)}` }];
  const names = { token_x_name: "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI", token_y_name: MEME.slice(2) };

  it("reads liquidity amounts keyed by side and direction in their field names, whatever the event is called", () => {
    const f = poolFlows({
      events: [
        { index: 0, type: `${BM}Add_Liquidity_Pool`, json: { pool_id: BM_POOL, ...names, token_x_amount_in: "57205071", token_y_amount_in: "52225167453", lsp_balance: "18446539931587002074", fee_amount: "0" } },
        { index: 1, type: `${BM}Remove_Liqidity_Pool`, json: { pool_id: BM_POOL, ...names, token_x_amount_out: "7022208298020", token_y_amount_out: "6424563423336090", fee_amount: "0" } },
      ],
      objects: bmPool,
    })[0];
    expect(f.deltas.get(SUI)).toBe(57205071n - 7022208298020n);
    expect(f.deltas.get(MEME)).toBe(52225167453n - 6424563423336090n);
    expect(f.undecoded_events).toEqual([]);
  });

  it("reads a swap whose event keys each side's amount in and out", () => {
    const ev: AttackEvent = {
      index: 3,
      type: `${BM}Swap_Event<${SUI}, ${MEME}>`,
      json: { pool_id: BM_POOL, token_x_in: names.token_x_name, amount_x_in: "2344409525142", token_y_in: names.token_y_name, amount_y_in: "0", token_x_out: names.token_x_name, amount_x_out: "0", token_y_out: names.token_y_name, amount_y_out: "3212307935276169" },
    };
    expect(readSwap(ev, { shared: new Map(), others: new Map([[BM_POOL, bmPool[0].objectType]]) })).toMatchObject({ pool: BM_POOL, a_to_b: true, amount_in: "2344409525142", amount_out: "3212307935276169", coin_in: SUI, coin_out: MEME });
    const f = poolFlows({ events: [ev], objects: bmPool })[0];
    expect([...f.deltas]).toEqual([
      [SUI, 2344409525142n],
      [MEME, -3212307935276169n],
    ]);
  });

  it("reads a vault's own USD value change directly, when its event names the vault but no coin amount", () => {
    // Volo's operation::OperationValueUpdateChecked from transaction
    // 7pTrudZb…: before 3459696699234926, after 1975074163896377, a
    // $1,484,622.535338549 loss.
    const VAULT = "0x79d30e223ca30e61b736b76bc9c55a6dc32bc3ad4f43bd7f361b653ab2ad38d3";
    const f = poolFlows({
      events: [
        {
          index: 0,
          type: "0xcd86f77503a755c48fe6c87e1b8e9a137ec0c1bf37aac8878b6083262b27fefa::operation::OperationValueUpdateChecked",
          json: {
            vault_id: VAULT,
            total_usd_value_before: "3459696699234926",
            total_usd_value_after: "1975074163896377",
            loss: "1484622535338549",
          },
        },
      ],
      objects: [{ objectId: VAULT, objectType: null, shared: true }],
    })[0];
    expect(f.pool).toBe(VAULT);
    expect(f.deltas.size).toBe(0);
    expect(f.recorded_loss_usd).toBeCloseTo(1484622.535338549, 6);
    expect(f.recorded_changes).toEqual([{ event: 0, field: "total_usd_value", before: "3459696699234926", after: "1975074163896377" }]);
    expect(f.events).toEqual([0]);
  });

  // Scallop exploit 6WNDjCX3…: the rewards event names its pool as
  // rewards_pool_id beside the spool, and moves SUI in a shape not read here.
  const REWARDS_POOL = "0x162250ef72393a4ad3d46294c4e1bdfcb03f04c869d390e7efbfc995353a7ee9";
  const SSUI_SPOOL = "0x4f0ba970d3c11db05c8f40c64a15b6a33322db3702d634ced6536960ab6f3ee4";
  const redeem: AttackEvent = {
    index: 3,
    type: "0xec1ac7f4d01c5bf178ff4e62e523e7df7721453d81d4904a42a0ffc2686c843d::user::SpoolAccountRedeemRewardsEventV2",
    json: {
      previous_points: "162019889778297",
      redeemed_points: "150098061595978",
      rewards: "150098061595978",
      rewards_fee: "0",
      rewards_pool_id: REWARDS_POOL,
      rewards_type: "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
      spool_account_id: "0x2a710b62bf4f905546489d6f9bc4428b0dfba92532a7c04be519e97cdc0fbda0",
      spool_id: SSUI_SPOOL,
    },
  };
  const scallopObjects = [
    { objectId: SSUI_SPOOL, objectType: "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a::spool::Spool", shared: true },
    { objectId: REWARDS_POOL, objectType: "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a::rewards_pool::RewardsPool<0x2::sui::SUI>", shared: true },
  ];

  it("attributes an event to the changed shared object whose id one of its fields carries, whatever the field is named", () => {
    expect(poolOfEvent(redeem.json, sharedObjectsOf({ objects: scallopObjects }))).toBe(REWARDS_POOL);
    // The spool account is not a changed shared object, and neither pool is here.
    expect(poolOfEvent(redeem.json, new Map())).toBeNull();
    const [f] = poolFlows({ events: [redeem], objects: scallopObjects });
    expect(f.pool).toBe(REWARDS_POOL);
    // A coin type beside a number: a coin moved in a shape not read here.
    expect(f.undecoded_events).toEqual([3]);
  });

  it("attributes an event to a changed pool another object owns when no changed shared object is named", () => {
    // A pool kept as a dynamic object field of a registry, as Typus's TLP
    // pool 0x98110aae… is.
    const CHILD = "0x98110aae0ffaf294259066380a2d35aba74e42860f1e87ee9c201f471eb3ba03";
    const flows = poolFlows({
      events: [
        { index: 0, type: `${CETUS_EV}SwapEvent`, json: { pool: CHILD, atob: true, amount_in: "10", amount_out: "7" } },
        { index: 1, type: `${CETUS_EV}RemoveLiquidityEvent`, json: { pool: CHILD, amount_a: "3", amount_b: "4" } },
      ],
      objects: [{ objectId: CHILD, objectType: `${CETUS_EV}Pool<${SUI}, ${HASUI}>`, shared: false, parent: `0x${"7a".repeat(32)}` }],
    });
    expect(flows).toHaveLength(1);
    expect(flows[0].pool).toBe(CHILD);
    expect(flows[0].deltas.get(SUI)).toBe(7n);
    expect(flows[0].deltas.get(HASUI)).toBe(-11n);
  });

  it("reads before/after pairs in every naming shape", () => {
    const changes = recordedChanges({
      index: 9,
      type: "0xv::vault::Checked",
      json: { nav_before: "10", nav_after: "5", before_sqrt_price: "7", after_sqrt_price: "8", old_rate: "1", new_rate: "2", index_old: "3", index_new: "4", total_before: "x" },
    });
    expect(changes.map((c) => [c.field, c.before, c.after])).toEqual([
      ["nav", "10", "5"],
      ["sqrt_price", "7", "8"],
      ["rate", "1", "2"],
      ["index", "3", "4"],
    ]);
  });

  it("decodes a type-keyed swap with no pool id of its own, attributed to the transaction's single pool-shaped object", () => {
    // Typus's lp_pool::SwapEvent as mainnet returns it (6KJvWtmr…): no
    // pool/pool_id field, only the two coin types that moved.
    const POOL_ID = "0x98110aae0ffaf294259066380a2d35aba74e42860f1e87ee9c201f471eb3ba03";
    const SUI_TYPE = "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
    const XBTC_TYPE = "876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC";
    const f = poolFlows({
      events: [
        {
          index: 0,
          type: "0xe27969a70f93034de9ce16e6ad661b480324574e68d15a64b513fd90eb2423e5::lp_pool::SwapEvent",
          json: { from_token_type: SUI_TYPE, from_amount: "1", to_token_type: XBTC_TYPE, actual_to_amount: "60000000" },
        },
      ],
      objects: [{ objectId: POOL_ID, objectType: "0xe27969a70f93034de9ce16e6ad661b480324574e68d15a64b513fd90eb2423e5::lp_pool::LiquidityPool" }],
    })[0];
    expect(f.pool).toBe(POOL_ID);
    expect(f.deltas.get(`0x${"0".repeat(63)}2::sui::SUI`)).toBe(1n);
    expect(f.deltas.get(`0x${XBTC_TYPE}`)).toBe(-60000000n);
  });

  it("does not attribute a type-keyed swap when more than one pool-shaped object was touched", () => {
    const f = poolFlows({
      events: [
        {
          index: 0,
          type: "0xe27969a70f93034de9ce16e6ad661b480324574e68d15a64b513fd90eb2423e5::lp_pool::SwapEvent",
          json: { from_token_type: "0x2::sui::SUI", from_amount: "1", to_token_type: "0xabc::xbtc::XBTC", actual_to_amount: "1" },
        },
      ],
      objects: [
        { objectId: "0xaaa", objectType: "0xe279::lp_pool::LiquidityPool" },
        { objectId: "0xbbb", objectType: "0xe279::other_pool::LiquidityPool" },
      ],
    });
    expect(f).toEqual([]);
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
      pureArgs: [],
      args: [],
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

describe("tradeAnomalies", () => {
  // Objects and packages from the Typus exploit 6KJvWtmr… and an ordinary
  // Typus swap, Ch14Spv4….
  const ORACLE_PKG = "0x4658a0fbd9a234dfc87726addcbe1a602f27ce4513ecc1ec99e6d973c7bfb101";
  const PERP_PKG = "0x9eda9afa0b42bf908766c42d02a549c271d7d0ae02c8c58c5075858f8f4d3b69";
  const PRICE_EVENT = "0x855eb2d260ee42b898266e6df90bfd3c4ed821ccb253a352c159c223244a4b8a::oracle::PriceEvent";
  const SUI_ORACLE = "0x0a318f26fcf35922a8671a2d843872a7a25ac10b678bdee52f10fbc77140c0d0";
  const XBTC_ORACLE = "0x6e7ca39c4ad0a1ad83937e98b220824566d858814aa8fd01294400b45c2bbc21";
  const AUTHORITY = "0xef710183951f400bc1480bab662d793e7ff324192a2518d8bd036358d9f0fb85";
  const VERSION = "0xa12c282a068328833ec4a9109fc77803ec1f523f8da1bb0f82bac8450335f0c9";
  const REGISTRY = "0xfee68e535bf24702be28fa38ea2d5946e617e0035027d5ca29dbed99efd82aaa";

  type Step = { command: number; pkg: string; module: string; fn: string; objects: string[]; pures?: string[]; results?: number[] };
  /** A PTB of Move calls: object and pure inputs deduplicated into `inputs`, every argument as a reference. */
  const ptb = (steps: Step[], events: AttackEvent[], shared: string[]) => {
    const inputs: AttackInput[] = [];
    const index = new Map<string, number>();
    const input = (key: string, make: () => AttackInput) => {
      if (!index.has(key)) {
        index.set(key, inputs.length);
        inputs.push(make());
      }
      return index.get(key)!;
    };
    const calls: AttackCall[] = steps.map((s) => {
      const pures = (s.pures ?? []).map((h) => Uint8Array.from(Buffer.from(h, "hex")));
      const args: ArgRef[] = [
        ...s.objects.map((id) => ({ input: input(id, () => ({ objectId: id, bytes: 0, values: [] })) })),
        ...pures.map((b, i) => ({ input: input(`${s.command}:${i}`, () => ({ objectId: null, bytes: b.length, values: pureValues(b) })) })),
        ...(s.results ?? []).map((r) => ({ result: r })),
      ];
      return { command: s.command, package: s.pkg, module: s.module, function: s.fn, typeArguments: [], objectArgs: s.objects, pureArgs: pures.map(readPureArg), args };
    });
    return { calls, events, inputs, vectors: [], balanceChanges: [], objects: shared.map((objectId) => ({ objectId, objectType: null, shared: true })) };
  };
  const update = (command: number, oracle: string, pures: string[]): Step => ({ command, pkg: ORACLE_PKG, module: "oracle", fn: "update_v2", objects: [oracle, AUTHORITY, CLOCK], pures });
  const swap = (command: number): Step => ({ command, pkg: PERP_PKG, module: "lp_pool", fn: "swap", objects: [VERSION, REGISTRY, SUI_ORACLE, XBTC_ORACLE, CLOCK], pures: ["0000000000000000"] });
  const priceEvent = (index: number, id: string, price: string): AttackEvent => ({ index, type: PRICE_EVENT, json: { id, price, ts_ms: "1760533514130" } });
  const callerAnomaly = (tx: ReturnType<typeof ptb>, state?: StateSnapshot) => tradeAnomalies(tx, state).find((a) => a.code === "caller-value-used");

  it("flags a value the caller passed that is written into an oracle and then swapped against, high when the oracle's values span 100x", () => {
    const a = callerAnomaly(
      ptb(
        [
          // 651548270 and 1, little-endian u64, as the exploit passed them.
          update(1, SUI_ORACLE, ["6ed6d52600000000", "6ed6d52600000000"]),
          update(2, XBTC_ORACLE, ["0100000000000000", "0100000000000000"]),
          swap(3),
          // The restore: xBTC back to 111,981.21692376.
          update(26, XBTC_ORACLE, ["d8cc10442f0a0000", "206837c3360a0000"]),
        ],
        [priceEvent(0, SUI_ORACLE, "651548270"), priceEvent(1, XBTC_ORACLE, "1"), priceEvent(18, XBTC_ORACLE, "11198121692376")],
        [SUI_ORACLE, XBTC_ORACLE],
      ),
    );
    expect(a?.severity).toBe("high");
    expect(a?.evidence[0]).toContain(XBTC_ORACLE);
  });

  it("grades a caller value written and used with no swing medium, the shape of a keeper's own set-and-settle", () => {
    const a = callerAnomaly(
      ptb(
        [
          // JBu7nxgh…: 278060333, little-endian u64.
          update(1, SUI_ORACLE, ["2ddd921000000000", "2ddd921000000000"]),
          { command: 2, pkg: "0xb36979a2a2bfccfc9ebbacbc786c923dc7e92cc00cba5ec685fd5b3ce9490463", module: "tds_authorized_entry", fn: "settle", objects: ["0x3d70b09359e3ca8301ae0abeda4f2fdf72ce313ba58c919ce568e5f535fd2ea8", SUI_ORACLE, CLOCK] },
        ],
        [priceEvent(1, SUI_ORACLE, "278060333")],
        [SUI_ORACLE],
      ),
    );
    expect(a?.severity).toBe("medium");
  });

  /** The oracle read at both versions with `price` at `p` before and after. */
  const oracleState = (id: string, before: string, after: string): StateSnapshot => ({
    objects: [{ objectId: id, objectType: "0x855e::oracle::Oracle", role: "shared", parent: null, before: { id, price: before }, after: { id, price: after }, balances: {}, supplies: {} }],
    skipped: [],
    unavailable: [],
    layout_unread: [],
  });

  it("flags a set, use and restore to the exact prior value high once the oracle's state is read", () => {
    // The field is unchanged across the transaction; its events show the
    // caller's 1 in between.
    const P = "11198121692376";
    const tx = ptb(
      [update(1, XBTC_ORACLE, ["0100000000000000", "0100000000000000"]), swap(2), update(3, XBTC_ORACLE, ["d8cc10442f0a0000", "d8cc10442f0a0000"])],
      [priceEvent(0, XBTC_ORACLE, "1"), priceEvent(4, XBTC_ORACLE, P)],
      [XBTC_ORACLE],
    );
    expect(callerAnomaly(tx, oracleState(XBTC_ORACLE, P, P))?.severity).toBe("high");
  });

  it("does not follow a small number or one the field held throughout, which equal a stored flag or zero by chance", () => {
    // BrnZ3L43…: a vault's status set to 1 for an operation and back to 0;
    // 9ioTHz4j…: an obligation's bad_debt_usd of 0, beside a caller's 0.
    const VAULT = "0x3be6c14feba10631a0c22d9044a16122e81b1bf59fb20a2ecc840d203f964c89";
    const status = (index: number, v: string): AttackEvent => ({ index, type: "0xcd86::vault::VaultStatusChanged", json: { vault_id: VAULT, status: v } });
    const tx = ptb(
      [
        { command: 1, pkg: "0xcd86", module: "operation", fn: "start_op", objects: [VAULT], pures: ["01", "0000000000000000"] },
        { command: 2, pkg: "0xcd86", module: "operation", fn: "end_op", objects: [VAULT] },
      ],
      [status(0, "1"), status(1, "0")],
      [VAULT],
    );
    const state: StateSnapshot = {
      objects: [{ objectId: VAULT, objectType: "0xcd86::vault::Vault", role: "shared", parent: null, before: { status: "0" }, after: { status: "0" }, balances: {}, supplies: {} }],
      skipped: [],
      unavailable: [],
      layout_unread: [],
    };
    expect(callerAnomaly(tx, state)).toBeUndefined();
  });

  it("grades a caller write that moves the stored value 10x to 99x high, below 10x medium", () => {
    // 50x: 278060333 / 50 = 5561206, little-endian u64.
    const tx50 = ptb([update(1, SUI_ORACLE, ["76db540000000000", "76db540000000000"]), swap(2)], [priceEvent(0, SUI_ORACLE, "5561206")], [SUI_ORACLE]);
    expect(callerAnomaly(tx50, oracleState(SUI_ORACLE, "278060333", "5561206"))?.severity).toBe("high");
    // 2x: 139030166, little-endian u64.
    const tx2 = ptb([update(1, SUI_ORACLE, ["966e490800000000", "966e490800000000"]), swap(2)], [priceEvent(0, SUI_ORACLE, "139030166")], [SUI_ORACLE]);
    expect(callerAnomaly(tx2, oracleState(SUI_ORACLE, "278060333", "139030166"))?.severity).toBe("medium");
  });

  it("does not flag a caller-set value nothing later reads", () => {
    expect(callerAnomaly(ptb([update(1, XBTC_ORACLE, ["0100000000000000", "0100000000000000"])], [priceEvent(0, XBTC_ORACLE, "1")], [XBTC_ORACLE]))).toBeUndefined();
  });

  it("does not flag an oracle refreshed from Pyth and then swapped against, the ordinary Typus flow", () => {
    const PYTH_STATE = "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8";
    const PRICE_INFO = "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37";
    const tx = ptb(
      [
        { command: 3, pkg: "0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91", module: "pyth", fn: "update_single_price_feed", objects: [PYTH_STATE, PRICE_INFO, CLOCK] },
        { command: 6, pkg: "0xd32562714f75525802377f6314736f41b01e1da29d894b7cdaf97356e8a226da", module: "oracle", fn: "update_with_pyth_usd", objects: [SUI_ORACLE, PYTH_STATE, PRICE_INFO, CLOCK] },
        { ...swap(9), pures: [] },
      ],
      [priceEvent(2, SUI_ORACLE, "216620047")],
      [SUI_ORACLE, PRICE_INFO],
    );
    expect(callerAnomaly(tx)).toBeUndefined();
  });

  it("lowers, but does not clear, a write that carries a signature-length argument", () => {
    const signature = `41${"ab".repeat(65)}`;
    const a = callerAnomaly(
      // 1000000, little-endian u64, later restored to 11198121692376.
      ptb([update(1, XBTC_ORACLE, ["40420f0000000000", signature]), swap(3)], [priceEvent(1, XBTC_ORACLE, "1000000"), priceEvent(5, XBTC_ORACLE, "11198121692376")], [XBTC_ORACLE]),
    );
    expect(a?.severity).toBe("medium");
  });

  it("follows a caller value through a call built only from pure inputs into the object it is stored in (Nemo's index)", () => {
    // 19Zkat1x…: fixed_point64::create_from_raw_value(30000 << 64), then
    // py::get_sy_amount_in_for_exact_py_out writes it into the PyState that
    // yield_factory::mint_py reads.
    const PY = "0xc6840365f500bee8732a3a256344a11343936b864c144b7e9de5bb8c54224fbe";
    const tx = ptb(
      [
        { command: 203, pkg: "0x1", module: "fixed_point64", fn: "create_from_raw_value", objects: [], pures: ["00000000000000003075000000000000"] },
        { command: 204, pkg: "0x0f28", module: "py", fn: "get_sy_amount_in_for_exact_py_out", objects: [PY, CLOCK], pures: ["0100000000000000"], results: [203] },
        { command: 207, pkg: "0x0f28", module: "yield_factory", fn: "mint_py", objects: [PY, CLOCK] },
      ],
      [],
      [PY],
    );
    const state: StateSnapshot = {
      objects: [
        {
          objectId: PY,
          objectType: "0x2b71::py::PyState<0x53a8::sSUI::SSUI>",
          role: "shared",
          parent: null,
          before: { py_index_stored: { value: "19906979018978642498" } },
          after: { py_index_stored: { value: "553402322211286548480000" } },
          balances: {},
          supplies: {},
        },
      ],
      skipped: [],
      unavailable: [],
      layout_unread: [],
    };
    const a = callerAnomaly(tx, state);
    expect(a?.severity).toBe("high");
    expect(a?.evidence[0]).toContain("py_index_stored.value");
  });

  it("with the object's state read, does not take an event echoing an amount as a stored value", () => {
    // A liquidity add: the event states the delta the caller passed, while
    // the pool's own liquidity after the transaction is a different number.
    const tx = ptb(
      [
        { command: 1, pkg: "0xc6fa", module: "pool", fn: "add_liquidity", objects: [POOL, CLOCK], pures: ["40420f0000000000"] },
        { command: 2, pkg: "0xc6fa", module: "pool", fn: "repay_add_liquidity", objects: [POOL] },
      ],
      [{ index: 0, type: `${CETUS_EV}AddLiquidityEvent`, json: { pool: POOL, liquidity: "1000000", amount_a: "5", amount_b: "5" } }],
      [POOL],
    );
    const state: StateSnapshot = {
      objects: [{ objectId: POOL, objectType: null, role: "shared", parent: null, before: { liquidity: "900000000" }, after: { liquidity: "901000000" }, balances: {}, supplies: {} }],
      skipped: [],
      unavailable: [],
      layout_unread: [],
    };
    expect(callerAnomaly(tx, state)).toBeUndefined();
  });

  it("names every field that holds the caller's value when the effects cannot say which command wrote it", () => {
    // Nemo 19Zkat1x…: after the transaction both of PyState's index fields
    // hold the caller's 30000 << 64; command 204 wrote one and 207 the other.
    const PY = "0xc6840365f500bee8732a3a256344a11343936b864c144b7e9de5bb8c54224fbe";
    const V = "553402322211286548480000";
    const tx = ptb(
      [
        { command: 203, pkg: "0x1", module: "fixed_point64", fn: "create_from_raw_value", objects: [], pures: ["00000000000000003075000000000000"] },
        { command: 204, pkg: "0x0f28", module: "py", fn: "get_sy_amount_in_for_exact_py_out", objects: [PY, CLOCK], pures: ["0100000000000000"], results: [203] },
        { command: 207, pkg: "0x0f28", module: "yield_factory", fn: "mint_py", objects: [PY, CLOCK] },
      ],
      [],
      [PY],
    );
    const index = (v: string) => ({ value: v });
    const state: StateSnapshot = {
      objects: [
        {
          objectId: PY,
          objectType: "0x2b71::py::PyState<0x53a8::sSUI::SSUI>",
          role: "shared",
          parent: null,
          before: { last_collect_interest_index: index("19906979018978642498"), py_index_stored: index("19906979018978642498") },
          after: { last_collect_interest_index: index(V), py_index_stored: index(V) },
          balances: {},
          supplies: {},
        },
      ],
      skipped: [],
      unavailable: [],
      layout_unread: [],
    };
    expect(callerValueWrites(tx, state).map((w) => w.fields)).toEqual([["last_collect_interest_index", "py_index_stored"]]);
  });

  // Aftermath Perpetuals 531W14qr…: the caller's integrator fee, -100,000 at 18
  // decimals as a u256, reaches the ClearingHouse only multiplied by the fill's
  // notional, and the ClearingHouse travels inside the session result.
  const CH = "0x95969906ca735c9d44e8a44b5b7791b4dacaddf70fbdfbda40ccd3f8a9fd4920";
  const U256 = 2n ** 256n;
  const le = (v: bigint, n: number) => Array.from({ length: n }, (_, i) => ((v >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("");
  const perps = (fee: bigint, stated: bigint) =>
    ptb(
      [
        { command: 10, pkg: "0x9e20", module: "interface", fn: "start_session", objects: [CH, CLOCK] },
        { command: 13, pkg: "0x9e20", module: "clearing_house", fn: "create_integrator_info", objects: [], pures: [le(fee, 32)] },
        { command: 16, pkg: "0x9e20", module: "interface", fn: "end_session", objects: [], results: [10, 13] },
        { command: 17, pkg: "0x9e20", module: "interface", fn: "deallocate_free_collateral", objects: [CLOCK], results: [16] },
      ],
      [
        {
          index: 11,
          type: "0x21d0::events::FilledTakerOrder",
          json: { ch_id: CH, taker_account_id: "1202", taker_fees: "34667426250000000", integrator_taker_fees: stated.toString(), quote_asset_delta_bid: "77038725000000000000" },
        },
      ],
      [CH],
    );

  it("follows a caller value into a shared object's accounting through a product another number of the event states, not a scale or a coincidence", () => {
    const fee = U256 - 10n ** 23n;
    const writes = callerValueWrites(perps(fee, U256 - 7703872500000000000000000n), undefined);
    expect(writes).toEqual([
      expect.objectContaining({
        object: CH,
        command: 16,
        reader_command: 17,
        fields: ["integrator_taker_fees"],
        value_signed: "-100000000000000000000000",
        product: expect.objectContaining({ stated: "-7703872500000000000000000", factor_field: "quote_asset_delta_bid", scale_digits: 18 }),
      }),
    ]);
    expect(tradeAnomalies(perps(fee, U256 - 7703872500000000000000000n)).find((a) => a.code === "caller-value-used")?.severity).toBe("medium");
    // A caller's 1,000,000 multiplies the notional into another unit; a
    // stated fee that is no product of the caller's value is unrelated.
    expect(callerValueWrites(perps(1000000n, 77038725000000000000000000n), undefined)).toEqual([]);
    expect(callerValueWrites(perps(U256 - 10n ** 23n, U256 - 5000000000000000000000000n), undefined)).toEqual([]);
  });

  it("stops the product search at its comparison limit and says so, rather than running unbounded", () => {
    // A batch of 40 calls into one shared object, each with a caller value no
    // event states, and 40 events naming the object with six numbers each.
    const POOL_B = `0x${"bb".repeat(32)}`;
    const steps: Step[] = Array.from({ length: 40 }, (_, c) => ({ command: c, pkg: "0x9", module: "book", fn: "place", objects: [POOL_B], pures: [le(BigInt(70001 + c * 13), 8)] }));
    const events: AttackEvent[] = Array.from({ length: 40 }, (_, i) => ({
      index: i,
      type: "0x9::book::Placed",
      json: Object.fromEntries([["book", POOL_B], ...Array.from({ length: 6 }, (_, f) => [`n${f}`, String(1234567890123n + BigInt(i * 977 + f * 31))])]),
    }));
    const tx = ptb(steps, events, [POOL_B]);
    const search = { capped: false, limit: 1000 };
    expect(callerValueWrites(tx, undefined, search)).toEqual([]);
    expect(search.capped).toBe(true);
    const full = { capped: false };
    callerValueWrites(tx, undefined, full);
    expect(full.capped).toBe(false);
  });

  // BlueMove drain 8pMKBovv…: the pool's LSP supply and its legacy balances at
  // the input version, and the add that minted 122,000 times the supply.
  const BM_POOL = "0xc74e2faca55745620d801fa46f1c7f29907e85483b78951712dba9b84c5a85c7";
  const MEME = "0xae24ae86fdc507ff4ee375679ae379b40f045ce8435a7bf9458d60b8f1bd7e34::aaameme::AAAMEME";
  const BM_TYPE = `0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9::swap::Pool<${SUI}, ${MEME}>`;
  const bmState = (supply: string): StateSnapshot => ({
    objects: [
      {
        objectId: BM_POOL,
        objectType: BM_TYPE,
        role: "child",
        parent: `0x${"93".repeat(32)}`,
        before: { lsp_supply: { value: supply }, token_x: "7022265624604", token_y: "6424615870978690", reserve_x: "467" },
        after: { lsp_supply: { value: supply }, token_x: "57104920", token_y: "52225167453", reserve_x: "57205538" },
        balances: { token_x: SUI, token_y: MEME },
        supplies: { "lsp_supply.value": `0xb24b::swap::LSP<${SUI}, ${MEME}>` },
      },
    ],
    skipped: [],
    unavailable: [],
    layout_unread: [],
  });
  const bmAdd = (x: string, y: string, minted: string): AttackEvent => ({
    index: 0,
    type: "0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9::swap::Add_Liquidity_Pool",
    json: { pool_id: BM_POOL, token_x_amount_in: x, token_y_amount_in: y, lsp_balance: minted, fee_amount: "0" },
  });
  const shareMint = (ev: AttackEvent, supply: string) =>
    tradeAnomalies({ calls: [], events: [ev], objects: [{ objectId: BM_POOL, objectType: BM_TYPE, shared: false, parent: `0x${"93".repeat(32)}` }], balanceChanges: [] }, bmState(supply)).find(
      (a) => a.code === "outsized-mint",
    );

  it("flags a share mint far above the deposit's share of the object's holdings, not a proportional or a first mint", () => {
    expect(shareMint(bmAdd("57205071", "52225167453", "18446539931587002074"), "150590393429569")?.evidence[0]).toContain(BM_POOL);
    // 1% of each holding for 1% of the supply.
    expect(shareMint(bmAdd("70222656246", "64246158709786", "1505903934295"), "150590393429569")).toBeUndefined();
    expect(shareMint(bmAdd("57205071", "52225167453", "18446539931587002074"), "0")).toBeUndefined();
  });

  const outsized = (events: AttackEvent[]) => tradeAnomalies({ calls: [], events, objects: [], balanceChanges: [] }).find((a) => a.code === "outsized-mint");

  it("flags the Cetus exploit's add: 1.04e34 liquidity for one raw unit, against the global bound and against its own ticks", () => {
    expect(outsized(LIQUIDITY_EVENTS.slice(0, 1))?.severity).toBe("high");
    const ranged = { ...LIQUIDITY_EVENTS[0], json: { ...(LIQUIDITY_EVENTS[0].json as object), tick_lower: { bits: 300000 }, tick_upper: { bits: 300200 } } };
    expect(outsized([ranged])?.evidence[0]).toContain("ticks 300000 to 300200 allow at most");
  });

  it("does not flag ordinary adds, on a wide range, on a one-tick range, or with no amounts named", () => {
    expect(
      outsized([
        // 2Du5VNRM…, a narrow Cetus range: 2e4 liquidity per unit.
        { index: 0, type: `${CETUS_EV}AddLiquidityEvent`, json: { pool: POOL, liquidity: "2426815457172", amount_a: "49663985", amount_b: "71665403" } },
        // Nemo's market LP add carries liquidity and no amount_a/amount_b.
        { index: 1, type: "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4::market::AddLiquidityEvent", json: { liquidity: "199655467567" } },
        // 3ckJEmsC…, Cetus AddLiquidityV2Event on ticks 67500 to 67560.
        { index: 2, type: `${CETUS_EV}AddLiquidityV2Event`, json: { pool: POOL, liquidity: "7134965334007", amount_a: "502537347", amount_b: "195600556774", tick_lower: { bits: 67500 }, tick_upper: { bits: 67560 } } },
        // 4a8LRHpv…, Bluefin LiquidityProvided on one tick, -39483 to -39482.
        { index: 3, type: "0x3492::events::LiquidityProvided", json: { liquidity: "97169841631", coin_a_amount: "16096535", coin_b_amount: "364248", lower_tick: { bits: 4294927813 }, upper_tick: { bits: 4294927814 } } },
      ]),
    ).toBeUndefined();
  });

  it("bounds a position's liquidity by what its amounts buy at the best price for it", () => {
    // L = 1e6 on ticks -100..100 at price 1: a = L (sb - 1) / sb, b = L (1 - sa).
    const sa = 1.0001 ** -50;
    const sb = 1.0001 ** 50;
    const a = BigInt(Math.floor((1e6 * (sb - 1)) / sb));
    const b = BigInt(Math.floor(1e6 * (1 - sa)));
    const bound = maxLiquidity(a, b, -100, 100);
    expect(bound).toBeGreaterThanOrEqual(1e6);
    expect(bound).toBeLessThan(1.01e6);
  });
});

describe("reconcileValue", () => {
  const ATTACKER_S = "0x27bc7a3c4f406cfa91551c32490ad7f5029414578c0649ab4ddbd232e76ef44e";
  const REWARDS_POOL = "0x162250ef72393a4ad3d46294c4e1bdfcb03f04c869d390e7efbfc995353a7ee9";
  const prices = new Map([[SUI, { price: 0.95, publishTime: 0, source: "defillama" as const }]]);
  const gain = [{ address: ATTACKER_S, coinType: SUI, amount: "150098051263289" }];

  it("leaves value that reached addresses unexplained when no decoded event or read holding paid it out", () => {
    const r = reconcileValue({ balanceChanges: gain }, [], prices);
    expect(r.decoded_usd).toBe(0);
    expect(r.state_usd).toBeNull();
    expect(r.unexplained_usd).toBeCloseTo(150098.051263289 * 0.95, 1);
  });

  it("explains it by a read object's Balance<T> holding that fell by the same amount", () => {
    const state: StateSnapshot = {
      objects: [
        {
          objectId: "0xeb92a6590daf1b37666ce8b2e35d241741c323dee20a4c40abb49350ae658380",
          objectType: `0x2::dynamic_field::Field<0x1::type_name::TypeName,0x2::balance::Balance<${SUI}>>`,
          role: "holding",
          parent: REWARDS_POOL,
          before: { value: "150098061595978" },
          after: { value: "0" },
          balances: { value: SUI },
          supplies: {},
        },
      ],
      skipped: [],
      unavailable: [],
      layout_unread: [],
    };
    const r = reconcileValue({ balanceChanges: gain }, [], prices, state);
    expect(r.unexplained).toEqual([]);
    expect(r.state_usd).toBeCloseTo(150098.051263289 * 0.95, 1);
  });

  it("raises unreconciled-gain for an unpriced coin nothing read paid out, never valuing it at zero", () => {
    const RECEIPT = "0xabc::receipt::RECEIPT";
    const r = reconcileValue({ balanceChanges: [{ address: ATTACKER_S, coinType: RECEIPT, amount: "900000000000000" }] }, [], prices, {
      objects: [],
      skipped: [],
      unavailable: [],
      layout_unread: [],
    });
    expect(r.unexplained).toEqual([expect.objectContaining({ usd: null })]);
    expect(r.unexplained_usd).toBe(0);
    expect(reconciliationAnomaly(r, 1)?.title).toContain("1 unpriced coin");
  });

  it("explains a coin minted by a read TreasuryCap's supply rising, an LST mint", () => {
    const LST = "0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI";
    const state: StateSnapshot = {
      objects: [
        {
          objectId: "0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b",
          objectType: `0xb0575765166030556a6eafd3b1b970eba8183ff748860680245b9edd41c716e7::liquid_staking::LiquidStakingInfo<${LST}>`,
          role: "shared",
          parent: null,
          before: { lst_treasury_cap: { total_supply: { value: "1000" } } },
          after: { lst_treasury_cap: { total_supply: { value: "1500" } } },
          balances: {},
          supplies: { "lst_treasury_cap.total_supply.value": LST },
        },
      ],
      skipped: [],
      unavailable: [],
      layout_unread: [],
    };
    const minted = { balanceChanges: [{ address: ATTACKER_S, coinType: LST, amount: "500" }] };
    const lstPrice = new Map([[LST, { price: 1, publishTime: 0, source: "defillama" as const }]]);
    expect(reconcileValue(minted, [], lstPrice).unexplained).toHaveLength(1);
    expect(reconcileValue(minted, [], lstPrice, state).unexplained).toEqual([]);
  });

  it("explains a swap by the pool's decoded payout, and cancels coins that only moved between addresses", () => {
    const flows = poolFlows(cetusFull);
    const r = reconcileValue({ balanceChanges: [...cetusFull.balanceChanges, { address: "0xa", coinType: SUI, amount: "-7" }, { address: "0xb", coinType: SUI, amount: "7" }] }, flows, prices);
    expect(r.unexplained.filter((u) => u.coin_type === SUI)).toEqual([]);
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
    objects: [
      { objectId: POOL, objectType: null, shared: true },
      { objectId: "0xb", objectType: null, shared: true },
    ],
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

  /**
   * `poolFlows` credits an id-less, type-keyed swap (Typus's
   * `lp_pool::SwapEvent`) to the transaction's one pool-shaped object. With a
   * second event naming a vault, the transaction is grouped under both the
   * vault and that pool, so the pool's deltas stay in the grouping as they
   * do in analyze_attack_tx.
   */
  it("groups a type-keyed swap under the pool its deltas are credited to, beside an event-named vault", () => {
    const LP = "0x98110aae0ffaf294259066380a2d35aba74e42860f1e87ee9c201f471eb3ba03";
    const VAULT = "0x79d30e223ca30e61b736b76bc9c55a6dc32bc3ad4f43bd7f361b653ab2ad38d3";
    const XBTC = "0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC";
    const t: AttackTx = {
      ...tx("d1", POOL, "0"),
      events: [
        {
          index: 0,
          type: "0xe27969a70f93034de9ce16e6ad661b480324574e68d15a64b513fd90eb2423e5::lp_pool::SwapEvent",
          json: {
            from_token_type: "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
            from_amount: "1",
            to_token_type: XBTC.slice(2),
            actual_to_amount: "60000000",
          },
        },
        {
          index: 1,
          type: "0xcd86f77503a755c48fe6c87e1b8e9a137ec0c1bf37aac8878b6083262b27fefa::operation::OperationValueUpdateChecked",
          json: { vault_id: VAULT, total_usd_value_before: "3459696699234926", total_usd_value_after: "1975074163896377" },
        },
      ],
      objects: [
        { objectId: LP, objectType: "0xe27969a70f93034de9ce16e6ad661b480324574e68d15a64b513fd90eb2423e5::lp_pool::LiquidityPool" },
        { objectId: VAULT, objectType: null, shared: true },
      ],
    };
    const [g] = aggregateIncident([t]).groups;
    expect(g.pools).toEqual([LP, VAULT].sort());
    expect(g.pool_deltas.get(XBTC)).toBe(-60000000n);
    expect(g.pool_deltas.get(SUI)).toBe(1n);
    expect(g.recorded_loss_usd).toBeCloseTo(1484622.535338549, 6);
  });

  it("groups a transaction no event decodes under the shared object whose Balance holdings fell", () => {
    const VAULT = `0x${"1a".repeat(32)}`;
    const REGISTRY = `0x${"2b".repeat(32)}`;
    const USD = `0x${"c".repeat(64)}::usd::USD`;
    const snap: StateSnapshot = {
      objects: [
        { objectId: VAULT, objectType: "0x9::market::Market", role: "shared", parent: null, before: { collateral: "79828259122" }, after: { collateral: "102816684" }, balances: { collateral: USD }, supplies: {} },
        // Took a fee in: its holdings rose, so it paid nothing out.
        { objectId: REGISTRY, objectType: "0x9::registry::Registry", role: "shared", parent: null, before: { fees: "5" }, after: { fees: "9" }, balances: { fees: USD }, supplies: {} },
      ],
      skipped: [],
      unavailable: [],
      layout_unread: [],
    };
    const t: AttackTx = {
      ...tx("d1", POOL, "0"),
      events: [{ index: 0, type: "0x9::events::FilledOrder", json: { market: VAULT, size: "3" } }],
      balanceChanges: [{ address: ATTACKER, coinType: USD, amount: "79725442434" }],
      objects: [
        { objectId: VAULT, objectType: "0x9::market::Market", shared: true },
        { objectId: REGISTRY, objectType: "0x9::registry::Registry", shared: true },
      ],
    };
    const loss = stateLossOf(snap);
    expect(loss?.pools).toEqual([VAULT]);

    const agg = aggregateIncident([t], undefined, new Map([["d1", loss!]]));
    expect(agg.unattributed).toEqual([]);
    expect(agg.groups).toHaveLength(1);
    expect(agg.groups[0]).toMatchObject({ pools: [VAULT], basis: "state", pool_type: "0x9::market::Market", digests: ["d1"] });
    expect(agg.groups[0].pool_deltas.get(USD)).toBe(102816684n - 79828259122n);
    expect(agg.groups[0].attacker_deltas.get(USD)).toBe(79725442434n);
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
