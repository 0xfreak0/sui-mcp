import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlPage, pagedTxConnection } from "./helpers/service-shapes.js";
import fixtures from "./fixtures/signatures.json" with { type: "json" };

/**
 * get_transaction_history: which end of an address's history a page starts
 * from, and whether each row is decoded from its whole balance-change list.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
/** A coin with no CoinMetadata answers NOT_FOUND over gRPC, which is what most test coins are. */
const mockGetCoinInfo = vi.fn();
vi.mock("../src/clients/grpc.js", () => ({ sui: { stateService: { getCoinInfo: mockGetCoinInfo } }, archive: {} }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
vi.mock("../src/protocols/registry.js", () => ({
  prefetchProtocolNames: async () => {},
  lookupProtocol: () => null,
  lookupProtocolDisplay: () => null,
  lookupOperation: () => null,
}));

const { registerHistoryTools } = await import("../src/tools/history.js");
const { ALIAS_AUTH_SAMPLE, resetAliasDelegateCache } = await import("../src/utils/identity.js");
const { resetLiveCoinScale } = await import("../src/utils/valuation.js");

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
  mockGetCoinInfo.mockReset();
  mockGetCoinInfo.mockRejectedValue(Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" }));
  resetAliasDelegateCache();
  resetLiveCoinScale();
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

describe("get_transaction_history coin scale", () => {
  /**
   * KONG has 1 decimal and is in no curated list. The history decode formats
   * its amounts at the decimals its CoinMetadata states, never at an assumed
   * scale.
   */
  it("formats a coin no curated list knows at its on-chain decimals", async () => {
    const KONG = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG";
    mockGetCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
      if (coinType === KONG) return { response: { metadata: { decimals: 1, symbol: "KONG" } } };
      throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
    });
    mockGqlQuery.mockResolvedValue(
      page([
        {
          digest: "5WEK9KPvK1NmZ91ZrEhYbTdzyaEz2ipzLbbmRnZs5WEA",
          sender: { address: SUBJECT },
          effects: {
            status: "SUCCESS",
            timestamp: "2024-09-26T07:00:00Z",
            balanceChanges: gqlPage([
              { coinType: { repr: KONG }, amount: "-7452793570", owner: { address: SUBJECT } },
              { coinType: { repr: KONG }, amount: "7452793570", owner: { address: REAL } },
            ]),
          },
          kind: { commands: gqlPage([]) },
        },
      ]),
    );
    const r = await run({ address: SUBJECT, limit: 1 });
    const out = JSON.stringify(r.transactions[0]);
    expect(out).toContain("745279357 KONG");
    expect(out).not.toContain("assumed scale");
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

    // All 200 were read. The row names 25 and counts the rest.
    expect(row.counterparty_count).toBe(200);
    expect(row.counterparties).toHaveLength(25);
    expect(row.counterparties[0].address).toBe(recipients[0]);
    // Behaviour, not wording: the note states the actual counts this row
    // computed (25 shown of 200 total), not a fixed phrase.
    expect(row.counterparties_note).toContain("25");
    expect(row.counterparties_note).toContain("200");
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
   * A PTB can run the same few calls hundreds of times. The row lists each
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

describe("get_transaction_history — alias-signed transactions", () => {
  /**
   * An alias signer's own page holds only what it received. `affectedAddress`
   * cannot surface the transactions it signed for its owner as an address
   * alias, because their sender and balance changes are all the owner's,
   * never the alias's.
   */
  it("lists transactions the address signed as an alias, separately from its own page", async () => {
    const alias = fixtures.ed25519.address;
    const owner = `0x${"d763".padEnd(64, "9")}`;
    mockGqlQuery.mockImplementation(async (q: string) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        return {
          objects: {
            nodes: [
              {
                owner: { address: { address: owner } },
                asMoveObject: { contents: { json: { aliases: { contents: [alias] } } } },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("o0:")) {
        return {
          o0: {
            nodes: [{ digest: "AliasSignedTx", effects: { timestamp: "2026-04-24T23:19:57.308Z" }, signatures: [{ signatureBytes: fixtures.ed25519.signatures[0] }] }],
          },
        };
      }
      return page([tx("received-sui", "2026-04-21T17:21:17Z", owner, [[alias, "1000000000"]])]);
    });
    const r = await run({ address: alias, limit: 10 });
    expect(r.transactions.map((t: { digest: string }) => t.digest)).toEqual(["received-sui"]);
    expect(r.signed_as_alias).toEqual([
      { digest: "AliasSignedTx", owner, timestamp: "2026-04-24T23:19:57.308Z", scheme: "ed25519" },
    ]);
    // Behaviour, not wording: the note reflects the actual sample size the
    // scan used, which is what changes if the bound is ever retuned.
    expect(r.signed_as_alias_note).toContain(String(ALIAS_AUTH_SAMPLE));
  });

  it("omits signed_as_alias when the address is not a delegate for anyone", async () => {
    const subject = SUBJECT;
    mockGqlQuery.mockImplementation(async (q: string) => {
      if (String(q).includes("address_alias::AddressAliases")) {
        return { objects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      return page([]);
    });
    const r = await run({ address: subject, limit: 10 });
    expect(r.signed_as_alias).toBeUndefined();
    expect(r.signed_as_alias_note).toBeUndefined();
  });

  it("does not run the alias scan again on a cursor page of the same address", async () => {
    const alias = fixtures.ed25519.address;
    const owner = `0x${"d763".padEnd(64, "9")}`;
    let scanCalls = 0;
    mockGqlQuery.mockImplementation(async (q: string) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        scanCalls++;
        return {
          objects: {
            nodes: [
              {
                owner: { address: { address: owner } },
                asMoveObject: { contents: { json: { aliases: { contents: [alias] } } } },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("o0:")) {
        return {
          o0: {
            nodes: [{ digest: "AliasSignedTx", effects: { timestamp: "2026-04-24T23:19:57.308Z" }, signatures: [{ signatureBytes: fixtures.ed25519.signatures[0] }] }],
          },
        };
      }
      return page(
        [tx("received-sui", "2026-04-21T17:21:17Z", owner, [[alias, "1000000000"]])],
        { hasPreviousPage: true, startCursor: "older-cursor" },
      );
    });

    const first = await run({ address: alias, limit: 10 });
    expect(first.signed_as_alias).toBeDefined();
    expect(scanCalls).toBe(1);

    const second = await run({ address: alias, limit: 10, cursor: first.next_cursor });
    expect(second.signed_as_alias).toBeUndefined();
    expect(scanCalls).toBe(1);
  });

  /**
   * A key removed from its owner's alias set can still be listed from the
   * cache, so the answer states when the scan read chain state, and that
   * time does not move on a cache hit.
   */
  it("states when the cached delegate scan was read, including on a later call served from the cache", async () => {
    const alias = fixtures.ed25519.address;
    const owner = `0x${"d763".padEnd(64, "9")}`;
    let now = Date.parse("2026-09-26T10:00:00Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let delegated = true;
    mockGqlQuery.mockImplementation(async (q: string) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        const nodes = delegated
          ? [{ owner: { address: { address: owner } }, asMoveObject: { contents: { json: { aliases: { contents: [alias] } } } } }]
          : [];
        return { objects: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      if (query.includes("o0:")) {
        return {
          o0: {
            nodes: [{ digest: "AliasSignedTx", effects: { timestamp: "2026-04-24T23:19:57.308Z" }, signatures: [{ signatureBytes: fixtures.ed25519.signatures[0] }] }],
          },
        };
      }
      return page([]);
    });
    try {
      const first = await run({ address: alias, limit: 10 });
      expect(first.alias_scan_as_of).toBe("2026-09-26T10:00:00.000Z");
      expect(first.signed_as_alias_note).toContain("read at 2026-09-26T10:00:00.000Z");
      expect(first.signed_as_alias_note).toMatch(/up to 5 minutes/);

      // The owner removes the key; two minutes later the cache still answers.
      delegated = false;
      now += 2 * 60_000;
      const second = await run({ address: alias, limit: 10 });
      expect(second.signed_as_alias).toBeDefined();
      expect(second.alias_scan_as_of).toBe("2026-09-26T10:00:00.000Z");
    } finally {
      clock.mockRestore();
    }
  });

  it("reports signed_as_alias_unavailable instead of reading a failed scan as 'not a delegate'", async () => {
    const alias = fixtures.ed25519.address;
    mockGqlQuery.mockImplementation(async (q: string) => {
      if (String(q).includes("address_alias::AddressAliases")) throw new Error("429 Too Many Requests");
      return page([]);
    });
    const r = await run({ address: alias, limit: 10 });
    expect(r.signed_as_alias).toBeUndefined();
    expect(r.signed_as_alias_unavailable).toBeDefined();
  });

  /**
   * The unavailable marker is emitted even when a row was found: a scan that
   * read page 1 of the AddressAliases objects (where one owner names this
   * key) and then failed on page 2 cannot present its page-1 match as found
   * by checking "every owner".
   */
  const aliasObject = (owner: string, delegate: string) => ({
    owner: { address: { address: owner } },
    asMoveObject: { contents: { json: { aliases: { contents: [delegate] } } } },
  });
  const signedByAlias = { nodes: [{ digest: "AliasSignedTx", effects: { timestamp: "2026-04-24T23:19:57.308Z" }, signatures: [{ signatureBytes: fixtures.ed25519.signatures[0] }] }] };

  it("marks rows found before a failed AddressAliases page as possibly incomplete", async () => {
    const alias = fixtures.ed25519.address;
    const owner = `0x${"d763".padEnd(64, "9")}`;
    mockGqlQuery.mockImplementation(async (q: string, v?: { after?: string | null }) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        if (v?.after) throw new Error("Rate-limited by graphql.mainnet.sui.io (HTTP 429) after 4 attempts.");
        return { objects: { nodes: [aliasObject(owner, alias)], pageInfo: { hasNextPage: true, endCursor: "page2" } } };
      }
      if (query.includes("o0:")) return { o0: signedByAlias };
      return page([]);
    });
    const r = await run({ address: alias, limit: 10 });
    expect(r.signed_as_alias).toHaveLength(1);
    expect(r.signed_as_alias_note).not.toMatch(/every owner/);
    expect(r.signed_as_alias_unavailable).toMatch(/may be incomplete/);
  });

  it("marks rows as possibly incomplete when one chunk of a custodian key's owners fails", async () => {
    const alias = fixtures.ed25519.address;
    // 21 owners name the key: two owner-transaction requests of 20 and 1.
    const owners = Array.from({ length: 21 }, (_, i) => `0x${String(i + 1).padStart(64, "a")}`);
    mockGqlQuery.mockImplementation(async (q: string) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        return { objects: { nodes: owners.map((o) => aliasObject(o, alias)), pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      if (query.includes("o0:")) {
        if (query.includes(owners[20])) throw new Error("Rate-limited by graphql.mainnet.sui.io (HTTP 429) after 4 attempts.");
        return Object.fromEntries(owners.slice(0, 20).map((_, j) => [`o${j}`, j === 0 ? signedByAlias : { nodes: [] }]));
      }
      return page([]);
    });
    const r = await run({ address: alias, limit: 10 });
    expect(r.signed_as_alias).toHaveLength(1);
    expect(r.signed_as_alias_unavailable).toMatch(/may be incomplete/);
  });

  it("keeps the complete-scan wording when every page and owner read succeeded", async () => {
    const alias = fixtures.ed25519.address;
    const owner = `0x${"d763".padEnd(64, "9")}`;
    mockGqlQuery.mockImplementation(async (q: string) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        return { objects: { nodes: [aliasObject(owner, alias)], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      if (query.includes("o0:")) return { o0: signedByAlias };
      return page([]);
    });
    const r = await run({ address: alias, limit: 10 });
    expect(r.signed_as_alias_note).toMatch(/every owner/);
    expect(r.signed_as_alias_unavailable).toBeUndefined();
  });
});
