import { describe, it, expect } from "vitest";
import { runWithNetwork } from "../src/config.js";
import { isVerifiedCoin, vouchFor, resolveVerifiedSymbol } from "../src/utils/coin-registry.js";
import { displayCoin } from "../src/utils/valuation.js";
import { lookupProtocol } from "../src/protocols/registry.js";

const MAINNET_USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
/** A real testnet USDC. Same asset, different package — that is the whole point. */
const TESTNET_USDC =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const MAINNET_DEEPBOOK =
  "0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a";

/**
 * The curated files hold mainnet package IDs, and a coin type embeds one.
 * Package IDs are derived from the publish transaction, so the same string on
 * another network is a different thing or nothing at all.
 *
 * Verified against the live networks: mainnet's USDC type does not exist on
 * testnet, while a real testnet USDC lives at a different type. Consulting the
 * list regardless of network got BOTH answers wrong — it vouched for a coin
 * that was absent, and refused to vouch for the genuine one.
 */
describe("curated data is mainnet-scoped", () => {
  it("vouches for a mainnet coin on mainnet", async () => {
    await runWithNetwork("mainnet", async () => {
      expect(isVerifiedCoin(MAINNET_USDC)).toBe(true);
      expect(vouchFor(MAINNET_USDC)).toBe("verified");
    });
  });

  it("does not vouch for a mainnet coin type on another network", async () => {
    await runWithNetwork("testnet", async () => {
      expect(isVerifiedCoin(MAINNET_USDC)).toBe(false);
    });
  });

  /**
   * The distinction that matters: off mainnet this is neither a claim nor a
   * denial. Reporting `false` would mark a legitimate testnet asset exactly the
   * way an impersonation token is marked.
   */
  it("says there is no curated knowledge rather than denying the coin", async () => {
    await runWithNetwork("testnet", async () => {
      expect(vouchFor(MAINNET_USDC)).toBe("not-curated-here");
      expect(vouchFor(TESTNET_USDC)).toBe("not-curated-here");
      expect(displayCoin(TESTNET_USDC).verified).toBeNull();
    });
  });

  it("still marks a coin verified on mainnet", async () => {
    await runWithNetwork("mainnet", async () => {
      expect(displayCoin(MAINNET_USDC).verified).toBe(true);
      // And a real mainnet impostor is still a firm false, not a null.
      expect(displayCoin(`0x${"f".repeat(64)}::usdc::USDC`).verified).toBe(false);
    });
  });

  it("resolves no symbol off mainnet rather than resolving to a mainnet type", async () => {
    await runWithNetwork("mainnet", async () => {
      expect(resolveVerifiedSymbol("SUI").status).toBe("resolved");
    });
    await runWithNetwork("testnet", async () => {
      expect(resolveVerifiedSymbol("SUI").status).toBe("unverified");
    });
  });

  /** Pre-existing: the registry named a mainnet protocol on testnet. */
  it("does not name a mainnet protocol on another network", async () => {
    await runWithNetwork("mainnet", async () => {
      expect(lookupProtocol(MAINNET_DEEPBOOK)?.name).toBeTruthy();
    });
    await runWithNetwork("testnet", async () => {
      expect(lookupProtocol(MAINNET_DEEPBOOK)).toBeNull();
    });
  });

  /**
   * Labels are deliberately NOT scoped this way, and the difference is
   * principled: addresses are key-derived, so one entity can legitimately hold
   * the same address on several networks. Package IDs cannot.
   */
  it("leaves address-keyed knowledge alone", async () => {
    const { getLabel } = await import("../src/utils/labels.js");
    await runWithNetwork("testnet", async () => {
      expect(() => getLabel("0x" + "1".repeat(64))).not.toThrow();
    });
  });
});
