import { describe, it, expect } from "vitest";
import {
  computeOwnerChanges,
  findOwnerTransitions,
  ownerDesc,
  ownerKey,
  type CheckpointState,
  type OwnerDesc,
  type VersionEntry,
} from "../src/utils/object-history.js";

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

  /** A party object (ConsensusAddressOwner) keeps its single owner. */
  it("keeps the single owner of a party object", () => {
    expect(ownerDesc({ __typename: "ConsensusAddressOwner", address: { address: "0xea55" } })).toEqual({
      kind: "consensus",
      address: "0xea55",
    });
  });

  /**
   * A kiosk-placed item's owner is an `ObjectOwner` (the kiosk's
   * `kiosk::Item` dynamic-field wrapper), which resolves to kind `object`.
   */
  it("resolves ObjectOwner to kind 'object', not 'unknown'", () => {
    expect(ownerDesc({ __typename: "ObjectOwner", address: { address: "0xf1e1d" } })).toEqual({
      kind: "object",
      address: "0xf1e1d",
    });
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

  it("sees a party transfer between two owners as a change of hands", () => {
    const party = (a: string) => ({ kind: "consensus" as const, address: a });
    const changes = computeOwnerChanges([v("1", addr("0xa")), v("2", party("0xa")), v("3", party("0xb"))]);
    expect(changes.map((c) => [c.from, c.to])).toEqual([
      [addr("0xa"), party("0xa")],
      [party("0xa"), party("0xb")],
    ]);
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

describe("findOwnerTransitions — checkpoint bisection for a busy object", () => {
  const addrState = (checkpoint: number, a: string): CheckpointState => ({ checkpoint, owner: addr(a) });

  it("finds nothing when the owner never changed", async () => {
    const fetch = async () => addr("0xa");
    const r = await findOwnerTransitions(addrState(0, "0xa"), addrState(1_000_000, "0xa"), fetch, { remaining: 100 });
    expect(r).toEqual({ transitions: [], truncated: false });
  });

  /**
   * An owner change buried deep inside a huge checkpoint range, surrounded
   * by thousands of same-owner mutations that bisection never has to read.
   * `owners.length` proves it: reaching one transition across a
   * 10-million-checkpoint range costs about log2(10e6), roughly 24 calls,
   * not 10 million.
   */
  it("finds one transition buried in a huge range without reading every checkpoint", async () => {
    const SWITCH = 6_700_211; // arbitrary, far from either end and off any round boundary
    const owners: OwnerDesc[] = [];
    const fetch = async (cp: number) => {
      owners.push(addr(cp >= SWITCH ? "0xb" : "0xa"));
      return owners[owners.length - 1];
    };
    const budget = { remaining: 100 };
    const r = await findOwnerTransitions(addrState(0, "0xa"), addrState(10_000_000, "0xb"), fetch, budget);
    expect(r.truncated).toBe(false);
    expect(r.transitions).toEqual([{ checkpoint: SWITCH, owner: addr("0xb") }]);
    expect(owners.length).toBeLessThan(30);
  });

  it("finds every transition, in order, across several owners", async () => {
    // 0xa until 100, 0xb until 300, 0xc from 300 on.
    const fetch = async (cp: number): Promise<OwnerDesc> =>
      cp < 100 ? addr("0xa") : cp < 300 ? addr("0xb") : addr("0xc");
    const r = await findOwnerTransitions(addrState(0, "0xa"), addrState(400, "0xc"), fetch, { remaining: 100 });
    expect(r.truncated).toBe(false);
    expect(r.transitions).toEqual([
      { checkpoint: 100, owner: addr("0xb") },
      { checkpoint: 300, owner: addr("0xc") },
    ]);
  });

  it("reports truncated rather than silently dropping a transition when the budget runs out", async () => {
    const fetch = async (cp: number): Promise<OwnerDesc> => (cp >= 500_000 ? addr("0xb") : addr("0xa"));
    const r = await findOwnerTransitions(addrState(0, "0xa"), addrState(1_000_000, "0xb"), fetch, { remaining: 1 });
    expect(r.truncated).toBe(true);
  });

  /**
   * `TRANSITION_BUDGET` caps call count, not time. These are sequential
   * network calls with no per-call deadline, so a slow endpoint can blow a
   * client's own deadline long before the call count does. `deadlineMs`
   * bounds wall-clock time the same way `remaining` bounds call count: past
   * it, the search stops splitting and reports truncated instead of losing
   * the whole trace.
   */
  it("stops at a wall-clock deadline the same way it stops at a call budget", async () => {
    const fetch = async (cp: number): Promise<OwnerDesc> => (cp >= 500_000 ? addr("0xb") : addr("0xa"));
    const r = await findOwnerTransitions(addrState(0, "0xa"), addrState(1_000_000, "0xb"), fetch, {
      remaining: 100,
      deadlineMs: Date.now() - 1, // already past
    });
    expect(r.truncated).toBe(true);
    expect(r.transitions).toEqual([]);
  });
});
