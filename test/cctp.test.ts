import { describe, it, expect } from "vitest";
import {
  caip2ForCctpDomain,
  cctpDomainLabel,
  decodeMintRecipient,
  parseDepositForBurn,
  parseMessageHeader,
} from "../src/utils/bridge/cctp.js";

/** Captured from mainnet tx 4rDEyqGebKd98mc8vpPs3E9jFXe37MhGWFN4tp2HdVvL. */
const MESSAGE_B64 =
  "AAAAAAAAAAgAAAADAAAAAAAGfaSv3Hksea0RIV1mYcwGMg1IuffdRvTp1JAcRZhvpDDjyAAAAAAAAAAAAAAAABkzDRDZzIdRIY6vUeiIXQWGQuCKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPy4o0WPiUEKsfJVDwVZ1r1ql08J9vGVqZ/N/QpOj/e8AAAAAAAAAAAAAAACaYsGvLf9/axcx2es2sWIsF+rnvgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqShzE7naPHECwelKAukmpUTlC5Puzfo+7yMAuZJ0/0pYA9U=";

const DEPOSIT = {
  nonce: "425380",
  burn_token: "0x3f2e28d163e25042ac7c9543c15675af5aa5d3c27dbc656a67f37f4293a3fdef",
  amount: "11085939",
  depositor: "0x13b9da3c7102c1e94a02e926a544e50b93eecdfa3eef2300b99274ff4a5803d5",
  mint_recipient: "0x0000000000000000000000009a62c1af2dff7f6b1731d9eb36b1622c17eae7be",
  destination_domain: 3,
};

describe("parseMessageHeader", () => {
  it("reads the header of a real Sui-origin message", () => {
    const h = parseMessageHeader(MESSAGE_B64)!;
    expect(h).toEqual({ version: 0, sourceDomain: 8, destinationDomain: 3, nonce: "425380" });
  });

  it("carries the nonce as a string", () => {
    // u64. Past 2^53 a Number would lose precision and stop matching the
    // destination chain's copy of the same nonce.
    expect(typeof parseMessageHeader(MESSAGE_B64)!.nonce).toBe("string");
  });

  it("returns null for anything too short to be a message", () => {
    expect(parseMessageHeader(Buffer.from("short").toString("base64"))).toBeNull();
    expect(parseMessageHeader("!!!not base64!!!")).toBeNull();
  });
});

describe("decodeMintRecipient", () => {
  it("un-pads a 32-byte value into a 20-byte EVM address", () => {
    expect(decodeMintRecipient(DEPOSIT.mint_recipient, 3)).toBe(
      "0x9a62c1af2dff7f6b1731d9eb36b1622c17eae7be",
    );
  });

  it("refuses to trim when the padding is not padding", () => {
    // Trimming a value whose high bytes are set would invent an address that
    // is not the recipient.
    const notPadded = `0x${"11".repeat(32)}`;
    expect(decodeMintRecipient(notPadded, 3)).toBeNull();
  });

  it("keeps all 32 bytes for a Sui destination", () => {
    const v = `0x${"ab".repeat(32)}`;
    expect(decodeMintRecipient(v, 8)).toBe(v);
  });

  it("base58-encodes a Solana destination", () => {
    // Solana addresses are base58 over the full 32 bytes, not hex.
    const out = decodeMintRecipient(`0x${"01".repeat(32)}`, 5)!;
    expect(out).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("returns null for an unmapped domain rather than guessing", () => {
    expect(decodeMintRecipient(DEPOSIT.mint_recipient, 99)).toBeNull();
  });
});

describe("parseDepositForBurn", () => {
  const header = parseMessageHeader(MESSAGE_B64);

  it("produces the transfer identity from the message header", () => {
    // (sourceDomain, nonce) is quoted back by the destination chain on mint.
    expect(parseDepositForBurn(DEPOSIT, header, true)!.transferId).toBe("8/425380");
  });

  it("resolves the destination from chain data alone", () => {
    const t = parseDepositForBurn(DEPOSIT, header, true)!;
    expect(t.destinationAccount).toBe("eip155:42161:0x9a62c1af2dff7f6b1731d9eb36b1622c17eae7be");
    expect(t.destinationChainLabel).toBe("Arbitrum");
    expect(t.amount).toBe("11085939");
  });

  it("still reports destination and recipient when no message header is present", () => {
    // The transfer id needs the header; what an investigator follows does not.
    const t = parseDepositForBurn(DEPOSIT, null, true)!;
    expect(t.transferId).toBeNull();
    expect(t.destinationAddress).toBe("0x9a62c1af2dff7f6b1731d9eb36b1622c17eae7be");
  });

  it("withholds the CAIP-2 claim off mainnet", () => {
    // Circle reuses its domain numbers across environments, so domain 3 off
    // mainnet is an Arbitrum testnet, not Arbitrum One.
    const t = parseDepositForBurn(DEPOSIT, header, false)!;
    expect(t.destinationAccount).toBeNull();
    expect(t.destinationAddress).toBe("0x9a62c1af2dff7f6b1731d9eb36b1622c17eae7be");
  });

  it("returns null for a payload that names no destination", () => {
    expect(parseDepositForBurn({ nonce: "1" }, null, true)).toBeNull();
    expect(parseDepositForBurn(null, header, true)).toBeNull();
  });
});

describe("domain mapping", () => {
  it("maps the domains confirmed against mainnet data", () => {
    // 8 appears as the source domain of a Sui transaction's own message;
    // 3's recipient matched what an independent indexer reported.
    expect(caip2ForCctpDomain(8)).toBe("sui:mainnet");
    expect(caip2ForCctpDomain(3)).toBe("eip155:42161");
  });

  it("names a domain it cannot map, rather than dropping it", () => {
    expect(caip2ForCctpDomain(4)).toBeNull();
    expect(cctpDomainLabel(4)).toBe("Noble");
    expect(cctpDomainLabel(999)).toBe("Circle domain 999");
  });
});
