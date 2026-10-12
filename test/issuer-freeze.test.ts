import { describe, it, expect } from "vitest";

import { issuerFreezeFromScan } from "../src/utils/issuer-freeze.js";

const COIN_A = "0xa::usdc::USDC";
const COIN_B = "0xb::wbtc::WBTC";
const CONFIG_A = "0xconf0000000000000000000000000000000000000000000000000000000000000001";
const CONFIG_B = "0xconf0000000000000000000000000000000000000000000000000000000000000002";

// ---------------------------------------------------------------------------
// Pure mapper
// ---------------------------------------------------------------------------

describe("issuerFreezeFromScan", () => {
  it("returns no freezes when the scan found none", () => {
    const r = issuerFreezeFromScan(
      { denied: [], pending: [], coins_checked: 2, complete: true },
      1261,
      new Map(),
    );

    expect(r.frozen_by_issuer).toEqual([]);
    expect(r.coins_checked).toBe(2);
    expect(r.scan_complete).toBe(true);
    expect(r.scan_note).toBeUndefined();
  });

  it("maps denied coin types into entries with config provenance", () => {
    const configs = new Map([[COIN_A, CONFIG_A]]);
    const r = issuerFreezeFromScan(
      { denied: [COIN_A], pending: [], coins_checked: 1, complete: true },
      1261,
      configs,
    );

    expect(r.frozen_by_issuer).toHaveLength(1);
    const e = r.frozen_by_issuer[0];
    expect(e.coin_type).toBe(COIN_A);
    expect(e.config_id).toBe(CONFIG_A);
    expect(e.deny_list_id).toBe("0x0000000000000000000000000000000000000000000000000000000000000403");
    expect(e.epoch).toBe(1261);
    expect(e.active).toBe(true);
    expect(e.evidence_tier).toBe("chain-derived");
  });

  it("excludes a denied coin when its config id is missing from the map — never fabricates", () => {
    const r = issuerFreezeFromScan(
      { denied: [COIN_A], pending: [], coins_checked: 1, complete: true },
      1261,
      new Map(), // empty — COIN_A not mapped
    );

    expect(r.frozen_by_issuer).toEqual([]);
    expect(r.scan_note).toMatch(/omitted because their config id was not available/i);
  });

  it("excludes pending entries — only active (denied) coin types become entries", () => {
    const r = issuerFreezeFromScan(
      { denied: [], pending: [COIN_B], coins_checked: 2, complete: true },
      1261,
      new Map([[COIN_B, CONFIG_B]]),
    );

    expect(r.frozen_by_issuer).toEqual([]);
  });

  it("reports chunk failure in scan_note when complete is false", () => {
    const r = issuerFreezeFromScan(
      { denied: [], pending: [], coins_checked: 0, complete: false },
      1261,
      new Map(),
    );

    expect(r.scan_complete).toBe(false);
    expect(r.scan_note).toMatch(/did not complete/i);
  });

  it("maps several denied coins in the order the scan returned them", () => {
    const configs = new Map([
      [COIN_A, CONFIG_A],
      [COIN_B, CONFIG_B],
    ]);
    const r = issuerFreezeFromScan(
      { denied: [COIN_B, COIN_A], pending: [], coins_checked: 2, complete: true },
      1261,
      configs,
    );

    expect(r.frozen_by_issuer).toHaveLength(2);
    expect(r.frozen_by_issuer[0].coin_type).toBe(COIN_B);
    expect(r.frozen_by_issuer[1].coin_type).toBe(COIN_A);
  });
});
