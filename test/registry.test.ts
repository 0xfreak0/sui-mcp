import { describe, it, expect } from "vitest";
import { lookupProtocol, lookupOperation } from "../src/protocols/registry.js";

describe("lookupProtocol", () => {
  it("resolves Cetus by full package ID", () => {
    const result = lookupProtocol(
      "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb"
    );
    expect(result).toEqual({ name: "Cetus", type: "dex" });
  });

  it("resolves Sui System by short ID", () => {
    expect(lookupProtocol("0x3")).toEqual({ name: "Sui System", type: "system" });
  });

  it("resolves Sui Framework by short ID", () => {
    expect(lookupProtocol("0x2")).toEqual({ name: "Sui Framework", type: "system" });
  });

  it("resolves Suilend", () => {
    const result = lookupProtocol(
      "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf"
    );
    expect(result).toEqual({ name: "Suilend", type: "lending" });
  });

  it("returns null for unknown package", () => {
    expect(lookupProtocol("0xdeadbeef")).toBeNull();
  });
});

describe("lookupOperation", () => {
  it("matches exact function name for swap", () => {
    const result = lookupOperation("pool", "swap");
    expect(result).toEqual({ action: "swap" });
  });

  it("matches function prefix with underscore (swap_a2b)", () => {
    const result = lookupOperation("pool", "swap_a2b");
    expect(result).toEqual({ action: "swap" });
  });

  it("matches router swap", () => {
    expect(lookupOperation("router", "swap_exact_input")).toEqual({ action: "swap" });
  });

  it("matches lending deposit", () => {
    expect(lookupOperation("lending", "deposit")).toEqual({ action: "deposit" });
  });

  it("matches lending_market deposit_liquidity for Suilend", () => {
    expect(lookupOperation("lending_market", "deposit_liquidity")).toEqual({
      action: "deposit",
    });
  });

  it("returns skip for infrastructure ops", () => {
    const result = lookupOperation("coin", "from_balance");
    expect(result).toEqual({ action: "convert", skip: true });
  });

  it("returns skip for refresh_reserve", () => {
    const result = lookupOperation("lending_market", "refresh_reserve");
    expect(result).toEqual({ action: "refresh", skip: true });
  });

  it("matches staking operations", () => {
    expect(lookupOperation("staking_pool", "request_add_stake")).toEqual({
      action: "stake",
    });
    expect(lookupOperation("staking_pool", "request_withdraw_stake")).toEqual({
      action: "unstake",
    });
  });

  it("matches transfer operations", () => {
    expect(lookupOperation("coin", "transfer")).toEqual({ action: "transfer" });
  });

  it("matches empty prefix (pay module)", () => {
    expect(lookupOperation("pay", "split_and_transfer")).toEqual({ action: "transfer" });
  });

  it("returns null for unknown module/function", () => {
    expect(lookupOperation("unknown_module", "unknown_fn")).toBeNull();
  });
});
