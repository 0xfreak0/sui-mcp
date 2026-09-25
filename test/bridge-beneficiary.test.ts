import { describe, it, expect } from "vitest";
import { decodeWormholePayload, mayanBeneficiaries } from "../src/utils/bridge/beneficiary.js";
import { extractWormholeMessages } from "../src/utils/bridge/wormhole.js";

/**
 * Payloads captured from mainnet WormholeMessage events. The expected
 * recipients are Wormholescan's `standarizedProperties.toAddress` for the same
 * VAA, and for the relayed transfer the Ethereum redemption forwarded the
 * funds to it. The destination contract each redemption called is what
 * resolve_bridge_transfer used to report as the destination account.
 */
const message = (sender: string, hex: string) =>
  extractWormholeMessages([
    {
      contents: {
        type: { repr: "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::publish_message::WormholeMessage" },
        json: { sender, sequence: "1", payload: Buffer.from(hex, "hex").toString("base64") },
      },
    },
  ])[0];

const TOKEN_BRIDGE = "0xccceeb29348f71bdd22ffef43a2a19c1f5b5e17c5cca5411529120182672ade5";

describe("decodeWormholePayload", () => {
  it("reads the recipient of a Token Bridge transfer to an EVM chain (GkWjxVGi…)", () => {
    const m = message(
      TOKEN_BRIDGE,
      "0100000000000000000000000000000000000000000000000000000e1104194d802a62e389553ae6f061970ce1be2607c7f918154532e4296512d5a2c773424ff5001500000000000000000000000063186b34c809cca9f3825a3592082e1f1549fa5b00040000000000000000000000000000000000000000000000000000000000000000",
    );
    const d = decodeWormholePayload(m, true)!;
    expect(d.kind).toBe("token-bridge-transfer");
    // Not 0xb6f6d86a…, the Token Bridge contract on BSC that redeemed it.
    expect(d.beneficiary?.account).toBe("eip155:56:0x63186b34c809cca9f3825a3592082e1f1549fa5b");
  });

  it("reads a Solana recipient as base58 (Heso3vSy…)", () => {
    const m = message(
      TOKEN_BRIDGE,
      "0100000000000000000000000000000000000000000000000000000000d7e5a5ac9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb30015e6c373f66273e9f86d0f4b0f77ad11ed7f3f8da1855e88116c689ad2de4d808e00010000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(decodeWormholePayload(m, true)!.beneficiary?.address).toBe("GXodYd6shU8hnUgrxzs9bGRT7TPKZHpbRWavhrH4MaiH");
  });

  it("reads the Token Bridge Relayer's target recipient behind payload 3 (7oiD7oNk…)", () => {
    const m = message(
      TOKEN_BRIDGE,
      "03000000000000000000000000000000000000000000000000000000293ca6226f069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f000000000010001000000000000000000000000cafd2f0a35a4459fa40c0517e17e6fa2939441ca0002c4c610707eab9b222996b075f7d07c7d9b07766ab7bcafef621fd53bbf089f4e010000000000000000000000000000000000000000000000000000000003a6794a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000089012a55cd6b88e407c9d4ae9b3425f55924919b",
    );
    const d = decodeWormholePayload(m, true)!;
    // The Cetus attacker's EVM address, not the relayer contract 0xcafd2f0a….
    expect(d.beneficiary?.account).toBe("eip155:1:0x89012a55cd6b88e407c9d4ae9b3425f55924919b");
    expect(d.beneficiary?.via_contract).toBe("0xcafd2f0a35a4459fa40c0517e17e6fa2939441ca");
  });

  it("reads an NTT transfer's recipient (5LmSEKvX…)", () => {
    const m = message(
      "0x79b7ae730c81028e29afdab42e0a48cb592b595450fb70c553af056a1b18d8e8",
      "9945ff104b6aede12bf98dce51cd92a157e13e89bf2dd7c5e2cfe47e91ad315505a46ac50bc1525f6607fce6db3f8cd1e2a6163e839dd7f8429dbf30b164406217ccfad7009100000000000000000000000000000000000000000000000000000000000001537f066fbb249d67b27844b459eaa75f76021e3abccfe3652c28bf7f13a42655da004f994e5454080000005d21dba0009258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3be42d322d70375b80830252d0615c145153e20690069addb0867d4266ebd75a000010000",
    );
    const d = decodeWormholePayload(m, true)!;
    // Not ntTeWkdx…, the NTT manager program.
    expect(d.beneficiary?.address).toBe("DohZdzwGwXhNdZGg4dfhXv189tzEvsQ7A74RgTH3WgeT");
  });

  it("names nobody for a payload it cannot attribute", () => {
    // Mayan's own 32-byte message on 6jMEFeap…: not a Token Bridge emitter.
    const m = message(
      "0x89b91e68d0264956632bf11f8abd2243caa56c4a42c97d9b97eadc71bf1074bf",
      "b5723827bfa006baa3447b91f15cf537ec9991c8ec5a3909f9d48e8001462be9",
    );
    expect(decodeWormholePayload(m, true)).toBeNull();
  });
});

describe("mayanBeneficiaries", () => {
  const PKG = "0xb5bd3599ec7f4ae86afd84398f6f2d862deecce965e8ace2d8d8c8108d5076df";
  const marker = { contents: { type: { repr: `${PKG}::init_order::InitMctpLogged` }, json: {} } };

  it("reads the order's destination, not the CCTP settlement contract (6jMEFeap…)", () => {
    const order = {
      contents: {
        type: { repr: `${PKG}::init_order::OrderCreated` },
        json: {
          addr_dest: "0x00000000000000000000000089012a55cd6b88e407c9d4ae9b3425f55924919b",
          chain_dest: 2,
          amount_in: "1000000000000",
        },
      },
    };
    const [b] = mayanBeneficiaries([order, marker], true);
    expect(b.account).toBe("eip155:1:0x89012a55cd6b88e407c9d4ae9b3425f55924919b");
  });

  it("reads an MCTP bridge's destination by CCTP domain (777Emr4V…)", () => {
    const submitted = {
      contents: {
        type: { repr: `${PKG}::bridge_with_fee::BridgeSubmittedWithFee` },
        json: { addr_dest: "0x0000000000000000000000001e0b842ca732d3bb91bb130a2b01559442160770", dest_domain: 6 },
      },
    };
    expect(mayanBeneficiaries([submitted, marker], true)[0].account).toBe(
      "eip155:8453:0x1e0b842ca732d3bb91bb130a2b01559442160770",
    );
  });

  it("ignores an OrderCreated from a package that emitted no Mayan marker", () => {
    // `init_order` is a generic module name; DEX order books use it too.
    const dexOrder = {
      contents: {
        type: { repr: "0xdex::init_order::OrderCreated" },
        json: { addr_dest: `0x${"1".repeat(64)}`, chain_dest: 2 },
      },
    };
    expect(mayanBeneficiaries([dexOrder, marker], true)).toEqual([]);
  });
});
