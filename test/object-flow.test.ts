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
   * A kiosk-held NFT is owned by the Kiosk object, so the ordinary NFT trade
   * is object -> object, and filtering to address-to-address would drop it.
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
   * Mainnet returns `inputState: null` for every change on old transactions,
   * not only genuine unwraps. Reading that as "unwrapped" and dropping it
   * loses every object transfer over the chain's first year, which is the era
   * a backward trace reaches.
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
   * Most UpgradeCap departures go to an unspendable address. Reporting those
   * as handovers would be wrong most of the time for the type that motivated
   * the feature.
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
   * For a digest the fullnode has pruned, the archive returns changedObjects
   * with objectType and both owners. This fixture has the shape mainnet
   * returns.
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
    // `movements` counts every movement read, so it can exceed
    // `transfers.length`.
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

describe("capability_transfers is not limited to curated framework types", () => {
  // `capability_transfers` covers every transfer with category
  // "capability", including a protocol-defined OperatorCap, rather than only
  // the five 0x2 types `high_consequence` marks.
  it("includes a protocol-defined Cap that is not one of the curated 0x2 types", () => {
    const m = readObjectMovements([moved("0xopcap", "0xvault::vault::OperatorCap")])[0]!;
    expect(m.category).toBe("capability");
    expect(m.high_consequence).toBe(false);
    const s = summarizeObjectFlow([m])!;
    expect(s.capability_transfers).toHaveLength(1);
    expect(s.capability_transfers[0]!.object_id).toBe("0xopcap");
    expect(s.note).toMatch(/carrying control changed hands/);
  });
});

describe("appeared is not custody unless it lands on a party", () => {
  /**
   * `appeared` means the previous holder was not recorded, which before
   * ~March 2024 is every change. Admitting all of them would report ordinary
   * shared-object traffic, such as a price-oracle update, as custody changes.
   */
  const appeared = (type: string, to: unknown): GqlObjectChange => ({
    address: "0x1",
    idCreated: false,
    idDeleted: false,
    inputState: null,
    outputState: state(type, to),
  });

  it("drops an unsourced object that is merely shared", () => {
    const m = readObjectMovements([appeared("0xpyth::price_info::PriceInfoObject", { __typename: "Shared" })]);
    expect(m[0]!.kind).toBe("appeared");
    expect(custodyChanges(m)).toEqual([]);
  });

  it("drops an unsourced object that is merely immutable", () => {
    const m = readObjectMovements([appeared("0xabc::cfg::Config", { __typename: "Immutable" })]);
    expect(custodyChanges(m)).toEqual([]);
  });

  it("keeps an unsourced object that lands on an address", () => {
    const m = readObjectMovements([appeared("0xabc::game::Game8192", addrOwner(B))]);
    expect(custodyChanges(m)).toHaveLength(1);
  });

  it("excludes dynamic fields outright — storage, not assets", () => {
    // Dynamic fields dominate object changes on older transactions.
    const m = readObjectMovements([
      appeared(`${P2}::dynamic_field::Field<u64,u8>`, objOwner("0xparent")),
    ]);
    expect(m).toEqual([]);
  });
});

describe("giving up a capability: who can use it afterwards", () => {
  const TREASURY = `${P2}::coin::TreasuryCap<0xa::t::T>`;
  const UPGRADE = `${P2}::package::UpgradeCap`;
  const ADMIN = "0xa::vault::AdminCap";
  const IMMUTABLE = { __typename: "Immutable" };
  const SHARED = { __typename: "Shared" };
  const to = (type: string, owner: unknown) => readObjectMovements([moved("0xcap", type, addrOwner(A), owner)])[0]!;
  // public_share_object only shares an object created in the same transaction.
  const createdShared = (type: string) =>
    readObjectMovements([{ address: "0xcap", idCreated: true, idDeleted: false, outputState: state(type, SHARED) }])[0]!;

  // authorize_upgrade and commit_upgrade take the cap by &mut, which a frozen
  // object cannot give.
  it("renounces an UpgradeCap by freezing it", () => {
    const flow = summarizeObjectFlow([to(UPGRADE, IMMUTABLE)])!;
    expect(flow.renounced_capabilities).toHaveLength(1);
    expect(flow.opened_capabilities).toHaveLength(0);
  });

  // coin::update_* and token::new_policy take a TreasuryCap by &, and most
  // custom checks take `_: &AdminCap`.
  it("opens a frozen TreasuryCap or custom cap to every transaction instead of renouncing it", () => {
    for (const type of [TREASURY, ADMIN]) {
      const flow = summarizeObjectFlow([to(type, IMMUTABLE)])!;
      expect(flow.renounced_capabilities).toHaveLength(0);
      expect(flow.opened_capabilities).toHaveLength(1);
      expect(flow.capability_transfers).toHaveLength(0);
    }
  });

  it("reports a capability shared at creation as opened to everyone", () => {
    const m = createdShared(TREASURY);
    expect(custodyChanges([m])).toHaveLength(1);
    const flow = summarizeObjectFlow([m])!;
    expect(flow.opened_capabilities).toHaveLength(1);
    expect(flow.renounced_capabilities).toHaveLength(0);
  });

  // display_registry::claim_with_publisher and coin::deny_list_v2_enable_global_pause
  // take the cap by &mut, so sharing opens them too.
  it("names every power a shared Publisher or DenyCapV2 opens", () => {
    expect(createdShared(`${P2}::package::Publisher`).note).toMatch(/display_registry::new_with_publisher and claim_with_publisher/);
    expect(createdShared(`${P2}::coin::DenyCapV2<0xa::t::T>`).note).toMatch(/deny_list_v2_enable_global_pause/);
  });

  it("still treats a transfer to a live address as a handover", () => {
    expect(summarizeObjectFlow([to(TREASURY, addrOwner(B))])!.capability_transfers).toHaveLength(1);
  });
});

describe("categorize — a capability is not the position it controls", () => {
  const reg = () => ({ name: "Suilend", type: "lending" });
  it("does not turn ObligationOwnerCap into a defi-position", () => {
    expect(categorize("0x5b54::lending_market::ObligationOwnerCap<0xa::b::C>", reg)).toBe("capability");
    expect(categorize("0xdee9::custodian_v2::AccountCap", reg)).toBe("capability");
  });
  it("does not promote framework types on a generic word", () => {
    expect(categorize(`${P2}::package::UpgradeTicket`, reg)).toBe("asset");
  });
  it("still promotes a real position", () => {
    expect(categorize("0xcetus::position::Position", reg)).toBe("defi-position");
  });
});

describe("gRPC classification honesty", () => {
  const base = {
    objectId: "0x1",
    objectType: `${P2}::package::UpgradeCap`,
    idOperation: 1,
  };

  it("does not call an ownerless change a transfer", () => {
    // Neither side names an owner: with nobody at either end, the change is
    // dropped rather than reported as a transfer.
    expect(readGrpcObjectChanges([{ ...base, inputState: 2 }])).toEqual([]);
  });

  it("trusts a given owner over the state enum", () => {
    const [m] = readGrpcObjectChanges([
      { ...base, inputState: 0, inputOwner: { kind: 1, address: A }, outputOwner: { kind: 1, address: B } },
    ]);
    expect(m!.kind).toBe("transferred");
    expect(m!.source_unrecorded).toBeUndefined();
    expect(m!.from).toEqual({ kind: "address", address: A });
  });
});

describe("objectCounterparties", () => {
  it("includes consensus owners, whose address the query now fetches", () => {
    const consensus = (a: string) => ({ __typename: "ConsensusAddressOwner", address: { address: a } });
    const m = readObjectMovements([moved("0x1", "0xabc::hero::Hero", consensus(A), consensus(B))]);
    expect(custodyChanges(m)).toHaveLength(1);
    expect(objectCounterparties(m).sort()).toEqual([A, B].sort());
  });

  it("excludes a burn address, which is nobody", () => {
    const burn = `0x${"0".repeat(64)}`;
    const m = readObjectMovements([moved("0xcap", `${P2}::package::UpgradeCap`, addrOwner(A), addrOwner(burn))]);
    expect(objectCounterparties(m)).toEqual([A]);
  });
});

describe("baseType — uppercase 0X", () => {
  it("pads it, so a real coin cannot escape the exclusion", () => {
    expect(categorize("0X2::coin::Coin")).toBe("coin");
  });
});
