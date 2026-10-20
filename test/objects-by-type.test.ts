import { beforeEach, describe, expect, it, vi } from "vitest";
import { scanObjectsByType } from "../src/tools/objects-by-type.js";
import { fetchTypeOrigins } from "../src/utils/package-versions.js";

const { mockGqlQuery } = vi.hoisted(() => ({ mockGqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/utils/package-versions.js", () => ({
  fetchTypeOrigins: vi.fn(async () => [{ module: "bidding", struct: "Bid", definingId: "0x42" }]),
}));
vi.mock("../src/utils/valuation.js", () => ({ prefetchCoinScale: vi.fn(async () => { }), coinScale: () => ({ decimals: 9, source: "coin_metadata" }) }));
vi.mock("../src/utils/output-cap.js", () => ({
  capPayload: (_name: string, _args: unknown, full: { objects: unknown[] }, _caps: unknown, opts: { full: boolean }) => ({
    payload: {
      ...full, objects: opts.full ? full.objects : full.objects.slice(0, 2),
      ...(full.objects.length > 2 && !opts.full ? { omitted: { lists: { objects: { count: full.objects.length - 2 } } } } : {})
    },
  }),
}));

const TYPE = "0x42::bidding::Bid";
const object = (i: number, amount: string, owner = "AddressOwner") => ({
  address: `0x${i.toString(16).padStart(64, "0")}`, version: i,
  previousTransaction: { digest: `digest${i}` },
  owner: { __typename: owner, address: { address: "0x2" } },
  asMoveObject: { contents: { type: { repr: TYPE }, json: { offer: { value: amount }, nested: { amount } } } },
});
const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  objects: { nodes, pageInfo: { hasNextPage, endCursor } },
});

beforeEach(() => {
  mockGqlQuery.mockReset();
  vi.mocked(fetchTypeOrigins).mockResolvedValue([{ module: "bidding", struct: "Bid", definingId: "0x42" }]);
  mockGqlQuery.mockImplementation((query: string) => {
    if (query.includes("type(type:")) return Promise.resolve({
      type: {
        layout: {
          struct: {
            type: TYPE, fields: [
              { name: "offer", layout: { struct: { type: "0x2::balance::Balance<0x2::sui::SUI>", fields: [] } } },
            ]
          }
        }
      }
    });
    throw new Error(`Unrouted query ${query}`);
  });
});

describe("list_objects_by_type", () => {
  it("pages the type, totals every row before the display cap and formats Balance<T>", async () => {
    const seen: unknown[] = [];
    mockGqlQuery.mockImplementation((query: string, vars: { after?: string }) => {
      if (query.includes("type(type:")) return Promise.resolve({
        type: {
          layout: {
            struct: {
              type: TYPE, fields: [
                { name: "offer", layout: { struct: { type: "0x2::balance::Balance<0x2::sui::SUI>", fields: [] } } },
              ]
            }
          }
        }
      });
      seen.push(vars);
      return Promise.resolve(vars.after ? page([object(3, "4000000000", "Shared")]) : page([
        object(1, "1000000000"), object(2, "2000000000", "ObjectOwner"),
      ], true, "next"));
    });
    const r = await scanObjectsByType({ type: TYPE, sum_fields: ["offer"] });
    expect(seen).toEqual([{ type: TYPE, first: 50, after: null }, { type: TYPE, first: 50, after: "next" }]);
    expect(r).toMatchObject({
      scanned: 3, matched: 3, complete: true,
      owner_kinds: { address: 1, object: 1, shared: 1 },
      sums: {
        offer: {
          total: "7000000000", min: "1000000000", max: "4000000000", count: 3,
          formatted_total: "7", coin_type: "0x2::sui::SUI"
        }
      }, omitted: { lists: { objects: { count: 1 } } }
    });
    expect((r.objects as Array<{ object_id: string }>)[0]?.object_id).toBe(object(3, "4").address);
  });

  it("filters unfunded rows before sums and owner counts, with nested paths", async () => {
    mockGqlQuery.mockImplementation((query: string) => query.includes("type(type:")
      ? Promise.resolve({ type: { layout: null } })
      : Promise.resolve(page([object(1, "0"), object(2, "20"), object(3, "30")])));
    const r = await scanObjectsByType({
      type: TYPE, sum_fields: ["nested.amount"],
      where: { field: "offer", gt: "0" }
    });
    expect(r).toMatchObject({
      scanned: 3, matched: 2, complete: true, owner_kinds: { address: 2 },
      sums: { "nested.amount": { total: "50", min: "20", max: "30" } }
    });
  });

  it("stops on a missing cursor rather than restarting the first page", async () => {
    mockGqlQuery.mockResolvedValue(page([object(1, "1")], true, null));
    const r = await scanObjectsByType({ type: TYPE });
    expect(r).toMatchObject({
      scanned: 1, complete: false, truncated: true,
      stop_reason: "missing_or_repeated_cursor"
    });
    expect(mockGqlQuery).toHaveBeenCalledTimes(1);
  });

  it("reports max_scan truncation and a continuation after the last scanned row", async () => {
    mockGqlQuery.mockResolvedValue(page([object(1, "7"), object(2, "9")], true, "cursor2"));
    const r = await scanObjectsByType({ type: TYPE, sum_fields: ["offer"], max_scan: 2 });
    expect(r).toMatchObject({
      scanned: 2, complete: false, truncated: true, stop_reason: "max_scan",
      next_cursor: "cursor2", next_call: { tool: "list_objects_by_type", args: { cursor: "cursor2" } }
    });
  });
  it("reports another defining package as incomplete scope for a module scan", async () => {
    vi.mocked(fetchTypeOrigins).mockResolvedValue([
      { module: "bidding", struct: "Bid", definingId: "0x42" },
      { module: "bidding", struct: "Escrow", definingId: "0x43" },
    ]);
    mockGqlQuery.mockResolvedValue(page([object(1, "5")]));
    const r = await scanObjectsByType({ type: "0x42::bidding" });
    expect(r).toMatchObject({
      scanned: 1, complete: false, queried_complete: true,
      truncated: true, stop_reason: "other_defining_packages"
    });
    expect((r.other_defining_packages as string[])[0]).toBe(`0x${"0".repeat(62)}43`);
  });

  it("keeps a missing filter value distinct from an unfunded object", async () => {
    mockGqlQuery.mockResolvedValue(page([
      object(1, "9"),
      { ...object(2, "0"), asMoveObject: { contents: { type: { repr: TYPE }, json: { id: "0x2" } } } },
    ]));
    const r = await scanObjectsByType({ type: TYPE, sum_fields: ["offer"], where: { field: "offer" } });
    expect(r).toMatchObject({
      scanned: 2, matched: 1, where_unreadable: 1, matched_complete: false,
      sums: { offer: { total: "9" } }
    });
  });
});
