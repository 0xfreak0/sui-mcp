import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `0x2::coin_registry` is Sui's canonical on-chain coin metadata, and it is NOT
 * a whitelist: anyone who can publish a coin can register it. Presence must
 * never become `verified`, which is the curated claim and a much stronger one.
 *
 * What it is worth reading for is decimals. `analyze_token` fell back to 9 when
 * nothing knew, and the coins that reach that fallback are exactly the ones a
 * wrong scale is most dangerous for.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { fetchRegistryCurrency } = await import("../src/utils/onchain-coin-registry.js");
const { decimalsTier } = await import("../src/tools/analyze-token.js");

const currency = (json: unknown) => ({ objects: { nodes: [{ asMoveObject: { contents: { json } } }] } });

beforeEach(() => mockGqlQuery.mockReset());

describe("reading a coin's registry entry", () => {
  it("returns the chain's decimals", async () => {
    mockGqlQuery.mockResolvedValue(currency({ decimals: 6, symbol: "USDC", name: "USDC" }));
    const c = await fetchRegistryCurrency("0xabc::usdc::USDC");
    expect(c).toMatchObject({ decimals: 6, symbol: "USDC", regulated: "unknown" });
  });

  /** The same authority `check_coin_restrictions` reads. */
  it("reports a regulated coin and the cap that can freeze holders", async () => {
    mockGqlQuery.mockResolvedValue(
      currency({ decimals: 6, regulated: { "@variant": "Regulated", cap: "0xcap" } }),
    );
    const c = await fetchRegistryCurrency("0xabc::usdc::USDC");
    expect(c?.regulated).toBe("regulated");
    expect(c?.regulated_cap_id).toBe("0xcap");
  });

  it("reports an unregulated coin without inventing a cap", async () => {
    mockGqlQuery.mockResolvedValue(currency({ decimals: 9, regulated: { "@variant": "Unregulated" } }));
    const c = await fetchRegistryCurrency("0xabc::t::T");
    expect(c?.regulated).toBe("unregulated");
    expect(c?.regulated_cap_id).toBeUndefined();
  });

  /** An entry with no decimals is no better than no entry. */
  it("returns null when the entry carries no decimals", async () => {
    mockGqlQuery.mockResolvedValue(currency({ symbol: "X" }));
    expect(await fetchRegistryCurrency("0xabc::t::T")).toBeNull();
  });

  it("returns null when the coin is not registered", async () => {
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [] } });
    expect(await fetchRegistryCurrency("0xabc::t::T")).toBeNull();
  });

  /** Enrichment: it must never be the reason analyze_token fails. */
  it("returns null rather than throwing when the lookup fails", async () => {
    mockGqlQuery.mockImplementationOnce(async () => {
      throw new Error("network");
    });
    expect(await fetchRegistryCurrency("0xabc::t::T")).toBeNull();
  });

  it("refuses something that is not a coin type without querying", async () => {
    expect(await fetchRegistryCurrency("not-a-coin-type")).toBeNull();
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  /** A short coin type has to find the entry the chain holds padded. */
  it("canonicalizes the coin type into the Currency type argument", async () => {
    mockGqlQuery.mockResolvedValue(currency({ decimals: 9 }));
    await fetchRegistryCurrency("0x2::sui::SUI");
    const vars = mockGqlQuery.mock.calls[0]![1] as { type: string };
    expect(vars.type).toBe(
      `0x${"0".repeat(63)}2::coin_registry::Currency<0x${"0".repeat(63)}2::sui::SUI>`,
    );
  });

  it("ignores non-string metadata rather than carrying it through", async () => {
    mockGqlQuery.mockResolvedValue(currency({ decimals: 9, symbol: { nested: true }, name: 5 }));
    const c = await fetchRegistryCurrency("0xabc::t::T");
    expect(c?.symbol).toBeUndefined();
    expect(c?.name).toBeUndefined();
  });
});

/**
 * `decimals_source` has to name the tier the value actually came from.
 *
 * This calls the REAL decision. The first version of this block re-implemented
 * the ternary inside the test file, so it asserted that its own copy behaved:
 * reintroducing the original defect left all 1,214 tests green while the live
 * tool went back to labelling the guess of 9 as `curated`.
 *
 * The defect it guards is a comparison TypeScript cannot flag —
 * `discoveredDecimals` is `number | null`, so `!== undefined` is always true —
 * which makes this suite the only thing watching.
 */
describe("choosing a decimals tier", () => {
  const tier = (
    metaDecimals?: number | null,
    registryDecimals?: number | null,
    discoveredDecimals?: number | null,
    symbolVerified = false,
  ) => decimalsTier({ metaDecimals, registryDecimals, discoveredDecimals, symbolVerified });

  it("reaches assumed when nothing knows", () => {
    expect(tier(undefined, undefined, null)).toBe("assumed");
  });

  /** The exact shape of the original defect: null, not undefined. */
  it("reaches assumed when the curated tier is null rather than undefined", () => {
    expect(tier(null, null, null, true)).toBe("assumed");
  });

  it("prefers chain metadata, then the registry, then a curated entry", () => {
    expect(tier(6, 9, 9, true)).toBe("coin_metadata");
    expect(tier(undefined, 6, 9, true)).toBe("coin_registry");
    expect(tier(undefined, undefined, 6, true)).toBe("curated");
  });

  it("separates a curated symbol from one reached by scanning", () => {
    expect(tier(undefined, undefined, 6, false)).toBe("symbol_scan");
  });

  /** A coin with 0 decimals is legitimate and must not fall through. */
  it("treats 0 decimals as a real answer", () => {
    expect(tier(0, 9, 9, true)).toBe("coin_metadata");
    expect(tier(undefined, 0, 9, true)).toBe("coin_registry");
    expect(tier(undefined, undefined, 0, true)).toBe("curated");
  });
});
