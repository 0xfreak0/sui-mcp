import { describe, it, expect } from "vitest";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { decodeTransaction, routeLoops } from "../src/protocols/decoder.js";
import { describeRouteLoops, type LoopEvent } from "../src/utils/route-loop-cost.js";

// Shapes of an Aftermath router route: each integration passes the router's
// data type first, then the path's start coin, then its own coins.
const RD = "0x3f0871fc4320e2399734c44eae3a7599c57900a66af6ba6fe0f6e50d2d8bed8a::router::RouterDataV1";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const USDT = "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const TOK = "0x1111111111111111111111111111111111111111111111111111111111111111::tok::TOK";
const ROUTER = "0x7de5de8d75a8f4e42cdd3c018f788bc9b9ebf2d3d61dcfe9d2136f17f077afd5";
const CETUS_INT = "0x8fbcffce4ac1b56d517cc2118fae85f1881a80a934af575d825f63a05af5a874";
const FULLSAIL_INT = "0xbb2f1bc0c032aa7237ead35cbdd42d49ee7b04e1269c37af1ca5ec8e099793cb";
const CETUS_POOL = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool";
const CETUS_SWAP = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent";
const FULLSAIL_SWAP = "0xe74104c66dd9f16b3096db2cc00300e556aa92edc871be4bc052b5dfb80db239::pool::SwapEvent";
const AFTERMATH_SWAP = "0xc4049b2d1cc0f6e017fda8260e4377cecd236bd7f56a54fee120816e72e2e0dd::events::SwapEventV2";
const SENDER = "0xa11ce";

const pool = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function call(pkg: string, fn: string, typeArgs: string[], args: unknown[] = []): GrpcTypes.Command {
  return { command: { oneofKind: "moveCall", moveCall: { package: pkg, module: "router", function: fn, typeArguments: typeArgs, arguments: args } } } as unknown as GrpcTypes.Command;
}

const RESULT = 3;
const begin = (a: string, b: string) => call(ROUTER, "begin_router_tx_r1_w1_varied_in", [a, b]);
/** A path start; `opener` is the command whose result it takes (the route's opening call). */
const start = (coin: string, opener?: number) =>
  call(ROUTER, "initiate_path_by_percent_w1", [RD, coin], opener === undefined ? [] : [{ kind: RESULT, result: opener }]);
const end = (a: string, b: string) => call(ROUTER, "end_router_tx_r1_w1", [a, b]);

/** A pool swap event as the integration that called the pool emits it. */
function swapEvent(type: string, emitter: string, poolId: string, atob: boolean, amountIn: string, amountOut: string): LoopEvent {
  return { type, package_id: emitter, module: "router", json: { atob, pool: poolId, amount_in: amountIn, amount_out: amountOut } };
}

function loopsOf(
  commands: GrpcTypes.Command[],
  events: LoopEvent[] | { unread: string },
  objects: Array<{ objectId: string; objectType: string }>,
  success = true,
) {
  const decoded = decodeTransaction(commands, [], SENDER);
  return describeRouteLoops(routeLoops(decoded.route_hops), decoded.route_hops, { success, commands, events, objects });
}

describe("route loops", () => {
  // USDC → USDT (Cetus) → USDC (Full Sail) → TOK (Cetus), the first two a
  // round trip back to USDC before the real hop.
  const midRoute = [
    begin(USDC, TOK),
    start(USDC),
    call(CETUS_INT, "swap_a_to_b_by_a_w1", [RD, USDC, USDC, USDT]),
    call(FULLSAIL_INT, "swap_b2a_w1", [RD, USDC, USDT, USDC]),
    call(CETUS_INT, "swap_a_to_b_by_a_w1", [RD, USDC, USDC, TOK]),
    end(USDC, TOK),
  ];
  const midObjects = [
    { objectId: pool(1), objectType: `${CETUS_POOL}<${USDC}, ${USDT}>` },
    { objectId: pool(2), objectType: `0xe74104c66dd9f16b3096db2cc00300e556aa92edc871be4bc052b5dfb80db239::pool::Pool<${USDC}, ${USDT}>` },
    { objectId: pool(3), objectType: `${CETUS_POOL}<${USDC}, ${TOK}>` },
  ];

  it("finds a loop in the middle of a route and costs it from the pool events", () => {
    const loops = loopsOf(
      midRoute,
      [
        swapEvent(CETUS_SWAP, CETUS_INT, pool(1), true, "4950000", "4951636"),
        swapEvent(FULLSAIL_SWAP, FULLSAIL_INT, pool(2), false, "4951636", "4949996"),
        swapEvent(CETUS_SWAP, CETUS_INT, pool(3), true, "4949996", "5968810930"),
      ],
      midObjects,
    );
    expect(loops).toHaveLength(1);
    expect(loops[0].hops).toEqual([2, 3]);
    expect(loops[0].coins).toBe("USDC → USDT → USDC");
    expect(loops[0].cost_method).toBe("pool_events");
    expect(loops[0].cost).toBe("0.000004 USDC");
    expect(loops[0].sent).toBe("4.95 USDC");
    expect(loops[0].returned).toBe("4.949996 USDC");
  });

  it("matches a hop only to an event with its coins in its direction, never by position", () => {
    // The Full Sail event is emitted with the direction of USDC → USDT, so it
    // cannot be the USDT → USDC hop even though it sits in that position.
    const loops = loopsOf(
      midRoute,
      [
        swapEvent(CETUS_SWAP, CETUS_INT, pool(1), true, "4950000", "4951636"),
        swapEvent(FULLSAIL_SWAP, FULLSAIL_INT, pool(2), true, "4951636", "4949996"),
        swapEvent(CETUS_SWAP, CETUS_INT, pool(3), true, "4949996", "5968810930"),
      ],
      midObjects,
    );
    expect(loops[0].cost).toBeNull();
    expect(loops[0].cost_method).toBe("unknown");
  });

  it("reports only the path that loops when a route has two", () => {
    const decoded = decodeTransaction(
      [
        begin(SUI, USDC),
        start(SUI),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, USDT]),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, USDT, USDC]),
        start(SUI),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, TOK]),
        call(CETUS_INT, "swap_b_to_a_w1", [RD, SUI, SUI, TOK]),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, USDC]),
        end(SUI, USDC),
      ],
      [],
      SENDER,
    );
    const loops = routeLoops(decoded.route_hops);
    expect(loops).toHaveLength(1);
    expect(loops[0].hops.map((h) => [h.coin_in, h.coin_out])).toEqual([
      [SUI, TOK],
      [TOK, SUI],
    ]);
    expect(loops[0].hops.map((h) => h.command)).toEqual([5, 6]);
  });

  it("never joins hops of different paths into a loop", () => {
    // Path one ends in USDC, path two starts from USDC and ends in SUI: the
    // coins return to SUI only across the path boundary.
    const decoded = decodeTransaction(
      [start(SUI), call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, USDC]), start(USDC), call(CETUS_INT, "swap_b_to_a_w1", [RD, USDC, SUI, USDC])],
      [],
      SENDER,
    );
    expect(decoded.route_hops.map((h) => h.path)).toEqual([0, 1]);
    expect(routeLoops(decoded.route_hops)).toEqual([]);
  });

  it("reports nothing for a route that never returns to a coin", () => {
    const loops = loopsOf(
      [
        begin(SUI, USDC),
        start(SUI),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, TOK]),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, TOK, USDT]),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, USDT, USDC]),
        end(SUI, USDC),
      ],
      [],
      [],
    );
    expect(loops).toEqual([]);
  });

  it("starts a loop only where the hops chain, not across a hop that restarts from the path's coin", () => {
    // The second hop takes SUI, not the USDC the first gave out, so only the
    // second and third hops go round.
    const decoded = decodeTransaction(
      [
        start(SUI),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, USDC]),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, TOK]),
        call(CETUS_INT, "swap_b_to_a_w1", [RD, SUI, SUI, TOK]),
      ],
      [],
      SENDER,
    );
    expect(routeLoops(decoded.route_hops).map((l) => l.hops.map((h) => h.command))).toEqual([[2, 3]]);
  });

  it("leaves the cost unknown when a hop's event is of an unverified shape", () => {
    const loops = loopsOf(
      midRoute,
      [
        { type: AFTERMATH_SWAP, package_id: CETUS_INT, module: "router", json: { pool_id: pool(1), types_in: [USDC], amounts_in: ["4950000"], types_out: [USDT], amounts_out: ["4951636"] } },
        swapEvent(FULLSAIL_SWAP, FULLSAIL_INT, pool(2), false, "4951636", "4949996"),
        swapEvent(CETUS_SWAP, CETUS_INT, pool(3), true, "4949996", "5968810930"),
      ],
      midObjects,
    );
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ hops: [2, 3], coins: "USDC → USDT → USDC", sent: null, returned: null, cost: null, cost_method: "unknown" });
  });

  it("leaves the cost unknown when the event fields were not read, and says why", () => {
    const loops = loopsOf(midRoute, { unread: "the event field lookup failed" }, midObjects);
    expect(loops[0]).toMatchObject({ cost: null, cost_method: "unknown" });
    expect(loops[0].note).toContain("the event field lookup failed");
  });

  it("tells a transaction that emitted no events apart from one whose fields were not read", () => {
    const none = loopsOf(midRoute, [], midObjects);
    const unread = loopsOf(midRoute, { unread: "the event field lookup failed" }, midObjects);
    expect(none[0]).toMatchObject({ cost: null, cost_method: "unknown" });
    expect(none[0].note).toContain("emitted no events");
    expect(none[0].note).not.toContain("the event field lookup failed");
    expect(unread[0].note).not.toContain("emitted no events");
  });

  it("reports no loop on a failed transaction, whose swaps were reverted", () => {
    expect(loopsOf(midRoute, [], midObjects, false)).toEqual([]);
  });

  it("leaves the cost unknown when the matched amounts do not carry from hop to hop", () => {
    const loops = loopsOf(
      midRoute,
      [
        swapEvent(CETUS_SWAP, CETUS_INT, pool(1), true, "4950000", "4951636"),
        swapEvent(FULLSAIL_SWAP, FULLSAIL_INT, pool(2), false, "2000000", "1999998"),
        swapEvent(CETUS_SWAP, CETUS_INT, pool(3), true, "1999998", "5968810930"),
      ],
      midObjects,
    );
    expect(loops[0]).toMatchObject({ cost: null, cost_method: "unknown" });
  });

  it("finds a three-hop loop and states a gain as a negative cost", () => {
    const loops = loopsOf(
      [
        begin(SUI, SUI),
        start(SUI, 0),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, USDC]),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, USDC, TOK]),
        call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, TOK, SUI]),
        end(SUI, SUI),
      ],
      [
        swapEvent(CETUS_SWAP, CETUS_INT, pool(1), true, "1000000000", "3500000"),
        swapEvent(CETUS_SWAP, CETUS_INT, pool(2), true, "3500000", "70000"),
        swapEvent(CETUS_SWAP, CETUS_INT, pool(3), true, "70000", "1000500000"),
      ],
      [
        { objectId: pool(1), objectType: `${CETUS_POOL}<${SUI}, ${USDC}>` },
        { objectId: pool(2), objectType: `${CETUS_POOL}<${USDC}, ${TOK}>` },
        { objectId: pool(3), objectType: `${CETUS_POOL}<${TOK}, ${SUI}>` },
      ],
    );
    expect(loops).toHaveLength(1);
    expect(loops[0].hops).toEqual([2, 4]);
    expect(loops[0].coins).toBe("SUI → USDC → TOK → SUI");
    expect(loops[0].cost).toBe("-0.0005 SUI");
    expect(loops[0].cost_method).toBe("pool_events");
    // The route declares SUI in and SUI out and this path is the loop.
    expect(loops[0].whole_trade).toBe(true);
  });

  describe("a loop that is the routed trade itself", () => {
    const swapSui = (via: string) => [call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, via]), call(CETUS_INT, "swap_b_to_a_w1", [RD, SUI, SUI, via])];

    it("marks every path of a route declared SUI in and SUI out, split over several paths", () => {
      const decoded = decodeTransaction(
        [begin(SUI, SUI), start(SUI, 0), ...swapSui(TOK), start(SUI, 0), ...swapSui(USDC), end(SUI, SUI)],
        [],
        SENDER,
      );
      expect(routeLoops(decoded.route_hops).map((l) => l.whole_trade)).toEqual([true, true]);
    });

    it("does not mark a loop in the middle of a route that trades one coin for another", () => {
      const decoded = decodeTransaction(midRoute.map((c, i) => (i === 1 ? start(USDC, 0) : c)), [], SENDER);
      expect(routeLoops(decoded.route_hops).map((l) => l.whole_trade)).toEqual([false]);
    });

    it("does not mark a loop that is only part of its path, even in a route declared SUI in and SUI out", () => {
      const decoded = decodeTransaction(
        [begin(SUI, SUI), start(SUI, 0), ...swapSui(TOK), call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, USDC]), call(CETUS_INT, "swap_b_to_a_w1", [RD, SUI, USDC, SUI]), end(SUI, SUI)],
        [],
        SENDER,
      );
      // SUI → TOK → SUI, then SUI → USDC → SUI: two loops, neither the whole path.
      expect(routeLoops(decoded.route_hops).map((l) => l.whole_trade)).toEqual([false, false]);
    });

    it("does not mark a path loop when the path start names no route", () => {
      const decoded = decodeTransaction([begin(SUI, SUI), start(SUI), ...swapSui(TOK), end(SUI, SUI)], [], SENDER);
      expect(routeLoops(decoded.route_hops).map((l) => l.whole_trade)).toEqual([false]);
    });

    it("reports the round trip as the trade's result, with the same amounts", () => {
      const loops = loopsOf(
        [begin(SUI, SUI), start(SUI, 0), ...swapSui(TOK), end(SUI, SUI)],
        [swapEvent(CETUS_SWAP, CETUS_INT, pool(1), true, "20069530", "2245385419"), swapEvent(CETUS_SWAP, CETUS_INT, pool(1), false, "2245385419", "21246999")],
        [{ objectId: pool(1), objectType: `${CETUS_POOL}<${SUI}, ${TOK}>` }],
      );
      expect(loops).toHaveLength(1);
      expect(loops[0]).toMatchObject({ whole_trade: true, cost: "-0.001177469 SUI", cost_method: "pool_events" });
    });

    it("does not mark a whole-path loop in a route that gives out another coin", () => {
      const decoded = decodeTransaction(
        [begin(SUI, USDC), start(SUI, 0), ...swapSui(TOK), start(SUI, 0), call(CETUS_INT, "swap_a_to_b_w1", [RD, SUI, SUI, USDC]), end(SUI, USDC)],
        [],
        SENDER,
      );
      expect(routeLoops(decoded.route_hops).map((l) => l.whole_trade)).toEqual([false]);
    });
  });
});
