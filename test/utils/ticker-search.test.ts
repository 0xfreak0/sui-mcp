import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithNetwork } from "../../src/config.js";
import { createMockClient } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));

// Import after registering the gRPC mock so indexer claims can be checked against exact on-chain types.
const { searchLiveTickers } = await import("../../src/utils/ticker-search.js");

const KONG = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG";
const FALSE_KONG = "0xcc345bb9b0d5ddd2d01a4e303a9fa4c00b6da760e4618ed31e303c585df962ca::kong::KONG";
const QUOTE = "0x2::sui::SUI";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers() };
}

function dexPair(type: string, symbol: string, name: string, pool: string, liquidity = 12345) {
  return {
    chainId: "sui", pairAddress: pool,
    baseToken: { address: type, symbol, name },
    quoteToken: { address: QUOTE, symbol: "SUI", name: "Sui" },
    liquidity: { usd: liquidity }, volume: { h24: 123 },
  };
}

beforeEach(() => {
  vi.stubEnv("SUI_DISABLE_LIVE_COIN_LIST", "1");
  mockSui.stateService.getCoinInfo.mockReset();
  mockSui.stateService.getCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => ({
    response: {
      metadata: { name: "Kong", symbol: "KONG", decimals: 9 },
      treasury: { totalSupply: 5000000000n },
      coinType,
    },
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("live ticker indexer evidence", () => {
  it("accepts only Sui pools and on-chain-confirmed symbol or name, never an indexer-only match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ pairs: [
      dexPair(KONG, "KONG", "Kong", "0xpool1"),
      dexPair(FALSE_KONG, "KONG", "Kong", "0xpool2"),
      { ...dexPair("0x3::eth::KONG", "KONG", "Kong", "0xeth"), chainId: "ethereum" },
    ] })));
    mockSui.stateService.getCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => ({
      response: {
        coinType,
        metadata: coinType === FALSE_KONG
          ? { name: "Some Other Coin", symbol: "OTHER", decimals: 6 }
          : { name: "Kong", symbol: "KONG", decimals: 9 },
        treasury: { totalSupply: 5000000000n },
      },
    }));

    const result = await runWithNetwork("mainnet", () => searchLiveTickers("KONG"));
    expect(result.providers).toEqual({ dexscreener: "ok", geckoterminal: "skipped" });
    expect(result.candidates).toMatchObject([{
      coin_type: KONG, name: "Kong", symbol: "KONG", decimals: 9,
      total_supply: "5000000000", liquidity_usd: 12345, pool_count: 1,
      volume_24h: 123, providers: ["dexscreener"], verified: false,
    }]);
    expect(mockSui.stateService.getCoinInfo).toHaveBeenCalledWith({ coinType: FALSE_KONG });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls through from DexScreener HTTP 429 to GeckoTerminal and reports the rate limit", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(null, 429))
      .mockResolvedValueOnce(response({
        data: [{
          id: "sui-network_0xpool3",
          attributes: { address: "0xpool3", reserve_in_usd: "8500", volume_usd: { h24: "210" } },
          relationships: {
            base_token: { data: { id: `sui-network_${KONG}` } },
            quote_token: { data: { id: `sui-network_${QUOTE}` } },
          },
        }],
        included: [
          { id: `sui-network_${KONG}`, attributes: { symbol: "KONG429", name: "Kong429" } },
          { id: `sui-network_${QUOTE}`, attributes: { symbol: "SUI", name: "Sui" } },
        ],
      })));
    mockSui.stateService.getCoinInfo.mockResolvedValue({
      response: { metadata: { name: "Kong429", symbol: "KONG429", decimals: 9 }, treasury: { totalSupply: 1n } },
    });

    const result = await runWithNetwork("mainnet", () => searchLiveTickers("KONG429"));
    expect(result.providers).toEqual({ dexscreener: "rate_limited", geckoterminal: "ok" });
    expect(result.unavailable_providers).toEqual([{ provider: "dexscreener", reason: expect.stringContaining("HTTP 429") }]);
    expect(result.candidates).toMatchObject([{ coin_type: KONG, symbol: "KONG429", providers: ["geckoterminal"], liquidity_usd: 8500, volume_24h: 210 }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses GeckoTerminal when DexScreener returns no matching Sui candidates", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ pairs: [
        { ...dexPair("0x3::eth::KONGZERO", "KONGZERO", "Kongzero", "0xeth"), chainId: "ethereum" },
      ] }))
      .mockResolvedValueOnce(response({ pairs: [] }))
      .mockResolvedValueOnce(response({
        data: [{
          id: "sui-network_0xpool4",
          attributes: { address: "0xpool4", reserve_in_usd: "100", volume_usd: { h24: "12" } },
          relationships: { base_token: { data: { id: `sui-network_${KONG}` } }, quote_token: { data: { id: `sui-network_${QUOTE}` } } },
        }],
        included: [
          { id: `sui-network_${KONG}`, attributes: { symbol: "KONGZERO", name: "Kongzero" } },
          { id: `sui-network_${QUOTE}`, attributes: { symbol: "SUI", name: "Sui" } },
        ],
      })));
    mockSui.stateService.getCoinInfo.mockResolvedValue({
      response: { metadata: { name: "Kongzero", symbol: "KONGZERO", decimals: 9 }, treasury: { totalSupply: 1n } },
    });
    const result = await runWithNetwork("mainnet", () => searchLiveTickers("KONGZERO"));
    expect(result.providers).toEqual({ dexscreener: "ok", geckoterminal: "ok" });
    expect(result.candidates).toMatchObject([{ coin_type: KONG, providers: ["geckoterminal"] }]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("merges a mixed-chain capped DexScreener page, Sui-refined query, and GeckoTerminal pools", async () => {
    const other = { ...dexPair("0x3::eth::PEPEX", "PEPEX", "Pepex", "0xeth"), chainId: "ethereum" };
    const gecko = {
      data: [{
        id: "sui-network_0xpool1",
        attributes: { address: "0xpool1", reserve_in_usd: "150", volume_usd: { h24: "10" } },
        relationships: { base_token: { data: { id: `sui-network_${KONG}` } }, quote_token: { data: { id: `sui-network_${QUOTE}` } } },
      }],
      included: [{ id: `sui-network_${KONG}`, attributes: { symbol: "PEPEX", name: "Pepex" } }],
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ pairs: [dexPair(KONG, "PEPEX", "Pepex", "0xpool1", 100), ...Array.from({ length: 29 }, () => other)] }))
      .mockResolvedValueOnce(response({ pairs: [dexPair(FALSE_KONG, "PEPEX", "Pepex copy", "0xpool2", 200)] }))
      .mockResolvedValueOnce(response(gecko)));
    mockSui.stateService.getCoinInfo.mockResolvedValue({
      response: { metadata: { name: "Pepex", symbol: "PEPEX", decimals: 6 }, treasury: { totalSupply: 1n } },
    });
    const result = await searchLiveTickers("PEPEX");
    expect(result.partial).toBe(false);
    expect(result.providers).toEqual({ dexscreener: "ok", geckoterminal: "ok" });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.find((c) => c.coin_type === KONG)).toMatchObject({
      providers: ["dexscreener", "geckoterminal"], pool_count: 1, liquidity_usd: 150,
    });
    expect(result.candidates.find((c) => c.coin_type === FALSE_KONG)).toMatchObject({ liquidity_usd: 200 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain("pepex%20SUI");
  });

  it("marks coverage partial when GeckoTerminal also fills its twenty-pool page", async () => {
    const other = { ...dexPair("0x3::eth::CAPPEDCOIN", "CAPPEDCOIN", "Capped", "0xeth"), chainId: "ethereum" };
    const geckoPools = Array.from({ length: 20 }, (_, i) => ({
      id: `sui-network_0xgecko${i}`,
      attributes: { address: `0xgecko${i}`, reserve_in_usd: "1" },
      relationships: { base_token: { data: { id: `sui-network_${KONG}` } } },
    }));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ pairs: [dexPair(KONG, "CAPPEDCOIN", "Capped", "0xdex"), ...Array.from({ length: 29 }, () => other)] }))
      .mockResolvedValueOnce(response({ pairs: [] }))
      .mockResolvedValueOnce(response({
        data: geckoPools, included: [{ id: `sui-network_${KONG}`, attributes: { symbol: "CAPPEDCOIN", name: "Capped" } }],
      })));
    mockSui.stateService.getCoinInfo.mockResolvedValue({ response: { metadata: { name: "Capped", symbol: "CAPPEDCOIN", decimals: 9 } } });
    const result = await searchLiveTickers("CAPPEDCOIN");
    expect(result).toMatchObject({ partial: true, unconfirmed: 0, providers: { dexscreener: "ok", geckoterminal: "ok" } });
    expect(result.candidates[0]).toMatchObject({ pool_count: 21 });
  });

  it("reports failed on-chain confirmations instead of treating them as absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ pairs: [dexPair(KONG, "KONGERR", "Kongerr", "0xpoolerr")] })));
    mockSui.stateService.getCoinInfo.mockRejectedValue(new Error("gRPC unavailable"));
    const result = await searchLiveTickers("KONGERR");
    expect(result).toMatchObject({ candidates: [], unconfirmed: 1, unconfirmed_reason: "gRPC unavailable", partial: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not serve a rate-limited fallback from its ten-minute cache", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(null, 429))
      .mockResolvedValueOnce(response({ data: [] }))
      .mockResolvedValueOnce(response({ pairs: [] }))
      .mockResolvedValueOnce(response({ pairs: [] }))
      .mockResolvedValueOnce(response({ data: [] })));
    const first = await searchLiveTickers("ONCE429");
    const second = await searchLiveTickers("ONCE429");
    expect(first.providers.dexscreener).toBe("rate_limited");
    expect(second.providers.dexscreener).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("does not query either public indexer off mainnet", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await runWithNetwork("testnet", async () => {
      expect(await searchLiveTickers("TEST-TICKER")).toEqual({
        candidates: [], providers: { dexscreener: "skipped", geckoterminal: "skipped" },
        unavailable_providers: [], partial: false, unconfirmed: 0,
      });
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockSui.stateService.getCoinInfo).not.toHaveBeenCalled();
  });
});
