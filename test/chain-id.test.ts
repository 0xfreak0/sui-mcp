import { describe, it, expect } from "vitest";
import {
  SUI_MAINNET,
  ETHEREUM,
  SOLANA_MAINNET,
  caip2ForSuiNetwork,
  chainDisplayName,
  formatAccountId,
  isKnownChainId,
  namespaceOf,
  normalizeAddressForChain,
  parseAccountId,
  sameAccount,
} from "../src/utils/chain-id.js";

describe("caip2ForSuiNetwork", () => {
  it("maps each Sui network to its own CAIP-2 chain", () => {
    expect(caip2ForSuiNetwork("mainnet")).toBe("sui:mainnet");
    expect(caip2ForSuiNetwork("testnet")).toBe("sui:testnet");
    expect(caip2ForSuiNetwork("devnet")).toBe("sui:devnet");
  });
});

describe("normalizeAddressForChain", () => {
  it("pads and lowercases Sui addresses to 32 bytes", () => {
    expect(normalizeAddressForChain(SUI_MAINNET, "0x2")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    );
    expect(normalizeAddressForChain(SUI_MAINNET, "0xABCD".padEnd(66, "0"))).toBe(
      "0xabcd".padEnd(66, "0"),
    );
  });

  it("lowercases EVM addresses but never pads them to 32 bytes", () => {
    const mixed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const out = normalizeAddressForChain(ETHEREUM, mixed);
    expect(out).toBe(mixed.toLowerCase());
    // 20 bytes, not padded up to Sui's 32 — padding would invent a
    // different address that belongs to nobody.
    expect(out).toHaveLength(42);
  });

  it("rejects an EVM address of the wrong width", () => {
    expect(() => normalizeAddressForChain(ETHEREUM, "0xdeadbeef")).toThrow(/20-byte/);
  });

  it("preserves Solana base58 case", () => {
    const addr = "So11111111111111111111111111111111111111112";
    expect(normalizeAddressForChain(SOLANA_MAINNET, addr)).toBe(addr);
  });

  it("rejects Solana addresses containing non-base58 characters", () => {
    // 0, O, I and l are excluded from the base58 alphabet.
    expect(() => normalizeAddressForChain(SOLANA_MAINNET, "S0IlOOOO")).toThrow(/base58/);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(normalizeAddressForChain(SUI_MAINNET, "  0x2  ")).toBe(
      normalizeAddressForChain(SUI_MAINNET, "0x2"),
    );
  });
});

describe("parseAccountId", () => {
  it("treats a bare address as belonging to the default chain", () => {
    const a = parseAccountId("0x2", SUI_MAINNET);
    expect(a.chain).toBe("sui:mainnet");
    expect(a.address).toBe(normalizeAddressForChain(SUI_MAINNET, "0x2"));
  });

  it("reads an explicit CAIP-10 account id regardless of the default", () => {
    const a = parseAccountId("eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", SUI_MAINNET);
    expect(a.chain).toBe("eip155:1");
    expect(a.address).toBe("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
  });

  it("normalizes per the named chain, not the default chain", () => {
    // The giveaway that the chain prefix is actually driving normalization:
    // under Sui rules this would be padded to 32 bytes.
    const a = parseAccountId("eip155:1:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", SUI_MAINNET);
    expect(a.address).toHaveLength(42);
  });

  it("round-trips through formatAccountId", () => {
    const raw = "eip155:8453:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
    expect(formatAccountId(parseAccountId(raw, SUI_MAINNET))).toBe(raw);
  });

  it("rejects an unknown chain rather than guessing how to normalize it", () => {
    expect(() => parseAccountId("cosmos:hub-4:abc", SUI_MAINNET)).toThrow(/unknown chain/i);
  });

  it("rejects a malformed account id", () => {
    expect(() => parseAccountId("sui:", SUI_MAINNET)).toThrow();
    expect(() => parseAccountId("", SUI_MAINNET)).toThrow();
  });
});

describe("sameAccount", () => {
  it("is true across formatting differences on the same chain", () => {
    expect(sameAccount("0x2", "sui:mainnet:0x2", SUI_MAINNET)).toBe(true);
  });

  it("is false for the same address string on different chains", () => {
    // The core reason chain qualification exists: an identical hex string on
    // two chains is two unrelated entities.
    expect(sameAccount("sui:mainnet:0x2", "sui:testnet:0x2", SUI_MAINNET)).toBe(false);
  });
});

describe("chain metadata", () => {
  it("knows the chains it can normalize for", () => {
    expect(isKnownChainId(SUI_MAINNET)).toBe(true);
    expect(isKnownChainId(ETHEREUM)).toBe(true);
    expect(isKnownChainId("cosmos:hub-4")).toBe(false);
  });

  it("exposes a namespace and a human-readable name", () => {
    expect(namespaceOf(ETHEREUM)).toBe("eip155");
    expect(chainDisplayName(ETHEREUM)).toBe("Ethereum");
    expect(chainDisplayName(SUI_MAINNET)).toBe("Sui");
    // An unknown chain still renders as something rather than throwing —
    // reports must not fail on a chain we merely cannot normalize for.
    expect(chainDisplayName("cosmos:hub-4")).toBe("cosmos:hub-4");
  });
});
