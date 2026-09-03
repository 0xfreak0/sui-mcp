import { describe, it, expect, beforeEach } from "vitest";
import {
  addSessionLabel,
  allLabels,
  getLabel,
  isSink,
  isSinkCategory,
  removeSessionLabel,
} from "../src/utils/labels.js";
import { runWithNetwork } from "../src/config.js";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("isSinkCategory", () => {
  it("treats cex/bridge/mixer/malicious/burn as sinks", () => {
    for (const c of ["cex", "bridge", "mixer", "malicious", "burn"] as const) {
      expect(isSinkCategory(c)).toBe(true);
    }
  });
  it("does not treat protocol/defi/validator/other as sinks", () => {
    for (const c of ["protocol", "defi", "validator", "other"] as const) {
      expect(isSinkCategory(c)).toBe(false);
    }
  });
});

describe("static labels", () => {
  it("ships the zero address as a burn sink", () => {
    const label = getLabel(ZERO);
    expect(label?.category).toBe("burn");
    expect(label?.source).toBe("curated");
    expect(isSink(ZERO)).toBe(true);
  });

  it("returns null for an unlabeled address", () => {
    expect(getLabel("0x1234567890abcdef")).toBeNull();
    expect(isSink("0x1234567890abcdef")).toBe(false);
  });
});

describe("session labels", () => {
  const addr = "0xabc0000000000000000000000000000000000000000000000000000000000099";

  beforeEach(() => {
    removeSessionLabel(addr);
  });

  it("adds and looks up a session label, normalizing the address", () => {
    addSessionLabel(addr, { label: "Attacker #1", category: "malicious", confidence: "high" });
    // Look up with a differently-cased / whitespaced form → same identity.
    const found = getLabel(`  ${addr.toUpperCase().replace("0X", "0x")}  `);
    expect(found?.label).toBe("Attacker #1");
    expect(found?.source).toBe("session");
    expect(isSink(addr)).toBe(true);
  });

  it("session labels take precedence over static", () => {
    addSessionLabel(ZERO, { label: "Reclassified", category: "cex" });
    expect(getLabel(ZERO)?.label).toBe("Reclassified");
    expect(getLabel(ZERO)?.source).toBe("session");
    // Cleanup so other tests see the static value again.
    removeSessionLabel(ZERO);
    expect(getLabel(ZERO)?.source).toBe("curated");
  });

  it("removeSessionLabel reports whether one existed and never removes static", () => {
    expect(removeSessionLabel(addr)).toBe(false);
    addSessionLabel(addr, { label: "x", category: "other" });
    expect(removeSessionLabel(addr)).toBe(true);
    // Static entry is untouched by removal.
    removeSessionLabel(ZERO);
    expect(getLabel(ZERO)?.category).toBe("burn");
  });

  it("allLabels includes static + session with precedence", () => {
    addSessionLabel(addr, { label: "Bridge X", category: "bridge" });
    const all = allLabels();
    const found = all.find((l) => l.label === "Bridge X");
    expect(found?.category).toBe("bridge");
    // Zero address still present from static.
    expect(all.some((l) => l.category === "burn")).toBe(true);
    removeSessionLabel(addr);
  });
});

describe("chain-qualified labels", () => {
  const SUI_ADDR = "0x00000000000000000000000000000000000000000000000000000000000000ff";
  const EVM_ADDR = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

  beforeEach(() => {
    removeSessionLabel(SUI_ADDR);
    removeSessionLabel(`eip155:1:${EVM_ADDR}`);
    runWithNetwork("testnet", () => removeSessionLabel(SUI_ADDR));
  });

  it("keeps a label on one chain from applying on another", () => {
    // The whole point of Stage 0: a bridge on Ethereum must not silently
    // terminate a Sui trace because the hex strings coincide.
    addSessionLabel(`eip155:1:${EVM_ADDR}`, { label: "Wormhole ETH", category: "bridge" });

    expect(getLabel(`eip155:1:${EVM_ADDR}`)?.label).toBe("Wormhole ETH");
    // Same string, read as a Sui address: a different account entirely.
    expect(getLabel(EVM_ADDR)).toBeNull();
  });

  it("scopes a session label to the network it was added on", () => {
    addSessionLabel(SUI_ADDR, { label: "Attacker (mainnet)", category: "malicious" });
    expect(getLabel(SUI_ADDR)?.label).toBe("Attacker (mainnet)");
    runWithNetwork("testnet", () => {
      expect(getLabel(SUI_ADDR)).toBeNull();
    });
  });

  it("still applies curated labels on every Sui network", () => {
    // Curated entries are knowledge about entities, not about one network.
    // Scoping them per-network would strip attribution from testnet work that
    // has it today.
    runWithNetwork("testnet", () => {
      expect(getLabel(ZERO)?.category).toBe("burn");
      expect(isSink(ZERO)).toBe(true);
    });
  });

  it("does not leak a curated Sui label onto a non-Sui chain", () => {
    expect(getLabel(`eip155:1:${EVM_ADDR}`)).toBeNull();
  });

  it("returns null instead of throwing on an unparseable reference", () => {
    // Called mid-trace on addresses that came off-chain; one malformed
    // counterparty must not abort an investigation.
    expect(getLabel("not-an-address!")).toBeNull();
    expect(isSink("not-an-address!")).toBe(false);
    expect(getLabel("eip155:1:0xtooshort")).toBeNull();
  });

  it("reports the account and chain for each label", () => {
    addSessionLabel(SUI_ADDR, { label: "Subject", category: "other" });
    const entry = allLabels().find((l) => l.address === SUI_ADDR);
    expect(entry?.account).toBe(`sui:mainnet:${SUI_ADDR}`);
    expect(entry?.chain).toBe("sui:mainnet");
  });

  it("rejects an address that is invalid on the chain it names", () => {
    // addSessionLabel throws where getLabel returns null: this is a caller
    // asserting an identity, and a mangled key would never match anything.
    expect(() =>
      addSessionLabel("eip155:1:0xdeadbeef", { label: "X", category: "cex" }),
    ).toThrow(/20-byte/);
  });
});
