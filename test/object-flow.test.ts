import { describe, it, expect } from "vitest";
import {
  categorize,
  isHighConsequence,
  readOwner,
  readObjectMovements,
  transfersBetweenAddresses,
  summarizeObjectFlow,
  HIGH_CONSEQUENCE_TYPES,
  type GqlObjectChange,
} from "../src/utils/object-flow.js";

const A = "0xaa";
const B = "0xbb";
const addrOwner = (a: string) => ({ __typename: "AddressOwner", address: { address: a } });
const state = (type: string | null, owner: unknown) => ({
  asMoveObject: type ? { contents: { type: { repr: type } } } : null,
  owner: owner as never,
});

/** An object moving from `A` to `B`. */
const moved = (id: string, type: string): GqlObjectChange => ({
  address: id,
  idCreated: false,
  idDeleted: false,
  inputState: state(type, addrOwner(A)),
  outputState: state(type, addrOwner(B)),
});

describe("categorize", () => {
  it("treats Coin<T> as a coin, whatever the generic", () => {
    expect(categorize("0x2::coin::Coin<0x2::sui::SUI>")).toBe("coin");
    expect(categorize("0x2::coin::Coin<0xdeadbeef::usdc::USDC>")).toBe("coin");
  });

  it("recognises the framework capabilities", () => {
    expect(categorize("0x2::package::UpgradeCap")).toBe("capability");
    expect(categorize("0x2::coin::TreasuryCap<0x2::sui::SUI>")).toBe("capability");
    expect(categorize("0x2::package::Publisher")).toBe("capability");
  });

  it("recognises a protocol's own admin cap by name", () => {
    // The package id is arbitrary here, which is why matching is on the
    // module::Name suffix rather than the full type.
    expect(categorize("0xfeed::vault::AdminCap")).toBe("capability");
    expect(categorize("0xfeed::pool::OwnerCapability")).toBe("capability");
  });

  it("classifies kiosks and ordinary assets apart", () => {
    expect(categorize("0x2::kiosk::Kiosk")).toBe("kiosk");
    expect(categorize("0xabc::hero::Hero")).toBe("asset");
  });

  it("says unknown rather than guessing when the type is unreadable", () => {
    expect(categorize(null)).toBe("unknown");
  });
});

describe("isHighConsequence", () => {
  /**
   * The distinction the output rests on: every entry here means the holder can
   * change what a package does, mint supply, or freeze someone. A protocol's
   * own `AdminCap` is a capability but not one whose powers we can state, so it
   * is reported without the claim.
   */
  it("covers exactly the framework types whose powers are known", () => {
    expect(Object.keys(HIGH_CONSEQUENCE_TYPES).sort()).toEqual([
      "coin::DenyCap",
      "coin::TreasuryCap",
      "package::Publisher",
      "package::UpgradeCap",
    ]);
  });

  it("is true for a TreasuryCap regardless of its generic", () => {
    expect(isHighConsequence("0x2::coin::TreasuryCap<0xfeed::tok::TOK>")).toBe(true);
  });

  it("is false for an unknown protocol cap, which is still a capability", () => {
    expect(isHighConsequence("0xfeed::vault::AdminCap")).toBe(false);
    expect(categorize("0xfeed::vault::AdminCap")).toBe("capability");
  });
});

describe("readOwner", () => {
  it("distinguishes every owner kind Sui has", () => {
    expect(readOwner(addrOwner(A))).toEqual({ kind: "address", address: A });
    expect(readOwner({ __typename: "ObjectOwner", address: { address: "0xpar" } }))
      .toEqual({ kind: "object", address: "0xpar" });
    expect(readOwner({ __typename: "Shared" })).toEqual({ kind: "shared", address: null });
    expect(readOwner({ __typename: "Immutable" })).toEqual({ kind: "immutable", address: null });
    expect(readOwner(null)).toBeNull();
  });
});

describe("readObjectMovements", () => {
  it("excludes Coin<T>, which the balance changes already state", () => {
    // Double-reporting would inflate exactly the case the trace handles well.
    const changes = [moved("0x1", "0x2::coin::Coin<0x2::sui::SUI>"), moved("0x2", "0xabc::hero::Hero")];
    const out = readObjectMovements(changes);
    expect(out).toHaveLength(1);
    expect(out[0]!.type_short).toBe("hero::Hero");
  });

  it("excludes mutations, which are writes rather than changes of hands", () => {
    const mutate: GqlObjectChange = {
      address: "0x9",
      inputState: state("0xabc::pool::Pool", addrOwner(A)),
      outputState: state("0xabc::pool::Pool", addrOwner(A)),
    };
    expect(readObjectMovements([mutate])).toEqual([]);
  });

  it("reads a transfer, with both ends and the type", () => {
    const [m] = readObjectMovements([moved("0xcap", "0x2::package::UpgradeCap")]);
    expect(m).toMatchObject({
      object_id: "0xcap",
      type_short: "package::UpgradeCap",
      kind: "transferred",
      category: "capability",
      high_consequence: true,
    });
    expect(m!.from).toEqual({ kind: "address", address: A });
    expect(m!.to).toEqual({ kind: "address", address: B });
    expect(m!.note).toMatch(/publish new code/i);
  });

  it("labels creation, deletion, wrapping and unwrapping distinctly", () => {
    const t = "0xabc::hero::Hero";
    const kinds = readObjectMovements([
      { address: "0x1", idCreated: true, outputState: state(t, addrOwner(B)) },
      { address: "0x2", idDeleted: true, inputState: state(t, addrOwner(A)) },
      { address: "0x3", inputState: state(t, addrOwner(A)) },
      { address: "0x4", outputState: state(t, addrOwner(B)) },
    ]).map((m) => m.kind);
    expect(kinds).toEqual(["created", "deleted", "wrapped", "unwrapped"]);
  });

  it("survives a change with no readable type", () => {
    const [m] = readObjectMovements([
      { address: "0x1", inputState: state(null, addrOwner(A)), outputState: state(null, addrOwner(B)) },
    ]);
    expect(m!.category).toBe("unknown");
    expect(m!.high_consequence).toBe(false);
  });
});

describe("transfersBetweenAddresses", () => {
  it("keeps only address-to-address moves", () => {
    const shared: GqlObjectChange = {
      address: "0xs",
      inputState: state("0xabc::pool::Pool", addrOwner(A)),
      outputState: state("0xabc::pool::Pool", { __typename: "Shared" }),
    };
    const all = readObjectMovements([moved("0x1", "0xabc::hero::Hero"), shared]);
    expect(all).toHaveLength(2);
    expect(transfersBetweenAddresses(all).map((m) => m.object_id)).toEqual(["0x1"]);
  });

  it("ignores a move that lands on the same address", () => {
    const same: GqlObjectChange = {
      address: "0x1",
      inputState: state("0xabc::hero::Hero", addrOwner(A)),
      outputState: state("0xabc::hero::Hero", addrOwner(A)),
    };
    expect(transfersBetweenAddresses(readObjectMovements([same]))).toEqual([]);
  });
});

describe("summarizeObjectFlow", () => {
  it("is null when nothing moved, not an empty block", () => {
    expect(summarizeObjectFlow([])).toBeNull();
  });

  it("is null when objects changed but none changed hands", () => {
    const created = readObjectMovements([
      { address: "0x1", idCreated: true, outputState: state("0xabc::hero::Hero", addrOwner(B)) },
    ]);
    expect(created).toHaveLength(1);
    expect(summarizeObjectFlow(created)).toBeNull();
  });

  it("leads with authority when a capability moved", () => {
    const s = summarizeObjectFlow(readObjectMovements([moved("0xcap", "0x2::package::UpgradeCap")]))!;
    expect(s.capability_transfers).toHaveLength(1);
    expect(s.note).toMatch(/moves authority, not value/i);
    expect(s.note).toMatch(/invisible to fund tracing/i);
  });

  it("still reports an ordinary asset transfer, without the authority language", () => {
    const s = summarizeObjectFlow(readObjectMovements([moved("0x1", "0xabc::hero::Hero")]))!;
    expect(s.capability_transfers).toHaveLength(0);
    expect(s.note).toMatch(/produce no balance change/i);
    expect(s.note).not.toMatch(/authority/i);
  });
});
