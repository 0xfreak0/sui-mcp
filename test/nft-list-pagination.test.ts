import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `list_nfts` at an exact page boundary: when a kiosk drains with no
 * remainder exactly as the page target is reached, the walk's bookkeeping
 * (`state.ki`, `state.dc`) advances past it, and the page must still return
 * a `next_cursor` while any kiosk or direct-owned object is left unscanned.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerNftTools } = await import("../src/tools/nft.js");

let handler: (args: { address: string; limit?: number; cursor?: string }) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, typeof handler> = {};
registerNftTools({
  tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
    handlers[name] = h;
  },
} as never);
handler = handlers.list_nfts;

const run = async (args: { address: string; limit?: number; cursor?: string }) =>
  JSON.parse((await handler(args)).content[0].text);

const OWNER = "0xaa1111111111111111111111111111111111111111111111111111111111aa";

/** One dynamic-field node for an item placed in a kiosk. */
function kioskItemNode(objectId: string) {
  return {
    name: { type: { repr: "0x2::kiosk::Item" } },
    value: {
      __typename: "MoveObject" as const,
      address: objectId,
      contents: { type: { repr: "0xabc::demo::Nft" }, json: {}, display: null },
    },
  };
}

/** One edge for a directly-owned (non-kiosk) NFT. */
function directEdge(objectId: string, cursor: string) {
  return {
    cursor,
    node: { address: objectId, contents: { type: { repr: "0xabc::demo::Nft" }, json: {}, display: null } },
  };
}

/**
 * A wallet holding `kiosks` (id -> item count) plus `directCount`
 * directly-owned NFTs beyond them. Every kiosk page and the direct-objects
 * page are served whole (no inner pagination) so the only thing under test is
 * the walker's own phase-boundary bookkeeping, not GraphQL-level paging.
 */
function mockWallet(kiosks: Record<string, number>, directCount: number) {
  mockGqlQuery.mockReset();
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
    if (query.includes('filter: { type: "0x2::kiosk::KioskOwnerCap"')) {
      return {
        address: {
          objects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: Object.keys(kiosks).map((id) => ({ contents: { json: { for: id } } })),
          },
        },
      };
    }
    if (query.includes("personal_kiosk::PersonalKioskCap")) {
      return { address: { objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
    }
    if (query.includes("dynamicFields")) {
      const kioskId = vars.kioskId as string;
      const count = kiosks[kioskId] ?? 0;
      const offset = vars.cursor ? Number(vars.cursor) : 0;
      const first = vars.first as number;
      const slice = Math.min(offset + first, count);
      const nodes = Array.from({ length: slice - offset }, (_, i) => kioskItemNode(`${kioskId}-item-${offset + i}`));
      const hasNextPage = slice < count;
      return {
        object: {
          dynamicFields: {
            pageInfo: { hasNextPage, endCursor: hasNextPage ? String(slice) : null },
            nodes,
          },
        },
      };
    }
    // DIRECT_OBJECTS_QUERY
    const edges = Array.from({ length: directCount }, (_, i) => directEdge(`direct-${i}`, `dc${i}`));
    return { address: { objects: { pageInfo: { hasNextPage: false, endCursor: null }, edges } } };
  });
}

// A block body, not an implicit-return arrow: `mockReset()` returns the mock
// itself, and vitest's `beforeEach` treats a returned FUNCTION as a teardown
// callback to invoke after the test, so an implicit return would call the
// mock a spurious extra time, with no arguments, after every test.
beforeEach(() => {
  mockGqlQuery.mockReset();
});

describe("list_nfts — exact-boundary pagination", () => {
  it("says there is more when a kiosk drains exactly at the page limit but another kiosk is unscanned", async () => {
    // kiosk-a has exactly 3 items, kiosk-b has 2 more: hitting limit 3 lands
    // exactly on kiosk-a's own boundary.
    mockWallet({ "kiosk-a": 3, "kiosk-b": 2 }, 0);
    const r = await run({ address: OWNER, limit: 3 });
    expect(r.page_size).toBe(3);
    expect(r.next_cursor).toBeDefined();
  });

  it("keeps returning a cursor until every kiosk is actually read", async () => {
    mockWallet({ "kiosk-a": 3, "kiosk-b": 2 }, 0);
    const page1 = await run({ address: OWNER, limit: 3 });
    expect(page1.next_cursor).toBeDefined();
    const page2 = await run({ address: OWNER, limit: 3, cursor: page1.next_cursor });
    expect(page2.page_size).toBe(2);
    expect(page2.next_cursor).toBeUndefined();
  });

  it("probes direct-owned objects when the target is met exactly as the last kiosk drains", async () => {
    // Only kiosk-a, exactly 3 items, plus 2 direct-owned NFTs: kiosks alone
    // fill the target, and the direct-owned objects must still be found.
    mockWallet({ "kiosk-a": 3 }, 2);
    const r = await run({ address: OWNER, limit: 3 });
    expect(r.page_size).toBe(3);
    expect(r.next_cursor).toBeDefined();
    const page2 = await run({ address: OWNER, limit: 3, cursor: r.next_cursor });
    expect(page2.page_size).toBe(2);
    expect(page2.next_cursor).toBeUndefined();
  });

  it("reports done with no cursor once the wallet really is exhausted", async () => {
    mockWallet({ "kiosk-a": 3 }, 0);
    const r = await run({ address: OWNER, limit: 3 });
    expect(r.page_size).toBe(3);
    expect(r.next_cursor).toBeUndefined();
  });

  it("still returns a cursor for the ordinary mid-kiosk case", async () => {
    // kiosk-a alone holds more than the target, so the page ends mid-kiosk
    // and the `nextInnerCursor` path supplies the cursor.
    mockWallet({ "kiosk-a": 10 }, 0);
    const r = await run({ address: OWNER, limit: 3 });
    expect(r.page_size).toBe(3);
    expect(r.next_cursor).toBeDefined();
  });
});
