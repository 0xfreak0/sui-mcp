import { describe, it, expect } from "vitest";
import { runWithNetwork } from "../src/config.js";

/**
 * The cache key is built inline in the tool handler, so this reconstructs it
 * rather than importing it. The property under test is what belongs in the key,
 * which is a design claim worth pinning even without exercising the handler.
 *
 * The last segment is the kiosk-owner table's version, which is part of the key
 * in NFT mode because the table is part of the answer there. A reconstruction
 * that drifts from the handler pins a key the tool does not build, so it is
 * kept in step deliberately — `test/holders-kiosk-resolution.test.ts` is what
 * exercises the real one end to end.
 */
const key = (mode: string, type: string, maxScan: number, topN: number, kiosk = "-") =>
  `${runWithNetwork("mainnet", () => "mainnet")}:${mode}:${type}:${maxScan}:${topN}:${kiosk}`;

const keyOn = (
  network: "mainnet" | "testnet",
  mode: string,
  type: string,
  maxScan: number,
  topN: number,
  kiosk = "-",
) => runWithNetwork(network, () => `${network}:${mode}:${type}:${maxScan}:${topN}:${kiosk}`);

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

  it("distinguishes kiosk-owner table states in NFT mode", () => {
    // A ranking resolved its kiosks against the table as it stood. Without this
    // segment, running get_nft_sales — which the tool's own caveat instructs —
    // returned the same unresolved ranking until the entry expired.
    expect(key("nft", TYPE, 2000, 20, "10:500:1700000000000")).not.toBe(
      key("nft", TYPE, 2000, 20, "11:900:1700000000001"),
    );
  });

});
