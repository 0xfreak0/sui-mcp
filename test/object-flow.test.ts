import { describe, it, expect } from "vitest";
import {
  baseType,
  categorize,
  custodyChanges,
  isHighConsequence,
  objectCounterparties,
  readGrpcObjectChanges,
  readObjectMovements,
  readOwner,
  summarizeObjectFlow,
  HIGH_CONSEQUENCE_TYPES,
  type GqlObjectChange,
  type GrpcChangedObject,
} from "../src/utils/object-flow.js";

// Full-length addresses on purpose: a short one like `0xbb` is numerically
// below 0x100, which isUnspendableAddress correctly reads as a burn address.
const A = `0xaa${"1".repeat(62)}`;
const B = `0xbb${"2".repeat(62)}`;
const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
const addrOwner = (a: string) => ({ __typename: "AddressOwner", address: { address: a } });
const objOwner = (a: string) => ({ __typename: "ObjectOwner", address: { address: a } });
const state = (type: string | null, owner: unknown) => ({
  asMoveObject: type ? { contents: { type: { repr: type } } } : null,
  owner: owner as never,
});
const moved = (id: string, type: string, from: unknown = addrOwner(A), to: unknown = addrOwner(B)): GqlObjectChange => ({
  address: id,
  idCreated: false,
  idDeleted: false,
  inputState: state(type, from),
  outputState: state(type, to),
});

describe("baseType — both address spellings must meet", () => {
  /** The chain reports padded; fixtures and callers write short. Pinning a
   *  framework type in full is worthless if the two never match. */
  it("pads the defining address and strips generics", () => {
    expect(baseType("0x2::coin::Coin<0x2::sui::SUI>")).toBe(`${P2}::coin::Coin`);
    expect(baseType(`${P2}::package::UpgradeCap`)).toBe(`${P2}::package::UpgradeCap`);
  });
  it("leaves a non-address-prefixed type alone", () => {
    expect(baseType("weird::Thing")).toBe("weird::Thing");
  });
});

describe("categorize — framework types are matched in FULL", () => {
  /**
   * Suffix matching would hand an airdropped fake the loudest output the tool
   * has. `capabilities.ts` already pins 0x2 types in full; this follows it.
   */
  it("does NOT treat another package's UpgradeCap as high-consequence", () => {
    expect(categorize("0xbad::package::UpgradeCap")).toBe("capability");
    expect(isHighConsequence("0xbad::package::UpgradeCap")).toBe(false);
    expect(isHighConsequence("0x2::package::UpgradeCap")).toBe(true);
  });

  /**
   * The mirror, and the worse one: naming a module `coin` and a struct `Coin`
   * would get an object EXCLUDED as "already a balance change" while producing
   * no balance change either — invisible in both channels.
   */
  it("does NOT treat another package's coin::Coin as a coin", () => {
    expect(categorize("0xevil::coin::Coin")).toBe("asset");
    expect(categorize("0x2::coin::Coin<0x2::sui::SUI>")).toBe("coin");
  });

  it("covers DenyCapV2, which is the type regulated coins actually use", () => {
    expect(isHighConsequence("0x2::coin::DenyCapV2<0xa::usdc::USDC>")).toBe(true);
    expect(isHighConsequence("0x2::coin::DenyCap<0xa::usdc::USDC>")).toBe(true);
  });

  it("states powers for exactly the five framework types", () => {
    expect(Object.keys(HIGH_CONSEQUENCE_TYPES).map((k) => k.split("::").slice(1).join("::")).sort())
      .toEqual(["coin::DenyCap", "coin::DenyCapV2", "coin::TreasuryCap", "package::Publisher", "package::UpgradeCap"]);
  });

  it("still calls an unknown protocol cap a capability, without claiming powers", () => {
    expect(categorize("0xfeed::vault::AdminCap")).toBe("capability");
    expect(isHighConsequence("0xfeed::vault::AdminCap")).toBe(false);
  });

  /**
   * A name proves nothing; a name on a package the registry vouches for does.
   * Without the resolver these stay ordinary assets rather than being guessed
   * into positions.
   */
  it("promotes a position type to defi-position only via the registry", () => {
    const t = "0xcetus::position::Position";
    expect(categorize(t)).toBe("asset");
    expect(categorize(t, () => ({ name: "Cetus", type: "dex" }))).toBe("defi-position");
  });

  it("does not promote a non-position type just because the package is known", () => {
    expect(categorize("0xcetus::art::Picture", () => ({ name: "Cetus" }))).toBe("asset");
  });
});

describe("readOwner — every owner kind, including the one the query forgot", () => {
  it("reads all five", () => {
    expect(readOwner(addrOwner(A))).toEqual({ kind: "address", address: A });
    expect(readOwner(objOwner("0xpar"))).toEqual({ kind: "object", address: "0xpar" });
    expect(readOwner({ __typename: "Shared" })).toEqual({ kind: "shared", address: null });
    expect(readOwner({ __typename: "Immutable" })).toEqual({ kind: "immutable", address: null });
    expect(readOwner({ __typename: "ConsensusAddressOwner", address: { address: A } }))
      .toEqual({ kind: "consensus", address: A });
  });
});

describe("custody is not only address-to-address", () => {
  /**
   * Measured against four real mainnet wallets: filtering to address-to-address
   * missed 10 of 28 genuine transfers, all of them kiosk. A kiosk-held NFT is
   * owned by the Kiosk object, so the ordinary NFT trade is object -> object.
   */
  it("keeps kiosk-to-kiosk moves", () => {
    const m = readObjectMovements([moved("0x1", "0xabc::hero::Hero", objOwner("0xk1"), objOwner("0xk2"))]);
    expect(custodyChanges(m)).toHaveLength(1);
  });

  it("keeps a withdrawal out of a kiosk to a wallet", () => {
    const m = readObjectMovements([moved("0x1", "0xabc::hero::Hero", objOwner("0xk1"), addrOwner(B))]);
    expect(custodyChanges(m)).toHaveLength(1);
  });

  it("still drops a move that lands where it started", () => {
    const m = readObjectMovements([moved("0x1", "0xabc::hero::Hero", addrOwner(A), addrOwner(A))]);
    expect(custodyChanges(m)).toEqual([]);
  });

  it("names only real addresses as counterparties, never parent objects", () => {
    const m = readObjectMovements([
      moved("0x1", "0xabc::hero::Hero", addrOwner(A), objOwner("0xkiosk")),
      moved("0x2", "0xabc::hero::Hero", objOwner("0xkiosk"), addrOwner(B)),
    ]);
    expect(objectCounterparties(m).sort()).toEqual([A, B]);
  });
});

describe("pre-2024 effects do not record the input owner", () => {
  /**
   * Mainnet returns `inputState: null` for EVERY change on old transactions —
   * 117 of 117 non-created changes at checkpoint 20,000,000, not just genuine
   * unwraps. Reading that as "unwrapped" and dropping it loses every object
   * transfer over the chain's first year, which is the era a backward trace
   * reaches.
   */
  const old: GqlObjectChange = {
    address: "0xcap",
    idCreated: false,
    idDeleted: false,
    inputState: null,
    outputState: state("0x2::package::UpgradeCap", addrOwner(B)),
  };

  it("reports it rather than dropping it", () => {
    const [m] = readObjectMovements([old]);
    expect(m!.kind).toBe("appeared");
    expect(custodyChanges([m!])).toHaveLength(1);
  });

  it("says outright that the previous holder is not knowable", () => {
    const [m] = readObjectMovements([old]);
    expect(m!.source_unrecorded).toBe(true);
    expect(m!.note).toMatch(/did not record who held this/i);
    expect(m!.from).toBeNull();
  });
});

describe("renouncing is not handing over", () => {
  /**
   * upgrade-cap.ts measured 27 of 30 UpgradeCap departures going to an
   * unspendable address. Reporting those as handovers would make the loudest
   * output wrong most of the time for the type that motivated the feature.
   */
  const burn = (to: string) =>
    readObjectMovements([moved("0xcap", "0x2::package::UpgradeCap", addrOwner(A), addrOwner(to))])[0]!;

  it("flags a cap sent to 0x0 as renounced", () => {
    const m = burn("0x0000000000000000000000000000000000000000000000000000000000000000");
    expect(m.renounced).toBe(true);
    expect(m.note).toMatch(/RENOUNCED, not transferred/);
    expect(m.note).toMatch(/reduction in risk/i);
  });

  it("does not flag a transfer to a live address", () => {
    expect(burn(B).renounced).toBeUndefined();
  });

  it("keeps renunciations out of capability_transfers", () => {
    const m = burn("0x0000000000000000000000000000000000000000000000000000000000000000");
    const s = summarizeObjectFlow([m])!;
    expect(s.capability_transfers).toHaveLength(0);
    expect(s.renounced_capabilities).toHaveLength(1);
    expect(s.note).not.toMatch(/Follow the recipient/);
  });
});

describe("readGrpcObjectChanges — the archive CAN report object changes", () => {
  /**
   * An earlier version claimed it could not and disclaimed object flow on
   * every archive hop. Verified false: for a digest the fullnode has pruned,
   * the archive returns changedObjects with objectType and both owners. This
   * is the shape mainnet actually returned.
   */
  const real: GrpcChangedObject = {
    objectId: "0x00055d67",
    objectType: `${P2}::package::UpgradeCap`,
    inputState: 2, // EXISTS
    idOperation: 1, // NONE
    inputOwner: { kind: 1, address: A },
    outputOwner: { kind: 1, address: B },
  };

  it("reads a capability transfer with both owners", () => {
    const [m] = readGrpcObjectChanges([real]);
    expect(m).toMatchObject({ kind: "transferred", high_consequence: true });
    expect(m!.from).toEqual({ kind: "address", address: A });
    expect(m!.to).toEqual({ kind: "address", address: B });
  });

  it("excludes Coin<T> here too", () => {
    expect(readGrpcObjectChanges([{ ...real, objectType: `${P2}::coin::Coin<${P2}::sui::SUI>` }])).toEqual([]);
  });

  /**
   * gRPC states whether an input existed, so unlike GraphQL it can tell a
   * genuine unwrap from an unrecorded owner.
   */
  it("calls a genuinely absent input an unwrap, not an unknown", () => {
    const [m] = readGrpcObjectChanges([{ ...real, inputState: 1, inputOwner: null }]);
    expect(m!.kind).toBe("unwrapped");
    expect(m!.source_unrecorded).toBeUndefined();
  });

  it("calls an existing input with no recorded owner 'appeared'", () => {
    const [m] = readGrpcObjectChanges([{ ...real, inputState: 2, inputOwner: null }]);
    expect(m!.kind).toBe("appeared");
    expect(m!.source_unrecorded).toBe(true);
  });

  it("maps every owner kind number", () => {
    // Destination address differs from the source, or an unchanged owner is
    // correctly classified as a mutation and dropped.
    const k = (n: number) => readGrpcObjectChanges([{ ...real, outputOwner: { kind: n, address: B } }])[0]!.to!.kind;
    expect([k(1), k(2), k(3), k(4), k(5)]).toEqual(["address", "object", "shared", "immutable", "consensus"]);
  });
});

describe("classifyKind edge cases", () => {
  it("prefers deleted over created on a contradictory entry", () => {
    const [m] = readObjectMovements([
      { address: "0x1", idCreated: true, idDeleted: true, inputState: state("0xa::b::C", addrOwner(A)) },
    ]);
    expect(m!.kind).toBe("deleted");
  });
  it("labels creation and wrapping", () => {
    const kinds = readObjectMovements([
      { address: "0x1", idCreated: true, outputState: state("0xa::b::C", addrOwner(B)) },
      { address: "0x2", inputState: state("0xa::b::C", addrOwner(A)) },
    ]).map((m) => m.kind);
    expect(kinds).toEqual(["created", "wrapped"]);
  });
});

describe("summarizeObjectFlow", () => {
  it("counts every movement, not only the transfers", () => {
    // The old version was fed a pre-filtered list, so `movements` could only
    // ever equal `transfers.length` — the field described something it never
    // measured.
    const m = readObjectMovements([
      { address: "0x1", idCreated: true, outputState: state("0xa::b::C", addrOwner(B)) },
      moved("0x2", "0xa::b::C"),
    ]);
    const s = summarizeObjectFlow(m)!;
    expect(s.movements).toBe(2);
    expect(s.transfers).toHaveLength(1);
  });

  it("is null when nothing changed hands", () => {
    const created = readObjectMovements([
      { address: "0x1", idCreated: true, outputState: state("0xa::b::C", addrOwner(B)) },
    ]);
    expect(summarizeObjectFlow(created)).toBeNull();
  });

  it("still reports when the only thing to say is that the read was truncated", () => {
    const s = summarizeObjectFlow([], { truncated: true })!;
    expect(s.truncated).toBe(true);
    expect(s.note).toMatch(/not evidence it did not happen/i);
  });
});
