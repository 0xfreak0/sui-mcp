import { describe, it, expect } from "vitest";
import {
  caip2ForWormholeChain,
  extractWormholeMessages,
  toForeignAccount,
  vaaId,
  wormholeChainLabel,
  WORMHOLE_CHAIN_SUI,
  type SuiEventNode,
} from "../src/utils/bridge/wormhole.js";

/**
 * A real mainnet WormholeMessage event, captured from transaction
 * 7g4nQFxU4sP7DRWG8kJSAYLCnyVTxc1VefThUYAUnBLh. Its sender and sequence match
 * Wormholescan's VAA id 21/89b91e…74bf/188994 exactly — which is the
 * deterministic join this module exists to expose.
 */
const REAL_EVENT: SuiEventNode = {
  contents: {
    type: {
      repr: "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::publish_message::WormholeMessage",
    },
    json: {
      sender: "0x89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf",
      sequence: "188994",
      nonce: 0,
      payload: "vbLt/bQlflZVJfj2p/lIhOg+2d+JzhkSI5r9lGaR/m0=",
      consistency_level: 0,
      timestamp: "1788467967",
    },
  },
};

const OTHER_EVENT: SuiEventNode = {
  contents: {
    type: { repr: "0xabc::pool::SwapEvent" },
    json: { amount_in: "1" },
  },
};

describe("extractWormholeMessages", () => {
  it("reads the VAA identity out of a real mainnet event", () => {
    const [msg] = extractWormholeMessages([OTHER_EVENT, REAL_EVENT]);
    expect(msg.emitter).toBe(
      "89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf",
    );
    expect(msg.sequence).toBe("188994");
    // The exact id Wormholescan indexes this transfer under.
    expect(msg.vaaId).toBe(
      "21/89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf/188994",
    );
    expect(msg.nonce).toBe(0);
    expect(msg.consistencyLevel).toBe(0);
  });

  it("matches the event by suffix so a core-bridge upgrade keeps working", () => {
    // A package upgrade mints a new ID. Pinning the full type would make this
    // silently stop finding messages the day Wormhole upgrades.
    const upgraded: SuiEventNode = {
      contents: {
        type: { repr: "0xfeed::publish_message::WormholeMessage" },
        json: { sender: "0x1", sequence: "7" },
      },
    };
    expect(extractWormholeMessages([upgraded])).toHaveLength(1);
  });

  it("returns every message, since one PTB can publish several", () => {
    const second: SuiEventNode = {
      contents: {
        type: { repr: "0x5306::publish_message::WormholeMessage" },
        json: { sender: "0x2", sequence: "9" },
      },
    };
    expect(extractWormholeMessages([REAL_EVENT, second])).toHaveLength(2);
  });

  it("ignores unrelated events", () => {
    expect(extractWormholeMessages([OTHER_EVENT])).toEqual([]);
  });

  it("skips malformed events instead of throwing", () => {
    // These run over transactions nobody curated; one odd shape must not cost
    // the whole lookup.
    const bad: SuiEventNode[] = [
      { contents: null },
      { contents: { type: { repr: "0x1::publish_message::WormholeMessage" }, json: null } },
      { contents: { type: { repr: "0x1::publish_message::WormholeMessage" }, json: {} } },
      {
        contents: {
          type: { repr: "0x1::publish_message::WormholeMessage" },
          json: { sender: "0x1" },
        },
      },
    ];
    expect(() => extractWormholeMessages(bad)).not.toThrow();
    expect(extractWormholeMessages(bad)).toEqual([]);
  });

  it("left-pads the emitter to 32 bytes, as a VAA holds it", () => {
    const short: SuiEventNode = {
      contents: {
        type: { repr: "0x1::publish_message::WormholeMessage" },
        json: { sender: "0x2", sequence: "1" },
      },
    };
    expect(extractWormholeMessages([short])[0].emitter).toBe("2".padStart(64, "0"));
  });
});

describe("vaaId", () => {
  it("renders the guardians' canonical form", () => {
    expect(vaaId(WORMHOLE_CHAIN_SUI, "0xab", "5")).toBe(`21/${"ab".padStart(64, "0")}/5`);
  });
});

describe("chain mapping", () => {
  it("maps the Wormhole chains it knows to CAIP-2", () => {
    expect(caip2ForWormholeChain(2)).toBe("eip155:1");
    expect(caip2ForWormholeChain(21)).toBe("sui:mainnet");
    expect(caip2ForWormholeChain(23)).toBe("eip155:42161");
  });

  it("returns null for a chain it cannot map rather than guessing", () => {
    // Emitting a wrong chain id would file an address under the wrong chain,
    // which is the exact error chain qualification exists to prevent.
    expect(caip2ForWormholeChain(22)).toBeNull();
    expect(caip2ForWormholeChain(9999)).toBeNull();
  });

  it("names a mapped chain from the chain-id registry, not a second list", () => {
    // Two name lists would drift; a mapped chain must read the same here as
    // it does everywhere else in a report.
    expect(wormholeChainLabel(2)).toBe("Ethereum");
    expect(wormholeChainLabel(1)).toBe("Solana");
    expect(wormholeChainLabel(21)).toBe("Sui");
  });

  it("still names an unmapped chain for the reader", () => {
    expect(wormholeChainLabel(22)).toBe("Aptos");
    expect(wormholeChainLabel(9999)).toBe("Wormhole chain 9999");
  });
});

describe("toForeignAccount", () => {
  it("qualifies an EVM destination as CAIP-10", () => {
    expect(toForeignAccount(23, "0x9a62c1af2dff7f6b1731d9eb36b1622c17eae7be")).toBe(
      "eip155:42161:0x9a62c1af2dff7f6b1731d9eb36b1622c17eae7be",
    );
  });

  it("preserves base58 case for a Solana destination", () => {
    const addr = "A75HYyr5VG6zhwQ7HCeSPYmke4svHCPWCg4AqkHJw63e";
    expect(toForeignAccount(1, addr)).toBe(
      `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${addr}`,
    );
  });

  it("returns null for an unmapped chain, so the caller reports the raw string", () => {
    expect(toForeignAccount(22, "0xabc")).toBeNull();
  });

  it("returns null when the address does not validate for the chain it names", () => {
    // An address stored under a guessed chain is worse than an unqualified
    // one: it reads as verified.
    expect(toForeignAccount(2, "0xdeadbeef")).toBeNull();
  });
});
