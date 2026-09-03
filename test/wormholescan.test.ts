import { describe, it, expect } from "vitest";
import { parseOperation, wormholescanAvailable } from "../src/utils/bridge/wormholescan.js";

/**
 * Two real mainnet response shapes, captured from
 * GET /api/v1/operations?sourceChain=21. They differ in which half is
 * populated, which is the variance this parser exists to absorb.
 */

/** Redeemed on Solana. `targetChain` is complete; standarizedProperties is empty. */
const REDEEMED = {
  id: "21/89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf/188994",
  emitterChain: 21,
  emitterAddress: { hex: "89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf" },
  sequence: 188994,
  sourceChain: {
    chainId: 21,
    transaction: { txHash: "7g4nQFxU4sP7DRWG8kJSAYLCnyVTxc1VefThUYAUnBLh" },
    from: "0x32bb36331d7a9ffb6cfd4488ded16df1d0a4e2c51cec32c68bb6d7bce8f852f7",
  },
  targetChain: {
    chainId: 1,
    timestamp: "2026-09-03T20:39:52Z",
    transaction: { txHash: "qNEDtYvBdmmGdGt7xAdN2ybz1aUvUNfy7zUfF3zvbW6LrwaGSHawDFoo1id3ye2w9itoGWmjKF32fVoCzWLzxKy" },
    status: "completed",
    to: "A75HYyr5VG6zhwQ7HCeSPYmke4svHCPWCg4AqkHJw63e",
  },
  content: {
    standarizedProperties: {
      appIds: null,
      fromChain: 0,
      fromAddress: "",
      toChain: 0,
      toAddress: "",
      tokenChain: 0,
      tokenAddress: "",
      amount: "",
    },
  },
};

/** Not yet redeemed: `targetChain` is an empty object, transfer detail is full. */
const IN_FLIGHT = {
  id: "21/db0fe8bb1e2b5be628adbea0636063325073e1070ee11e4281457dfd7f158235/4rDEy-0",
  emitterChain: 21,
  emitterAddress: { hex: "db0fe8bb1e2b5be628adbea0636063325073e1070ee11e4281457dfd7f158235" },
  sequence: "4rDEy-0",
  sourceChain: {
    chainId: 21,
    transaction: { txHash: "4rDEyqGebKd98mc8vpPs3E9jFXe37MhGWFN4tp2HdVvL" },
  },
  targetChain: {},
  content: {
    standarizedProperties: {
      appIds: ["MESSAGING_EXECUTOR", "CCTP_V1"],
      fromChain: 21,
      fromAddress: "0x13b9da3c7102c1e94a02e926a544e50b93eecdfa3eef2300b99274ff4a5803d5",
      toChain: 23,
      toAddress: "0x9a62c1af2dff7f6b1731d9eb36b1622c17eae7be",
      tokenChain: 21,
      tokenAddress: "0x3f2e28d163e25042ac7c9543c15675af5aa5d3c27dbc656a67f37f4293a3fdef",
      amount: "1108593900",
    },
  },
};

describe("parseOperation", () => {
  it("reads a redeemed operation's destination", () => {
    const op = parseOperation(REDEEMED)!;
    expect(op.destination).toMatchObject({
      wormholeChain: 1,
      to: "A75HYyr5VG6zhwQ7HCeSPYmke4svHCPWCg4AqkHJw63e",
      status: "completed",
    });
    expect(op.sourceTxHash).toBe("7g4nQFxU4sP7DRWG8kJSAYLCnyVTxc1VefThUYAUnBLh");
  });

  it("normalizes a numeric sequence to a string", () => {
    // u64 sequences exceed Number.MAX_SAFE_INTEGER; a string is the only safe
    // carrier, and it must match the on-chain event's string form to join.
    expect(parseOperation(REDEEMED)!.sequence).toBe("188994");
  });

  it("does not invent transfer detail from an all-zero standarizedProperties", () => {
    // Observed on mainnet: a complete targetChain alongside an empty
    // standarizedProperties. Reporting fromChain 0 / amount "" as real would
    // put a bogus zero-amount transfer in a case file.
    expect(parseOperation(REDEEMED)!.transfer).toBeNull();
  });

  it("treats an empty targetChain as not-yet-redeemed rather than a destination", () => {
    const op = parseOperation(IN_FLIGHT)!;
    expect(op.destination).toBeNull();
    // ...while the transfer half is fully present. Neither may be used to
    // decide the other is absent.
    expect(op.transfer).toMatchObject({ toChain: 23, amount: "1108593900" });
  });

  it("keeps the indexer's protocol attribution", () => {
    expect(parseOperation(IN_FLIGHT)!.appIds).toEqual(["MESSAGING_EXECUTOR", "CCTP_V1"]);
  });

  it("returns null for a non-object rather than throwing", () => {
    expect(parseOperation(null)).toBeNull();
    expect(parseOperation("nope")).toBeNull();
  });

  it("survives an operation missing every optional field", () => {
    const op = parseOperation({ id: "x" })!;
    expect(op.destination).toBeNull();
    expect(op.transfer).toBeNull();
    expect(op.sourceTxHash).toBeNull();
    expect(op.appIds).toEqual([]);
  });
});

describe("wormholescanAvailable", () => {
  it("knows which networks are indexed", () => {
    expect(wormholescanAvailable("mainnet")).toBe(true);
    expect(wormholescanAvailable("testnet")).toBe(true);
  });

  it("reports devnet as unindexed rather than silently using mainnet", () => {
    // Querying the mainnet index with a devnet digest returns an empty result
    // that reads as "never redeemed" instead of "not indexed here".
    expect(wormholescanAvailable("devnet")).toBe(false);
  });
});
