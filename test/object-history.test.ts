import { describe, it, expect } from "vitest";
import { computeOwnerChanges, ownerDesc, ownerKey, type VersionEntry } from "../src/utils/object-history.js";

function v(version: string, owner: VersionEntry["owner"]): VersionEntry {
  return { version, tx: `tx${version}`, timestamp: `t${version}`, checkpoint: version, owner };
}
const addr = (a: string) => ({ kind: "address" as const, address: a });

describe("ownerDesc", () => {
  it("maps GraphQL owner unions", () => {
    expect(ownerDesc({ __typename: "AddressOwner", address: { address: "0x1" } })).toEqual({ kind: "address", address: "0x1" });
    expect(ownerDesc({ __typename: "Shared" })).toEqual({ kind: "shared" });
    expect(ownerDesc({ __typename: "Immutable" })).toEqual({ kind: "immutable" });
    expect(ownerDesc(null)).toEqual({ kind: "unknown" });
  });
});

describe("ownerKey", () => {
  it("distinguishes address owners by address", () => {
    expect(ownerKey(addr("0x1"))).not.toBe(ownerKey(addr("0x2")));
    expect(ownerKey({ kind: "shared" })).toBe("shared");
  });
});

describe("computeOwnerChanges", () => {
  it("returns no changes when the owner is stable", () => {
    expect(computeOwnerChanges([v("1", addr("0xa")), v("2", addr("0xa")), v("3", addr("0xa"))])).toEqual([]);
  });

  it("detects a transfer between addresses", () => {
    const changes = computeOwnerChanges([v("1", addr("0xa")), v("2", addr("0xb"))]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: addr("0xa"), to: addr("0xb"), at_version: "2", tx: "tx2" });
  });

  it("detects address -> shared (an object being shared)", () => {
    const changes = computeOwnerChanges([v("1", addr("0xa")), v("2", { kind: "shared" })]);
    expect(changes).toHaveLength(1);
    expect(changes[0].to).toEqual({ kind: "shared" });
  });

  it("captures multiple hops in order", () => {
    const changes = computeOwnerChanges([
      v("1", addr("0xa")),
      v("2", addr("0xa")),
      v("3", addr("0xb")),
      v("4", addr("0xc")),
    ]);
    expect(changes.map((c) => c.at_version)).toEqual(["3", "4"]);
  });
});
