import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The kiosk resolution path, which had no coverage at all.
 *
 * A kiosk's own `owner` field does not follow the `KioskOwnerCap` and disagreed
 * with the real holder in 121 of 300 sampled mainnet kiosks. A marketplace sale
 * names the buyer beside the buyer's kiosk in one record, so a kiosk seen
 * trading has a chain-derived owner. These tests drive the real handler against
 * a real temporary store.
 *
 * The store path is set per test rather than inherited: without that, a
 * developer with `SUI_STORE_PATH` exported runs the suite against their own
 * database, and every assertion here depends on what the table holds.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({
  sui: { stateService: { getCoinInfo: async () => ({ response: {} }) } },
  archive: {},
}));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));

const A = `0xaa${"1".repeat(62)}`;
const DECLARED = `0xdd${"2".repeat(62)}`;
const REAL = `0xbb${"3".repeat(62)}`;
const KIOSK = `0xcc${"4".repeat(62)}`;
/** The parent must really be a Kiosk; a Bag-held NFT is not kiosk-held. */
const KIOSK_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::kiosk::Kiosk";

/** owner -> dynamic field -> kiosk, which declares an owner. */
const kioskNft = (declared: string, kioskId: string) => ({
  owner: {
    address: {
      asObject: {
        owner: {
          address: {
            address: kioskId,
            asObject: {
              asMoveObject: {
                contents: { type: { repr: KIOSK_TYPE }, json: { owner: declared } },
              },
            },
          },
        },
      },
    },
  },
});
const plainNft = (owner: string) => ({ owner: { address: { address: owner } } });

let dir: string;

async function load() {
  const store = await import("../src/utils/store.js");
  const { registerHolderTools } = await import("../src/tools/holders.js");
  let handler!: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  registerHolderTools({
    tool: (n: string, _d: unknown, _s: unknown, h: typeof handler) => {
      if (n === "get_top_holders") handler = h;
    },
  } as never);
  return {
    store,
    run: async (a: Record<string, unknown>) => JSON.parse((await handler(a)).content[0]!.text),
  };
}

beforeEach(() => {
  vi.resetModules();
  mockGqlQuery.mockReset();
  dir = mkdtempSync(join(tmpdir(), "sui-kiosk-"));
  process.env.SUI_STORE_PATH = join(dir, "store.db");
});

afterEach(() => {
  delete process.env.SUI_STORE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("a kiosk a sale has named resolves to the real wallet", () => {
  it("prefers the sale record over the kiosk's declared owner", async () => {
    const { store, run } = await load();
    store.initStore();
    store.saveKioskOwners("mainnet", [{ kiosk_id: KIOSK, owner: REAL, checkpoint: 500 }]);

    mockGqlQuery.mockResolvedValue({
      objects: { nodes: [kioskNft(DECLARED, KIOSK)], pageInfo: { hasNextPage: false } },
    });
    const r = await run({ type: "0xr1::a::B", mode: "nft", limit: 5, max_scan: 500 });

    expect(r.kiosk_resolved_from_sales).toBe(1);
    expect(r.kiosk_attributed).toBe(0);
    const holder = r.top_holders[0];
    expect(holder.address).toBe(REAL);
    expect(holder.holder_kind).toBe("kiosk_resolved");
    expect(holder.from_sale_records).toBe(1);
    // The declared owner must not appear at all: it was wrong.
    expect(r.top_holders.some((h: { address: string }) => h.address === DECLARED)).toBe(false);
  });

  it("falls back to the declared owner for a kiosk no sale has named", async () => {
    const { run } = await load();
    mockGqlQuery.mockResolvedValue({
      objects: { nodes: [kioskNft(DECLARED, KIOSK)], pageInfo: { hasNextPage: false } },
    });
    const r = await run({ type: "0xr2::a::B", mode: "nft", limit: 5, max_scan: 500 });
    expect(r.kiosk_resolved_from_sales).toBe(0);
    expect(r.top_holders[0].address).toBe(DECLARED);
    expect(r.top_holders[0].holder_kind).toBe("kiosk_declared");
  });

  /** Counts have to describe the same scan, or the caveat is about nothing. */
  it("keeps the kiosk counts consistent with what was scanned", async () => {
    const { store, run } = await load();
    store.initStore();
    store.saveKioskOwners("mainnet", [{ kiosk_id: KIOSK, owner: REAL, checkpoint: 500 }]);
    mockGqlQuery.mockResolvedValue({
      objects: {
        nodes: [plainNft(A), kioskNft(DECLARED, KIOSK), kioskNft(DECLARED, `0xzz${"9".repeat(62)}`)],
        pageInfo: { hasNextPage: false },
      },
    });
    const r = await run({ type: "0xr3::a::B", mode: "nft", limit: 5, max_scan: 500 });
    expect(r.total_scanned).toBe(3);
    expect(r.kiosk_held).toBe(2);
    expect(
      r.kiosk_resolved_from_sales + r.kiosk_attributed + (r.kiosk_unresolved ?? 0),
    ).toBe(r.kiosk_held);
  });

  /**
   * The tool's own caveat tells the caller to run get_nft_sales. A payload
   * cached under a key that ignores the mapping table made that instruction do
   * nothing for 24 hours.
   */
  it("does not serve a cached ranking after new mappings are learned", async () => {
    const { store, run } = await load();
    store.initStore();
    mockGqlQuery.mockResolvedValue({
      objects: { nodes: [kioskNft(DECLARED, KIOSK)], pageInfo: { hasNextPage: false } },
    });
    const args = { type: "0xr4::a::B", mode: "nft", limit: 5, max_scan: 500 };

    const before = await run(args);
    expect(before.top_holders[0].address).toBe(DECLARED);

    expect(await run(args)).toMatchObject({ cached: true });

    store.saveKioskOwners("mainnet", [{ kiosk_id: KIOSK, owner: REAL, checkpoint: 900 }]);
    const after = await run(args);
    expect(after.cached).toBe(false);
    expect(after.top_holders[0].address).toBe(REAL);
  });
});

describe("kiosk_owners storage", () => {
  it("reports rows actually written, not rows attempted", async () => {
    const { store } = await load();
    store.initStore();
    const rows = [{ kiosk_id: KIOSK, owner: REAL, checkpoint: 500 }];
    expect(store.saveKioskOwners("mainnet", rows)).toBe(1);
    // Same checkpoint: the ON CONFLICT clause rejects it, so nothing is written.
    expect(store.saveKioskOwners("mainnet", rows)).toBe(0);
    // Older: also rejected.
    expect(store.saveKioskOwners("mainnet", [{ ...rows[0]!, checkpoint: 400 }])).toBe(0);
    // Newer wins.
    expect(store.saveKioskOwners("mainnet", [{ ...rows[0]!, owner: A, checkpoint: 900 }])).toBe(1);
    expect(store.loadKioskOwners("mainnet", [KIOSK]).get(KIOSK)).toBe(A);
  });

  it("does not read another network's rows", async () => {
    const { store } = await load();
    store.initStore();
    store.saveKioskOwners("mainnet", [{ kiosk_id: KIOSK, owner: REAL, checkpoint: 1 }]);
    expect(store.loadKioskOwners("testnet", [KIOSK]).size).toBe(0);
  });
});

/**
 * A kiosk whose declared owner is unusable and which no sale has named belongs
 * to nobody this tool can name. It is still a kiosk-held NFT, so the three
 * kiosk numbers have to keep summing to `kiosk_held` — a reader checking that
 * would otherwise find it short with nothing saying why.
 */
describe("a kiosk nothing can resolve", () => {
  it("is counted in kiosk_unresolved, and the kiosk numbers still reconcile", async () => {
    const { run } = await load();
    mockGqlQuery.mockResolvedValue({
      objects: {
        nodes: [
          {
            owner: {
              address: {
                asObject: {
                  owner: {
                    address: {
                      address: KIOSK,
                      asObject: {
                        asMoveObject: {
                          contents: { type: { repr: KIOSK_TYPE }, json: { owner: { nested: true } } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const r = await run({ type: "0xr5::a::B", mode: "nft", limit: 5, max_scan: 500 });
    expect(r.kiosk_held).toBe(1);
    expect(r.kiosk_unresolved).toBe(1);
    expect(r.unresolved_owners).toBe(1);
    expect(
      r.kiosk_resolved_from_sales + r.kiosk_attributed + (r.kiosk_unresolved ?? 0),
    ).toBe(r.kiosk_held);
  });
});
