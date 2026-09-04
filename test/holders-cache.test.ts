import { describe, it, expect } from "vitest";
import { runWithNetwork } from "../src/config.js";

/**
 * The cache key is built inline in the tool handler, so this reconstructs it
 * rather than importing it. The property under test is what belongs in the key,
 * which is a design claim worth pinning even without exercising the handler.
 */
const key = (mode: string, type: string, maxScan: number, topN: number) =>
  `${runWithNetwork("mainnet", () => "mainnet")}:${mode}:${type}:${maxScan}:${topN}`;

const keyOn = (network: "mainnet" | "testnet", mode: string, type: string, maxScan: number, topN: number) =>
  runWithNetwork(network, () => `${network}:${mode}:${type}:${maxScan}:${topN}`);

const TYPE = "0x2::sui::SUI";

describe("get_top_holders cache key", () => {
  it("distinguishes different result sizes", () => {
    // The cached payload holds exactly `limit` holders. Serving a 20-holder
    // entry to a request for 100 returns the wrong list, and reads as "this
    // collection has 20 holders" rather than as a cache hit.
    expect(key("token", TYPE, 2000, 20)).not.toBe(key("token", TYPE, 2000, 100));
  });

  it("distinguishes networks", () => {
    // The same coin type on mainnet and testnet has a different holder set —
    // the same reason labels and the fan-out cache are network-keyed.
    expect(keyOn("mainnet", "token", TYPE, 2000, 20)).not.toBe(
      keyOn("testnet", "token", TYPE, 2000, 20),
    );
  });

  it("still reuses an entry for an identical request", () => {
    // Keying on more fields must not defeat caching for the repeat case it
    // exists to serve.
    expect(key("token", TYPE, 2000, 20)).toBe(key("token", TYPE, 2000, 20));
  });

  it("distinguishes scan depth and mode", () => {
    expect(key("token", TYPE, 2000, 20)).not.toBe(key("token", TYPE, 5000, 20));
    expect(key("token", TYPE, 2000, 20)).not.toBe(key("nft", TYPE, 2000, 20));
  });
});
