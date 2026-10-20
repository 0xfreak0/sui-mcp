import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { decodeTransaction } from "../src/protocols/decoder.js";
import type { SwapEvidence, SwapEventInput } from "../src/utils/pool-swap-events.js";

/**
 * Router transactions from mainnet whose swap labels disagreed with their
 * pools' own swap events before the labels were read from those events.
 * Each fixture keeps the PTB's Move calls with their arguments (framework
 * calls without them), the input object ids, every event (swap events with
 * their fields) and the changed objects' types.
 */
interface Fixture {
  sender: string;
  commands: Array<{ package?: string; module?: string; function?: string; typeArguments?: string[]; arguments?: unknown[]; kind?: string }>;
  inputObjectIds: (string | null)[];
  events: SwapEventInput[];
  objectTypes: Record<string, string>;
  balanceChanges: GrpcTypes.BalanceChange[];
}
const FIXTURES: Record<string, Fixture> = JSON.parse(readFileSync(new URL("./fixtures/router-swap-events.json", import.meta.url), "utf8"));

const commandsOf = (f: Fixture) =>
  f.commands.map((c) =>
    c.package ? { command: { oneofKind: "moveCall", moveCall: c } } : { command: { oneofKind: c.kind } },
  ) as unknown as GrpcTypes.Command[];
const evidenceOf = (f: Fixture): SwapEvidence => ({ events: f.events, inputObjectIds: f.inputObjectIds, objectTypes: new Map(Object.entries(f.objectTypes)) });
const swaps = (actions: string[]) => actions.filter((a) => a.startsWith("Swap ")).map((a) => a.replace(/^Swap /, "").replace(/ on .*$/, ""));

describe("swap labels read from the pools' own events", () => {
  const cases: Array<[string, string[]]> = [
    // Astros: Bluefin AssetSwap a2b false on Pool<STSUI, USDC>, 1,847,135 USDC in
    ["DcA6ngs7MTEjbS2nqjNnLPLMwoXGZgaCpAfR9fjb9m1x", ["USDC → stSUI", "stSUI → SUI"]],
    // 7k: Momentum flash_swap repaid in MMT; its SwapEvent takes 1,746,000,000 MMT in
    ["3WZbaq42Vr3dPhKx24BhCy1UCunouXyPuNHnjwvRcqhF", ["MMT → USDC"]],
    // Cetus v3 context whose types read two ways; every pool call's events state it
    ["9LbWQbZZh3d3q4ENHYHB7YXptdrUorgoSN6v2XZyw8bJ", ["USDC → USDB", "USDC → SUI", "USDC → BUCK", "USDC → SUI", "USDB → BUCK", "USDB → BUCK", "BUCK → SUI"]],
    // Cetus v3 context whose types read two ways; every pool call's events state it. Full Sail's SwapEvent and the router's echo have a fee event between them
    ["EyVUHKNH8Z5EArisdy94UhDYasQxBucb69bt6Nm4M5rV", ["USDC → WAL", "USDC → WAL", "USDC → DEEP", "USDC → stSUI", "DEEP → WAL", "DEEP → WAL", "stSUI → SUI", "SUI → WAL"]],
    // Astros: two calls on one Turbos pool, Bluefin a2b true on Pool<USDC, XAUM>, Momentum flash swaps
    ["GSFcNqRyHHLbXE7SfAvizQbQ6XnKaVvTUUcoywNapbs3", ["IKA → USDC", "IKA → USDC", "USDC → XAUM", "USDC → SUI", "IKA → SUI", "SUI → USDC", "USDC → XAUM", "IKA → SUI", "SUI → USDC", "USDC → XAUM", "IKA → SUI", "SUI → USDC", "USDC → XAUM", "IKA → SUI", "SUI → USDC", "USDC → XAUM", "IKA → SUI", "SUI → USDC", "USDC → XAUM"]],
    // 7k: Cetus atob on Pool<LBTC, BTC>
    ["2FidCEDML7C11TSYkmQDhG4paRnxuUsJH1o74rmQer62", ["LBTC → wBTC", "LBTC → TBTC", "wBTC → xBTC", "xBTC → TBTC"]],
    // FlowX: Bluefin AssetSwap echoed by the router's BluefinSwapEvent; swap_exact_y_to_x
    ["Coa7jSAW1vxRkwhzxBRLa1JMbtWxmwXRMoNpVLrTSG6B", ["SUI → USDC", "USDC → suiUSDe", "suiUSDe → SUI"]],
    // Astros: the Cetus SwapEvent of each router::swap<USDC, USDSUI> takes USDSUI in
    ["FB5eibzhNoxcqWtjX1xwYmGSiHew9b9ZougY9jwaWdft", ["USDSUI → USDC", "USDC → suiUSDe", "USDSUI → USDC", "USDC → suiUSDe", "USDSUI → USDC", "USDC → suiUSDe", "USDSUI → USDC", "USDC → suiUSDe"]],
    // 7k: Bluefin a2b true on Pool<USDC, XAUM>
    ["4CfcGBYmcWsZ1xEW9UUwTEo5Pn2WmZxzVoYffPY2tr4X", ["USDC → XAUM"]],
    // FlowX
    ["Bj4W56YrA3Zmh4FK3D5YzPMuJrGbv58Ua2YPYL7ELRFq", ["SUI → stSUI", "stSUI → USDC", "SUI → WAL", "WAL → USDC"]],
    // FlowX
    ["FX8es7dbyMxxyFDwzs3RvYHLzdYqn3Mn2dfXWSeWkHhs", ["SEND → USDC", "USDC → TATO", "USDC → TATO", "USDC → TATO"]],
    // Astros: Momentum flash swaps whose SwapEvents take LBTC and SUI in
    ["Gspre1cKf7poRrvR8sFcTkfiZofyyet9s7jHNPNrCeX1", ["LBTC → wBTC", "wBTC → SUI", "SUI → NAVX", "LBTC → wBTC", "wBTC → SUI", "SUI → NAVX"]],
    // Cetus v3 context with a one-coin stake call; the router's own SwapEvent names its coins
    ["2JwYMsgSmHUu4zV7y74196Ny4ESFpswXj76RHL7i3Eoi", ["WAL → USDC", "WAL → DEEP", "WAL → DEEP", "WAL → SUI", "DEEP → USDC", "SUI → SCA", "SUI → USDC", "SUI → stSUI", "SCA → USDC", "stSUI → USDC"]],
    // FlowX: a one-coin stake leg swap_exact_x_to_y<STSUI> between two pool swaps of the same route path
    ["3UhJcQKQdaVUZwr73fH1sPyACj5kqEWukyJErWZmhPhz", ["USDC → stSUI", "stSUI → SUI", "SUI → BLUE", "USDC → SUI", "SUI → BLUE"]],
    // Arbitrage bot: Bluefin FlashSwap events, a2b false on Pool<STSUI, USDC> then a2b true on Pool<STSUI, SUI>
    ["7ni1zqot4JktmUrGCJMSqoozvqHfDDVSQDohg2CDk8oN", ["SUI → USDT", "USDT → USDC", "USDC → stSUI", "stSUI → SUI"]],
    // Cetus v1 context then Aftermath: FlowX's Swap, then its Pay, then the aggregator's echo of the Swap
    ["BhBBTGMxpr1gP5nrphECEFU9W43aQgY8rPm15o39SbVw", ["FUD → SUI", "SUI → IKA", "IKA → USDC", "USDC → stSUI", "stSUI → SUI", "SUI → FUD"]],
    // FlowX: stSUI redemption is first in each of two paths; the issuer's
    // RedeemEvent names both coins without a preceding pool swap.
    ["BvkmeokA27CSwN1c44woDukBcjzwBGSNYXGHTig9AJsZ", ["stSUI → SUI", "SUI → USDC", "USDC → BUCK", "stSUI → BUCK", "stSUI → SUI", "SUI → USDC", "USDC → BUCK"]],
    // FlowX: the final stSUI redemption has no following pool swap.
    ["7bDSn7wuLC8VqFooWArSTbR1dTdGT9sSZp7BedX4kG6F", ["USDC → BUCK", "BUCK → stSUI", "stSUI → SUI"]],
    // FlowX: each of three paths ends in a SpringSui mint; the framework's
    // MintEvent names sSUI, SUI in and sSUI out.
    ["4AsWs7y8UGXXCGuJccwEZC9R6T5JUj6goHjY1VHick7p", ["USDSUI → USDC", "USDC → SUI", "SUI → sSUI", "USDSUI → SUI", "SUI → sSUI", "USDSUI → SUI", "SUI → sSUI"]],
    // FlowX: Haedal's swap_exact_x_to_y has no type arguments; UserInstantUnstaked names haSUI by its type
    ["2Mv5FsuYnRqLd56YERePhvodKG7Xxj64Qf4oovM5489E", ["haSUI → SUI"]],
    // FlowX: Volo's stake_pool UnstakeEventExt beside native_pool's UnstakedEvent is one redemption
    ["GjJyadVtxLLjD1X1NDJgGvwdWadgfh8XNzESUpQuDnvM", ["vSUI → SUI"]],
    // FlowX: a haSUI redemption then a vSUI mint in one path
    ["6WhsDCgHBsUDCnHyeyRR3Kmub9JQFuKe8xMfdKRERkLr", ["haSUI → SUI", "SUI → vSUI"]],
    // Cetus v3 context: the aggregator's router::SwapEvent after Haedal's UserInstantUnstaked states the same swap
    ["FwcAmAQh464VErNQAJjUJZQyPitjdUkSduDj25GdGzL3", ["USDC → HAEDAL", "HAEDAL → haSUI", "haSUI → SUI"]],
  ];
  it.each(cases)("%s", (digest, expected) => {
    const f = FIXTURES[digest];
    expect(swaps(decodeTransaction(commandsOf(f), f.balanceChanges, f.sender, { swapEvidence: evidenceOf(f) }).actions)).toEqual(expected);
  });

  it("falls back to the call's own types without events", () => {
    const f = FIXTURES["DcA6ngs7MTEjbS2nqjNnLPLMwoXGZgaCpAfR9fjb9m1x"];
    expect(swaps(decodeTransaction(commandsOf(f), f.balanceChanges, f.sender).actions)).toEqual(["stSUI → USDC", "stSUI → SUI"]);
  });

  it("does not infer a redemption from an incomplete or differently typed event", () => {
    const f = FIXTURES["7bDSn7wuLC8VqFooWArSTbR1dTdGT9sSZp7BedX4kG6F"];
    const event = f.events.findIndex((e) => e.type.includes("::liquid_staking::RedeemEvent>"));
    const decode = (replacement: SwapEventInput) => swaps(decodeTransaction(commandsOf(f), f.balanceChanges, f.sender, {
      swapEvidence: { ...evidenceOf(f), events: f.events.map((e, i) => i === event ? replacement : e) },
    }).actions);
    const original = f.events[event];
    const payload = original.json;
    if (!payload || typeof payload !== "object" || !("event" in payload) || !payload.event || typeof payload.event !== "object") throw new Error("Fixture has no issuer event fields");
    expect(decode({ ...original, json: { event: { ...payload.event, sui_amount_out: "0" } } })).toEqual(["USDC → BUCK", "BUCK → stSUI"]);
    expect(decode({ ...original, type: original.type.replace("::events::Event<", "::other::Event<") })).toEqual(["USDC → BUCK", "BUCK → stSUI"]);
  });

  it("does not assign a redemption event when two calls can have emitted it", () => {
    const f = FIXTURES["7bDSn7wuLC8VqFooWArSTbR1dTdGT9sSZp7BedX4kG6F"];
    const commands = commandsOf(f);
    const redeem = commands.findIndex((c) => c.command.oneofKind === "moveCall" && c.command.moveCall.typeArguments?.length === 1 && c.command.moveCall.function?.startsWith("swap"));
    commands.splice(redeem, 0, commands[redeem]);
    expect(swaps(decodeTransaction(commands, f.balanceChanges, f.sender, { swapEvidence: evidenceOf(f) }).actions)).toEqual(["USDC → BUCK", "BUCK → stSUI"]);
  });

  it("reads an issuer event only on a call named swap whose type argument is the LST", () => {
    const f = FIXTURES["7bDSn7wuLC8VqFooWArSTbR1dTdGT9sSZp7BedX4kG6F"];
    const decode = (change: (call: { function?: string; typeArguments?: string[] }) => void) => {
      const commands = commandsOf(f);
      const redeem = commands.findIndex((c) => c.command.oneofKind === "moveCall" && c.command.moveCall.typeArguments?.length === 1 && c.command.moveCall.function?.startsWith("swap"));
      const call = commands[redeem].command;
      if (call.oneofKind !== "moveCall") throw new Error("Fixture has no redeem call");
      const copy = { ...call.moveCall };
      change(copy);
      commands[redeem] = { ...commands[redeem], command: { oneofKind: "moveCall", moveCall: copy } };
      return swaps(decodeTransaction(commands, f.balanceChanges, f.sender, { swapEvidence: evidenceOf(f) }).actions);
    };
    expect(decode((c) => (c.function = "redeem"))).toEqual(["USDC → BUCK", "BUCK → stSUI"]);
    expect(decode((c) => (c.typeArguments = ["0x2::sui::SUI"]))).not.toContain("stSUI → SUI");
  });
});

describe("placing a pool's swap event on a call", () => {
  const PKG = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const POOL = "0x00000000000000000000000000000000000000000000000000000000000000aa";
  const A = "0x2222222222222222222222222222222222222222222222222222222222222222::a::A";
  const B = "0x3333333333333333333333333333333333333333333333333333333333333333::b::B";
  const POOL_TYPE = `${PKG}::pool::Pool<${A}, ${B}>`;
  const call = (module: string, fn: string, inputs: number[]) =>
    ({
      command: {
        oneofKind: "moveCall",
        moveCall: { package: PKG, module, function: fn, typeArguments: [A, B], arguments: inputs.map((input) => ({ kind: 2, input })) },
      },
    }) as unknown as GrpcTypes.Command;
  const swapEvent = (module: string, atob: boolean): SwapEventInput => ({ packageId: PKG, module, type: `${PKG}::pool::SwapEvent`, json: { pool: POOL, atob, amount_in: "5", amount_out: "4" } });
  const labels = (commands: GrpcTypes.Command[], events: SwapEventInput[]) =>
    swaps(
      decodeTransaction(commands, [], "0xsender", {
        swapEvidence: { events, inputObjectIds: [POOL], objectTypes: new Map([[POOL, POOL_TYPE]]) },
      }).actions,
    );

  it("reads the direction against the pool's own type arguments", () => {
    expect(labels([call("pool", "swap", [0])], [swapEvent("pool", false)])).toEqual(["B → A"]);
  });

  it("counts a router's echo of the pool's event once", () => {
    const echo: SwapEventInput = { packageId: PKG, module: "pool", type: `${PKG}::router::SwapEvent`, json: { pool: POOL, from: { name: B.slice(2) }, target: { name: A.slice(2) } } };
    expect(labels([call("pool", "swap", [0])], [swapEvent("pool", false), echo])).toEqual(["B → A"]);
  });

  it("pairs several calls on one pool with its swaps in order", () => {
    expect(labels([call("pool", "swap", [0]), call("pool", "swap", [0])], [swapEvent("pool", true), swapEvent("pool", false)])).toEqual(["A → B", "B → A"]);
  });

  it("labels a flash swap the PTB repays as a swap, and never the repay", () => {
    const commands = [call("pool", "flash_swap", [0]), call("pool", "repay_flash_swap", [0])];
    const { actions } = decodeTransaction(commands, [], "0xsender", {
      swapEvidence: { events: [swapEvent("pool", true)], inputObjectIds: [POOL], objectTypes: new Map([[POOL, POOL_TYPE]]) },
    });
    expect(swaps(actions)).toEqual(["A → B"]);
    expect(actions[1]).toMatch(/repay_flash_swap/);
  });

  it("keeps a flash swap with no repay in the PTB a flash swap", () => {
    expect(labels([call("pool", "flash_swap", [0])], [swapEvent("pool", true)])).toEqual([]);
  });

  it("places a swap on the call that emitted it when another module's call takes the pool", () => {
    // The router reaches the pool through an object of its own; the
    // liquidity call into the pool's module takes the pool and emits nothing.
    const commands = [call("router", "swap", [1]), call("pool", "add_liquidity", [0])];
    const { actions } = decodeTransaction(commands, [], "0xsender", {
      swapEvidence: { events: [swapEvent("router", false)], inputObjectIds: [POOL, "0xbb"], objectTypes: new Map([[POOL, POOL_TYPE]]) },
    });
    expect(swaps(actions)).toEqual(["B → A"]);
  });

  it("keeps the fallback for a call with a swap event it cannot read", () => {
    // One call swaps on two pools; the second pool's event names no direction
    // and no coins, so an event label would list one of its two swaps.
    const POOL2 = "0x00000000000000000000000000000000000000000000000000000000000000cc";
    const commands = [call("arb", "run", [0, 1])];
    const kriyaLike: SwapEventInput = { packageId: PKG, module: "arb", type: `${PKG}::spot::SwapEvent<${A}>`, json: { pool_id: POOL2, amount_in: "4", amount_out: "3" } };
    const evidence = (events: SwapEventInput[]) => ({
      swapEvidence: { events, inputObjectIds: [POOL, POOL2], objectTypes: new Map([[POOL, POOL_TYPE], [POOL2, POOL_TYPE]]) },
    });
    expect(swaps(decodeTransaction(commands, [], "0xsender", evidence([swapEvent("arb", true)])).actions)).toEqual(["A → B"]);
    const { actions } = decodeTransaction(commands, [], "0xsender", evidence([swapEvent("arb", true), kriyaLike]));
    expect(swaps(actions)).toEqual([]);
    expect(actions[0]).toMatch(/arb::run/);
    // A router's echo right after the unread event states that swap.
    const echo: SwapEventInput = { packageId: PKG, module: "arb", type: `${PKG}::router::KriyaSwapEvent`, json: { pool: POOL2, a2b: false, amount_in: "4", amount_out: "3" } };
    expect(swaps(decodeTransaction(commands, [], "0xsender", evidence([swapEvent("arb", true), kriyaLike, echo])).actions)).toEqual(["A → B", "B → A"]);
    const reversed = { ...echo, json: { ...(echo.json as object), a2b: true } };
    expect(swaps(decodeTransaction(commands, [], "0xsender", evidence([swapEvent("arb", true), reversed, kriyaLike])).actions)).toEqual(["A → B", "A → B"]);
  });

  it("labels no swap whose side is not a coin", () => {
    // A Nemo-shaped SwapEvent<SY> trades PT, a position unit, for SY.
    const sy = { value: "18446744073709551616000", positive: false };
    const ptForSy: SwapEventInput = { packageId: PKG, module: "market", type: `${PKG}::market::SwapEvent<${A}>`, json: { market_state_id: POOL, pt_amount: sy, sy_amount: sy } };
    const { actions } = decodeTransaction([call("market", "swap_exact_pt_for_sy", [0])], [], "0xsender", {
      swapEvidence: { events: [ptForSy], inputObjectIds: [POOL], objectTypes: new Map([[POOL, POOL_TYPE]]) },
    });
    expect(swaps(actions)).toEqual([]);
    expect(actions[0]).toMatch(/market::swap_exact_pt_for_sy/);
  });
});
