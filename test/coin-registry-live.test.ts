import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveSymbolWithLive,
  refreshLiveCoins,
  resetLiveCoins,
  vouchFor,
} from "../src/utils/coin-registry.js";

const NATIVE_USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const NEW_COIN = `0x${"a".repeat(64)}::brandnew::BRANDNEW`;

const fetchMock = vi.fn();
beforeEach(() => {
  resetLiveCoins();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.SUI_DISABLE_LIVE_COIN_LIST;
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** List call then metadata call, in that order. */
const liveReturns = (types: string[], meta: unknown[]) =>
  fetchMock.mockResolvedValueOnce(ok(types)).mockResolvedValueOnce(ok(meta));

describe("live coin list — additive", () => {
  it("resolves a symbol the checked-in file has never seen", async () => {
    liveReturns([NEW_COIN], [{ symbol: "BRANDNEW", name: "Brand New", decimals: 9 }]);
    const r = await resolveSymbolWithLive("BRANDNEW");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.coin.coin_type).toBe(NEW_COIN);
      // Marked, so a reader can tell reviewed data from data fetched a moment ago.
      expect(r.via).toBe("live");
    }
  });

  it("vouches for a live-only coin as live, not verified", async () => {
    liveReturns([NEW_COIN], [{ symbol: "BRANDNEW", decimals: 9 }]);
    await refreshLiveCoins();
    expect(vouchFor(NEW_COIN)).toBe("live");
    expect(vouchFor(NATIVE_USDC)).toBe("verified");
  });

  /**
   * The reviewed file is the floor. A fetched list must not be able to turn an
   * ambiguous symbol into a confident one — that would reintroduce the exact
   * failure this registry exists to prevent, just with a nicer source.
   */
  it("cannot make an ambiguous curated symbol unambiguous", async () => {
    liveReturns(
      [`0x${"b".repeat(64)}::usdc::USDC`],
      [{ symbol: "USDC", name: "Another USDC", decimals: 6 }],
    );
    const r = await resolveSymbolWithLive("USDC");
    expect(r.status).toBe("ambiguous");
    // And it did not even reach the network: the curated answer was decisive.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not reopen a symbol the curated file already resolved", async () => {
    const r = await resolveSymbolWithLive("SUI");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.via).not.toBe("live");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("live coin list — fails closed", () => {
  it("leaves the registry unchanged when the list call fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const r = await resolveSymbolWithLive("BRANDNEW");
    expect(r.status).toBe("unverified");
    expect(vouchFor(NEW_COIN)).toBeNull();
  });

  it("leaves it unchanged on a non-200", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    expect((await resolveSymbolWithLive("BRANDNEW")).status).toBe("unverified");
  });

  it("refuses a metadata response that does not line up positionally", async () => {
    // Two coins requested, one metadata entry back: every label after the gap
    // would point at the wrong coin.
    liveReturns([NEW_COIN, `0x${"c".repeat(64)}::other::OTHER`], [{ symbol: "BRANDNEW" }]);
    expect((await resolveSymbolWithLive("BRANDNEW")).status).toBe("unverified");
  });

  it("ignores a list that is not an array", async () => {
    fetchMock.mockResolvedValueOnce(ok({ coins: [] }));
    expect((await resolveSymbolWithLive("BRANDNEW")).status).toBe("unverified");
  });

  it("never throws out of a refresh", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(refreshLiveCoins()).resolves.toBeUndefined();
  });
});

describe("live coin list — cost", () => {
  it("does not refetch within the TTL, including after a failure", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    await refreshLiveCoins();
    await refreshLiveCoins();
    await refreshLiveCoins();
    // An outage must not turn every lookup into a request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("can be pinned to the repo file", async () => {
    process.env.SUI_DISABLE_LIVE_COIN_LIST = "1";
    const r = await resolveSymbolWithLive("BRANDNEW");
    expect(r.status).toBe("unverified");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
