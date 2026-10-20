import { beforeEach, describe, expect, it, vi } from "vitest";
import { scanObjectsByType } from "../src/tools/objects-by-type.js";
import { resetLiveCoinScale } from "../src/utils/valuation.js";
import { resetCoinLayouts } from "../src/utils/state-read.js";

/**
 * list_objects_by_type against a stubbed GraphQL service (type origins and
 * object pages) and gRPC (struct layouts, coin metadata). capPayload and
 * the coin-scale cache are the real ones.
 */
const { mockGqlQuery, getDatatype, getCoinInfo } = vi.hoisted(() => ({
  mockGqlQuery: vi.fn(), getDatatype: vi.fn(), getCoinInfo: vi.fn(),
}));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => {
  const client = { movePackageService: { getDatatype }, stateService: { getCoinInfo } };
  return { sui: client, archive: client };
});

const pad = (byte: string) => `0x${byte.repeat(32)}`;
const PKG = pad("42");
const LATEST = pad("43");
const V2 = pad("44");
const COINS = pad("c0");
const COINS_V2 = pad("c1");
const FW = pad("00").slice(0, -1) + "2";
const A = `${COINS}::coins::A`;
const B = `${COINS}::coins::B`;
const SUI = `${FW}::sui::SUI`;

const ORIGINS: Record<string, Array<{ module: string; struct: string; definingId: string }>> = {
  [PKG]: [
    { module: "bidding", struct: "Bid", definingId: PKG },
    { module: "bidding", struct: "Witness", definingId: PKG },
    { module: "vault", struct: "Vault", definingId: PKG },
    { module: "vault", struct: "Counter", definingId: V2 },
  ],
  [COINS]: [{ module: "coins", struct: "A", definingId: COINS }, { module: "coins", struct: "B", definingId: COINS }],
  [FW]: [{ module: "sui", struct: "SUI", definingId: FW }, { module: "coin", struct: "Coin", definingId: FW }],
};
ORIGINS[LATEST] = ORIGINS[PKG]!;
ORIGINS[COINS_V2] = ORIGINS[COINS]!;

const SIG_U64 = 6;
const SIG_DATATYPE = 10;
const SIG_TYPE_PARAMETER = 11;
const balanceOfParam = (name: string) => ({
  name, type: { type: SIG_DATATYPE, typeName: `${FW}::balance::Balance`, typeParameterInstantiation: [{ type: SIG_TYPE_PARAMETER, typeParameter: 0, typeParameterInstantiation: [] }] },
});
const LAYOUTS: Record<string, unknown[]> = {
  Bid: [balanceOfParam("offer")],
  Vault: [balanceOfParam("amount")],
  Counter: [{ name: "amount", type: { type: SIG_U64, typeParameterInstantiation: [] } }],
  Coin: [balanceOfParam("balance")],
};

let objectPages: Record<string, unknown[][]>;

function object(i: number, type: string, json: Record<string, unknown>, owner = "Shared") {
  return {
    address: `0x${i.toString(16).padStart(64, "0")}`, version: i,
    previousTransaction: { digest: `digest${i}` },
    owner: { __typename: owner, ...(owner === "Shared" ? {} : { address: { address: pad("0a") } }) },
    asMoveObject: { contents: { type: { repr: type }, json: { id: `0x${i.toString(16)}`, ...json } } },
  };
}

beforeEach(() => {
  resetLiveCoinScale();
  resetCoinLayouts();
  objectPages = {};
  mockGqlQuery.mockReset();
  mockGqlQuery.mockImplementation(async (query: string, vars: { a?: string; type?: string; after?: string | null; first?: number }) => {
    if (query.includes("typeOrigins")) {
      const origins = ORIGINS[vars.a!];
      return { package: origins ? { typeOrigins: origins } : null };
    }
    if (query.includes("objects(filter")) {
      const pages = objectPages[vars.type!] ?? [[]];
      const index = vars.after ? Number(vars.after.slice(1)) : 0;
      const nodes = (pages[index] ?? []).slice(0, vars.first);
      const more = index + 1 < pages.length;
      return { objects: { nodes, pageInfo: { hasNextPage: more, endCursor: more ? `c${index + 1}` : null } } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  });
  getDatatype.mockReset();
  getDatatype.mockImplementation(async ({ name }: { name: string }) => {
    const fields = LAYOUTS[name];
    if (!fields) throw new Error("NOT_FOUND");
    return { response: { datatype: { fields } } };
  });
  getCoinInfo.mockReset();
  getCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
    if (coinType === A) return { response: { metadata: { decimals: 2 } } };
    if (coinType === B) return { response: { metadata: { decimals: 6 } } };
    throw new Error("NOT_FOUND");
  });
});

const bidType = (coin: string) => `${PKG}::bidding::Bid<${coin}>`;

describe("list_objects_by_type", () => {
  it("totals every scanned row before the display cap and formats one coin at its own scale", async () => {
    objectPages[`${PKG}::bidding::Bid`] = Array.from({ length: 4 }, (_, p) =>
      Array.from({ length: 50 }, (_, i) => object(p * 50 + i + 1, bidType(A), { offer: String(p * 50 + i + 1) })));
    const r = await scanObjectsByType({ type: `${PKG}::bidding::Bid`, sum_fields: ["offer"] }) as Record<string, any>;
    expect(r).toMatchObject({ scanned: 200, matched: 200, complete: true, pages: 4 });
    expect(r.sums.offer).toMatchObject({ total: "20100", min: "1", max: "200", count: 200, coin_type: A, formatted_total: "201", decimals: 2, decimals_source: "coin_metadata" });
    // The real cap shortened the rows, never the totals, and kept the largest first.
    expect(r.objects.length).toBeLessThan(200);
    expect(r.omitted.lists.objects.count).toBe(200 - r.objects.length);
    expect(r.objects.slice(0, 3).map((o: { fields: { offer: string } }) => o.fields.offer)).toEqual(["200", "199", "198"]);
  });

  it("never adds amounts of different coins: per-coin totals, and no cross-coin total, min or max", async () => {
    objectPages[`${PKG}::bidding::Bid`] = [[
      object(1, bidType(A), { offer: "100" }), object(2, bidType(A), { offer: "50" }),
      object(3, bidType(B), { offer: "7000000" }),
    ]];
    const r = await scanObjectsByType({ type: `${PKG}::bidding::Bid`, sum_fields: ["offer"] }) as Record<string, any>;
    expect(r.sums.offer).toMatchObject({ total: null, min: null, max: null, count: 3, unit_count: 2 });
    expect(r.sums.offer.observed_total).toBeUndefined();
    expect(r.sum_units).toEqual([
      { field: "offer", coin_type: A, count: 2, raw_total: "150", min: "50", max: "100", formatted_total: "1.5", decimals: 2, decimals_source: "coin_metadata" },
      { field: "offer", coin_type: B, count: 1, raw_total: "7000000", min: "7000000", max: "7000000", formatted_total: "7", decimals: 6, decimals_source: "coin_metadata" },
    ]);
    // One layout read covers both instantiations.
    expect(getDatatype).toHaveBeenCalledTimes(1);
  });

  it("keeps a Balance<T> field and a u64 field of the same name apart in a module scan", async () => {
    objectPages[`${PKG}::vault`] = [[
      object(1, `${PKG}::vault::Vault<${A}>`, { amount: "100" }),
      object(2, `${V2}::vault::Counter`, { amount: "5" }),
    ]];
    const r = await scanObjectsByType({ type: `${PKG}::vault`, sum_fields: ["amount"] }) as Record<string, any>;
    expect(r.sums.amount.total).toBeNull();
    expect(r.sum_units.map((u: Record<string, unknown>) => [u.coin_type ?? u.object_type, u.raw_total])).toEqual([
      [A, "100"], [`${V2}::vault::Counter`, "5"],
    ]);
    expect(r).toMatchObject({ complete: false, other_defining_packages: [V2], stop_reason: "other_defining_packages" });
  });

  it("adds coins across object types when every layout proves the same coin", async () => {
    objectPages[`${PKG}::vault`] = [[
      object(1, `${PKG}::vault::Vault<${A}>`, { amount: "100" }),
      object(2, bidType(A), { amount: "1" }),
    ]];
    LAYOUTS.Bid = [balanceOfParam("amount")];
    try {
      const r = await scanObjectsByType({ type: `${PKG}::vault`, sum_fields: ["amount"] }) as Record<string, any>;
      expect(r.sums.amount).toMatchObject({ total: "101", coin_type: A, formatted_total: "1.01" });
    } finally {
      LAYOUTS.Bid = [balanceOfParam("offer")];
    }
  });

  it("counts per object type when a layout cannot be read, and gives a total only for one type", async () => {
    getDatatype.mockRejectedValue(new Error("UNAVAILABLE"));
    objectPages[`${PKG}::bidding::Bid`] = [[object(1, bidType(A), { offer: "100" }), object(2, bidType(B), { offer: "3" })]];
    const mixed = await scanObjectsByType({ type: `${PKG}::bidding::Bid`, sum_fields: ["offer"] }) as Record<string, any>;
    expect(mixed.sums.offer.total).toBeNull();
    expect(mixed.sum_units.map((u: Record<string, unknown>) => u.object_type)).toEqual([bidType(A), bidType(B)]);
    expect(mixed.layout_note).toMatch(/could not be read/);

    objectPages[`${PKG}::bidding::Bid`] = [[object(1, bidType(A), { offer: "100" }), object(2, bidType(A), { offer: "3" })]];
    const one = await scanObjectsByType({ type: `${PKG}::bidding::Bid`, sum_fields: ["offer"] }) as Record<string, any>;
    expect(one.sums.offer).toMatchObject({ total: "103" });
    expect(one.sums.offer.coin_type).toBeUndefined();
  });

  it("reads past the layout budget per object type rather than per coin", async () => {
    const structs = Array.from({ length: 22 }, (_, i) => `S${i}`);
    ORIGINS[PKG]!.push(...structs.map((s) => ({ module: "many", struct: s, definingId: PKG })));
    for (const s of structs) LAYOUTS[s] = [balanceOfParam("amount")];
    try {
      objectPages[`${PKG}::many`] = [structs.map((s, i) => object(i + 1, `${PKG}::many::${s}<${A}>`, { amount: "1" }))];
      const r = await scanObjectsByType({ type: `${PKG}::many`, sum_fields: ["amount"] }) as Record<string, any>;
      expect(getDatatype).toHaveBeenCalledTimes(20);
      expect(r.sums.amount.total).toBeNull();
      expect(r.sum_units.find((u: Record<string, unknown>) => u.coin_type === A)).toMatchObject({ count: 20, raw_total: "20" });
      expect(r.sum_units.filter((u: Record<string, unknown>) => u.object_type)).toHaveLength(2);
      expect(r.layout_note).toMatch(/2 struct definitions past the first 20/);
    } finally {
      ORIGINS[PKG]!.splice(4);
      for (const s of structs) delete LAYOUTS[s];
    }
  });

  it("refuses a struct, module or type argument its package does not define, naming the closest", async () => {
    await expect(scanObjectsByType({ type: `${PKG}::bidding::Bidd` })).rejects.toThrow(/defines no struct named Bidd.*closest first: Bid, Witness/);
    await expect(scanObjectsByType({ type: `${PKG}::biding` })).rejects.toThrow(/no struct in a module named biding.*closest first: bidding, vault/);
    await expect(scanObjectsByType({ type: `0x2::coin::Coin<0x2::SUI::SUI>` })).rejects.toThrow(/module named SUI.*closest first: sui, coin/);
    await expect(scanObjectsByType({ type: `${pad("99")}::m::T` })).rejects.toThrow(/No package exists/);
    await expect(scanObjectsByType({ type: `${PKG}::bidding::Bid<` })).rejects.toThrow(/Pass a Move struct type or module/);
    expect(mockGqlQuery.mock.calls.some(([q]) => String(q).includes("objects(filter"))).toBe(false);
  });

  it("rewrites the struct and its type arguments to their defining packages, padded", async () => {
    objectPages[bidType(A)] = [[object(1, bidType(A), { offer: "9" })]];
    const r = await scanObjectsByType({ type: `${LATEST}::bidding::Bid<${COINS_V2.replace(/^0x0*/, "0x")}::coins::A>`, sum_fields: ["offer"] }) as Record<string, any>;
    expect(r.queried_type).toBe(bidType(A));
    expect(r.sums.offer.total).toBe("9");
    expect(r.type_note).toBeDefined();
  });

  it("stops on a missing cursor rather than restarting the first page", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: { a?: string }) => query.includes("typeOrigins")
      ? { package: { typeOrigins: ORIGINS[vars.a!] } }
      : { objects: { nodes: [object(1, bidType(A), { offer: "1" })], pageInfo: { hasNextPage: true, endCursor: null } } });
    const r = await scanObjectsByType({ type: `${PKG}::bidding::Bid` }) as Record<string, any>;
    expect(r).toMatchObject({ complete: false, truncated: true, stop_reason: "missing_or_repeated_cursor", scanned: 1 });
    expect(r.next_call).toBeUndefined();
  });

  it("reports max_scan truncation and a continuation that keeps detail", async () => {
    objectPages[`${PKG}::bidding::Bid`] = [
      [object(1, bidType(A), { offer: "1" }), object(2, bidType(A), { offer: "2" })],
      [object(3, bidType(A), { offer: "3" })],
    ];
    const r = await scanObjectsByType({ type: `${PKG}::bidding::Bid`, sum_fields: ["offer"], max_scan: 2, detail: "full" }) as Record<string, any>;
    expect(r).toMatchObject({ complete: false, truncated: true, stop_reason: "max_scan", next_cursor: "c1" });
    expect(r.next_call.args).toMatchObject({ cursor: "c1", max_scan: 2, detail: "full" });
  });

  it("keeps a missing filter value apart from a struct without the field, and from an unfunded object", async () => {
    objectPages[`${PKG}::bidding::Bid`] = [[
      object(1, bidType(A), { offer: null }),
      object(2, bidType(A), { other: "5" }),
      object(3, bidType(A), { offer: "0" }),
      object(4, bidType(A), { offer: "4" }),
    ]];
    const r = await scanObjectsByType({ type: `${PKG}::bidding::Bid`, sum_fields: ["offer"], where: { field: "offer" } }) as Record<string, any>;
    expect(r).toMatchObject({ scanned: 4, matched: 1, where_unreadable: 1, where_absent: 1, matched_complete: false });
    expect(r.sums.offer.total).toBe("4");
  });

  it("gives no total for a path no object has, and a lower bound when some amounts are unreadable", async () => {
    objectPages[`${PKG}::bidding::Bid`] = [[object(1, bidType(A), { offer: "3" }), object(2, bidType(A), { offer: { bits: 1 } })]];
    const r = await scanObjectsByType({ type: `${PKG}::bidding::Bid`, sum_fields: ["offer", "offr"] }) as Record<string, any>;
    expect(r.sums.offr).toMatchObject({ total: null, count: 0, absent: 2 });
    expect(r.sums.offr.field_note).toMatch(/Top-level fields of the first object scanned: id, offer/);
    expect(r.sums.offer).toMatchObject({ total: null, observed_total: "3", unreadable: 1, coin_type: A, formatted_observed_total: "0.03" });
  });

  it("reads balance.value on a Balance that GraphQL renders as its amount", async () => {
    const coin = `${FW}::coin::Coin<${SUI}>`;
    objectPages[coin] = [[object(1, coin, { balance: "1500000000" }, "AddressOwner")]];
    const r = await scanObjectsByType({ type: "0x2::coin::Coin<0x2::sui::SUI>", sum_fields: ["balance.value"] }) as Record<string, any>;
    expect(r.sums["balance.value"]).toMatchObject({ total: "1500000000", coin_type: SUI, formatted_total: "1.5", decimals: 9 });
    expect(r.owner_kinds.address).toBe(1);
  });

  it("says wrapped objects are not indexed when a type has no top-level object", async () => {
    const r = await scanObjectsByType({ type: `${PKG}::bidding::Witness` }) as Record<string, any>;
    expect(r).toMatchObject({ scanned: 0, matched: 0, complete: true });
    expect(r.scope_note).toMatch(/wrapped/);
  });
});
