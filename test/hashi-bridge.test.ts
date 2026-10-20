import { describe, expect, it } from "vitest";
import { runWithNetwork } from "../src/config.js";
import { readBridgeEvents } from "../src/utils/bridge/exits.js";
import { bitcoinWitnessAddress, HASHI_PACKAGES } from "../src/utils/bridge/hashi.js";
import { hashiRequestState, type Lifecycle } from "../src/utils/bridge/hashi-status.js";
import { groupExits, readExit, type FlowTx } from "../src/utils/address-flows.js";
import type { SuiEventNode } from "../src/utils/bridge/wormhole.js";

const pkg = HASHI_PACKAGES.testnet!;
const event = (type: string, json: unknown, packageId = pkg): SuiEventNode => ({
  contents: { type: { repr: `${packageId}::${type}` }, json },
});

// testnet 6mnmYUk6oHaJtEjCSq5FBBDYk9UBGH9qT6aBkpzBbd3A;
// https://mempool.space/signet/tx/d731a322f0af85615cc0d5c08bacfe4c67f07115f80cbe867f3c67a0870d6227
const committed = event("withdrawal_queue::WithdrawalPickedForProcessing", {
  withdrawal_txn_id: "0x427fc0d8fdf16df17175308f68dab9fb4ecff14b9e74997e2d47840c00a74ec1",
  txid: "0x27620d87a0673c7f86be0cf81571f0674cfeac8bc0d5c05c6185aff022a331d7",
  request_ids: ["0xbb504a6bda48060dc5b34e4da29c75d6074df27b3ec86131355f8f5dff551447"],
  withdrawal_outputs: [{ amount: "101411668", bitcoin_address: "zCIqJ49NY6dsb9QZY0LPu8PcMKw=" }],
  change_outputs: [{ amount: "13261137473", bitcoin_address: "jqnl2BSj5QMaB6RgV+JDW0dnBoaxwPAuM4HynYauj38=" }],
});
const confirmedDeposit = event("deposit::DepositConfirmed", {
  request_id: "0x55d25571398131217aaee4f412b0632675b800525a44d02d4df7a83c93fd569d",
  utxo: {
    id: { txid: "0x17b0cff2c9c75b20bb061cd8092b128e5e267ec18140883595999cb11aad5af4", vout: 0 },
    amount: "100117826",
    derivation_path: "0x5469cba4fb40675770a78e345a92595e1a3ab9b1514d0f050966038849fdb743",
  },
});

describe("Hashi Bitcoin transfers", () => {
  it("decodes the on-chain Bitcoin output and reverses the transaction hash for explorers", () => {
    const reading = runWithNetwork("testnet", () => readBridgeEvents([committed], false));
    expect(reading.hashiWithdrawals).toEqual([expect.objectContaining({
      status: "committed",
      bitcoin_txid: "0xd731a322f0af85615cc0d5c08bacfe4c67f07115f80cbe867f3c67a0870d6227",
      outputs: [{
        request_id: "0xbb504a6bda48060dc5b34e4da29c75d6074df27b3ec86131355f8f5dff551447",
        amount_sats: "101411668",
        bitcoin_address: "tb1qes3z5fu0f436wmr06svkxsk0h0pacv9vcsn3m7",
        bitcoin_address_raw: "zCIqJ49NY6dsb9QZY0LPu8PcMKw=",
      }],
    })]);
    expect(reading.beneficiaries.filter((b) => b.protocol === "Hashi")).toEqual([expect.objectContaining({
      chain: null, chain_label: "Bitcoin Signet", account: null,
      address: "tb1qes3z5fu0f436wmr06svkxsk0h0pacv9vcsn3m7",
      address_raw: "zCIqJ49NY6dsb9QZY0LPu8PcMKw=", amount: "101411668",
    })]);
  });

  it("reports a confirmed mint as inbound without an outbound beneficiary", () => {
    // testnet 3omHBika6m1afTvGZ7Q5KwXfTqgJA6HkQcM7nsMyHJts
    const minted = event(`treasury::Minted<${pkg}::btc::BTC>`, { amount: "100117826" });
    expect(runWithNetwork("testnet", () => readBridgeEvents([confirmedDeposit], false)).hashiInbound).toEqual([]);
    const reading = runWithNetwork("testnet", () => readBridgeEvents([minted, confirmedDeposit], false));
    expect(reading.hashiWithdrawals).toEqual([]);
    expect(reading.hashiInbound).toEqual([expect.objectContaining({
      direction: "inbound", amount_sats: "100117826",
      bitcoin_txid: "0xf45aad1ab19c999535884081c17e265e8e122b09d81c06bb205bc7c9f2cfb017",
      sui_recipient: "0x5469cba4fb40675770a78e345a92595e1a3ab9b1514d0f050966038849fdb743",
    })]);
    expect(reading.beneficiaries).toEqual([]);
  });

  it("ignores malformed requests, unrelated events, change outputs and unsupported witness programs", () => {
    const request = event("withdrawal_queue::WithdrawalRequested", {
      btc_amount: "100101037", bitcoin_address: "ytZRXj/kJ6nBca6fWUF+BLmrKxhJgxfR+RF51GCpYzE=",
    });
    const reading = runWithNetwork("testnet", () => readBridgeEvents([
      request,
      event("withdrawal_queue::WithdrawalPickedForProcessing", committed.contents!.json, "0x1234"),
      event("deposit::DepositConfirmed", confirmedDeposit.contents!.json, "0x1234"),
    ], false));
    expect(reading.hashiWithdrawals).toEqual([]);
    expect(reading.hashiInbound).toEqual([]);
    expect(reading.beneficiaries).toEqual([]);
    expect(bitcoinWitnessAddress("AA==", "mainnet")).toBeNull();
    expect(bitcoinWitnessAddress("!!", "testnet")).toBeNull();
    // BIP350 valid P2TR witness-program vector.
    expect(bitcoinWitnessAddress(Buffer.from("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex").toString("base64"), "mainnet"))
      .toBe("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0");
    expect(bitcoinWitnessAddress("dR526BmRltRUlBxF0bOjI/FDO9Y=", "mainnet")).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  });
});

// testnet HVWncNgMVZwqR956nVsp3zan6PudMMTfWW9EJnCw9oK, the request the commitment above paid.
const REQUESTER = "0xa3fa9ca3014d07835ed2f6e7b74246f83c9d426d0186dc8dd33d368f924af48f";
const REQUEST_ID = "0xbb504a6bda48060dc5b34e4da29c75d6074df27b3ec86131355f8f5dff551447";
const requested = event("withdrawal_queue::WithdrawalRequested", {
  request_id: REQUEST_ID,
  btc_amount: "101412570",
  bitcoin_address: "zCIqJ49NY6dsb9QZY0LPu8PcMKw=",
  timestamp_ms: "1792471447746",
  requester_address: REQUESTER,
  sui_tx_digest: "BDmIiDO2dl7Tk4iLgwFwTv5dLugsYjuL8sYz7A4pxZ4=",
});
// testnet 4ahHNd8LuyYPJ8CucP7y5Quf5RQv8Di2LbFg7fd6TU3d
const cancelled = event("withdrawal_queue::WithdrawalCancelled", {
  request_id: "0xd77d19042e6b6db1ccda019809a219407fc8670ea6fbf5e3da9e663af9c4e79e",
  requester_address: "0xd85a6b45f455c658224d664e75909fb89e63b2be1a14f46a28b5dfd16158e344",
  btc_amount: "100520000",
});
const confirmedWithdrawal = event("withdrawal_queue::WithdrawalConfirmed", {
  withdrawal_txn_id: "0x427fc0d8fdf16df17175308f68dab9fb4ecff14b9e74997e2d47840c00a74ec1",
  txid: "0x27620d87a0673c7f86be0cf81571f0674cfeac8bc0d5c05c6185aff022a331d7",
  request_ids: [REQUEST_ID],
});
const tx = (digest: string, events: SuiEventNode[]) => ({ digest, events, eventsTruncated: false });

describe("Hashi withdrawal requests", () => {
  it("reads the requester's request as the exit and its destination as the beneficiary", () => {
    const reading = runWithNetwork("testnet", () => readBridgeEvents([requested], false));
    expect(reading.hashiRequests).toEqual([expect.objectContaining({
      status: "requested", request_id: REQUEST_ID, requester: REQUESTER, amount_sats: "101412570",
      bitcoin_address: "tb1qes3z5fu0f436wmr06svkxsk0h0pacv9vcsn3m7",
    })]);
    expect(reading.beneficiaries).toEqual([expect.objectContaining({
      protocol: "Hashi", source: "hashi-withdrawal-request", account: null, chain_label: "Bitcoin Signet",
      address: "tb1qes3z5fu0f436wmr06svkxsk0h0pacv9vcsn3m7", amount: "101412570",
    })]);
  });

  it("reads a cancellation as a refund with no beneficiary", () => {
    const reading = runWithNetwork("testnet", () => readBridgeEvents([cancelled], false));
    expect(reading.hashiCancellations).toEqual([expect.objectContaining({ direction: "refund", amount_sats: "100520000" })]);
    expect(reading.beneficiaries).toEqual([]);
  });

  it("files the request, not the operator's commitment, as the sender's exit", () => {
    const operator = "0x2c65bc963dde513dab1566dbec203373b59438ecf57086802a7d58a5d9645b71";
    const flowTx = (sender: string, digest: string, calls: FlowTx["calls"], eventTypes: string[], changes: FlowTx["changes"]): FlowTx => ({
      digest, timestamp: null, checkpoint: 1, sender, status: "success", gasSponsor: sender, netGas: 0n, changes, calls, eventTypes,
    });
    const commit = flowTx(operator, "6mnmYUk6", [{ packageId: pkg, module: "withdraw", function: "commit_withdrawal_tx" }],
      [committed.contents!.type!.repr], []);
    const request = flowTx(REQUESTER, "HVWncNgM", [{ packageId: pkg, module: "withdraw", function: "request_withdrawal" }],
      [requested.contents!.type!.repr], [{ owner: REQUESTER, coinType: `${pkg}::btc::BTC`, amount: -101412570n }]);
    runWithNetwork("testnet", () => {
      expect(readExit(operator, commit, [committed], false)).toBeNull();
      const exit = readExit(REQUESTER, request, [requested], false)!;
      expect(exit.bridge).toBe("Hashi");
      expect(exit.hashiRequestIds).toEqual([REQUEST_ID]);
      expect(exit.sent.get(`${pkg}::btc::BTC`)).toBe(101412570n);
      // A cancelled request stays listed but leaves every total.
      const [group] = groupExits([{ ...exit, cancelled: true }]);
      expect(group.cancelledDigests).toEqual(["HVWncNgM"]);
      expect(group.sent.size).toBe(0);
      expect(group.destinations[0].sent.size).toBe(0);
    });
  });
});

describe("hashiRequestState", () => {
  const state = (request: Lifecycle | null, record: Lifecycle | null = null) =>
    hashiRequestState(REQUEST_ID, request, record, "testnet");

  it("keeps an uncommitted request below chain-derived", () => {
    const s = state({ more: false, txs: [tx("HVWncNgM", [requested])] });
    expect(s).toMatchObject({ status: "requested", requester: REQUESTER, request_digest: "HVWncNgM", bitcoin_delivery: { evidence: "heuristic" } });
  });

  it("reports the committed Bitcoin transaction, then the committee's confirmation", () => {
    const life = { more: false, txs: [tx("HVWncNgM", [requested]), tx("6mnmYUk6", [committed])] };
    expect(state(life)).toMatchObject({
      status: "committed", commit_digest: "6mnmYUk6", output_sats: "101411668", lifecycle_incomplete: true,
      bitcoin_txid: "0xd731a322f0af85615cc0d5c08bacfe4c67f07115f80cbe867f3c67a0870d6227",
      bitcoin_delivery: { evidence: "chain-derived" },
    });
    const record = { more: false, txs: [tx("6mnmYUk6", [committed]), tx("GkFcUgwm", [confirmedWithdrawal])] };
    const s = state(life, record);
    expect(s).toMatchObject({ status: "confirmed", confirm_digest: "GkFcUgwm" });
    expect(s.lifecycle_incomplete).toBeUndefined();
  });

  it("reports a cancellation, and an unread lifecycle as unknown", () => {
    const cancelledState = hashiRequestState(
      "0xd77d19042e6b6db1ccda019809a219407fc8670ea6fbf5e3da9e663af9c4e79e",
      { more: false, txs: [tx("4ahHNd8L", [cancelled])] },
      null,
      "testnet",
    );
    expect(cancelledState).toMatchObject({ status: "cancelled", cancel_digest: "4ahHNd8L" });
    expect(state(null)).toMatchObject({ status: null, bitcoin_delivery: { evidence: null } });
    // A cancellation from another package's event is not this request's.
    const foreign = event("withdrawal_queue::WithdrawalCancelled", { ...cancelled.contents!.json as object, request_id: REQUEST_ID }, "0x1234");
    expect(state({ more: true, txs: [tx("HVWncNgM", [requested, foreign])] })).toMatchObject({ status: "requested", lifecycle_incomplete: true });
  });
});
