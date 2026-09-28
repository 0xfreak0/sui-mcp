import { describe, it, expect } from "vitest";
import { exitLeg, legUsd, likeForLike, roundTripAnomaly, scoreRoundTrip, type Leg } from "../src/utils/round-trip.js";
import type { PricePoint } from "../src/utils/valuation.js";

const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const LP = "0x49708adfaa0eaa59d5775b10da5cc6164b74ba04cf80bbdd5272718aea741206::lpcoin::LPCOIN";
const JUNK = "0x1111111111111111111111111111111111111111111111111111111111111111::junk::JUNK";
const SENDER = `0x${"a".repeat(64)}`;
const PRICES = new Map<string, PricePoint>([
  [SUI, { price: 1, publishTime: 0, source: "defillama", decimals: 9 }],
  [USDC, { price: 1, publishTime: 0, source: "defillama", decimals: 6 }],
]);
const leg = (digest: string, deltas: Array<[string, bigint]>): Leg => ({ digest, timestampMs: 1_000, deltas: new Map(deltas) });

describe("legUsd", () => {
  it("values what an address received on net, leaving the unit out, and is unknown when it paid an unpriced coin", () => {
    expect(legUsd(leg("a", [[SUI, 2_000_000_000n], [USDC, -500_000n]]), PRICES, null)).toBeCloseTo(1.5);
    expect(legUsd(leg("a", [[USDC, 5_000_000n], [LP, -10n]]), PRICES, LP)).toBeCloseTo(5);
    expect(legUsd(leg("a", [[USDC, 5_000_000n], [JUNK, -10n]]), PRICES, null)).toBeNull();
    expect(legUsd(leg("a", [[USDC, 5_000_000n], [JUNK, 10n]]), PRICES, null)).toBeCloseTo(5);
  });
});

describe("scoreRoundTrip", () => {
  it("prices shares per unit: redeeming units minted for a fraction of their value reads high", () => {
    // Minted 100 LP for $0.02, redeems 100 LP for $15.
    const mint = { leg: leg("mint", [[USDC, -20_000n], [LP, 100n]]), units: 100n };
    const exit = { leg: leg("exit", [[USDC, 15_000_000n], [LP, -100n]]), units: 100n };
    const trip = scoreRoundTrip("share", LP, "0xvault", exit, [mint], PRICES);
    expect(trip).toMatchObject({ entry_digest: "mint", paid_usd: 0.02, received_usd: 15, factor: 750, basis: "same-coins" });
    expect(roundTripAnomaly([trip!])?.severity).toBe("high");
  });

  it("prorates a partial redemption of the shares minted", () => {
    const mint = { leg: leg("mint", [[USDC, -100_000_000n], [LP, 1_000n]]), units: 1_000n };
    // Half the shares for $55: at the entry rate they cost $50, so 1.1x.
    const exit = { leg: leg("exit", [[USDC, 55_000_000n], [LP, -500n]]), units: 500n };
    expect(scoreRoundTrip("share", LP, "0xvault", exit, [mint], PRICES)?.factor).toBeCloseTo(1.1);
    const fair = { leg: leg("exit", [[USDC, 50_100_000n], [LP, -500n]]), units: 500n };
    expect(scoreRoundTrip("share", LP, "0xvault", fair, [mint], PRICES)).toBeNull();
  });

  it("scores a position against the whole transaction that created it, medium under 2x", () => {
    const entry = { leg: leg("open", [[USDC, -3_000_000_000n]]), units: null };
    const exit = { leg: leg("close", [[SUI, 1_000_000_000_000n], [USDC, 2_600_000_000n]]), units: null };
    const trip = scoreRoundTrip("position", "0xpos", null, exit, [entry], PRICES);
    expect(trip?.factor).toBeCloseTo(1.2);
    expect(roundTripAnomaly([trip!])?.severity).toBe("medium");
  });

  it("skips an entry paid partly in an unpriced coin, an entry that paid nothing, and a gas-sized exit", () => {
    const exit = { leg: leg("close", [[USDC, 9_000_000n]]), units: null };
    expect(scoreRoundTrip("position", "0xpos", null, exit, [{ leg: leg("open", [[USDC, -1_000_000n], [JUNK, -5n]]), units: null }], PRICES)).toBeNull();
    expect(scoreRoundTrip("position", "0xpos", null, exit, [{ leg: leg("open", [[USDC, 1_000_000n]]), units: null }], PRICES)).toBeNull();
    const tiny = { leg: leg("close", [[USDC, 50_000n]]), units: null };
    expect(scoreRoundTrip("position", "0xpos", null, tiny, [{ leg: leg("open", [[USDC, -1n]]), units: null }], PRICES)).toBeNull();
  });
});

describe("exitLeg", () => {
  it("takes the gas the sender paid out of its SUI change", () => {
    const l = exitLeg(
      {
        digest: "d",
        timestampMs: 1,
        balanceChanges: [
          { address: SENDER, coinType: "0x2::sui::SUI", amount: "-7620250" },
          { address: `0x${"b".repeat(64)}`, coinType: "0x2::sui::SUI", amount: "5" },
        ],
        gas: { payer: SENDER, net: 7_664_764n },
      },
      SENDER,
    );
    expect([...l.deltas]).toEqual([[SUI, 44_514n]]);
  });
});

describe("cross-asset and leveraged trips", () => {
  const SUI_UP = new Map<string, PricePoint>([...PRICES, [SUI, { price: 1.3, publishTime: 0, source: "defillama", decimals: 9 }]]);

  it("tells a like-for-like trip from a zap and from a leg that both pays and receives", () => {
    expect(likeForLike(leg("in", [[USDC, -1n], [LP, 5n]]), leg("out", [[USDC, 2n], [SUI, 1n], [LP, -5n]]), LP)).toBe(true);
    expect(likeForLike(leg("in", [[SUI, -1n]]), leg("out", [[USDC, 2n]]), null)).toBe(false);
    expect(likeForLike(leg("in", [[SUI, -3n], [USDC, 2n]]), leg("out", [[SUI, 4n]]), null)).toBe(false);
    expect(likeForLike(leg("in", [[SUI, -3n]]), leg("out", [[SUI, 4n], [USDC, -2n]]), null)).toBe(false);
  });

  it("values a zap's legs at their own times, so a price move between them is not a gain", () => {
    // 100 SUI at $1 in, $100 USDC out; SUI rose to $1.3 by the exit.
    const entry = { leg: leg("zap", [[SUI, -100_000_000_000n]]), units: null };
    const exit = { leg: leg("out", [[USDC, 100_000_000n]]), units: null };
    // At the exit's prices alone the entry would read $130 paid; unscored without its own prices.
    expect(scoreRoundTrip("position", "0xpos", null, exit, [entry], SUI_UP)).toBeNull();
    expect(scoreRoundTrip("position", "0xpos", null, exit, [{ ...entry, ownPrices: PRICES }], SUI_UP)).toBeNull();
  });

  it("counts a trip that is not like-for-like only from 2x, at its own time's prices", () => {
    const entry = { leg: leg("in", [[SUI, -100_000_000_000n]]), units: null, ownPrices: PRICES };
    const gain = (usdc: bigint) => scoreRoundTrip("position", "0xpos", null, { leg: leg("out", [[USDC, usdc]]), units: null }, [entry], SUI_UP);
    expect(gain(150_000_000n)).toBeNull();
    expect(gain(250_000_000n)).toMatchObject({ factor: 2.5, basis: "own-time" });
  });
});
