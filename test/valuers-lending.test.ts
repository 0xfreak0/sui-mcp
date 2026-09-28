import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Lending and margin readers: the protocol arithmetic that turns stored
 * balances into amounts, pricing at a protocol's oracle against a provider,
 * and three readers end to end against a synthetic chain.
 */

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const WAD = 10n ** 18n;
const RAY = 10n ** 27n;
const OWNER = `0x${"a11ce".padStart(64, "0")}`;
const syn = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/* ------------------------------------------------------------------ *
 * Synthetic chain behind a mocked GraphQL client
 * ------------------------------------------------------------------ */

interface Obj {
  address: string;
  type: string;
  json: Record<string, unknown>;
}
const objects = new Map<string, Obj>();
const ofType = new Map<string, Obj[]>();
const owned = new Map<string, Obj[]>();
const fields = new Map<string, Map<string, unknown>>();
const balances = new Map<string, string>();
let ownedFails = false;
let failParent: string | null = null;

const fieldKey = (k: { type: string; bcs: string }) => `${k.type}|${k.bcs}`;
function setField(parent: string, key: { type: string; bcs: string }, value: unknown) {
  if (!fields.has(parent)) fields.set(parent, new Map());
  fields.get(parent)!.set(fieldKey(key), value);
}
const moveObject = (o: Obj) => ({ address: o.address, version: 1, asMoveObject: { contents: { type: { repr: o.type }, json: o.json } } });

const gqlQuery = vi.fn(async (query: string, vars: Record<string, unknown> = {}) => {
  if (query.includes("multiGetObjects")) {
    return { multiGetObjects: (vars.keys as Array<{ address: string }>).map((k) => (objects.has(k.address) ? moveObject(objects.get(k.address)!) : null)) };
  }
  if (query.includes("checkpoint(sequenceNumber")) return { checkpoint: { timestamp: "2026-01-01T00:00:00.000Z", epoch: { epochId: 900 } } };
  if (query.includes("objectAt(checkpoint")) {
    const list = [...ofType.entries()].filter(([t]) => t === vars.type).flatMap(([, v]) => v);
    return {
      objects: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: list.map((o) => ({ address: o.address, objectAt: { version: 1, asMoveObject: { contents: { type: { repr: o.type }, json: o.json } } } })),
      },
    };
  }
  if (query.includes("objects(first: 50, after: $after, filter: { type: $type })")) {
    if (ownedFails) throw new Error("GraphQL error: Request is outside consistent range");
    const list = owned.get(`${vars.owner as string}|${vars.type as string}`) ?? [];
    return {
      address: {
        objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: list.map((o) => ({ address: o.address, version: 1, contents: { type: { repr: o.type }, json: o.json } })) },
      },
    };
  }
  if (query.includes("multiGetBalances")) {
    return { address: { multiGetBalances: (vars.keys as string[]).map((t) => ({ coinType: { repr: t }, totalBalance: balances.get(t) ?? "0" })) } };
  }
  if (query.includes("a0: address(")) {
    if (failParent && Object.values(vars).includes(failParent)) throw new Error("GraphQL error: bad parent");
    const out: Record<string, unknown> = {};
    for (let j = 0; vars[`p${j}`] !== undefined; j++) {
      const parent = vars[`p${j}`] as string;
      const objectFields = query.includes(`multiGetDynamicObjectFields(keys: $k${j})`);
      const values = (vars[`k${j}`] as Array<{ type: string; bcs: string }>).map((k) => {
        const v = fields.get(parent)?.get(fieldKey(k));
        if (v === undefined) return null;
        return objectFields ? { value: { contents: { json: v } } } : { value: { json: v } };
      });
      out[`a${j}`] = { [objectFields ? "multiGetDynamicObjectFields" : "multiGetDynamicFields"]: values };
    }
    return out;
  }
  throw new Error(`unexpected query: ${query.slice(0, 120)}`);
});
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

let providerPrices: Record<string, number> = {};
const priceUsdAtTime = vi.fn(async (types: string[], at?: number) => ({
  points: new Map(
    types.filter((t) => providerPrices[t] !== undefined).map((t) => [t, { price: providerPrices[t], publishTime: at ?? 1_800_000_000, source: "defillama" as const }]),
  ),
  unpriced: types.filter((t) => providerPrices[t] === undefined).map((t) => ({ coin_type: t, code: "not_listed" as const, reason: "No price." })),
}));
vi.mock("../src/utils/valuation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/valuation.js")>()),
  priceUsdAtTime,
  prefetchCoinScale: async () => undefined,
}));

// Imported after the mocks above, which the factories close over.
const lending = await import("../src/utils/valuers/lending.js");
const { suilendLegs, parseSuilendReserve, borrowedFeeds, suilendHealth } = await import("../src/utils/valuers/suilend.js");
const { naviAmount, naviReserveIds, naviOracleOwners } = await import("../src/utils/valuers/navi.js");
const { redeemMarketCoins, sCoinToMarketCoins, marketCoinUnderlying } = await import("../src/utils/valuers/scallop.js");
const { alphaLegs, alphaHealth } = await import("../src/utils/valuers/alphalend.js");
const { healthLeads } = await import("../src/tools/defi.js");
const { v2Debt, v1Bottle } = await import("../src/utils/valuers/bucket.js");
const { proPnl, fromProUnits } = await import("../src/utils/valuers/bluefin.js");
const { valueObjects, valuePositions, registerValuer } = await import("../src/utils/position-value.js");

beforeEach(() => {
  objects.clear();
  ofType.clear();
  owned.clear();
  fields.clear();
  balances.clear();
  ownedFails = false;
  failParent = null;
  providerPrices = {};
  lending.resetLendingMemo();
});

/* ------------------------------------------------------------------ *
 * Pricing at a protocol's oracle
 * ------------------------------------------------------------------ */

describe("assembleLending", () => {
  const NOW = 1_800_000_000;
  const base = { protocol: "P", kind: "lending" as const, object_id: null, oracle: "p_oracle", at_s: NOW, method: "m." };
  const prices = (entries: Record<string, number>) => ({
    points: new Map(Object.entries(entries).map(([t, price]) => [t, { price, publishTime: NOW, source: "defillama" as const }])),
    unpriced: [],
  });

  it("values at the oracle price and nets borrows against supply", () => {
    const p = lending.assembleLending(
      base,
      [
        { coin_type: SUI, amount: 10n * 10n ** 9n, side: "supply", oracle_price: 2, oracle_at_s: NOW - 60 },
        { coin_type: USDC, amount: 5n * 10n ** 6n, side: "borrow", oracle_price: 1, oracle_at_s: NOW - 60 },
      ],
      prices({ [SUI]: 2.01, [USDC]: 1 }),
    );
    expect(p.assets.map((a) => a.usd)).toEqual([20, 5]);
    expect(p.usd_net).toBe(15);
    expect(p.tier).toBe("chain-derived");
    expect(p.assets.every((a) => a.price_check === undefined)).toBe(true);
  });

  it("values a leg at the provider's price when a fresh oracle price fails the check, never chain-derived", () => {
    // A reserve priced by another asset's feed looks like this: fresh, and $1 for a coin worth nothing.
    const p = lending.assembleLending(base, [{ coin_type: SUI, amount: 10n ** 9n, side: "supply", oracle_price: 2, oracle_at_s: NOW - 60 }], prices({ [SUI]: 2.2 }));
    expect(p.assets[0].usd).toBeCloseTo(2.2);
    expect(p.assets[0].price_source).toBe("defillama");
    expect(p.assets[0].price_check).toMatchObject({ oracle_price: 2, provider_price: 2.2, diff_pct: 10 });
    expect(p.assets[0].price_check?.oracle_age_sec).toBeUndefined();
    expect(p.tier).toBe("price-provider");
  });

  it("treats an oracle price no provider can confirm as an estimate", () => {
    const p = lending.assembleLending(base, [{ coin_type: SUI, amount: 10n ** 9n, side: "supply", oracle_price: 2, oracle_at_s: NOW - 60 }], prices({}));
    expect(p.assets[0].usd).toBe(2);
    expect(p.tier).toBe("heuristic");
  });

  it("never values a leg at another asset's feed", () => {
    const leg = { coin_type: USDC, amount: 10n ** 6n, side: "supply" as const, oracle_price: 1, oracle_at_s: NOW - 60, feed_of: SUI };
    const withProvider = lending.assembleLending(base, [leg], prices({ [USDC]: 0.001 }));
    expect(withProvider.assets[0].usd).toBeCloseTo(0.001);
    expect(withProvider.assets[0].price_source).toBe("defillama");
    const without = lending.assembleLending(base, [leg], prices({}));
    expect(without.assets[0].usd).toBeNull();
    expect(without.usd_net).toBeNull();
  });

  it("values a liquid-staking leg as SUI at its issuer's rate and the protocol's SUI price", () => {
    const lst = `${syn(0x7777)}::lst::LST`;
    const leg = { coin_type: lst, amount: 10n ** 9n, side: "supply" as const, decimals: 9, oracle_price: 2, oracle_at_s: NOW - 60, lst: { sui_per_lst: 1.05, issuer: "Issuer" } };
    // The protocol prices the LST at SUI's $2; the provider has the LST at $2.10.
    const p = lending.assembleLending({ ...base, sui_oracle: { price: 2, at_s: NOW - 60 } }, [leg], prices({ [lst]: 2.1 }));
    expect(p.assets[0].usd).toBeCloseTo(2.1);
    expect(p.assets[0].price_check).toBeUndefined();
    expect(p.tier).toBe("chain-derived");
    // With no provider price for the LST itself, SUI's at the same rate is the check.
    const q = lending.assembleLending({ ...base, sui_oracle: { price: 2, at_s: NOW - 60 } }, [leg], prices({ [SUI]: 2 }));
    expect(q.assets[0].usd).toBeCloseTo(2.1);
    expect(q.tier).toBe("chain-derived");
  });

  it("values at the provider's price when the oracle price is stale and disagrees, and says how old it was", () => {
    const p = lending.assembleLending(base, [{ coin_type: SUI, amount: 10n ** 9n, side: "supply", oracle_price: 2, oracle_at_s: NOW - 7200 }], prices({ [SUI]: 2.2 }));
    expect(p.assets[0].usd).toBeCloseTo(2.2);
    expect(p.assets[0].price_source).toBe("defillama");
    expect(p.assets[0].price_check).toMatchObject({ oracle_price: 2, provider_price: 2.2, oracle_age_sec: 7200 });
    expect(p.tier).toBe("price-provider");
  });

  it("keeps a stale oracle price that still agrees with the provider", () => {
    const p = lending.assembleLending(base, [{ coin_type: SUI, amount: 10n ** 9n, side: "supply", oracle_price: 2, oracle_at_s: NOW - 7200 }], prices({ [SUI]: 2.01 }));
    expect(p.assets[0].price_source).toBe("p_oracle");
    expect(p.tier).toBe("chain-derived");
  });

  it("leaves the net null when a leg has neither an oracle nor a provider price", () => {
    const p = lending.assembleLending(
      base,
      [
        { coin_type: SUI, amount: 10n ** 9n, side: "supply", oracle_price: 2 },
        { coin_type: USDC, amount: 10n ** 6n, side: "borrow" },
      ],
      prices({}),
    );
    expect(p.assets[1].usd).toBeNull();
    expect(p.usd_net).toBeNull();
    expect(p.unpriced_reason).toContain(USDC);
  });

  it("does not scale an amount by guessed decimals", () => {
    const unknown = `${syn(0xbeef)}::x::X`;
    const p = lending.assembleLending(base, [{ coin_type: unknown, amount: 10n ** 9n, side: "supply", oracle_price: 1 }], prices({}));
    expect(p.assets[0].usd).toBeNull();
    expect(p.usd_net).toBeNull();
  });
});

describe("health ratios and their basis", () => {
  const NOW = 1_800_000_000;
  const wad = (usd: number) => ({ value: (BigInt(usd) * WAD).toString() });
  const suilendShaped = (figures: Record<string, number>) => Object.fromEntries(Object.entries(figures).map(([k, v]) => [k, wad(v)]));

  it("measures a Suilend obligation's borrow limit at the upper-bound borrows and its liquidation line at the weighted borrows", () => {
    const h = suilendHealth(
      suilendShaped({ weighted_borrowed_value_usd: 9_500, weighted_borrowed_value_upper_bound_usd: 9_600, allowed_borrow_value_usd: 10_000, unhealthy_borrow_value_usd: 11_000 }),
    );
    expect(h.borrow_limit_used).toBe(0.96);
    expect(h.liquidation_threshold_used).toBe(0.8636);
    expect(h.allowed_borrow_value_usd).toBe(10_000);
    // Without an upper bound the weighted borrows measure both.
    const older = suilendHealth(suilendShaped({ weighted_borrowed_value_usd: 9_500, allowed_borrow_value_usd: 10_000, unhealthy_borrow_value_usd: 11_000 }));
    expect(older.borrow_limit_used).toBe(0.95);
  });

  it("measures an AlphaLend position's weighted loans against its safe collateral and its liquidation value", () => {
    const h = alphaHealth(suilendShaped({ weighted_total_loan_usd: 40, safe_collateral_usd: 50, liquidation_value: 60, total_collateral_usd: 80, total_loan_usd: 40 }));
    expect(h.borrow_limit_used).toBe(0.8);
    expect(h.liquidation_threshold_used).toBe(0.6667);
  });

  it("reads nothing borrowed as 0 and a borrow against no limit as unknown", () => {
    expect(lending.usedRatio(0, 0)).toBe(0);
    expect(lending.usedRatio(5, 0)).toBeNull();
    expect(lending.usedRatio(5, null)).toBeNull();
  });

  const base = { protocol: "P", kind: "lending" as const, object_id: null, oracle: "p_oracle", at_s: NOW, method: "m." };
  const prices = { points: new Map([[USDC, { price: 1, publishTime: NOW, source: "defillama" as const }]]), unpriced: [] };
  // $100 supplied and $50 borrowed at the legs' prices.
  const legs = [
    { coin_type: USDC, amount: 100n * 10n ** 6n, side: "supply" as const, decimals: 6, oracle_price: 1 },
    { coin_type: USDC, amount: 50n * 10n ** 6n, side: "borrow" as const, decimals: 6, oracle_price: 1 },
  ];

  it("says which figures measure liquidation only when the protocol's totals and the legs' part by more than the price-check tolerance", () => {
    const within = lending.assembleLending({ ...base, stored_totals: { deposits_usd: 98.5, borrows_usd: 50 } }, legs, prices);
    expect(within.health_basis).toBeUndefined();
    const apart = lending.assembleLending({ ...base, stored_totals: { deposits_usd: 90, borrows_usd: 50 } }, legs, prices);
    expect(apart.health_basis).toContain("a gap of $10.00");
    expect(apart.health_basis).toContain("use `health` for distance to liquidation");
    expect(apart.health_basis).not.toContain("refresh");
    // Borrows alone can part them too, and a recorded refresh time dates the ratios.
    const stale = lending.assembleLending({ ...base, stored_totals: { deposits_usd: 100, borrows_usd: 40, as_of_s: NOW - 86_400 } }, legs, prices);
    expect(stale.health_basis).toContain(`as of its last refresh at ${new Date((NOW - 86_400) * 1000).toISOString()}`);
    expect(stale.health_basis).toContain("its ratios are as of that refresh");
  });

  it("counts collateral reported in its own row before comparing", () => {
    const p = lending.assembleLending({ ...base, stored_totals: { deposits_usd: 130, borrows_usd: 50, supply_elsewhere_usd: 30 } }, legs, prices);
    expect(p.health_basis).toBeUndefined();
  });

  it("leads with a position at 95% of its borrow limit or more, never below", () => {
    const at = (weighted: number) => ({
      protocol: "Suilend",
      kind: "lending" as const,
      object_id: syn(weighted),
      assets: [],
      usd_net: 1,
      method: "m.",
      tier: "chain-derived" as const,
      health: suilendHealth(suilendShaped({ weighted_borrowed_value_usd: weighted, allowed_borrow_value_usd: 10_000, unhealthy_borrow_value_usd: 11_000 })),
      detail: { health_ratios: { borrow_limit_used: ["weighted_borrowed_value_usd", "allowed_borrow_value_usd"], liquidation_threshold_used: ["weighted_borrowed_value_usd", "unhealthy_borrow_value_usd"] } },
    });
    const leads = healthLeads([at(9_499), at(9_500), at(10_100)]);
    expect(leads.map((l) => l.borrow_limit_used)).toEqual([1.01, 0.95]);
    expect(leads[1].lead).toContain("has used 95.00% of its borrow limit (weighted_borrowed_value_usd $9,500 over allowed_borrow_value_usd $10,000)");
    expect(leads[1].lead).toContain("86.36% of its liquidation threshold");
    expect(leads[1].lead).toContain("a small price move or accrued interest reaches the limit");
    expect(leads[0].lead).toContain("is past its borrow limit at 101.00%");
  });
});

describe("shared reads", () => {
  it("encodes a TypeName key the way Move spells the type, with padded addresses and no 0x", () => {
    const key = lending.typeNameKey("0x2::sui::SUI");
    const bytes = Buffer.from(key.bcs, "base64");
    expect(bytes[0]).toBe(bytes.length - 1);
    expect(bytes.subarray(1).toString("ascii")).toBe(`${"0".repeat(63)}2::sui::SUI`);
  });

  it("splits only top-level type arguments", () => {
    expect(lending.typeArgs("0x1::m::T<0x2::a::A, 0x3::b::B<0x4::c::C, 0x5::d::D>>")).toEqual(["0x2::a::A", "0x3::b::B<0x4::c::C, 0x5::d::D>"]);
  });

  it("keeps every chunk inside the byte budget and the count cap", () => {
    const chunks = lending.chunkByBytes(Array.from({ length: 30 }, (_v, i) => i), () => 100, 450, 3);
    expect(chunks.every((c) => c.length <= 3 && c.length * 100 <= 450)).toBe(true);
    expect(chunks.flat()).toEqual(Array.from({ length: 30 }, (_v, i) => i));
  });

  it("sends concurrent field reads for one state as one request, each caller getting its own rows", async () => {
    setField(syn(0x901), lending.u8Key(1), "one");
    setField(syn(0x902), lending.u8Key(2), "two");
    gqlQuery.mockClear();
    const [a, b] = await Promise.all([
      lending.readFields([{ parent: syn(0x901), keys: [lending.u8Key(1), lending.u8Key(9)] }], "77"),
      lending.readFields([{ parent: syn(0x902), keys: [lending.u8Key(2)] }], "77"),
    ]);
    expect(a).toEqual([["one", null]]);
    expect(b).toEqual([["two"]]);
    expect(gqlQuery).toHaveBeenCalledTimes(1);
  });

  it("keeps every request under the service's 5,000-byte payload, variables included", async () => {
    gqlQuery.mockClear();
    const parents = Array.from({ length: 25 }, (_v, i) => syn(0xa00 + i));
    const rows = await lending.readFields(parents.map((parent) => ({ parent, keys: [lending.addressKey(OWNER)] })), "79");
    expect(rows).toHaveLength(25);
    expect(gqlQuery.mock.calls.length).toBeGreaterThan(1);
    for (const [query, variables] of gqlQuery.mock.calls) {
      expect(Buffer.byteLength(JSON.stringify({ query, variables }))).toBeLessThanOrEqual(5000);
    }
  });

  it("retries each caller alone when the combined read fails, so one bad read fails only its caller", async () => {
    setField(syn(0x901), lending.u8Key(1), "one");
    failParent = syn(0x9ad);
    const [good, bad] = await Promise.allSettled([
      lending.readFields([{ parent: syn(0x901), keys: [lending.u8Key(1)] }], "78"),
      lending.readFields([{ parent: syn(0x9ad), keys: [lending.u8Key(1)] }], "78"),
    ]);
    expect(good).toEqual({ status: "fulfilled", value: [["one"]] });
    expect(bad.status).toBe("rejected");
  });
});

/* ------------------------------------------------------------------ *
 * Protocol arithmetic
 * ------------------------------------------------------------------ */

const suilendReserve = (coinType: string, over: Record<string, unknown> = {}) => ({
  coin_type: { name: coinType.slice(2) },
  mint_decimals: 9,
  price: { value: (2n * WAD).toString() },
  price_last_update_timestamp_s: "1800000000",
  available_amount: "1000",
  borrowed_amount: { value: (500n * WAD).toString() },
  unclaimed_spread_fees: { value: (100n * WAD).toString() },
  ctoken_supply: "1000",
  cumulative_borrow_rate: { value: ((11n * WAD) / 10n).toString() },
  ...over,
});

describe("Suilend", () => {
  it("redeems cTokens at supply less fees over cToken supply, and grows a borrow by the reserve's rate", () => {
    const reserve = parseSuilendReserve(suilendReserve(SUI));
    const legs = suilendLegs(
      {
        deposits: [{ reserve_array_index: "0", deposited_ctoken_amount: "100" }],
        borrows: [{ reserve_array_index: "0", borrowed_amount: { value: (50n * WAD).toString() }, cumulative_borrow_rate: { value: WAD.toString() } }],
      },
      [reserve],
    );
    // (1000 + 500 - 100) / 1000 = 1.4 per cToken; 50 at 1.0 grown to 1.1 is 55.
    expect(legs.map((l) => [l.side, l.amount])).toEqual([
      ["supply", 140n],
      ["borrow", 55n],
    ]);
    expect(legs[0].oracle_price).toBe(2);
  });
});

describe("NAVI", () => {
  it("scales a balance by the index, then from NAVI's 9 decimals to the coin's own", () => {
    const index = (11n * RAY) / 10n;
    expect(naviAmount(10n ** 9n, index, 9)).toBe(1_100_000_000n);
    expect(naviAmount(10n ** 9n, index, 6)).toBe(1_100_000n);
    expect(naviAmount(10n ** 9n, index, 12)).toBe(1_100_000_000_000n);
    expect(naviAmount(10n ** 9n, index, null)).toBe(1_100_000_000n);
  });

  it("reads reserve ids from a base64 vector<u8>", () => {
    expect(naviReserveIds(Buffer.from([0, 10]).toString("base64"))).toEqual([0, 10]);
  });
});

describe("Scallop", () => {
  it("redeems market coins at cash plus debt less revenue over supply, and sCoins at their treasury's ratio", () => {
    const sheet = { cash: 800n, debt: 400n, revenue: 200n, market_coin_supply: 900n };
    expect(redeemMarketCoins(90n, sheet)).toBe(100n);
    expect(sCoinToMarketCoins(100n, { s_coin_supply: 200n, market_coin_balance: 100n })).toBe(50n);
  });

  it("recognises a market coin by Scallop's own type only", () => {
    expect(marketCoinUnderlying(`0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf::reserve::MarketCoin<${SUI}>`)).toBe(SUI);
    expect(marketCoinUnderlying(`${syn(0xbad)}::reserve::MarketCoin<${SUI}>`)).toBeNull();
  });
});

describe("AlphaLend", () => {
  it("values xTokens at the market ratio and grows loans by the market's compounded interest", () => {
    const markets = new Map([["1", { market_id: "1", coin_type: SUI, xtoken_ratio: (105n * WAD) / 100n, compounded_interest: (12n * WAD) / 10n }]]);
    const legs = alphaLegs(
      { collaterals: { contents: [{ key: "1", value: "1000" }] }, loans: [{ market_id: "1", amount: "100", borrow_compounded_interest: { value: WAD.toString() } }] },
      markets,
    );
    expect(legs.map((l) => [l.side, l.amount])).toEqual([
      ["supply", 1050n],
      ["borrow", 120n],
    ]);
  });
});

describe("Bucket", () => {
  const vault = {
    vault_id: syn(1),
    coin_type: SUI,
    decimals: 9,
    interest_rate: WAD / 10n,
    interest_unit: WAD / 5n,
    updated_ms: 0n,
    total_debt: 1n,
    min_collateral_ratio: 1.1,
    table: syn(2),
  };

  it("grows v2 debt linearly from the vault's last update and rounds the interest up", () => {
    const halfYear = 31_536_000_000n / 2n;
    // Unit 0.2 + 0.1 * 0.5 = 0.25; the position settled at 0.1, so interest is 0.15 * 1000.
    expect(v2Debt({ debt_amount: 1000n, interest_unit: WAD / 10n }, vault, halfYear)).toBe(1150n);
    expect(v2Debt({ debt_amount: 1000n, interest_unit: WAD / 10n }, { ...vault, total_debt: 0n }, halfYear)).toBe(1100n);
  });

  it("adds a v1 bottle's redistribution share and grows its debt by the interest index", () => {
    const bucket = {
      bucket_id: syn(3),
      coin_type: SUI,
      decimals: 9,
      min_collateral_ratio: 1.1,
      bottles: syn(4),
      surplus: syn(5),
      reward_per_unit_stake: 2n ** 63n,
      debt_per_unit_stake: 2n ** 62n,
    };
    const bottle = { collateral_amount: "1000", buck_amount: "100", stake_amount: "1000", reward_coll_snapshot: "0", reward_debt_snapshot: "0" };
    // Index 1.2 grows by 1.2 * (1e23 * 1000 ms) / 1e27 to 1.32; the bottle settled at 1.1.
    const interest = { rate: 10n ** 23n, active_index: (12n * RAY) / 10n, updated_ms: 0n };
    expect(v1Bottle(bottle, bucket, interest, (11n * RAY) / 10n, 1000n)).toEqual({ collateral: 1500n, debt: 120n + 250n });
  });
});

describe("Bluefin Pro", () => {
  it("signs unrealized PnL by side and converts internal units to the coin's", () => {
    const p = { size: "10000000000", average_entry_price: "2000000000" };
    expect(proPnl({ ...p, is_long: true }, 3_000_000_000n)).toBe(10_000_000_000n);
    expect(proPnl({ ...p, is_long: false }, 3_000_000_000n)).toBe(-10_000_000_000n);
    expect(fromProUnits(33_541_505_340n, 6)).toBe(33_541_505n);
  });
});

/* ------------------------------------------------------------------ *
 * Readers end to end
 * ------------------------------------------------------------------ */

const SUILEND_PKG = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const CAP_TYPE = `${SUILEND_PKG}::lending_market::ObligationOwnerCap<${syn(0x9)}::pool::POOL>`;

function seedSuilend() {
  const market = syn(0x100);
  const obligation = syn(0x101);
  objects.set(market, {
    address: market,
    type: `${SUILEND_PKG}::lending_market::LendingMarket<${syn(0x9)}::pool::POOL>`,
    json: {
      reserves: [
        suilendReserve(SUI, { available_amount: "1000", borrowed_amount: { value: "0" }, unclaimed_spread_fees: { value: "0" }, ctoken_supply: "1000" }),
        suilendReserve(USDC, { mint_decimals: 6, price: { value: WAD.toString() }, cumulative_borrow_rate: { value: WAD.toString() } }),
      ],
    },
  });
  objects.set(obligation, {
    address: obligation,
    type: `${SUILEND_PKG}::obligation::Obligation<${syn(0x9)}::pool::POOL>`,
    json: {
      lending_market_id: market,
      deposits: [{ reserve_array_index: "0", deposited_ctoken_amount: "10000000000" }],
      borrows: [{ reserve_array_index: "1", borrowed_amount: { value: (5_000_000n * WAD).toString() }, cumulative_borrow_rate: { value: WAD.toString() } }],
      deposited_value_usd: { value: (20n * WAD).toString() },
      allowed_borrow_value_usd: { value: (14n * WAD).toString() },
      unhealthy_borrow_value_usd: { value: (15n * WAD).toString() },
    },
  });
  return { market, obligation };
}

describe("Suilend reader", () => {
  it("values an obligation cap a transaction moved, with the obligation's own health figures", async () => {
    const { obligation } = seedSuilend();
    providerPrices = { [SUI]: 2, [USDC]: 1 };
    const cap = syn(0x102);
    const r = await valueObjects([{ object_id: cap, type: CAP_TYPE, json: { id: cap, obligation_id: obligation } }], { owner: OWNER });
    expect(r.unhandled).toEqual([]);
    const [p] = r.positions;
    expect(p.protocol).toBe("Suilend");
    expect(p.object_id).toBe(cap);
    // 10 SUI at $2 supplied, 5 USDC at $1 borrowed.
    expect(p.assets.map((a) => [a.coin_type, a.side, a.amount])).toEqual([
      [SUI, "supply", "10000000000"],
      [USDC, "borrow", "5000000"],
    ]);
    expect(p.usd_net).toBeCloseTo(15);
    expect(p.tier).toBe("chain-derived");
    expect(p.health?.allowed_borrow_value_usd).toBe(14);
  });

  it("names the listing it could not make at a checkpoint instead of failing", async () => {
    ownedFails = true;
    const r = await valuePositions({ owner: OWNER, atCheckpoint: "123" }, ["suilend"]);
    expect(r.positions).toEqual([]);
    expect(r.unread).toHaveLength(1);
    expect(r.unread[0].what).toContain("ObligationOwnerCap");
  });
});

describe("NAVI reader", () => {
  it("finds an address's balances in every market it uses and values them in the coin's own decimals", async () => {
    const NAVI_STORAGE = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca::storage::Storage";
    const ORACLE_TABLE = "0xc0601facd3b98d1e82905e660bf9f5998097dedcf86ed802cf485865e3e3667c";
    const reserve = (id: number, coinType: string, oracleId: number, supplyTable: string, borrowTable: string) => ({
      id,
      oracle_id: oracleId,
      coin_type: coinType.slice(2),
      current_supply_index: ((11n * RAY) / 10n).toString(),
      current_borrow_index: RAY.toString(),
      supply_balance: { user_state: { id: supplyTable } },
      borrow_balance: { user_state: { id: borrowTable } },
    });
    // Market A: the owner supplies SUI and borrows USDC. Market B: the owner has no entry.
    ofType.set(NAVI_STORAGE, [
      { address: syn(0x200), type: NAVI_STORAGE, json: { reserves: { id: syn(0x201) }, reserves_count: 2, user_info: { id: syn(0x202) } } },
      { address: syn(0x300), type: NAVI_STORAGE, json: { reserves: { id: syn(0x301) }, reserves_count: 1, user_info: { id: syn(0x302) } } },
    ]);
    setField(syn(0x201), lending.u8Key(0), reserve(0, SUI, 0, syn(0x210), syn(0x211)));
    setField(syn(0x201), lending.u8Key(1), reserve(1, USDC, 10, syn(0x212), syn(0x213)));
    setField(syn(0x202), lending.addressKey(OWNER), { collaterals: Buffer.from([0]).toString("base64"), loans: Buffer.from([1]).toString("base64") });
    setField(syn(0x210), lending.addressKey(OWNER), (10n * 10n ** 9n).toString());
    setField(syn(0x213), lending.addressKey(OWNER), (4n * 10n ** 9n).toString());
    setField(ORACLE_TABLE, lending.u8Key(0), { value: "2000000000", decimal: 9, timestamp: String(Date.now()) });
    setField(ORACLE_TABLE, lending.u8Key(10), { value: "1000000", decimal: 6, timestamp: String(Date.now()) });
    providerPrices = { [SUI]: 2, [USDC]: 1 };

    const r = await valuePositions({ owner: OWNER }, ["navi"]);
    expect(r.unread).toEqual([]);
    expect(r.positions).toHaveLength(1);
    const [p] = r.positions;
    // 10 scaled SUI at index 1.1 is 11 SUI; 4 scaled USDC in 9 decimals is 4 USDC in 6.
    expect(p.assets.map((a) => [a.coin_type, a.side, a.amount])).toEqual([
      [SUI, "supply", "11000000000"],
      [USDC, "borrow", "4000000"],
    ]);
    expect(p.usd_net).toBeCloseTo(18);
    expect(p.detail?.storage_id).toBe(syn(0x200));
  });
});

describe("Scallop reader", () => {
  it("values held sCoins as a supply position and names the receipt coin", async () => {
    const MARKET = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
    const TREASURY = "0x80ca577876dec91ae6d22090e56c39bc60dce9086ab0729930c6900bc4162b4c::s_coin_converter::SCoinTreasury";
    const ORACLE_TABLE = "0xf5d0a43dcc96aa33cbe48d86155ede120377d25863389a75634364a5c8e054a7";
    const sCoin = `${syn(0x400)}::s_sui::S_SUI`;
    objects.set(MARKET, {
      address: MARKET,
      type: "market",
      json: {
        vault: { balance_sheets: { table: { id: syn(0x401) }, keys: { contents: [SUI.slice(2)] } } },
        borrow_dynamics: { table: { id: syn(0x402) }, keys: { contents: [SUI.slice(2)] } },
      },
    });
    ofType.set(TREASURY, [{ address: syn(0x403), type: `${TREASURY}<${sCoin}, ${SUI}>`, json: { s_coin_supply: { value: "100" }, market_coin_balance: "100" } }]);
    setField(syn(0x401), lending.typeNameKey(SUI), { cash: "800", debt: "400", revenue: "200", market_coin_supply: "900" });
    setField(ORACLE_TABLE, lending.typeNameKey(SUI), { value: "2000000000", last_updated: String(Math.floor(Date.now() / 1000)) });
    balances.set(sCoin, "9000000000");
    providerPrices = { [SUI]: 2 };

    const r = await valuePositions({ owner: OWNER }, ["scallop"]);
    expect(r.unread).toEqual([]);
    const [p] = r.positions;
    // 9 sCoins are 9 market coins, which redeem at 1000/900 for 10 SUI.
    expect(p.assets).toMatchObject([{ coin_type: SUI, side: "supply", amount: "10000000000" }]);
    expect(p.usd_net).toBeCloseTo(20);
    expect(p.detail?.receipt_coin_types).toEqual([sCoin]);
  });
});

describe("borrowed price feeds", () => {
  it("marks a Suilend reserve that reuses an earlier reserve's feed for another coin, and only that one", () => {
    const fud = `${syn(0xf0d)}::fud::FUD`;
    const lst = `${syn(0x5501)}::lst::LST`;
    const reserves = [
      parseSuilendReserve(suilendReserve(SUI, { price_identifier: { bytes: "U1VJ" } })),
      parseSuilendReserve(suilendReserve(USDC, { price_identifier: { bytes: "VVNEQw==" } })),
      parseSuilendReserve(suilendReserve(fud, { price_identifier: { bytes: "VVNEQw==" }, config: { element: { open_ltv_pct: 0 } } })),
      parseSuilendReserve(suilendReserve(lst, { price_identifier: { bytes: "U1VJ" } })),
    ];
    expect([...borrowedFeeds(reserves)]).toEqual([
      [2, USDC],
      [3, SUI],
    ]);
    const legs = suilendLegs({ deposits: [{ reserve_array_index: "1", deposited_ctoken_amount: "1" }, { reserve_array_index: "2", deposited_ctoken_amount: "1" }] }, reserves);
    expect(legs.map((l) => l.feed_of)).toEqual([undefined, USDC]);
  });

  it("gives a NAVI oracle id to the first reserve listed with it", () => {
    const owners = naviOracleOwners([
      { id: 3, oracle_id: 0, coin_type: USDC },
      { id: 0, oracle_id: 0, coin_type: SUI },
      { id: 1, oracle_id: 1, coin_type: USDC },
    ]);
    expect([...owners]).toEqual([
      [0, SUI],
      [1, USDC],
    ]);
  });
});

describe("Bucket accrual time", () => {
  it("accrues v2 debt to the checkpoint read, not to a later pricing time", async () => {
    const V2_VAULT = "0x9f835c21d21f8ce519fec17d679cd38243ef2643ad879e7048ba77374be4036e::vault::Vault";
    const ACCOUNT = "0x665188033384920a5bb5dcfb2ef21f54b4568d08b431718b97e02e5c184b92cc::account::Account";
    const checkpointMs = Date.parse("2026-01-01T00:00:00.000Z");
    const account = syn(0xacc);
    ofType.set(V2_VAULT, [
      {
        address: syn(0xba1),
        type: `${V2_VAULT}<${SUI}>`,
        json: {
          decimal: 9,
          interest_rate: { value: (WAD / 10n).toString() },
          interest_unit: { value: (WAD / 5n).toString() },
          timestamp: String(checkpointMs),
          total_debt_amount: "1000",
          min_collateral_ratio: { value: "1100000000" },
          position_table: { id: syn(0xba2) },
        },
      },
    ]);
    setField(syn(0xba2), lending.addressKey(account), { value: { coll_amount: "5000", debt_amount: "1000", interest_unit: { value: (WAD / 5n).toString() } } });
    const aYearLater = checkpointMs / 1000 + 31_536_000;
    const r = await valueObjects([{ object_id: account, type: ACCOUNT, json: { id: account } }], { owner: OWNER, atCheckpoint: "500", atTime: aYearLater });
    expect(r.positions[0].assets.find((a) => a.side === "borrow")?.amount).toBe("1000");
  });
});

describe("AlphaLend LP collateral", () => {
  it("credits a moved PositionCap with its LP collateral, under the cap's id", async () => {
    const PROTOCOL = "0x01d9cf05d65fa3a9bb7163095139120e3c4e414dfbab153a49779a7d14010b93";
    const CAP = "0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4::position::PositionCap";
    const ORACLE_KEY = { type: "0x58fb555e394c7c67537292963c0916023d1b9530896e9f1d2cea734d7208ce93::oracle::OracleIdentityKey", bcs: "AA==" };
    const [positions, markets, oracleUid, priceTable, positionId, lpId, capId] = [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7].map(syn);
    const lpType = `${syn(0x5151)}::fake_lp::Position`;
    registerValuer({
      name: "fake_lp",
      value: async () => ({ positions: [], unread: [] }),
      handles: (t) => t === lpType,
      valueObject: async (o) => ({ positions: [{ protocol: "X", kind: "clmm", object_id: o.object_id, assets: [], usd_net: 5, method: "m.", tier: "price-provider" }], unread: [] }),
    });
    objects.set(PROTOCOL, { address: PROTOCOL, type: "p", json: { positions: { id: positions }, markets: { id: markets }, oracle: { id: oracleUid } } });
    objects.set(lpId, { address: lpId, type: lpType, json: {} });
    setField(oracleUid, ORACLE_KEY, { id: priceTable });
    setField(positions, lending.idKey(positionId), {
      collaterals: { contents: [{ key: "1", value: "1000000000" }] },
      loans: [],
      lp_collaterals: { lp_position_id: lpId },
    });
    setField(markets, lending.u64Key(1), { market_id: "1", coin_type: { name: SUI.slice(2) }, xtoken_ratio: { value: WAD.toString() }, compounded_interest: { value: WAD.toString() } });
    setField(priceTable, lending.typeNameKey(SUI), { price: { value: (2n * WAD).toString() }, last_updated: String(Math.floor(Date.now() / 1000)) });
    providerPrices = { [SUI]: 2 };
    const r = await valueObjects([{ object_id: capId, type: CAP, json: { position_id: positionId } }], { owner: OWNER });
    expect(r.positions.map((p) => [p.object_id, p.usd_net])).toEqual(
      expect.arrayContaining([
        [capId, 5],
        [capId, expect.closeTo(2)],
      ]),
    );
    expect(r.positions.find((p) => p.kind === "clmm")?.detail?.lp_position_id).toBe(lpId);
  });
});
