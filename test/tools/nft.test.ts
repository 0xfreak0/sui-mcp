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
    // Query 1: KioskOwnerCap → returns one standard kiosk
    // Query 2: PersonalKioskCap → returns one personal kiosk wrapping a different kiosk id
    // Query 3 + 4: dynamic fields for each kiosk
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
      // dynamicFields query: vars.kioskId tells us which kiosk
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
      // direct-owned objects (top-up step)
      if (query.includes("address(address: $owner)") && !query.includes("filter:")) {
        return Promise.resolve({ address: { objects: emptyPage } });
      }
      throw new Error("unexpected query: " + query);
    });

    const handler = tools.get("list_nfts")!;
    const result = await handler({ address: OWNER, limit: 50 });
    const data = JSON.parse(result.content[0].text);

    expect(data.kiosk_count).toBe(2);
    expect(data.total_kiosk_nfts).toBe(3);
    expect(data.nfts).toHaveLength(3);
    expect(data.truncated).toBe(false);

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
        return Promise.resolve({ address: { objects: emptyPage } });
      }
      throw new Error("unexpected query: " + query);
    });

    const handler = tools.get("list_nfts")!;
    const result = await handler({ address: OWNER, limit: 50 });
    const data = JSON.parse(result.content[0].text);

    expect(data.kiosk_count).toBe(1);
    expect(data.total_kiosk_nfts).toBe(1);
  });

  it("sets truncated:true when limit caps the kiosk slice", async () => {
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
        return Promise.resolve({ address: { objects: emptyPage } });
      }
      if (query.includes("dynamicFields")) {
        const nodes = Array.from({ length: 5 }, (_, i) =>
          kioskItemNode(STD_KIOSK_ID, i, nftCollection("Z")),
        );
        return Promise.resolve({
          object: {
            dynamicFields: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
        });
      }
      if (query.includes("address(address: $owner)") && !query.includes("filter:")) {
        return Promise.resolve({ address: { objects: emptyPage } });
      }
      throw new Error("unexpected query: " + query);
    });

    const handler = tools.get("list_nfts")!;
    const result = await handler({ address: OWNER, limit: 2 });
    const data = JSON.parse(result.content[0].text);

    expect(data.total_kiosk_nfts).toBe(5);
    expect(data.nfts).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.truncation_note).toBeDefined();
  });

  it("excludes PersonalKioskCap objects from direct-owned NFT results", async () => {
    mockGql.mockImplementation((query: string, _vars: Record<string, unknown>) => {
      if (query.includes("0x2::kiosk::KioskOwnerCap")) {
        return Promise.resolve({ address: { objects: emptyPage } });
      }
      if (query.includes("personal_kiosk::PersonalKioskCap")) {
        return Promise.resolve({ address: { objects: emptyPage } });
      }
      // Direct-owned: returns a Coin, a regular KioskOwnerCap, a PersonalKioskCap, and a real NFT
      if (query.includes("address(address: $owner)") && !query.includes("filter:")) {
        return Promise.resolve({
          address: {
            objects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  address: "0xc01",
                  contents: { type: { repr: "0x2::coin::Coin<0x2::sui::SUI>" }, json: {}, display: null },
                },
                {
                  address: "0xc02",
                  contents: { type: { repr: "0x2::kiosk::KioskOwnerCap" }, json: {}, display: null },
                },
                {
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
                {
                  address: "0xc04",
                  contents: {
                    type: { repr: nftCollection("Direct") },
                    json: { name: "Real NFT", image_url: "https://example/r.png" },
                    display: { output: { name: "Real NFT", image_url: "https://example/r.png" } },
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
});
