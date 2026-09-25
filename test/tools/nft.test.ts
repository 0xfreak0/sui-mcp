import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGql = vi.fn();
vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: (...args: unknown[]) => mockGql(...args),
  graphqlClient: {},
}));

const { registerNftTools } = await import("../../src/tools/nft.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerNftTools(mockServer);

const OWNER = "0x000000000000000000000000000000000000000000000000000000000000beef";
const STD_KIOSK_ID = "0x000000000000000000000000000000000000000000000000000000000000aaa1";
const PERSONAL_KIOSK_ID = "0x000000000000000000000000000000000000000000000000000000000000bbb1";

const emptyPage = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
/** An empty page of directly owned objects, which are read as edges for their cursors. */
const emptyDirect = { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] };

function nftCollection(suffix: string) {
  return `0x0000000000000000000000000000000000000000000000000000000000000999::col${suffix}::NFT`;
}

function kioskItemNode(kioskId: string, idx: number, collection: string) {
  return {
    name: { type: { repr: "0x2::dynamic_object_field::Wrapper<0x2::kiosk::Item>" } },
    value: {
      __typename: "MoveObject",
      address: `0xaaaa${kioskId.slice(-4)}${String(idx).padStart(4, "0")}`,
      contents: {
        type: { repr: collection },
        json: { name: `Item ${idx}`, image_url: `https://example/${idx}.png` },
        display: { output: { name: `Item ${idx}`, image_url: `https://example/${idx}.png` } },
      },
    },
  };
}

describe("list_nfts — kiosk discovery", () => {
  beforeEach(() => {
    mockGql.mockReset();
  });

  it("discovers kiosks held inside PersonalKioskCap and walks their items", async () => {
    mockGql.mockImplementation((query: string, _vars: Record<string, unknown>) => {
      if (query.includes("0x2::kiosk::KioskOwnerCap")) {
        return Promise.resolve({
          address: {
            objects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ contents: { json: { for: STD_KIOSK_ID } } }],
            },
          },
        });
      }
      if (query.includes("personal_kiosk::PersonalKioskCap")) {
        return Promise.resolve({
          address: {
            objects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { contents: { json: { cap: { for: PERSONAL_KIOSK_ID } } } },
              ],
            },
          },
        });
      }
      if (query.includes("dynamicFields")) {
        const kioskId = (_vars as { kioskId: string }).kioskId;
        if (kioskId === STD_KIOSK_ID) {
          return Promise.resolve({
            object: {
              dynamicFields: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [kioskItemNode(STD_KIOSK_ID, 1, nftCollection("A"))],
              },
            },
          });
        }
        if (kioskId === PERSONAL_KIOSK_ID) {
          return Promise.resolve({
            object: {
              dynamicFields: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  kioskItemNode(PERSONAL_KIOSK_ID, 1, nftCollection("B")),
                  kioskItemNode(PERSONAL_KIOSK_ID, 2, nftCollection("B")),
                ],
              },
            },
          });
        }
      }
      if (query.includes("address(address: $owner)") && !query.includes("filter:")) {
        return Promise.resolve({ address: { objects: emptyDirect } });
      }
      throw new Error("unexpected query: " + query);
    });

    const handler = tools.get("list_nfts")!;
    const result = await handler({ address: OWNER, limit: 50 });
    const data = JSON.parse(result.content[0].text);

    expect(data.kiosk_count).toBe(2);
    expect(data.nfts).toHaveLength(3);
    expect(data.next_cursor).toBeUndefined();

    const kioskIds = new Set(data.nfts.map((n: { kiosk_id: string }) => n.kiosk_id));
    expect(kioskIds.has(STD_KIOSK_ID)).toBe(true);
    expect(kioskIds.has(PERSONAL_KIOSK_ID)).toBe(true);

    const collections = new Set(data.nfts.map((n: { collection: string }) => n.collection));
    expect(collections.has(nftCollection("A"))).toBe(true);
    expect(collections.has(nftCollection("B"))).toBe(true);
  });

  it("dedupes when the same kiosk id is reported by both queries", async () => {
    const SHARED_ID = "0x000000000000000000000000000000000000000000000000000000000000cafe";
    mockGql.mockImplementation((query: string, _vars: Record<string, unknown>) => {
      if (query.includes("0x2::kiosk::KioskOwnerCap")) {
        return Promise.resolve({
          address: {
            objects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ contents: { json: { for: SHARED_ID } } }],
            },
          },
        });
      }
      if (query.includes("personal_kiosk::PersonalKioskCap")) {
        return Promise.resolve({
          address: {
            objects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ contents: { json: { cap: { for: SHARED_ID } } } }],
            },
          },
        });
      }
      if (query.includes("dynamicFields")) {
        return Promise.resolve({
          object: {
            dynamicFields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [kioskItemNode(SHARED_ID, 1, nftCollection("X"))],
            },
          },
        });
      }
      if (query.includes("address(address: $owner)") && !query.includes("filter:")) {
        return Promise.resolve({ address: { objects: emptyDirect } });
      }
      throw new Error("unexpected query: " + query);
    });

    const handler = tools.get("list_nfts")!;
    const result = await handler({ address: OWNER, limit: 50 });
    const data = JSON.parse(result.content[0].text);

    expect(data.kiosk_count).toBe(1);
    expect(data.nfts).toHaveLength(1);
  });

  it("returns next_cursor when limit caps the result, and resumes correctly", async () => {
    // 5 NFTs in one kiosk. The mock pages the way GraphQL does: `first`
    // items after the cursor, which is the index reached so far.
    const ITEMS = [1, 2, 3, 4, 5].map((i) => kioskItemNode(STD_KIOSK_ID, i, nftCollection("Z")));
    const kioskPage = (after: string | null, first: number) => {
      const start = after === null ? 0 : Number(after);
      const end = Math.min(ITEMS.length, start + first);
      return {
        pageInfo: { hasNextPage: end < ITEMS.length, endCursor: String(end) },
        nodes: ITEMS.slice(start, end),
      };
    };

    mockGql.mockImplementation((query: string, vars: Record<string, unknown>) => {
      if (query.includes("0x2::kiosk::KioskOwnerCap")) {
        return Promise.resolve({
          address: {
            objects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ contents: { json: { for: STD_KIOSK_ID } } }],
            },
          },
        });
      }
      if (query.includes("personal_kiosk::PersonalKioskCap")) {
        return Promise.resolve({ address: { objects: emptyPage } });
      }
      if (query.includes("dynamicFields")) {
        return Promise.resolve({
          object: { dynamicFields: kioskPage(vars.cursor as string | null, vars.first as number) },
        });
      }
      if (query.includes("address(address: $owner)") && !query.includes("filter:")) {
        return Promise.resolve({ address: { objects: emptyDirect } });
      }
      throw new Error("unexpected query: " + query);
    });

    const handler = tools.get("list_nfts")!;

    // First page: exactly `limit`, with a cursor because the kiosk has more.
    const r1 = await handler({ address: OWNER, limit: 2 });
    const d1 = JSON.parse(r1.content[0].text);
    expect(d1.nfts).toHaveLength(2);
    expect(d1.next_cursor).toBeDefined();

    // Resume: should return the remaining 3 items and no further cursor.
    const r2 = await handler({ address: OWNER, limit: 50, cursor: d1.next_cursor });
    const d2 = JSON.parse(r2.content[0].text);
    expect(d2.nfts).toHaveLength(3);
    expect(d2.next_cursor).toBeUndefined();

    // Together the two pages must cover items 1..5 with no overlap or gap.
    const ids = [...d1.nfts, ...d2.nfts].map((n: { object_id: string }) => n.object_id);
    expect(new Set(ids).size).toBe(5);
  });

  it("excludes PersonalKioskCap objects from direct-owned NFT results", async () => {
    mockGql.mockImplementation((query: string, _vars: Record<string, unknown>) => {
      if (query.includes("0x2::kiosk::KioskOwnerCap")) {
        return Promise.resolve({ address: { objects: emptyPage } });
      }
      if (query.includes("personal_kiosk::PersonalKioskCap")) {
        return Promise.resolve({ address: { objects: emptyPage } });
      }
      if (query.includes("address(address: $owner)") && !query.includes("filter:")) {
        return Promise.resolve({
          address: {
            objects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                {
                  cursor: "c-0xc01",
                  node: {
                    address: "0xc01",
                    contents: { type: { repr: "0x2::coin::Coin<0x2::sui::SUI>" }, json: {}, display: null },
                  },
                },
                {
                  cursor: "c-0xc02",
                  node: {
                    address: "0xc02",
                    contents: { type: { repr: "0x2::kiosk::KioskOwnerCap" }, json: {}, display: null },
                  },
                },
                {
                  cursor: "c-0xc03",
                  node: {
                    address: "0xc03",
                    contents: {
                      type: {
                        repr:
                          "0x0cb4bcc0560340eb1a1b929cabe56b33fc6449820ec8c1980d69bb98b649b802::personal_kiosk::PersonalKioskCap",
                      },
                      json: {},
                      display: null,
                    },
                  },
                },
                {
                  cursor: "c-0xc04",
                  node: {
                    address: "0xc04",
                    contents: {
                      type: { repr: nftCollection("Direct") },
                      json: { name: "Real NFT", image_url: "https://example/r.png" },
                      display: { output: { name: "Real NFT", image_url: "https://example/r.png" } },
                    },
                  },
                },
              ],
            },
          },
        });
      }
      throw new Error("unexpected query: " + query);
    });

    const handler = tools.get("list_nfts")!;
    const result = await handler({ address: OWNER, limit: 50 });
    const data = JSON.parse(result.content[0].text);

    expect(data.nfts).toHaveLength(1);
    expect(data.nfts[0].object_id).toBe("0xc04");
    expect(data.nfts[0].collection).toBe(nftCollection("Direct"));
  });

  // A page of 50 directly owned objects was returned whole, so `limit: 1` on
  // a wallet of NFTs with inline SVG images came back as 150k characters.
  it("stops directly owned NFTs at the limit and resumes after the last one kept", async () => {
    const edge = (id: string, repr: string) => ({
      cursor: `c-${id}`,
      node: { address: id, contents: { type: { repr }, json: {}, display: null } },
    });
    const PAGE = [
      edge("0xd01", "0x2::coin::Coin<0x2::sui::SUI>"),
      edge("0xd02", nftCollection("D")),
      edge("0xd03", nftCollection("D")),
      edge("0xd04", nftCollection("D")),
    ];
    const seen: Array<string | null> = [];
    mockGql.mockImplementation((query: string, vars: Record<string, unknown>) => {
      if (query.includes("filter:")) return Promise.resolve({ address: { objects: emptyPage } });
      const after = (vars.cursor as string | null) ?? null;
      seen.push(after);
      const start = after === null ? 0 : PAGE.findIndex((e) => e.cursor === after) + 1;
      return Promise.resolve({
        address: { objects: { pageInfo: { hasNextPage: false, endCursor: "c-0xd04" }, edges: PAGE.slice(start) } },
      });
    });

    const handler = tools.get("list_nfts")!;
    const d1 = JSON.parse((await handler({ address: OWNER, limit: 1 })).content[0].text);
    expect(d1.nfts.map((n: { object_id: string }) => n.object_id)).toEqual(["0xd02"]);
    expect(d1.next_cursor).toBeDefined();

    const d2 = JSON.parse((await handler({ address: OWNER, limit: 5, cursor: d1.next_cursor })).content[0].text);
    expect(d2.nfts.map((n: { object_id: string }) => n.object_id)).toEqual(["0xd03", "0xd04"]);
    expect(d2.next_cursor).toBeUndefined();
    expect(seen).toEqual([null, "c-0xd02"]);
  });

  it("rejects malformed cursor strings", async () => {
    const handler = tools.get("list_nfts")!;
    await expect(handler({ address: OWNER, cursor: "not-base64-json" })).rejects.toThrow(/invalid cursor/);
  });
});
