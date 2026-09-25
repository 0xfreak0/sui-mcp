import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { detectBridges, resolvableHit, type CallSite } from "../src/utils/bridge/detect.js";
import { matchesEvent } from "../src/utils/bridge/event-type.js";
import { readBridgeEvents } from "../src/utils/bridge/exits.js";
import { layerZeroTransfers } from "../src/utils/bridge/layerzero.js";
import { parseScanMessage } from "../src/utils/bridge/layerzeroscan.js";
import { nttRedemptions, type PureInputNode } from "../src/utils/bridge/wormhole-inbound.js";
import type { SuiEventNode } from "../src/utils/bridge/wormhole.js";

/**
 * resolve_bridge_transfer's own GraphQL query, run against mainnet for each
 * digest and stored as returned. The expected recipients were checked against
 * an independent source where one exists: LayerZero Scan's payload for
 * 4rH8bqFB…, Axelarscan's destinationAddress for 6YaLkwRs…, Allbridge's API
 * recipientAddress for AyApNXU7….
 */
interface FixtureTx {
  transaction: {
    effects: { events: { nodes: SuiEventNode[] } };
    kind: {
      commands: { nodes: Array<{ function?: { name: string; module: { name: string; package: { address: string } } } }> };
      inputs: { nodes: PureInputNode[] };
    };
  };
}
const FIXTURES: Record<string, FixtureTx> = JSON.parse(
  readFileSync(new URL("./fixtures/bridge-transactions.json", import.meta.url), "utf8"),
);
const eventsOf = (d: string) => FIXTURES[d].transaction.effects.events.nodes;
const typesOf = (d: string) => eventsOf(d).map((e) => e.contents!.type!.repr!);
const callsOf = (d: string): CallSite[] =>
  FIXTURES[d].transaction.kind.commands.nodes.flatMap((c) =>
    c.function ? [{ packageId: c.function.module.package.address, module: c.function.module.name, function: c.function.name }] : [],
  );

const LZ_OFT = "4rH8bqFBzvaZFTvc74LH6DsHC79kHPm3TJD7tQc597Bg";
const LZ_OAPP = "5LR4enKoPtdUxkZx2xkXWC6u5vxTsKXS5cFgPcPkqymA";
const AXELAR = "6YaLkwRs9BkjDJYWCbqhmBMXdH64AXsPnsC2eC977iw9";
const ALLBRIDGE_SOL = "AyApNXU7fNRcism61V76ijzxbXKAefLL6U5wXooJVthc";
const ALLBRIDGE_POOL = "FmxxWhRozP6j8PUBKYNXnNpLJcwGgNWuQkurvY2M1pxj";
const CELER = "AkW2h1WQc7wPJXEfZBTG6R3MwjoHB5ohEvfKfsqrRUoL";
const SWIFT = "3aVcL3mhsmhrNbBS3L21YrF6tGXozpaHBB7TVJqpsEMR";
const MESON = "7EyRb8BbLPKvKQmuH2ExUFDnzxV6d6nhKGWBxG18ohiZ";
const NTT_IN = "H2qXS8fTHgeMvjME4aWShazkvLbp28DZc6ZrAGqKa6dU";
const TOKEN_BRIDGE_IN = "84Z1YEzexaCBC6FUnsCvLjYaqWz7qjhA89fRagEWvpHx";

describe("detecting the newer bridges", () => {
  it.each([
    [LZ_OFT, "LayerZero"],
    [LZ_OAPP, "LayerZero"],
    [AXELAR, "Axelar ITS"],
    [ALLBRIDGE_SOL, "Allbridge Core"],
    [ALLBRIDGE_POOL, "Allbridge Core"],
    [CELER, "Celer cBridge"],
    [SWIFT, "Mayan Swift"],
  ])("finds %s from its events alone", (digest, protocol) => {
    const hit = detectBridges([], typesOf(digest)).find((h) => h.protocol === protocol);
    expect(hit?.matched).toBe("event");
    expect(resolvableHit([hit!])?.protocol).toBe(protocol);
  });

  it.each([
    [LZ_OFT, "LayerZero"],
    [AXELAR, "Axelar ITS"],
    [ALLBRIDGE_SOL, "Allbridge Core"],
    [CELER, "Celer cBridge"],
    [SWIFT, "Mayan Swift"],
    [MESON, "Meson"],
  ])("finds %s from its calls alone", (digest, protocol) => {
    expect(detectBridges(callsOf(digest)).find((h) => h.protocol === protocol)?.matched).toBe("call");
  });

  it("detects Meson, which emits no events, and says its destination is not in Sui data", () => {
    expect(eventsOf(MESON)).toEqual([]);
    const [hit] = detectBridges(callsOf(MESON));
    expect(hit.resolution).toBe("detect-only");
    expect(hit.note).toContain("cannot be read from chain data");
  });

  it("does not take LayerZero's send_compose for an exit", () => {
    const compose = [{ packageId: "0x31beaef8", module: "endpoint_v2", function: "send_compose" }];
    expect(detectBridges(compose)).toEqual([]);
  });

  it("pins generic event names to their package", () => {
    // `events::TokensSentEvent` and `peg_bridge::BurnEvent` are names any
    // package can define; only Allbridge's and Celer's own are exits.
    const lookalikes = [
      "0x" + "ab".repeat(32) + "::events::TokensSentEvent",
      "0x" + "ab".repeat(32) + "::events::InterchainTransfer<0x2::sui::SUI>",
      "0x" + "ab".repeat(32) + "::peg_bridge::BurnEvent",
      "0x" + "ab".repeat(32) + "::init_order::OrderCreated",
    ];
    expect(detectBridges([], lookalikes)).toEqual([]);
  });

  it("matches a pinned marker whatever the spelling of the package address", () => {
    const marker = "0x0000000000000000000000000000000000000000000000000000000000000abc::m::E";
    expect(matchesEvent(marker, "0xabc::m::E<0x2::sui::SUI>")).toBe(true);
    expect(matchesEvent(marker, "0xabd::m::E")).toBe(false);
    expect(matchesEvent(marker, "0xabc::m::Ex")).toBe(false);
  });

  it("reports nothing for an inbound redemption", () => {
    expect(detectBridges(callsOf(NTT_IN), typesOf(NTT_IN))).toEqual([]);
    expect(detectBridges(callsOf(TOKEN_BRIDGE_IN), typesOf(TOKEN_BRIDGE_IN))).toEqual([]);
  });
});

describe("LayerZero packets", () => {
  it("reads the OFT recipient, GUID and destination from the packet (4rH8bqFB…)", () => {
    const [t] = layerZeroTransfers(eventsOf(LZ_OFT));
    // GUID and recipient as LayerZero Scan reports them for this transaction.
    expect(t.guid).toBe("0xb108fd02770cbe42f914326c8941d6bd57086a77cd9434d394e6629dd83d1386");
    expect(t.dst_eid).toBe(30101);
    expect(t.destination_chain).toBe("eip155:1");
    expect(t.destination_oapp.address).toBe("0x0555e30da8f98308edb960aa94c0db47230d2b9c");
    expect(t.beneficiary?.account).toBe("eip155:1:0x5d99551ce4a2c1467adf632474424e7e22c72c66");
    expect(t.oft?.amount_sd).toBe("60006900");
  });

  it("names no recipient for an app that is not a provable OFT (5LR4enKo…)", () => {
    const [t] = layerZeroTransfers(eventsOf(LZ_OAPP));
    expect(t.destination_chain).toBe("eip155:1");
    expect(t.destination_oapp.address).toBe("0x0be91692750982b4ba92dabc3985c548098f68c5");
    expect(t.beneficiary).toBeNull();
  });

  it("will not read an OFT recipient when the OFT event came from another package", () => {
    const events = eventsOf(LZ_OFT).map((e) =>
      e.contents!.type!.repr!.endsWith("::oft::OFTSentEvent")
        ? { contents: { ...e.contents, type: { repr: "0x" + "ee".repeat(32) + "::oft::OFTSentEvent" } } }
        : e,
    );
    expect(layerZeroTransfers(events)[0].beneficiary).toBeNull();
  });

  it("parses LayerZero Scan's message shape", () => {
    const m = parseScanMessage({
      guid: "0xB108FD02770CBE42F914326C8941D6BD57086A77CD9434D394E6629DD83D1386",
      status: { name: "DELIVERED" },
      source: { status: "SUCCEEDED" },
      pathway: { sender: { name: "wBTC" }, receiver: { address: "0x0555e30da8f98308edb960aa94c0db47230d2b9c" } },
      destination: { status: "SUCCEEDED", tx: { txHash: "0xca09e0696b49f7ef759a7ad8114d6c8540ab3d88ef26367db88a9ce8dc91b210", blockTimestamp: 1790315927 } },
    });
    expect(m?.guid).toBe("0xb108fd02770cbe42f914326c8941d6bd57086a77cd9434d394e6629dd83d1386");
    expect(m?.destination?.timestamp).toBe("2026-09-25T05:58:47.000Z");
  });
});

describe("beneficiaries of the newer bridges", () => {
  const beneficiariesOf = (d: string) => readBridgeEvents(eventsOf(d), true).beneficiaries;

  it("reads Axelar's 20-byte EVM destination (6YaLkwRs…)", () => {
    const [b] = beneficiariesOf(AXELAR);
    expect(b.protocol).toBe("Axelar ITS");
    expect(b.account).toBe("eip155:1:0xce16f69375520ab01377ce7b88f5ba8c48f8d666");
    expect(b.amount).toBe("500000000000");
  });

  it("names Allbridge's wallet, not the Solana token account CCTP mints into (AyApNXU7…)", () => {
    const r = readBridgeEvents(eventsOf(ALLBRIDGE_SOL), true);
    expect(r.beneficiaries.map((b) => b.address)).toEqual(["EVouhT1HgMproxeVcFdmZERhbpnYS4taEV3tzG3zBbdV"]);
    expect(r.beneficiaries[0].chain).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    // The CCTP burn is Allbridge's carrier, matched on the shared nonce.
    expect(r.cctpTransfers[0].destinationAddress).toBe("5xpSpHUF6Mub1vn1nf9yCktEJi4a6bqVKqwMxrYvHgd");
    expect(r.carriesAllbridge(r.cctpTransfers[0].nonce)).toBe(true);
  });

  it("reads the deprecated pool bridge's recipient and messenger (FmxxWhRo…)", () => {
    const r = readBridgeEvents(eventsOf(ALLBRIDGE_POOL), true);
    expect(r.allbridge[0].route).toBe("pool");
    expect(r.allbridge[0].messenger).toBe("Allbridge");
    expect(r.beneficiaries[0].account).toBe("eip155:1:0x1c68916c0eddb9d88f88f89cfdacb5388a50781f");
  });

  it("reads Celer's destination and burn id (AkW2h1WQ…)", () => {
    const r = readBridgeEvents(eventsOf(CELER), true);
    expect(r.celer[0].transfer_id).toBe("0xec30eb7b4f12151fabdb283baaf6583a66f00d83ac3dd0011bc5659b82f82fb0");
    expect(r.beneficiaries[0].account).toBe("eip155:1:0x1c207712859b8f29c3a2af72cd30fa600ca9bc9e");
  });

  it("does not claim eip155 for a Celer chain id this server does not know as EVM", () => {
    const event = eventsOf(CELER)[0];
    const json = { ...(event.contents!.json as object), to_chain: "12370001" };
    const [b] = readBridgeEvents([{ contents: { ...event.contents, json } }], true).beneficiaries;
    expect(b.chain).toBeNull();
    expect(b.account).toBeNull();
    expect(b.chain_label).toBe("Celer chain 12370001");
  });

  it("reads a Mayan Swift order's Solana recipient (3aVcL3mh…)", () => {
    const [b] = beneficiariesOf(SWIFT);
    expect(b.protocol).toBe("Mayan Swift");
    expect(b.address).toBe("EqP2tJMQxQit7AM1T4onNcej6yhYRCWMarySQnFYKcEG");
    expect(b.transfer_id).toBe("0x9c98049c000bad83cd9d1100bf77309a2ad68d9a633fd4a5b8248d9d98794b30");
  });
});

describe("Wormhole transfers arriving on Sui", () => {
  it("reads the origin VAA of a Token Bridge redemption (84Z1YEze…)", () => {
    const [r] = readBridgeEvents(eventsOf(TOKEN_BRIDGE_IN), true).wormholeInbound;
    // Emitter 0xb6f6d86a… is the Token Bridge on BNB Chain.
    expect(r.vaa_id).toBe("4/000000000000000000000000b6f6d86a8f9879a9c87f643768d9efc38c1da6e7/873101");
    expect(r.origin_chain).toBe("eip155:56");
  });

  it("reads an NTT redemption's origin and Sui recipient from the VAA it passed in (H2qXS8fT…)", () => {
    expect(eventsOf(NTT_IN)).toEqual([]);
    const [r] = nttRedemptions(FIXTURES[NTT_IN].transaction.kind.inputs.nodes, true);
    // Wormholescan has this VAA, from Solana, with the same toAddress and amount.
    expect(r.kind).toBe("ntt-redemption");
    expect(r.vaa_id).toBe("1/a84051ee54d531c23b904961e053801c73e446317a1a843421b5cfa2c1435fec/203");
    expect(r.origin_chain).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(r.recipient).toBe("0x59a420a6246e2471a22f769cbeb89f80c605a0860f3d757050147bc551a3a700");
    expect(r.amount).toBe("103670410");
  });

  it("finds no NTT redemption in an outbound transaction's inputs", () => {
    expect(nttRedemptions(FIXTURES[LZ_OFT].transaction.kind.inputs.nodes, true)).toEqual([]);
  });
});
