import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeStructTag } from "@mysten/sui/utils";
import { createMockClient } from "./helpers/mock-grpc.js";
import type { HistoricalPrices } from "../src/utils/valuation.js";

const mockSui = createMockClient();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
const gqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: (q: string, v: unknown) => gqlQuery(q, v) }));
const priceCoinTypes = vi.fn<(types: string[]) => Promise<HistoricalPrices>>();
vi.mock("../src/utils/valuers/common.js", async (orig) => ({
  ...(await orig<typeof import("../src/utils/valuers/common.js")>()),
  priceCoinTypes: (types: string[]) => priceCoinTypes(types),
}));
// Only the reader under test and the synthetic specific readers below.
vi.mock("../src/utils/valuers/index.js", () => ({}));

// Imported after the mocks above, whose factories close over these fixtures.
const { registerValuer, valuePositions } = await import("../src/utils/position-value.js");
const { heldWalk, HELD_BALANCES } = await import("../src/utils/valuers/held-balances.js");
const { ownedCoverage } = await import("../src/utils/owned-coverage.js");
const { operatedSharedObjects } = await import("../src/utils/operated-objects.js");

const hex = (c: string) => `0x${c.repeat(64)}`;
const OWNER = hex("a");
const OTHER = hex("b");
const USDC = `${hex("c")}::usdc::USDC`;
const LP = `${hex("d")}::lp::LP`;
const PKG = hex("e");
const POSITION = `${PKG}::position::Position`;
const WRAPPER = `${PKG}::farm::Wrapped`;
const HOLDER = `${PKG}::vault::Holder`;
const NFT = `${hex("f")}::nft::Art`;
const COIN = (t: string) => `0x2::coin::Coin<${t}>`;
const TABLE = `0x2::object_table::ObjectTable<0x1::string::String, ${COIN(USDC)}>`;
const KIOSK_CAP = "0x2::kiosk::KioskOwnerCap";
const n = (t: string) => normalizeStructTag(t);

const UID = { struct: { type: n("0x2::object::UID"), fields: [{ name: "id", layout: { struct: { type: n("0x2::object::ID"), fields: [{ name: "bytes", layout: "address" }] } } }] } };
const struct = (type: string, fields: Array<[string, unknown]>) => ({ struct: { type: n(type), fields: fields.map(([name, layout]) => ({ name, layout })) } });
const LAYOUTS: Record<string, unknown> = {
  [n(TABLE)]: struct(TABLE, [["id", UID], ["size", "u64"]]),
  [n(POSITION)]: struct(POSITION, [["id", UID], ["liquidity", "u128"]]),
  [n(WRAPPER)]: struct(WRAPPER, [["id", UID], ["position", struct(POSITION, [["id", UID], ["liquidity", "u128"]])]]),
  [n(HOLDER)]: struct(HOLDER, [["id", UID], ["lp", struct(`0x2::balance::Balance<${LP}>`, [["value", "u64"]])], ["cash", struct(`0x2::balance::Balance<${USDC}>`, [["value", "u64"]])]]),
};

type Owned = { objectId: string; version: string; type: string; json: Record<string, unknown> };
let owned: Owned[] = [];
let entries: Record<string, Array<Record<string, unknown>>> = {};
let layoutAsks: string[] = [];

function serve(q: string, v: Record<string, unknown>): unknown {
  if (q.includes("{ layout }")) {
    const out: Record<string, unknown> = {};
    for (const [k, t] of Object.entries(v)) {
      layoutAsks.push(String(t));
      out[k] = LAYOUTS[String(t)] ? { layout: LAYOUTS[String(t)] } : null;
    }
    return out;
  }
  const page = (id: string) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes: (entries[id] ?? []).map((value) => ({ value })) });
  if ("id" in v) return { address: { dynamicFields: page(String(v.id)) } };
  // Many objects' own fields in one request, aliased o0, o1, ...
  return Object.fromEntries(Object.entries(v).map(([k, id]) => [k.replace("a", "o"), { dynamicFields: page(String(id)) }]));
}

function prices(entries: Array<[string, number]>): HistoricalPrices {
  return { points: new Map(entries.map(([t, price]) => [t, { price, publishTime: 1_700_000_000, source: "pyth" as const }])), unpriced: [] };
}

// A specific reader for the synthetic position and LP coin types.
registerValuer({
  name: "fake_positions",
  value: async () => ({ positions: [], unread: [] }),
  handles: (type) => n(type) === n(POSITION) || n(type) === n(COIN(LP)),
  valueObject: async (obj) => ({
    positions: [{ protocol: "Fake", kind: "clmm", object_id: obj.object_id, assets: [], usd_net: 7, method: `read ${obj.type}`, tier: "price-provider" }],
    unread: [],
  }),
});

// A specific reader for a synthetic lending cap: $10 supplied, $8 borrowed.
const LENDING_CAP = `${PKG}::lending::Cap`;
registerValuer({
  name: "fake_lending",
  value: async () => ({ positions: [], unread: [] }),
  handles: (type) => n(type) === n(LENDING_CAP),
  valueObject: async (obj) => ({
    positions: [
      {
        protocol: "FakeLend",
        kind: "lending",
        object_id: obj.object_id,
        assets: [
          { coin_type: n(USDC), amount: "10000000", side: "supply", usd: 10 },
          { coin_type: n(USDC), amount: "8000000", side: "borrow", usd: 8 },
        ],
        usd_net: 2,
        method: "synthetic",
        tier: "price-provider",
      },
    ],
    unread: [],
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  owned = [];
  entries = {};
  layoutAsks = [];
  gqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => serve(q, v));
  mockSui.listOwnedObjects.mockImplementation(async () => ({ objects: owned, hasNextPage: false, cursor: null }));
  priceCoinTypes.mockImplementation(async () => prices([[n(USDC), 1]]));
});

const value = async () => {
  const ctx = { owner: OWNER, memo: new Map<string, Promise<unknown>>() };
  const r = await valuePositions(ctx, [HELD_BALANCES, "fake_positions"]);
  return { ...r, walk: await heldWalk(ctx)! };
};

describe("balances held inside owned objects", () => {
  it("values an owned table of coins at its entries, read once", async () => {
    const table = hex("1");
    owned = [{ objectId: table, version: "1", type: TABLE, json: { id: table, size: "1" } }];
    entries[table] = [{ __typename: "MoveObject", address: hex("2"), contents: { type: { repr: n(COIN(USDC)) }, json: { id: hex("2"), balance: "5000000" } } }];
    const { positions } = await value();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ kind: "vault", object_id: table, protocol: null });
    // The table's entries are its own dynamic fields: read twice they would double the amount.
    expect(positions[0].assets).toEqual([expect.objectContaining({ amount: "5000000" })]);
  });

  it("values a position it wraps by that position's reader and says where it is held", async () => {
    const wrapper = hex("3");
    const inner = hex("4");
    owned = [{ objectId: wrapper, version: "1", type: WRAPPER, json: { id: wrapper, position: { id: inner, liquidity: "9" } } }];
    const { positions } = await value();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ protocol: "Fake", object_id: inner, usd_net: 7 });
    expect(positions[0].detail?.held_in).toEqual({ object_id: wrapper, type: WRAPPER });
    expect(positions[0].method).toMatch(/^Held inside /);
  });

  it("gives a balance of a coin a reader values to that reader, and prices the rest", async () => {
    const holder = hex("5");
    owned = [{ objectId: holder, version: "1", type: HOLDER, json: { id: holder, lp: "100", cash: "2000000" } }];
    const { positions } = await value();
    const lp = positions.find((p) => p.protocol === "Fake");
    const cash = positions.find((p) => p.kind === "vault");
    expect(lp?.object_id).toBe(holder);
    expect(cash?.assets.map((a) => a.amount)).toEqual(["2000000"]);
  });

  it("leaves a type a specific reader owns to it, and reads no layout for JSON that cannot hold a coin", async () => {
    owned = [
      { objectId: hex("6"), version: "1", type: POSITION, json: { id: hex("6"), liquidity: "1" } },
      { objectId: hex("7"), version: "1", type: NFT, json: { id: hex("7"), name: "art", url: "https://example.invalid/a.png" } },
    ];
    const { positions } = await value();
    expect(positions).toEqual([]);
    expect(layoutAsks.map((t) => t.toLowerCase())).not.toContain(n(NFT).toLowerCase());
  });
});

describe("coverage of owned objects", () => {
  it("counts every owned object once: read by a reader, a kiosk key, or not recognised by type", async () => {
    const table = hex("1");
    owned = [
      { objectId: table, version: "1", type: TABLE, json: { id: table, size: "1" } },
      { objectId: hex("6"), version: "1", type: POSITION, json: { id: hex("6"), liquidity: "1" } },
      { objectId: hex("8"), version: "1", type: KIOSK_CAP, json: { id: hex("8"), for: hex("9") } },
      { objectId: hex("7"), version: "1", type: NFT, json: { id: hex("7"), name: "a" } },
      { objectId: hex("0"), version: "1", type: NFT, json: { id: hex("0"), name: "b" } },
      { objectId: hex("2"), version: "1", type: COIN(USDC), json: { id: hex("2"), balance: "1" } },
    ];
    entries[table] = [{ __typename: "MoveObject", address: hex("2"), contents: { type: { repr: n(COIN(USDC)) }, json: { id: hex("2"), balance: "5" } } }];
    const { positions, unread, walk } = await value();
    const c = ownedCoverage(walk, positions, unread, false);
    expect(c.owned_objects).toBe(5);
    expect(c.read_by).toEqual({ [HELD_BALANCES]: 1, fake_positions: 1 });
    expect(c.kiosk_keys).toBe(1);
    expect(c.not_recognised).toBe(2);
    expect(c.not_recognised_types).toEqual([{ type: NFT, count: 2, object_ids: [hex("7"), hex("0")] }]);
    expect(c.note).toMatch(/2 object\(s\) of 1 type\(s\) no reader recognises are not in the total/);
  });

  it("counts a reader's objects as unread, not read, when the reader failed as a whole or could not list its type", () => {
    const walk = { objects: [{ objectId: hex("6"), version: "1", type: POSITION, json: { id: hex("6") } }], complete: true, fields_read: [] };
    for (const what of ["fake_positions", `fake_positions: ${POSITION}`]) {
      const c = ownedCoverage(walk, [], [{ what, reason: "service down" }], false);
      expect(c.read_by).toEqual({});
      expect(c.unread).toBe(1);
    }
  });
});

describe("shared objects an address operates", () => {
  const VAULT = hex("5");
  const SOLO = hex("6");
  const SUI = n("0x2::sui::SUI");
  let extra: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    extra = [];
    gqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => {
      if (q.includes("sentAddress")) {
        const shared = (address: string, mutable = true) => ({ __typename: "SharedInput", address, mutable });
        return { transactions: { nodes: [{ kind: { inputs: { nodes: [shared(VAULT), shared(SOLO), shared("0x6", false)] } } }] } };
      }
      if (q.includes("multiGetObjects")) {
        const json: Record<string, Record<string, unknown>> = {
          [VAULT]: { id: VAULT, members: { contents: [OWNER, OTHER] } },
          [SOLO]: { id: SOLO, owner: OWNER },
        };
        return {
          multiGetObjects: (v.keys as Array<{ address: string }>).map((k) => ({ address: k.address, version: 1, asMoveObject: { contents: { type: { repr: `${PKG}::vault::Vault` }, json: json[k.address] } } })),
        };
      }
      entries[VAULT] = [{ __typename: "MoveValue", type: { repr: `0x2::balance::Balance<${SUI}>` }, json: "3000000000" }, ...extra];
      return serve(q, v);
    });
    priceCoinTypes.mockImplementation(async () => prices([[SUI, 2]]));
  });

  it("names a shared object whose control field lists the address, with who else it lists and what it holds", async () => {
    const { leads } = await operatedSharedObjects(OWNER, { owner: OWNER, memo: new Map() });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ object_id: VAULT, field: "members", listed_with: [OTHER], priced_usd: 6 });
    expect(leads[0].lead).toMatch(/not in the address's totals/);
  });

  it("nets a wrapped lending position's borrows out of what the object holds", async () => {
    extra = [{ __typename: "MoveObject", address: hex("9"), contents: { type: { repr: LENDING_CAP }, json: { id: hex("9") } } }];
    const { leads } = await operatedSharedObjects(OWNER, { owner: OWNER, memo: new Map() });
    // 3 SUI at $2, plus $10 supplied less $8 borrowed.
    expect(leads[0].priced_usd).toBe(8);
    expect(leads[0].lead).toMatch(/net of what it owes/);
  });
});
