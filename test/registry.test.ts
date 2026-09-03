import { describe, it, expect } from "vitest";
import {
  isCuratedProtocol,
  loadProtocolRegistry,
  lookupOperation,
  lookupProtocol,
} from "../src/protocols/registry.js";

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

/**
 * Curated entries are written the way a human types them (`0x2`), but the
 * chain reports every package ID padded to 32 bytes. Nothing here prefetches,
 * so these must be answered by the exact-match tier alone — the lineage tier
 * reads only what a prefetch has cached, and relying on it would make system
 * packages identifiable only after a network round trip.
 */
describe("registry key normalization", () => {
  const pad = (short: string) => `0x${short.slice(2).padStart(64, "0")}`;

  it("resolves a short curated ID given in the padded form the chain reports", () => {
    expect(lookupProtocol(pad("0x2"))).toEqual({ name: "Sui Framework", type: "system" });
    expect(lookupProtocol(pad("0x3"))).toEqual({ name: "Sui System", type: "system" });
    expect(lookupProtocol(pad("0xdee9"))?.name).toBe("DeepBook");
  });

  it("counts a padded curated ID as curated", () => {
    // prefetchProtocolNames filters on this, so a false answer also costs a
    // pointless lineage and MVR round trip for a package we already know.
    expect(isCuratedProtocol(pad("0x2"))).toBe(true);
    expect(isCuratedProtocol("0x2")).toBe(true);
  });

  it("reports every registry key in normalized form", () => {
    const keys = Object.keys(loadProtocolRegistry());
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.length === 66 && k.startsWith("0x"))).toBe(true);
  });

  it("returns null for a string that is not an address, rather than throwing", () => {
    // Called mid-decode on IDs from chain data and tool arguments; one bad
    // string must not abort the loop.
    expect(() => lookupProtocol("not-an-address")).not.toThrow();
    expect(lookupProtocol("not-an-address")).toBeNull();
    expect(isCuratedProtocol("not-an-address")).toBe(false);
  });
});
