import { describe, it, expect, vi, beforeAll } from "vitest";
import type { ValuedPosition } from "../../src/utils/position-value.js";

/**
 * A `list_nfts` page with values: the page total covers every row, the
 * summary view keeps each collection's estimate short and names the call
 * with its evidence, and the full view carries that evidence. The wallet
 * and the nft reader are stand-ins; every id is synthetic.
 */

const pad = (hex: string) => `0x${hex.padStart(64, "0")}`;
const OWNER = pad("0a");
const KIOSK = pad("aaa1");
const PRICED = `${pad("aa")}::nft::Priced`;
const UNPRICED = `${pad("bb")}::nft::Unpriced`;
/** Enough priced collections that their short rows pass the summary budget. */
const MANY = Array.from({ length: 40 }, (_, i) => `${pad((0x1000 + i).toString(16))}::a_long_module_name_for_size::SomeCollectionName`);

const items: Array<{ id: string; type: string }> = [
  { id: pad("f1"), type: PRICED },
  { id: pad("f2"), type: PRICED },
  { id: pad("f3"), type: UNPRICED },
  ...MANY.map((type, i) => ({ id: pad((0x2000 + i).toString(16)), type })),
];

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: async (query: string) => {
    if (query.includes("0x2::kiosk::KioskOwnerCap")) {
      return { address: { objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ contents: { json: { for: KIOSK } } }] } } };
    }
    if (query.includes("filter: { type:")) return { address: { objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
    if (query.includes("dynamicFields")) {
      return {
        object: {
          dynamicFields: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: items.map(({ id, type }) => ({
              name: { type: { repr: "0x2::kiosk::Item" } },
              value: { __typename: "MoveObject", address: id, contents: { type: { repr: type }, json: {}, display: null } },
            })),
          },
        },
      };
    }
    return { address: { objects: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } } };
  },
}));

const { registerNftTools } = await import("../../src/tools/nft.js");
const { registerValuer } = await import("../../src/utils/position-value.js");

const position = (id: string, type: string, usd: number | null): ValuedPosition => ({
  protocol: null,
  kind: "nft",
  object_id: id,
  assets: [{ coin_type: type, amount: "1", side: "item", usd }],
  usd_net: usd,
  method: "stand-in",
  tier: "heuristic",
  detail: {
    unit_sui: usd === null ? null : usd / 2,
    basis: usd === null ? null : "floor",
    floor: usd === null ? null : { sui: usd / 2, listed_at: "2026-09-01T00:00:00.000Z", source: "TradePort orderbook", counted: true },
    last_sale: null,
  },
  ...(usd === null ? { unpriced_reason: "No market this server reads." } : {}),
});

beforeAll(() => {
  // Replaces the real reader by name, so no market is read.
  registerValuer({
    name: "nft",
    fallback: true,
    handles: () => true,
    value: async () => ({ positions: [], unread: [] }),
    valueObject: async (obj) => ({
      positions: [position(obj.object_id, obj.type, obj.type === UNPRICED ? null : obj.type === PRICED ? 10.123456 : 1)],
      unread: [],
    }),
  });
});

const handlers: Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> = {};
registerNftTools({ tool: (name: string, _d: string, _s: unknown, h: (typeof handlers)[string]) => (handlers[name] = h) } as never);
const run = async (args: Record<string, unknown>) => {
  const text = (await handlers.list_nfts({ address: OWNER, limit: 100, ...args })).content[0].text;
  return { text, body: JSON.parse(text) };
};

describe("list_nfts page values", () => {
  it("totals every row, and the summary keeps estimates short, most page value first, with the evidence named", async () => {
    const { text, body } = await run({});
    expect(body.valuation).toMatchObject({ usd: 60.25, priced: 42, unpriced: 1 });
    expect(body.nfts.find((n: { object_id: string }) => n.object_id === pad("f1")).est_usd).toBe(10.12);
    const listed = body.valuation.nft_estimates.collections;
    expect(listed[0]).toEqual({ collection: PRICED, unit_sui: 5.061728, basis: "floor", page_usd: 20.25 });
    expect(JSON.stringify(listed).length).toBeLessThanOrEqual(3_000);
    expect(body.valuation.nft_estimates.unpriced_collections).toBe(1);
    const evidence = body.omitted.valuation_evidence;
    expect(evidence.collections).toBe(42);
    expect(evidence.priced_collections_not_listed.count).toBe(41 - listed.length);
    expect(evidence.next_call).toEqual({ tool: "list_nft_collections", args: { address: OWNER } });
    expect(text).not.toContain('"listed_at"');
  });

  it("carries each collection's evidence, unpriced ones included, in the full view", async () => {
    const { body } = await run({ detail: "full" });
    const rows = body.valuation.nft_estimates.collections;
    expect(rows).toHaveLength(42);
    expect(rows.find((c: { collection: string }) => c.collection === PRICED).floor.source).toBe("TradePort orderbook");
    expect(rows.find((c: { collection: string }) => c.collection === UNPRICED).unpriced).toBeTruthy();
    expect(body.omitted).toBeUndefined();
  });
});
