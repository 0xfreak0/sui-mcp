import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlPage, pagedTxConnection } from "./helpers/service-shapes.js";

/**
 * get_transaction_history: which end of an address's history a page starts
 * from, and whether each row is decoded from its whole balance-change list.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
vi.mock("../src/protocols/registry.js", () => ({
  prefetchProtocolNames: async () => {},
  lookupProtocol: () => null,
  lookupProtocolDisplay: () => null,
  lookupOperation: () => null,
}));

const { registerHistoryTools } = await import("../src/tools/history.js");

type Args = { address: string; limit?: number; order?: "newest" | "oldest"; cursor?: string };
let handler: (a: Args) => Promise<{ content: { text: string }[] }>;
registerHistoryTools({
  tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
    handler = h;
  },
} as never);

const run = async (a: Args) => JSON.parse((await handler(a)).content[0].text);

const SUBJECT = `0x6b28df${"7".repeat(53)}04ac9`;
const REAL = `0x7a4c19${"8".repeat(53)}de50f`;
const FAKE = `0x7a41c6${"9".repeat(53)}de50f`;

const tx = (digest: string, timestamp: string, sender: string, changes: [string, string][]) => ({
  digest,
  sender: { address: sender },
  effects: {
    status: "SUCCESS",
    timestamp,
    balanceChanges: gqlPage(
      changes.map(([address, amount]) => ({ coinType: { repr: "0x2::sui::SUI" }, amount, owner: { address } })),
    ),
  },
  kind: { commands: gqlPage([]) },
});

/** A page as the service returns it for either direction: ascending, both page infos. */
const page = (nodes: unknown[], info: { hasPreviousPage?: boolean; startCursor?: string; hasNextPage?: boolean } = {}) => ({
  transactions: {
    nodes,
    pageInfo: {
      hasNextPage: info.hasNextPage ?? false,
      endCursor: "end",
      hasPreviousPage: info.hasPreviousPage ?? false,
      startCursor: info.startCursor ?? "start",
    },
  },
});

beforeEach(() => {
  mockGqlQuery.mockReset();
});

describe("get_transaction_history order", () => {
  it("starts at the most recent transaction and pages back in time", async () => {
    mockGqlQuery.mockResolvedValue(
      page(
        [
          tx("older", "2025-09-07T16:37:23.702Z", REAL, [[SUBJECT, "5"], [REAL, "-5"]]),
          tx("newer", "2025-11-05T20:51:56.870Z", REAL, [[SUBJECT, "5"], [REAL, "-5"]]),
        ],
        { hasPreviousPage: true, startCursor: "older-cursor" },
      ),
    );

    const r = await run({ address: SUBJECT, limit: 2 });

    const vars = mockGqlQuery.mock.calls[0][1];
    expect(vars.last).toBe(2);
    expect(vars.first).toBeUndefined();
    expect(r.transactions.map((t: { digest: string }) => t.digest)).toEqual(["newer", "older"]);
    expect(r.order).toBe("newest");
    expect(r.newest_shown).toBe("2025-11-05T20:51:56.870Z");
    expect(r.oldest_shown).toBe("2025-09-07T16:37:23.702Z");
    // The next page is OLDER, so the cursor is the page's start.
    expect(r.has_next_page).toBe(true);
    expect(r.next_cursor).toBe("older-cursor");
  });

  it("continues a newest-first walk with `before`", async () => {
    mockGqlQuery.mockResolvedValue(page([]));
    await run({ address: SUBJECT, limit: 10, cursor: "older-cursor" });
    const vars = mockGqlQuery.mock.calls[0][1];
    expect(vars.before).toBe("older-cursor");
    expect(vars.after).toBeUndefined();
  });

  it("walks forward from the first transaction with order: oldest", async () => {
    mockGqlQuery.mockResolvedValue(
      page([tx("first", "2023-06-08T00:00:00Z", REAL, [[SUBJECT, "5"], [REAL, "-5"]])], { hasNextPage: true }),
    );
    const r = await run({ address: SUBJECT, limit: 10, order: "oldest", cursor: "c1" });
    const vars = mockGqlQuery.mock.calls[0][1];
    expect(vars.first).toBe(10);
    expect(vars.after).toBe("c1");
    expect(r.order).toBe("oldest");
    expect(r.next_cursor).toBe("end");
  });

  it("checks address poisoning over recent activity, not the address's first page", async () => {
    // The service answers `first` with the address's genesis and `last` with
    // today's dust. Only the recent page carries the lookalike.
    mockGqlQuery.mockImplementation(async (_q: string, v: Record<string, unknown>) =>
      v.last
        ? page([
            tx("real", "2026-09-24T00:00:00Z", REAL, [[SUBJECT, "5000000000"], [REAL, "-5002000000"]]),
            tx("back", "2026-09-24T01:00:00Z", SUBJECT, [[SUBJECT, "-2000000000"], [REAL, "2000000000"]]),
            tx("dust", "2026-09-25T00:00:00Z", FAKE, [[SUBJECT, "1000000"], [FAKE, "-2097880"]]),
          ])
        : page([tx("genesis", "2023-06-08T00:00:00Z", REAL, [[SUBJECT, "5"], [REAL, "-5"]])]),
    );
    const r = await run({ address: SUBJECT, limit: 10 });
    expect(r.address_poisoning.pairs[0].suspect).toBe(FAKE);
  });
});

describe("get_transaction_history reads every balance change", () => {
  /** FujboNeQt8Nbb…: 202 balance changes, the payer's debit sorting after all 200 recipients. */
  it("decodes a transaction past its first page of balance changes", async () => {
    const digest = "FujboNeQt8NbbxzodUkhnna23DNQshKybq6ADLiokv8p";
    const recipients = Array.from({ length: 200 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);
    const all = [
      ...recipients.map((a) => ({ coinType: { repr: "0xc::my_coin::MY_COIN" }, amount: "1000", owner: { address: a } })),
      { coinType: { repr: "0x2::sui::SUI" }, amount: "-288999560", owner: { address: SUBJECT } },
      { coinType: { repr: "0xc::my_coin::MY_COIN" }, amount: "-200000", owner: { address: SUBJECT } },
    ];
    const conn = pagedTxConnection(digest, all, "balanceChanges");
    const node = {
      digest,
      sender: { address: SUBJECT },
      effects: { status: "SUCCESS", timestamp: "2025-11-05T20:51:56.870Z", balanceChanges: conn.first },
      kind: { commands: gqlPage([]) },
    };
    mockGqlQuery.mockImplementation(
      async (q: string, v: Record<string, unknown>) => conn.respond(q, v) ?? page([node]),
    );

    const r = await run({ address: SUBJECT, limit: 1 });
    const row = r.transactions[0];

    expect(row.counterparties).toHaveLength(200);
    expect(row.token_flow.map((f: { amount: string }) => f.amount).sort()).toEqual(["-200000", "-288999560"]);
    expect(r.incomplete_transactions).toBeUndefined();
  });

  it("names a row decoded from a partial list", async () => {
    const digest = "FujboNeQt8NbbxzodUkhnna23DNQshKybq6ADLiokv8p";
    const all = Array.from({ length: 60 }, (_, i) => ({
      coinType: { repr: "0x2::sui::SUI" },
      amount: "1",
      owner: { address: `0x${i.toString(16).padStart(64, "0")}` },
    }));
    const first = gqlPage(all.slice(0, 50), { hasNextPage: true, endCursor: "p1" });
    mockGqlQuery.mockImplementation(async (q: string) => {
      if (q.includes("transactionEffects(digest")) throw new Error("429 Too Many Requests");
      return page([
        {
          digest,
          sender: { address: SUBJECT },
          effects: { status: "SUCCESS", timestamp: "2025-11-05T20:51:56.870Z", balanceChanges: first },
          kind: { commands: gqlPage([]) },
        },
      ]);
    });

    const r = await run({ address: SUBJECT, limit: 1 });

    expect(r.incomplete_transactions).toEqual([
      { digest, balance_changes_truncated: true, commands_truncated: false },
    ]);
  });
});

describe("a row's actions", () => {
  /**
   * The Nemo exploit's CUedaeif… ran the same few calls hundreds of times, and
   * its one history row carried 46k characters of actions. The row lists each
   * distinct action once with its count; get_transaction keeps the sequence.
   */
  it("lists a repeated call once, with how many times it ran", async () => {
    const call = (fn: string) => ({
      __typename: "MoveCallCommand",
      function: { name: fn, module: { name: "market", package: { address: `0x${"ab".repeat(32)}` } } },
    });
    const commands = [call("init"), ...Array.from({ length: 48 }, (_, i) => call(i % 2 ? "swap" : "voucher")), call("done")];
    mockGqlQuery.mockResolvedValue(
      page([{ ...tx("drain", "2025-09-07T16:05:11.505Z", SUBJECT, [[SUBJECT, "5"]]), kind: { commands: gqlPage(commands) } }]),
    );
    const r = await run({ address: SUBJECT, limit: 1 });
    const actions: string[] = r.transactions[0].actions;
    expect(actions).toHaveLength(4);
    expect(actions[0]).toMatch(/::market::init$/);
    expect(actions[1]).toMatch(/::market::voucher ×24$/);
    expect(actions[2]).toMatch(/::market::swap ×24$/);
    expect(actions[3]).toMatch(/::market::done$/);
  });
});
