import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockClient } from "./helpers/mock-grpc.js";
import { notFoundError, grpcError } from "./helpers/service-shapes.js";

const mockSui = createMockClient();

vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { coinScale, prefetchCoinScale, resetLiveCoinScale } = await import("../src/utils/valuation.js");

// KONG SUI: 0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG.
// Not on the curated list (both KONG coins on mainnet are unverified), and
// CoinMetadata declares 1 decimal, so the assumed 9 would misstate it by
// 10^8.
const KONG = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG";

describe("coinScale live-metadata tier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLiveCoinScale();
  });

  it("resolves an unverified coin's real decimals once prefetched, instead of assuming 9", async () => {
    mockSui.stateService.getCoinInfo.mockResolvedValue({
      response: {
        coinType: KONG,
        metadata: { name: "KONG SUI", symbol: "KONG", decimals: 1 },
        treasury: { totalSupply: 100000000000n },
      },
    });

    expect(coinScale(KONG)).toEqual({ decimals: 9, source: "assumed" });

    await prefetchCoinScale([KONG]);

    expect(coinScale(KONG)).toEqual({ decimals: 1, source: "coin_metadata" });
    expect(mockSui.stateService.getCoinInfo).toHaveBeenCalledWith({ coinType: KONG });
  });

  it("never calls the network for a coin the curated registry already answers", async () => {
    await prefetchCoinScale(["0x2::sui::SUI"]);
    expect(mockSui.stateService.getCoinInfo).not.toHaveBeenCalled();
    expect(coinScale("0x2::sui::SUI")).toEqual({ decimals: 9, source: "registry" });
  });

  it("caches a genuine gRPC NOT_FOUND as null rather than re-requesting it", async () => {
    mockSui.stateService.getCoinInfo.mockRejectedValue(notFoundError("Coin type not found"));

    await prefetchCoinScale([KONG]);
    expect(coinScale(KONG).source).toBe("assumed");
    await prefetchCoinScale([KONG]);

    expect(mockSui.stateService.getCoinInfo).toHaveBeenCalledTimes(1);
  });

  /**
   * A timeout is transient, so it is left uncached rather than cached as
   * `null` like a genuine "no CoinMetadata". A later call then gets another
   * chance to read KONG's real decimals (1) instead of formatting it at the
   * assumed 9 for the rest of the process.
   */
  it("does NOT cache a transient failure — a later prefetch gets another chance", async () => {
    mockSui.stateService.getCoinInfo.mockRejectedValueOnce(grpcError("DEADLINE_EXCEEDED", "timed out"));
    await prefetchCoinScale([KONG]);
    expect(coinScale(KONG).source).toBe("assumed");

    mockSui.stateService.getCoinInfo.mockResolvedValueOnce({
      response: { coinType: KONG, metadata: { name: "KONG SUI", symbol: "KONG", decimals: 1 }, treasury: { totalSupply: 100000000000n } },
    });
    await prefetchCoinScale([KONG]);

    expect(coinScale(KONG)).toEqual({ decimals: 1, source: "coin_metadata" });
    expect(mockSui.stateService.getCoinInfo).toHaveBeenCalledTimes(2);
  });

  describe("many coins at once", () => {
    // Coins no curated list knows: one GraphQL request reads up to 20.
    const coins = Array.from({ length: 25 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}::meme::M${i}`);
    const answer = (q: string) =>
      Object.fromEntries(
        [...q.matchAll(/(c\d+):coinMetadata\(coinType:"([^"]+)"\)/g)].map(([, alias, type]) => [alias, type.endsWith("::M3") ? null : { decimals: 6 }]),
      );

    it("reads them over GraphQL, 20 to a request, and caches a coin with no metadata as none", async () => {
      mockGqlQuery.mockReset().mockImplementation(async (q: string) => answer(q));

      await prefetchCoinScale(coins);

      expect(mockGqlQuery).toHaveBeenCalledTimes(2);
      expect(mockSui.stateService.getCoinInfo).not.toHaveBeenCalled();
      expect(coinScale(coins[0])).toEqual({ decimals: 6, source: "coin_metadata" });
      expect(coinScale(coins[24])).toEqual({ decimals: 6, source: "coin_metadata" });
      expect(coinScale(coins[3]).source).toBe("assumed");
      await prefetchCoinScale(coins);
      expect(mockGqlQuery).toHaveBeenCalledTimes(2);
    });

    it("reads every coin of a failed request over gRPC instead", async () => {
      mockGqlQuery.mockReset().mockRejectedValueOnce(new Error("GraphQL error: payload too large")).mockImplementation(async (q: string) => answer(q));
      mockSui.stateService.getCoinInfo.mockResolvedValue({ response: { metadata: { decimals: 2 } } });

      await prefetchCoinScale(coins);

      expect(mockSui.stateService.getCoinInfo).toHaveBeenCalledTimes(20);
      expect(coinScale(coins[0])).toEqual({ decimals: 2, source: "coin_metadata" });
      expect(coinScale(coins[24])).toEqual({ decimals: 6, source: "coin_metadata" });
    });
  });
});
