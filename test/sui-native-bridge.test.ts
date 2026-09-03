import { describe, it, expect } from "vitest";
import {
  decodeBridgeAddress,
  parseClaimEvent,
  parseDepositEvent,
  suiBridgeChainLabel,
} from "../src/utils/bridge/sui-native.js";

/**
 * The exact payload of the TokenDepositedEvent in mainnet transaction
 * 4xLuY6N68PgqBow9i4iawBvVw3eEkxKQNRQeSWFGwjJi.
 */
const REAL_DEPOSIT = {
  seq_num: "23371",
  source_chain: 0,
  sender_address: "xKRFS6UEKXM8q3C7Q0rJnXTSCnU0w9/Tux+m6Ts8SzI=",
  target_chain: 10,
  target_address: "1vBbGb8sBcJkpka3dXBX13RmHFw=",
  token_type: 4,
  amount: "130004100000",
};

describe("decodeBridgeAddress", () => {
  it("decodes a 20-byte EVM destination", () => {
    expect(decodeBridgeAddress("1vBbGb8sBcJkpka3dXBX13RmHFw=")).toBe(
      "0xd6f05b19bf2c05c264a646b7757057d774661c5c",
    );
  });

  it("decodes a 32-byte Sui sender", () => {
    expect(decodeBridgeAddress("xKRFS6UEKXM8q3C7Q0rJnXTSCnU0w9/Tux+m6Ts8SzI=")).toBe(
      "0xc4a4454ba50429733cab70bb434ac99d74d20a7534c3dfd3bb1fa6e93b3c4b32",
    );
  });

  it("refuses a length that is neither an EVM nor a Sui address", () => {
    // Padding an odd length into something address-shaped would produce a
    // plausible-looking address belonging to nobody.
    expect(decodeBridgeAddress(Buffer.from("abc").toString("base64"))).toBeNull();
  });
});

describe("parseDepositEvent", () => {
  it("reads the destination out of a real mainnet deposit", () => {
    const t = parseDepositEvent(REAL_DEPOSIT)!;
    // The whole point: no indexer is involved in establishing this.
    expect(t.targetAccount).toBe("eip155:1:0xd6f05b19bf2c05c264a646b7757057d774661c5c");
    expect(t.targetChainLabel).toBe("Ethereum");
    expect(t.amount).toBe("130004100000");
  });

  it("exposes the bridge's own transfer identity", () => {
    // (source_chain, seq_num) is quoted back by the Ethereum side on claim,
    // so it is the key for confirming the transfer completed.
    expect(parseDepositEvent(REAL_DEPOSIT)!.transferId).toBe("0/23371");
  });

  it("reports the raw address but no CAIP-10 for an unmapped chain", () => {
    const t = parseDepositEvent({ ...REAL_DEPOSIT, target_chain: 11 })!;
    expect(t.targetAccount).toBeNull();
    expect(t.targetAddress).toBe("0xd6f05b19bf2c05c264a646b7757057d774661c5c");
    expect(t.targetChainLabel).toBe("Ethereum Sepolia");
  });

  it("returns null rather than a half-populated transfer", () => {
    expect(parseDepositEvent({ seq_num: "1" })).toBeNull();
    expect(parseDepositEvent(null)).toBeNull();
  });
});

describe("suiBridgeChainLabel", () => {
  it("names the chains the bridge declares", () => {
    expect(suiBridgeChainLabel(0)).toBe("Sui");
    expect(suiBridgeChainLabel(10)).toBe("Ethereum");
  });

  it("falls back to the number for anything undeclared", () => {
    expect(suiBridgeChainLabel(99)).toBe("Sui-bridge chain 99");
  });
});

/** The TokenTransferClaimed payload from mainnet tx 5bATZ4ZYEZa9…ADut. */
const REAL_CLAIM = { message_key: { source_chain: 10, message_type: 0, bridge_seq_num: "32597" } };

describe("parseClaimEvent", () => {
  it("resolves an inbound claim to its origin chain and transfer id", () => {
    const c = parseClaimEvent(REAL_CLAIM, true)!;
    // The mirror of an outbound transfer_id: the origin chain emitted this
    // exact identity, so a trace running backwards can pick it up there.
    expect(c.transferId).toBe("10/32597");
    expect(c.sourceChainLabel).toBe("Ethereum");
    expect(c.sourceChainId).toBe("eip155:1");
  });

  it("withholds the CAIP-2 origin off mainnet", () => {
    // Same rule as outbound: the bridge reuses its chain numbers across
    // environments, so off mainnet chain 10 is not Ethereum mainnet.
    const c = parseClaimEvent(REAL_CLAIM, false)!;
    expect(c.sourceChainId).toBeNull();
    // The bridge's own chain number is still reported, so the origin is not lost.
    expect(c.sourceChain).toBe(10);
  });

  it("returns null when the message key is absent or incomplete", () => {
    expect(parseClaimEvent({}, true)).toBeNull();
    expect(parseClaimEvent({ message_key: { source_chain: 10 } }, true)).toBeNull();
    expect(parseClaimEvent(null, true)).toBeNull();
  });

  it("keeps the sequence as a string", () => {
    // Same u64 precision argument as everywhere else: it has to compare equal
    // to the origin chain's copy.
    expect(typeof parseClaimEvent(REAL_CLAIM, true)!.seqNum).toBe("string");
  });
});
