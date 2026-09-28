import { describe, it, expect } from "vitest";
import { offMarketPrices, priceAnomaly, priceClaimsOf } from "../src/utils/price-claims.js";
import type { AttackEvent } from "../src/utils/attack-analysis.js";
import type { PricePoint } from "../src/utils/valuation.js";

const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const ETH = "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH";
const AT = 1_700_000_000;
const point = (price: number, extra: Partial<PricePoint> = {}): PricePoint => ({ price, publishTime: AT, source: "defillama", ...extra });
const PRICES = new Map<string, PricePoint>([
  [SUI, point(0.74)],
  [USDC, point(1)],
  [ETH, point(2500)],
]);
let n = 0;
const ev = (coin: string, price: string, type = "0x9::oracle::PriceSet"): AttackEvent => ({
  index: n++,
  type,
  json: { coin_type: coin.replace(/^0x/, ""), price, updated_at: "1700000000" },
});

describe("priceClaimsOf", () => {
  it("reads numbers next to exactly one coin, from a field or a lone type argument, and from coin-keyed rows", () => {
    const claims = priceClaimsOf(
      [
        ev(SUI, "7405000000"),
        { index: 90, type: "0x9::pool::Swap", json: { coin_a: SUI, coin_b: USDC, amount: "5" } },
        { index: 91, type: `0x9::oracle::Updated<${ETH}>`, json: { value: "25000000" } },
      ],
      [{ objectId: "0xrow", objectType: "0x2::dynamic_field::Field<0x1::type_name::TypeName,0x9::oracle::Info>", after: { name: USDC.slice(2), value: { price: "1000000" } } }],
    );
    expect(claims.map((c) => [c.source, c.coin, c.path])).toEqual([
      ["event", SUI, "price"],
      ["event", SUI, "updated_at"],
      ["event", ETH, "value"],
      ["row", USDC, "price"],
    ]);
  });
});

describe("offMarketPrices", () => {
  it("flags a coin 100x from its provider price in a field that agrees with the provider for the others (set, use, restore)", () => {
    const claims = priceClaimsOf([ev(SUI, "74050000"), ev(USDC, "10018916957"), ev(SUI, "7405000000")]);
    const found = offMarketPrices(claims, PRICES, AT);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ coin: SUI, path: "price", scale: 10, agreeing: [USDC] });
    expect(found[0].factor).toBeCloseTo(0.01, 3);
    expect(priceAnomaly(found)?.severity).toBe("high");
  });

  it("reads medium from 5x and nothing under it", () => {
    const at = (v: string) => offMarketPrices(priceClaimsOf([ev(USDC, "1000000"), ev(ETH, "2500000000"), ev(SUI, v)]), PRICES, AT);
    expect(priceAnomaly(at("4440000"))?.severity).toBe("medium"); // 6x
    expect(at("2960000")).toEqual([]); // 4x
  });

  it("needs two agreeing coins that are at least half of the priced coins in the field", () => {
    // One agreeing coin does not make a field a price.
    expect(offMarketPrices(priceClaimsOf([ev(USDC, "1000000"), ev(SUI, "7400")]), PRICES, AT)).toEqual([]);
    // Two of five agree: the field is not taken for a price.
    const TOKS = ["0x1::a::A", "0x1::b::B", "0x1::c::C"];
    const prices = new Map([...PRICES, ...TOKS.map((t) => [t, point(3)] as [string, PricePoint])]);
    const claims = priceClaimsOf([ev(USDC, "1000000"), ev(ETH, "2500000000"), ...TOKS.map((t, i) => ev(t, String(90_000 * (i + 1))))]);
    expect(offMarketPrices(claims, prices, AT)).toEqual([]);
  });

  it("does not judge by a stale or low-confidence provider price", () => {
    const claims = priceClaimsOf([ev(USDC, "1000000"), ev(ETH, "2500000000"), ev(SUI, "7400")]);
    expect(offMarketPrices(claims, new Map([...PRICES, [SUI, point(0.74, { publishTime: AT - 7200 })]]), AT)).toEqual([]);
    expect(offMarketPrices(claims, new Map([...PRICES, [SUI, point(0.74, { confidence: 0.5 })]]), AT)).toEqual([]);
    expect(offMarketPrices(claims, PRICES, AT)).toHaveLength(1);
  });
});
