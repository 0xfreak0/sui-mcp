import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlPage } from "./helpers/service-shapes.js";

/**
 * A coin can be held in two places: `Coin<T>` objects, and the owner's address
 * balance, which is a dynamic field of the accumulator root and not a coin
 * object at all. Walking coins alone ranked XAGM as complete while leaving out
 * its #2 holder (0xd70a55ed…, 13.74% of supply, all of it in the address
 * balance), and scanned USAD, whose whole supply sits in one address balance,
 * as an NFT collection with no holders.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({
  sui: { stateService: { getCoinInfo: async () => ({ response: { treasury: { totalSupply: "1000" } } }) } },
  archive: {},
}));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));

const { registerHolderTools } = await import("../src/tools/holders.js");

type Args = { type?: string; mode?: string; limit?: number; max_scan?: number };
let handler: (a: Args) => Promise<{ content: { text: string }[] }>;
registerHolderTools({
  tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
    if (n === "get_top_holders") handler = h;
  },
} as never);
const run = async (a: Args) => JSON.parse((await handler(a)).content[0].text);

const A = `0xaa${"1".repeat(62)}`;
const B = `0xbb${"2".repeat(62)}`;
const C = `0xcc${"3".repeat(62)}`;
/** A sui bridge liquidity_pool::Bank, which holds USDC and SUI in its own address balance. */
const BANK = "0x44cf357eda762cf0cd86547f7bfcaa51a4b55de615c57903ab461f38ffed4b4b";
const BANK_TYPE = "0x58978a0c0678f010ff0ced45da75bf76f2cc33b96508c9a616dc547651f78341::liquidity_pool::Bank";

const coin = (owner: string, balance: string) => ({
  owner: { address: { address: owner } },
  asMoveObject: { contents: { json: { balance } } },
});

/** Shape captured from mainnet: the field id, the owner in `name.address`, the amount in `value.value`. */
let fieldSeq = 0;
const balanceEntry = (owner: string, value: string) => {
  const id = `0x${(++fieldSeq).toString(16).padStart(64, "0")}`;
  return { asMoveObject: { contents: { json: { id, name: { address: owner }, value: { value } } } } };
};

interface Page {
  objects: unknown;
}
const page = (nodes: unknown[], opts?: { hasNextPage?: boolean; endCursor?: string }): Page => ({
  objects: gqlPage(nodes, opts),
});

/**
 * Route each query to the answer the service gives it. The coin walk and the
 * address-balance walk are separate connections, any other type is the NFT
 * walk and finds nothing, and identity lookups are multi-gets whose entries
 * mirror the keys, null meaning nothing lives there.
 */
function chain(o: {
  coins?: (after?: string) => Page;
  balances?: (after?: string) => Page;
  objects?: Record<string, unknown>;
  probe?: Partial<Record<"coin" | "addressBalance" | "metadata" | "currency", unknown[]>>;
}) {
  mockGqlQuery.mockImplementation(
    (query: string, vars: { type?: string; after?: string; keys?: { address: string }[] }) => {
      if (query.includes("multiGetAddresses")) {
        return Promise.resolve({
          multiGetAddresses: vars.keys!.map((k) => ({ address: k.address, objects: { nodes: [] } })),
        });
      }
      if (query.includes("multiGetObjects")) {
        return Promise.resolve({ multiGetObjects: vars.keys!.map((k) => o.objects?.[k.address] ?? null) });
      }
      if (query.includes("addressBalance:")) {
        const hit = (k: "coin" | "addressBalance" | "metadata" | "currency") => ({
          nodes: (o.probe?.[k] ?? []).map((address) => ({ address })),
        });
        return Promise.resolve({
          coin: hit("coin"),
          addressBalance: hit("addressBalance"),
          metadata: hit("metadata"),
          currency: hit("currency"),
        });
      }
      if (vars.type?.startsWith("0x2::coin::Coin<")) return Promise.resolve((o.coins ?? (() => page([])))(vars.after));
      if (vars.type?.includes("::accumulator::Key<")) {
        return Promise.resolve((o.balances ?? (() => page([])))(vars.after));
      }
      // Any other type is the NFT walk, and none of these tests has a collection.
      if (vars.type) return Promise.resolve(page([]));
      return Promise.reject(new Error(`unrouted query: ${query}`));
    },
  );
}

beforeEach(() => {
  mockGqlQuery.mockReset();
});

describe("address balances are part of the ranking", () => {
  it("merges them into the per-holder total and keeps the split", async () => {
    chain({
      coins: () => page([coin(A, "200"), coin(A, "100"), coin(B, "50")]),
      balances: () => page([balanceEntry(C, "500"), balanceEntry(A, "25")]),
    });
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 1000 });

    expect(r.complete_ranking).toBe(true);
    expect(r.coin_objects_scanned).toBe(3);
    expect(r.address_balances_scanned).toBe(2);
    expect(r.unique_holders).toBe(3);
    expect(r.top_holders.map((h: { address: string }) => h.address)).toEqual([C, A, B]);
    // C holds nothing in coin objects and still ranks first.
    expect(r.top_holders[0]).toMatchObject({
      rank: 1,
      balance: "500",
      coin_balance: "0",
      address_balance: "500",
      count: 0,
      percentage: "50.0000%",
    });
    expect(r.top_holders[1]).toMatchObject({ balance: "325", coin_balance: "300", address_balance: "25", count: 2 });
  });

  it("is not a complete ranking when the address-balance walk stops at a null cursor", async () => {
    let calls = 0;
    chain({
      coins: () => page([coin(A, "300")]),
      balances: () => {
        calls++;
        return { objects: { nodes: [balanceEntry(B, "10")], pageInfo: { hasNextPage: true, endCursor: null } } };
      },
    });
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 1001 });

    expect(calls).toBe(1);
    expect(r.coin_walk_truncated).toBe(false);
    expect(r.address_balance_walk_truncated).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.complete_ranking).toBe(false);
    expect(r.top_holders).toBeUndefined();
    expect(r.sampled_holders[0].percentage).toBeUndefined();
    expect(r.caveat).toMatch(/address-balance walk after 1 entries/);
  });

  it("is not a complete ranking when the address-balance walk runs out of budget", async () => {
    let n = 0;
    chain({
      coins: () => page([coin(A, "300")]),
      balances: () => {
        n++;
        return page([balanceEntry(`0x${n.toString(16).padStart(64, "0")}`, "1")], {
          hasNextPage: true,
          endCursor: `c${n}`,
        });
      },
    });
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 3 });

    expect(r.coin_walk_truncated).toBe(false);
    expect(r.address_balance_walk_truncated).toBe(true);
    expect(r.address_balances_scanned).toBe(3);
    expect(r.complete_ranking).toBe(false);
  });

  it("counts a coin held only in address balances instead of reporting nothing found", async () => {
    chain({ balances: () => page([balanceEntry(A, "1000")]) });
    const r = await run({ type: "0xabc::usad::USAD", mode: "token", limit: 5, max_scan: 1000 });

    expect(r.complete_ranking).toBe(true);
    expect(r.coin_objects_scanned).toBe(0);
    expect(r.top_holders[0]).toMatchObject({ address: A, balance: "1000", coin_balance: "0", address_balance: "1000" });
  });
});

describe("auto mode knows a coin that has no coin objects", () => {
  it("scans a type with only an address-balance entry as a token", async () => {
    chain({
      probe: { addressBalance: ["0x66e49907aaf279b9e4274365fd434447da0ac9b308ed27b767595fb3e0034164"] },
      balances: () => page([balanceEntry(A, "1000")]),
    });
    const r = await run({ type: "0xab1::usad::USAD", limit: 5, max_scan: 1000 });

    expect(r.mode).toBe("token");
    expect(r.top_holders[0]).toMatchObject({ address: A, address_balance: "1000" });
  });

  it("scans a type with coin metadata but no holders as a token", async () => {
    chain({ probe: { metadata: ["0x77cccd4aeba30013290ce819b1a38899dd1e9961e9fa570084ecef216159db8f"] } });
    const r = await run({ type: "0xab2::fresh::FRESH", limit: 5, max_scan: 1000 });

    expect(r.mode).toBe("token");
    expect(r.complete_ranking).toBe(false);
    expect(r.caveat).toMatch(/no address balances/);
  });

  it("still scans a type the chain knows as none of these as a collection", async () => {
    chain({ probe: {} });
    const r = await run({ type: "0xab3::art::Piece", limit: 5, max_scan: 1000 });

    expect(r.mode).toBe("nft");
  });
});

describe("a holder is not assumed to be a wallet", () => {
  it("reports an object holding an address balance as an object, with its type", async () => {
    chain({
      coins: () => page([coin(A, "10")]),
      balances: () => page([balanceEntry(BANK, "900")]),
      objects: {
        [BANK]: { address: BANK, asMovePackage: null, asMoveObject: { contents: { type: { repr: BANK_TYPE } } } },
      },
    });
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 1002 });

    expect(r.top_holders[0]).toMatchObject({ address: BANK, owner_kind: "object", object_type: BANK_TYPE });
    expect(r.top_holders[1]).toMatchObject({ address: A, owner_kind: "wallet" });
    expect(r.top_holders[1].object_type).toBeUndefined();
  });
});
