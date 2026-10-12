import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkLabelFile } from "../scripts/lib/label-file-check.mjs";

const source = { id: "issuer", source_url: "https://issuer.example/addresses", count: 1 };
const address = `sui:mainnet:0x${"a".repeat(64)}`;
const label = {
  label: "Verified deployment", category: "bridge", source_id: "issuer",
  source_url: source.source_url, retrieved_at: "2026-10-06", evidence: "official-docs",
};
const disclosed = { sources: [source], labels: { [address]: label } };

describe("attribution file admission", () => {
  it("refuses chain-ambiguous and cross-network accounts, rather than mapping them to Sui mainnet", () => {
    expect(() => checkLabelFile({ ...disclosed, labels: { [`eip155:1:0x${"a".repeat(64)}`]: label } }, "disclosed-labels.json")).toThrow();
    expect(() => checkLabelFile({ ...disclosed, labels: { [`sui:testnet:0x${"a".repeat(64)}`]: label } }, "disclosed-labels.json")).toThrow();
  });

  it("refuses unattributed labels and invalid source URLs before they can change trace stops", () => {
    expect(() => checkLabelFile({ ...disclosed, labels: { [address]: { ...label, source_id: "unknown" } } }, "disclosed-labels.json")).toThrow();
    expect(() => checkLabelFile({ ...disclosed, labels: { [address]: { ...label, source_url: "http://issuer.example" } } }, "disclosed-labels.json")).toThrow();
  });

  it("rejects a source inventory that claims more addresses than the stored rows", () => {
    expect(() => checkLabelFile({ ...disclosed, sources: [{ ...source, count: 2 }] }, "disclosed-labels.json")).toThrow(/count does not match/);
  });

  it("refuses a validator holder assertion without a verified direct-owner state", () => {
    const state = { epoch: 12, checkpoint: 45, object_id: `0x${"0".repeat(63)}5`, operation_cap_holder: address.slice("sui:mainnet:".length), operation_cap_holder_status: "object_owned_holder_unproven" };
    const snapshot = { epoch: 12, sources: [{ ...source, epoch: 12 }], labels: { [address]: { ...label, category: "validator", evidence: "chain-state", chain_state: state } } };
    expect(() => checkLabelFile(snapshot, "validator-labels.json")).toThrow();
    expect(checkLabelFile({ ...snapshot, labels: { [address]: { ...snapshot.labels[address], chain_state: { ...state, operation_cap_holder_status: "direct_owner" } } } }, "validator-labels.json")).toBe(1);
  });

  // The weekly data-sync job opens its PR only after the test suite passes, so
  // this is what stops a sync that wrote an inadmissible row from shipping.
  it.each(["disclosed-labels.json", "validator-labels.json"])("admits the shipped %s", (name) => {
    const file = JSON.parse(readFileSync(new URL(`../src/data/${name}`, import.meta.url), "utf8"));
    expect(checkLabelFile(file, name)).toBe(Object.keys(file.labels).length);
  });
});
