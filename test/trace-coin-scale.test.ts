import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * trace_funds reads a hop's coin decimals before formatting it. XAUm is in no
 * curated list and its CoinMetadata states 9 decimals, so the hop (modelled
 * on 7pTrudZb…) must print at that scale, not "(unverified, assumed scale)".
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
const mockGetCoinInfo = vi.fn();
vi.mock("../src/clients/grpc.js", () => ({ sui: { stateService: { getCoinInfo: mockGetCoinInfo } }, archive: {} }));
vi.mock("../src/utils/archive-fallback.js", () => ({ withArchiveFallback: async () => null }));
vi.mock("../src/utils/identity.js", () => ({ describeAddresses: async () => new Map(), identityNote: () => null }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false }));
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
vi.mock("../src/utils/store.js", () => ({ getCachedTransaction: () => null, saveTransaction: () => {} }));
vi.mock("../src/utils/fanout.js", () => ({
  measureFanout: async () => ({ classification: "narrow", counterparty_count: 2, scanned_transactions: 5, truncated: false }),
}));
const { candidates, gqlTx } = await import("./helpers/trace-shapes.js");
const { resetLiveCoinScale } = await import("../src/utils/valuation.js");
const { registerTraceTools } = await import("../src/tools/trace.js");

let handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
registerTraceTools({
  tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
    if (n === "trace_funds") handler = h;
  },
} as never);

const XAUM = "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM";
const VAULT = `0x79d30e${"1".repeat(53)}ad38d`;
const ATTACKER = `0xd76359${"2".repeat(53)}fa46a`;

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockGetCoinInfo.mockReset();
  resetLiveCoinScale();
});

describe("trace_funds coin scale", () => {
  it("formats a hop's coin at its on-chain decimals before rendering it", async () => {
    mockGetCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
      if (coinType === XAUM) return { response: { coinType: XAUM, metadata: { decimals: 9, symbol: "XAUm" } } };
      throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
    });
    const hop = {
      digest: "7pTrudZb57z2acJFvC2CnBCuaU6RA1UpU9auDZQEESit",
      sender: ATTACKER,
      changes: [
        [VAULT, "-215600000000", XAUM],
        [ATTACKER, "215600000000", XAUM],
      ] as Array<[string, string, string]>,
    };
    mockGqlQuery.mockImplementation(async (q: string) =>
      String(q).includes("transactions(") ? candidates([]) : gqlTx(hop),
    );

    const r = await handler({ digest: hop.digest, direction: "forward", hops: 1 });
    const text = r.content.map((c) => c.text).join("\n");

    expect(mockGetCoinInfo).toHaveBeenCalledWith({ coinType: XAUM });
    expect(text).toContain("215.6 XAUM");
    expect(text).not.toContain("assumed scale");
  });
});
