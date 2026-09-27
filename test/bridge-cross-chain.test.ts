import { describe, it, expect } from "vitest";
import { crossChainLeads } from "../src/utils/bridge/cross-chain.js";
import { detectBridges } from "../src/utils/bridge/detect.js";
import { lookupProtocol } from "../src/protocols/registry.js";

/** A package no bridge reader or registry entry covers. */
const UNKNOWN = "0x7a1e0000000000000000000000000000000000000000000000000000000000aa";
const event = (type: string, json: unknown) => ({ contents: { type: { repr: type }, json } });
const EVM = Buffer.from("1f9840a85d5af5bf1d1762f925bdaddc4201f984", "hex");

describe("crossChainLeads", () => {
  it("reads a destination chain and a 20-byte recipient from an unknown package's event", () => {
    const [lead] = crossChainLeads([
      event(`${UNKNOWN}::gateway::Sent`, { amount: "5000000", dst_chain_id: "30101", recipient: EVM.toString("base64") }),
    ]);
    expect(lead).toMatchObject({
      evidence: "heuristic",
      chain_field: "dst_chain_id",
      chain_value: "30101",
      recipient_field: "recipient",
      recipient_raw: `0x${EVM.toString("hex")}`,
      recipient_bytes: 20,
      direction: "outbound",
    });
  });

  it("finds a padded recipient nested inside a struct, as a byte array", () => {
    const padded = [...Buffer.alloc(12), ...EVM];
    const [lead] = crossChainLeads([event(`${UNKNOWN}::msg::Out`, { message: { to_chain: 2, to: { data: padded } } })]);
    expect(lead).toMatchObject({ chain_field: "message.to_chain", recipient_field: "message.to.data", recipient_bytes: 32, direction: "outbound" });
  });

  it("names the destination chain when the event states its source chain first", () => {
    const [lead] = crossChainLeads([
      event(`${UNKNOWN}::gateway::Sent`, { source_chain: 21, target_chain: 2, target_address: EVM.toString("base64") }),
    ]);
    expect(lead).toMatchObject({ chain_field: "target_chain", chain_value: "2", direction: "outbound" });
  });

  it("reads a source chain and sender as inbound", () => {
    const [lead] = crossChainLeads([
      event(`${UNKNOWN}::gateway::Received`, { source_chain: 1, sender_address: EVM.toString("base64") }),
    ]);
    expect(lead.direction).toBe("inbound");
  });

  it("leaves out an event with no address-sized byte string, or only a Sui address", () => {
    const sui = `0x${"ab".repeat(32)}`;
    expect(
      crossChainLeads([
        event(`${UNKNOWN}::pool::Swap`, { chain_id: 1, amount_in: "10", amount_out: "9" }),
        event(`${UNKNOWN}::vault::Moved`, { domain: 5, owner: sui }),
        event(`${UNKNOWN}::vault::Zero`, { dst_chain: 5, recipient: Buffer.alloc(20).toString("base64") }),
      ]),
    ).toEqual([]);
  });

  it("does not read 32 random bytes as a recipient unless the field names a party", () => {
    const guid = Buffer.from("6261526db47cdd8f1bb6312c0589db20be7671c3ddc95912f638fbf9a3612585", "hex");
    // The shape of an OFT app's own send event: a GUID, never a recipient.
    expect(crossChainLeads([event(`${UNKNOWN}::oft::Sent`, { dst_eid: 30101, guid: { bytes: guid.toString("base64") } })])).toEqual([]);
    expect(crossChainLeads([event(`${UNKNOWN}::oft::Sent`, { dst_eid: 30101, to_address: guid.toString("base64") })])).toHaveLength(1);
  });

  it("leaves out a lead that restates a recipient a curated reader decoded from the same transaction", () => {
    const sent = event(`${UNKNOWN}::oft::Sent`, { dst_eid: 30101, to_address: Buffer.concat([Buffer.alloc(12), EVM]).toString("base64") });
    expect(crossChainLeads([sent], [`0x${EVM.toString("hex")}`])).toEqual([]);
    expect(crossChainLeads([sent], [])).toHaveLength(1);
  });

  it("leaves out an event a curated bridge reader already covers", () => {
    // The TokenDepositedEvent of mainnet transaction 4xLuY6N68PgqBow9i4iawBvVw3eEkxKQNRQeSWFGwjJi.
    const deposit = {
      seq_num: "23371",
      source_chain: 0,
      sender_address: "xKRFS6UEKXM8q3C7Q0rJnXTSCnU0w9/Tux+m6Ts8SzI=",
      target_chain: 10,
      target_address: "1vBbGb8sBcJkpka3dXBX13RmHFw=",
      token_type: 4,
      amount: "130004100000",
    };
    expect(crossChainLeads([event("0x000000000000000000000000000000000000000000000000000000000000000b::bridge::TokenDepositedEvent", deposit)])).toEqual([]);
    // The same fields from an unknown package are a lead.
    expect(crossChainLeads([event(`${UNKNOWN}::bridge::Deposited`, deposit)])).toHaveLength(1);
  });
});

describe("the Sui Bridge package is curated", () => {
  it("names 0xb and does not read a call to it other than send_token as an exit", () => {
    expect(lookupProtocol("0xb")?.name).toBe("Sui Bridge");
    expect(detectBridges([{ packageId: "0xb", module: "bridge", function: "claim_and_transfer_token" }])).toEqual([]);
    expect(detectBridges([{ packageId: "0xb", module: "bridge", function: "send_token" }]).map((h) => h.protocol)).toEqual(["Sui Bridge"]);
  });
});
