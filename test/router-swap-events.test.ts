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
    // Cetus v3 context whose types read two ways; every pool call's events state it
    ["EyVUHKNH8Z5EArisdy94UhDYasQxBucb69bt6Nm4M5rV", ["USDC → WAL", "USDC → WAL", "USDC → DEEP", "USDC → stSUI", "DEEP → WAL", "DEEP → WAL", "DEEP → WAL", "stSUI → SUI", "SUI → WAL"]],
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
  ];
  it.each(cases)("%s", (digest, expected) => {
    const f = FIXTURES[digest];
    expect(swaps(decodeTransaction(commandsOf(f), f.balanceChanges, f.sender, { swapEvidence: evidenceOf(f) }).actions)).toEqual(expected);
  });

  it("falls back to the call's own types without events", () => {
    const f = FIXTURES["DcA6ngs7MTEjbS2nqjNnLPLMwoXGZgaCpAfR9fjb9m1x"];
    expect(swaps(decodeTransaction(commandsOf(f), f.balanceChanges, f.sender).actions)).toEqual(["stSUI → USDC", "stSUI → SUI"]);
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
});
