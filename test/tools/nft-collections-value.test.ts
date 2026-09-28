import { describe, it, expect, vi, beforeAll } from "vitest";
import type { ValuedPosition } from "../../src/utils/position-value.js";

/**
 * `list_nft_collections` with values: the wallet total covers every
 * collection even when the rows are capped, priced collections always show,
 * and a collection another reader values is named, not priced as an NFT.
 * Holdings and the nft reader are stand-ins; every id is synthetic.
 */

const pad = (hex: string) => `0x${hex.padStart(64, "0")}`;
const OWNER = pad("0a");
const PRICED_A = `${pad("aa")}::nft::A`;
const PRICED_B = `${pad("bb")}::nft::B`;
const LP_TYPE = `${pad("1b")}::pool::Position`;
const SPAM = Array.from({ length: 300 }, (_, i) => `${pad((0x1000 + i).toString(16))}::airdrop_with_a_long_module_name::ClaimYourRewardTicket`);

vi.mock("../../src/utils/nft-holdings.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readHeldCollections: async () => ({
    counts: new Map<string, number>([[PRICED_A, 3], [PRICED_B, 1], [LP_TYPE, 1], ...SPAM.map((t) => [t, 1] as [string, number])]),
    direct: new Map<string, number>(),
    kiosk_count: 2,
    kiosks_unread: 0,
  }),
}));

const { registerNftTools } = await import("../../src/tools/nft.js");
const { registerValuer } = await import("../../src/utils/position-value.js");

const position = (type: string, count: number, usd: number | null): ValuedPosition => ({
  protocol: null,
  kind: "nft",
  object_id: null,
  assets: [{ coin_type: type, amount: String(count), side: "item", usd }],
  usd_net: usd,
  method: "stand-in",
  tier: "heuristic",
  detail: { unit_usd: usd === null ? null : usd / count },
  ...(usd === null ? { unpriced_reason: "no market" } : {}),
});

beforeAll(() => {
  // Replaces the real readers by name, so no market is read.
  registerValuer({
    name: "nft",
    fallback: true,
    handles: () => true,
    value: async () => ({
      positions: [position(PRICED_A, 3, 30), position(PRICED_B, 1, 12.5), ...SPAM.map((t) => position(t, 1, null))],
      unread: [],
    }),
  });
  registerValuer({
    name: "test_lp",
    handles: (t) => t === LP_TYPE,
    value: async () => ({ positions: [], unread: [] }),
    valueObject: async () => ({ positions: [], unread: [] }),
  });
});

const handlers: Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> = {};
registerNftTools({ tool: (name: string, _d: string, _s: unknown, h: (typeof handlers)[string]) => (handlers[name] = h) } as never);
const run = async (args: Record<string, unknown>) => JSON.parse((await handlers.list_nft_collections({ address: OWNER, ...args })).content[0].text);

describe("list_nft_collections with values", () => {
  it("totals every collection while the rows are capped, keeping every priced one", async () => {
    const r = await run({});
    expect(r.estimated_value).toMatchObject({
      usd: 42.5,
      tier: "heuristic",
      priced_collections: 2,
      priced_nfts: 4,
      unpriced_collections: 300,
      unpriced_nfts: 300,
      not_valued_collections: 1,
    });
    expect(r.total_collections).toBe(303);
    expect(r.truncated).toBe(true);
    expect(r.omitted.lists.collections.count).toBe(303 - r.collections.length);
    expect(r.collections.slice(0, 2).map((c: { collection: string }) => c.collection)).toEqual([PRICED_A, PRICED_B]);
  });

  it("names the reader that values a collection instead of pricing it as an NFT", async () => {
    const r = await run({ detail: "full" });
    expect(r.collections).toHaveLength(303);
    expect(r.collections.find((c: { collection: string }) => c.collection === LP_TYPE).value).toEqual({ valued_by: "test_lp" });
  });

  it("lists counts alone with value off", async () => {
    const r = await run({ value: false, detail: "full" });
    expect(r.estimated_value).toBeUndefined();
    expect(r.collections[0]).toEqual({ collection: PRICED_A, count: 3 });
  });
});
