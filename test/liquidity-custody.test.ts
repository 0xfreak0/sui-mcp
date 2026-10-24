import { describe, expect, it } from "vitest";
import { aggregateCustodyRows, capLiquidityHolders, fractionOfLiquidity, liquidityHolderKind } from "../src/utils/liquidity-custody.js";
import { removalEvidence, removalScanIncomplete } from "../src/utils/liquidity-origin.js";
import type { NextCall } from "../src/utils/output-cap.js";

function nextOffset(page: { omitted?: { next_call: NextCall } }): number {
  const call = page.omitted?.next_call;
  if (!call || !("args" in call) || typeof call.args.liquidity_offset !== "number") {
    throw new Error("Liquidity continuation has no numeric offset");
  }
  return call.args.liquidity_offset;
}

describe("liquidity custody", () => {
  const deployer = "0xabcdef";

  it("distinguishes burn addresses, publisher and wallets", () => {
    expect(liquidityHolderKind("0x0", deployer, undefined, "wallet")).toBe("burned");
    expect(liquidityHolderKind("0x2", deployer, undefined, "wallet")).toBe("burned");
    expect(liquidityHolderKind(deployer, deployer, undefined, "wallet")).toBe("publisher");
    expect(liquidityHolderKind("0x123456", deployer, undefined, "wallet")).toBe("wallet");
    expect(liquidityHolderKind("0x123456", null, undefined, undefined)).toBe("unknown");
  });

  it("does not infer a lock from an object and identifies the framework kiosk exactly", () => {
    expect(liquidityHolderKind("0x123456", deployer, "0x2::kiosk::Kiosk", "object")).toBe("kiosk");
    expect(liquidityHolderKind("0x123456", deployer, "0xabc::kiosk::Kiosk", "object")).toBe("object");
    expect(liquidityHolderKind("0x123456", deployer, "0xabc::locker::Lock", "object")).toBe("object");
    expect(liquidityHolderKind("0x123456", deployer, undefined, "package")).toBe("package");
  });

  it("marks a recent removal window incomplete when any transaction's events or balances have another page", () => {
    expect(removalScanIncomplete(undefined)).toBe(true);
    expect(removalScanIncomplete({
      nodes: [{ digest: "tx", effects: { events: { nodes: [], pageInfo: { hasNextPage: true } } } }],
      pageInfo: { hasPreviousPage: false },
    })).toBe(true);
    expect(removalScanIncomplete({
      nodes: [{ digest: "tx", effects: { balanceChanges: { nodes: [], pageInfo: { hasNextPage: true } } } }],
      pageInfo: { hasPreviousPage: false },
    })).toBe(true);
    expect(removalScanIncomplete({ nodes: [], pageInfo: { hasPreviousPage: false } })).toBe(false);
  });

  it("computes fractional shares with bigint arithmetic without overflow", () => {
    const supply = 10n ** 75n;
    expect(fractionOfLiquidity(supply / 4n, supply)).toBe(0.25);
    expect(fractionOfLiquidity(1n, 0n)).toBeNull();
    expect(fractionOfLiquidity(1n, -1n)).toBeNull();
  });

  it("sums a wallet's positions before assigning its pool share", () => {
    const holders = aggregateCustodyRows([
      { address: "0xa", amount: 13n, counterpart: 40n, position_id: "0x1" },
      { address: "0xb", amount: 70n, counterpart: 10n, position_id: "0x2" },
      { address: "0xA", amount: 17n, counterpart: 50n, position_id: "0x3" },
    ]);
    expect(holders).toHaveLength(2);
    expect(holders[0]).toMatchObject({
      amount: 30n, counterpart: 90n, position_ids: ["0x1", "0x3"],
    });
    expect(fractionOfLiquidity(holders[0]!.amount, 100n)).toBe(0.3);
    expect(fractionOfLiquidity(holders[0]!.counterpart!, 100n)).toBe(0.9);
  });

  it("pages every owner with an advancing structured call and exact omissions", () => {
    const holders = Array.from({ length: 207 }, (_, id) => ({ address: `0x${id + 1}`, kind: "wallet" as const, amount_raw: String(id + 1) }));
    const first = capLiquidityHolders(holders, 0, "0x2::sui::SUI", 0, "0xabc", 100_000);
    const second = capLiquidityHolders(holders, nextOffset(first), "0x2::sui::SUI", 0, "0xabc", 100_000);
    const third = capLiquidityHolders(holders, nextOffset(second), "0x2::sui::SUI", 0, "0xabc", 100_000);
    expect([...first.holders, ...second.holders, ...third.holders]).toEqual(holders);
    const firstCall = first.omitted?.next_call;
    expect(firstCall && "args" in firstCall ? firstCall.args.liquidity_holder_pool : null).toBe("0xabc");
    expect([first.omitted!.lists.holders.count, second.omitted!.lists.holders.count]).toEqual([107, 7]);
    expect(first.omitted!.lists.holders.from).toBe(100);
    expect(second.omitted!.lists.holders.from).toBe(200);
    expect(third.omitted).toBeUndefined();
    expect(holders.reduce((sum, row) => sum + Number(row.amount_raw), 0)).toBe(21528);
  });

  it("retains every flagged custodian even when they exceed the ordinary cap", () => {
    const custodians = Array.from({ length: 110 }, (_, id) => ({ address: `0x${id + 1}`, kind: "object" as const, amount_raw: "1" }));
    const wallets = Array.from({ length: 120 }, (_, id) => ({ address: `0x${id + 111}`, kind: "wallet" as const, amount_raw: "1" }));
    const all = [...custodians, ...wallets];
    const first = capLiquidityHolders(all, 0, "0x2::sui::SUI", 0, "0xabc", 100_000);
    expect(first.holders.slice(0, 110)).toEqual(custodians);
    expect(first.holders).toHaveLength(210);
    expect(first.omitted!.lists.holders.count).toBe(20);
    const second = capLiquidityHolders(all, nextOffset(first), "0x2::sui::SUI", 0, "0xabc", 100_000);
    expect([...first.holders, ...second.holders]).toEqual(all);
  });

  it("does not repeat flagged holders placed beyond the first omitted wallet", () => {
    const wallets = Array.from({ length: 130 }, (_, id) => ({ address: `0xw${id}`, kind: "wallet" as const, amount_raw: "1" }));
    const flagged = { address: "0xpool", kind: "object" as const, amount_raw: "1" };
    const holders = [...wallets.slice(0, 120), flagged, ...wallets.slice(120)];
    const first = capLiquidityHolders(holders, 0, "0x2::sui::SUI", 0, "0xabc", 100_000);
    expect(first.holders).toContainEqual(flagged);
    const next = first.omitted?.next_call;
    expect(next && "args" in next ? next.args.liquidity_flagged_done : null).toBe(true);
    const second = capLiquidityHolders(holders, nextOffset(first), "0x2::sui::SUI", 0, "0xabc", 100_000, { liquidity_flagged_done: true });
    expect([...first.holders, ...second.holders].map((h) => h.address)).toEqual([
      ...wallets.slice(0, 100).map((h) => h.address), flagged.address, ...wallets.slice(100).map((h) => h.address),
    ]);
    expect([...first.holders, ...second.holders].filter((h) => h.address === flagged.address)).toHaveLength(1);
    expect(second.omitted).toBeUndefined();
  });

  it("advances from offset zero when mandatory holders consume the whole first-page budget", () => {
    const holders = [
      { address: "0xwallet", kind: "wallet" as const, amount_raw: "1" },
      ...Array.from({ length: 120 }, (_, i) => ({ address: `0xo${i}`, kind: "object" as const, amount_raw: "1" })),
    ];
    const first = capLiquidityHolders(holders, 0, "0x2::sui::SUI", 0, "0xabc", 100);
    expect(first.holders.map((h) => h.address)).toEqual(holders.slice(1).map((h) => h.address));
    expect(nextOffset(first)).toBe(0);
    const next = capLiquidityHolders(holders, 0, "0x2::sui::SUI", 0, "0xabc", 100, { liquidity_flagged_done: true });
    expect(next.holders).toEqual([holders[0]]);
    expect(next.omitted).toBeUndefined();
  });

  // Event shapes read off mainnet: Turbos BurnEvent in 8c1NTV8RxFZBJkhqGXiRevuiNQUJYoVSEHAks1EFkkhe,
  // FlowX v2 pair::LiquidityRemoved and Cetus pool::RemoveLiquidityEvent.
  const turbosPool = "0x198af6ff81028c6577e94465d534c4e2cfcbbab06a95724ece7011c55a9d1f5a";
  const turbosBurn = (pool: string, delta: string) => ({
    contents: {
    type: { repr: "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::BurnEvent" },
    json: { pool, owner: "0x11dd706586a987b8af3191da762c421f1ce45437057018a0c248dffb1cf65ce8", amount_a: "2965163159", amount_b: "0", liquidity_delta: delta },
    }
  });

  it("reads a removal from every searched venue's own event, not only Remove*Liquidity names", () => {
    const pool = { pool_id: turbosPool, token_a: null, token_b: null };
    expect(removalEvidence([turbosBurn(turbosPool, "300700962440")], pool)).toEqual([{
      type: "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::BurnEvent", liquidity_removed: "300700962440",
    }]);
    const kriya = { contents: { type: { repr: "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66::spot_dex::LiquidityRemovedEvent" }, json: { pool_id: turbosPool, lsp_burned: "5" } } };
    expect(removalEvidence([kriya], pool)).toHaveLength(1);
  });

  it("drops zero-liquidity events, other pools' removals and events that name no pool", () => {
    const pool = { pool_id: turbosPool, token_a: null, token_b: null };
    expect(removalEvidence([turbosBurn(turbosPool, "0")], pool)).toEqual([]);
    expect(removalEvidence([turbosBurn("0x4f519b65c0e394b697d538ae3d6922c10f707a696208ea24cb3a69479aa24528", "1137767289617")], pool)).toEqual([]);
    const unnamed = { contents: { type: { repr: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::RemoveLiquidityEvent" }, json: { liquidity: "10" } } };
    expect(removalEvidence([unnamed], pool)).toEqual([]);
    const swap = { contents: { type: { repr: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent" }, json: { pool: turbosPool } } };
    expect(removalEvidence([swap], pool)).toEqual([]);
  });

  it("matches a FlowX v2 removal by its two unprefixed coin types", () => {
    const sui = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
    const deep = "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";
    const event = { contents: { type: { repr: "0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0::pair::LiquidityRemoved" }, json: {
      user: "0x9349c99a5431cc9543459a631d841fec8703ddec90cb5b6b8bdcd93dddba7517", coin_x: sui.slice(2), coin_y: deep.slice(2),
      amount_x: "1366802426", amount_y: "70135417", liquidity: "269702225", fee: "68939860",
    } } };
    expect(removalEvidence([event], { pool_id: "0x1", token_a: sui, token_b: deep })).toHaveLength(1);
    expect(removalEvidence([event], { pool_id: "0x1", token_a: sui, token_b: "0x2::coin::OTHER" })).toEqual([]);
  });
});
