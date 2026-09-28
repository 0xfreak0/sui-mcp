import { describe, it, expect, vi } from "vitest";

/**
 * `get_nft_sales` with `include_sales` on a busy window: totals cover every
 * sale, the default view lists the newest that fit and counts the rest, and
 * `detail: "full"` lists them all. Every id is synthetic.
 */

const SIMPLE_BUY = "0xff2251ea99230ed1cbe3a347a209352711c6723fcdcd9286e16636e65bb55cab::tradeport_listings::BuySimpleListingEvent";
const pad = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const SALES = 600;
const filters: unknown[] = [];

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: async (query: string, vars: { filter?: { type: string; beforeCheckpoint?: number }; after?: string }) => {
    if (query.includes("checkpoint { sequenceNumber }") && !query.includes("events")) return { checkpoint: { sequenceNumber: 1_000_000 } };
    filters.push(vars.filter);
    if (vars.filter?.type !== SIMPLE_BUY) return { events: { nodes: [], pageInfo: { hasNextPage: false } } };
    // Oldest first, as the service pages events.
    const start = vars.after ? Number(vars.after) : 0;
    const end = Math.min(start + 50, SALES);
    const nodes = Array.from({ length: end - start }, (_, k) => {
      const i = start + k;
      return {
        contents: { type: { repr: SIMPLE_BUY }, json: { nft_id: pad(0x1000 + i), price: "1000000000", seller: pad(1), buyer: pad(2) } },
        timestamp: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
        transaction: { digest: `D${i}`, effects: { checkpoint: { sequenceNumber: 900_000 + i } } },
      };
    });
    return { events: { nodes, pageInfo: { hasNextPage: end < SALES, endCursor: String(end) } } };
  },
}));

const { registerNftSalesTools } = await import("../../src/tools/nft-sales.js");
let handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
registerNftSalesTools({ tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => (handler = h) } as never);
const run = async (args: Record<string, unknown>) =>
  JSON.parse((await handler({ hours: 24, max_pages: 200, include_sales: true, ...args })).content[0].text);

describe("get_nft_sales sale records", () => {
  it("lists the newest sales that fit, counts the rest, and totals every sale", async () => {
    const r = await run({});
    expect(r.sales).toBe(SALES);
    expect(r.volume_mist).toBe(String(SALES * 1_000_000_000));
    expect(r.truncated).toBe(true);
    expect(r.caveat).toBeUndefined();
    const shown: Array<{ checkpoint: number }> = r.sale_records;
    expect(shown.length).toBeLessThan(SALES);
    expect(shown[0].checkpoint).toBe(900_000 + SALES - 1);
    expect(shown.every((s, i) => i === 0 || s.checkpoint < shown[i - 1].checkpoint)).toBe(true);
    expect(r.omitted.lists.sale_records.count).toBe(SALES - shown.length);
    expect(r.omitted.next_call).toEqual({ tool: "get_nft_sales", repeat_with: { detail: "full" } });
  });

  it("reads only up to the checkpoint it reports as the window's end", async () => {
    const r = await run({});
    expect(filters).toContainEqual(expect.objectContaining({ beforeCheckpoint: r.to_checkpoint + 1 }));
  });

  it("lists every sale with detail full, and a complete read is not marked truncated", async () => {
    const r = await run({ detail: "full" });
    expect(r.sale_records).toHaveLength(SALES);
    expect(r.truncated).toBe(false);
    expect(r.omitted).toBeUndefined();
  });
});
