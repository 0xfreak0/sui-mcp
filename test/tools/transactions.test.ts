import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import { pagedTxConnection } from "../helpers/service-shapes.js";
import fixture from "../fixtures/address-balance-txs.json" with { type: "json" };
import scallop from "../fixtures/scallop-exploit-ptb.json" with { type: "json" };

/**
 * A real mainnet digest. get_transaction rejects a malformed one before making
 * any request, so a placeholder like "TxDigest123" never reaches the
 * handler under test.
 */
const TEST_DIGEST = "6rbfmByTyP4k7EREQBV9XZNhaG4RPm2ExT5bhVDfhGpu";
/** A second one, so the archive case stays distinguishable from the fullnode case. */
const ARCHIVED_DIGEST = "CBjycKjVXizZ2VcxVjE2u6xBhP8YJgSgLziZA7N7crXK";

const mockSui = createMockClient();
const mockArchive = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockArchive,
}));

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: mockGqlQuery,
}));

const { registerTransactionTools } = await import("../../src/tools/transactions.js");
const { registerDecodeTools } = await import("../../src/tools/decode.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerTransactionTools(mockServer);
registerDecodeTools(mockServer);

// Coin-scale prefetch runs before every decode. Tests that do not care
// about decimals get a coin with no CoinMetadata, which takes the
// "unknown, fall back to the symbol guess" path.
mockSui.stateService.getCoinInfo.mockResolvedValue({ response: {} });

describe("get_transaction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns decoded transaction with protocol info", async () => {
    mockSui.ledgerService.getTransaction.mockResolvedValue({
      response: {
        transaction: {
          digest: TEST_DIGEST,
          timestamp: { seconds: 1700000000n, nanos: 0 },
          checkpoint: 50000n,
          transaction: {
            sender: "0xsender",
            kind: {
              data: {
                oneofKind: "programmableTransaction",
                programmableTransaction: {
                  commands: [
                    {
                      command: {
                        oneofKind: "moveCall",
                        moveCall: {
                          package: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
                          module: "pool",
                          function: "swap_a2b",
                          typeArguments: [
                            "0x2::sui::SUI",
                            "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          effects: {
            status: { success: true },
            gasUsed: {
              computationCost: 1000n,
              storageCost: 2000n,
              storageRebate: 500n,
              nonRefundableStorageFee: 100n,
            },
            epoch: 500n,
          },
          events: { events: [] },
          balanceChanges: [
            { address: "0xsender", coinType: "0x2::sui::SUI", amount: "-1000000000" },
            { address: "0xsender", coinType: "0xdba::usdc::USDC", amount: "500000" },
          ],
        },
      },
    });

    const handler = tools.get("get_transaction")!;
    const result = await handler({ digest: TEST_DIGEST });
    const data = JSON.parse(result.content[0].text);

    expect(data.digest).toBe(TEST_DIGEST);
    expect(data.sender).toBe("0xsender");
    expect(data.status).toBe("success");
    expect(data.protocols).toContain("Cetus");
    expect(data.actions[0]).toContain("Swap");
    expect(data.token_flow).toHaveLength(2);
    expect(data.gas.computation_cost).toBe("1000");
  });

  it("falls back to archive on fullnode error", async () => {
    mockSui.ledgerService.getTransaction.mockRejectedValue(new Error("not found"));
    mockArchive.ledgerService.getTransaction.mockResolvedValue({
      response: {
        transaction: {
          digest: ARCHIVED_DIGEST,
          transaction: { sender: "0xsender", kind: { data: { oneofKind: undefined } } },
          effects: { status: { success: true } },
          events: { events: [] },
          balanceChanges: [],
        },
      },
    });

    const handler = tools.get("get_transaction")!;
    const result = await handler({ digest: ARCHIVED_DIGEST });
    const data = JSON.parse(result.content[0].text);

    expect(data.digest).toBe(ARCHIVED_DIGEST);
    expect(mockArchive.ledgerService.getTransaction).toHaveBeenCalled();
  });
});

describe("get_transaction detail 'full' and decode_ptb by digest", () => {
  /**
   * The Scallop spool exploit, mainnet 6WNDjCX3…: update_points (command 5)
   * received a dormant sWETH spool while stake (command 4) received the sSUI
   * spool. No event names the spool update_points read, so the argument is
   * the only place the donor shows.
   */
  const DONOR_SPOOL = "0xeec40beccb07c575bebd842eeaabb835f77cd3dab73add433477e57f583a6787";
  const SSUI_SPOOL = "0x4f0ba970d3c11db05c8f40c64a15b6a33322db3702d634ced6536960ab6f3ee4";
  const ATTACKER_ACCOUNT = "0x2a710b62bf4f905546489d6f9bc4428b0dfba92532a7c04be519e97cdc0fbda0";
  const big = (v?: string) => (v === undefined ? undefined : BigInt(v));
  const response = {
    transaction: {
      digest: scallop.digest,
      transaction: {
        sender: "0x27bc7a3c4f406cfa91551c32490ad7f5029414578c0649ab4ddbd232e76ef44e",
        bcs: { name: "TransactionData", value: Buffer.from(scallop.transaction_bcs, "base64") },
        kind: { data: { oneofKind: "programmableTransaction", programmableTransaction: { inputs: [], commands: [] } } },
      },
      effects: {
        status: scallop.status,
        changedObjects: scallop.changedObjects.map((c) => ({ ...c, inputVersion: big(c.inputVersion), outputVersion: big(c.outputVersion) })),
        unchangedConsensusObjects: scallop.unchangedConsensusObjects.map((u) => ({ ...u, version: big(u.version) })),
      },
      events: { events: [] },
      balanceChanges: [],
    },
  };
  const functions = scallop.functions as Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSui.ledgerService.getTransaction.mockResolvedValue({ response });
    mockSui.getMoveFunction.mockImplementation(async ({ packageId, moduleName, name }: Record<string, string>) => {
      const f = functions[`${packageId}::${moduleName}::${name}`];
      if (!f) throw new Error("function not found");
      return { function: f };
    });
  });

  it("shows the object each command received, and the changed objects' ids by kind", async () => {
    const data = JSON.parse((await tools.get("get_transaction")!({ digest: scallop.digest, detail: "full" })).content[0].text);

    expect(data.commands[5].target).toMatch(/::user::update_points$/);
    expect(data.commands[5].arguments[0]).toEqual({
      type: "Input",
      index: 5,
      object_id: DONOR_SPOOL,
      version: "849862370",
      object_type: "spool::Spool",
    });
    expect(data.commands[4].target).toMatch(/::user::stake$/);
    expect(data.commands[4].arguments[0].object_id).toBe(SSUI_SPOOL);
    // The account update_points wrote into is the one new_spool_account made.
    expect(data.commands[5].arguments[1]).toMatchObject({ type: "NestedResult", result: 3, from: "user::new_spool_account" });
    expect(data.commands[3].returns[0]).toMatch(/::spool_account::SpoolAccount</);
    expect(data.commands[0].amounts[0]).toMatchObject({ value_type: "u64", value: "200000000" });

    expect(data.inputs[5]).toMatchObject({
      type: "SharedObject",
      object_id: DONOR_SPOOL,
      initial_shared_version: "73801626",
      object_type: "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a::spool::Spool",
    });

    expect(data.object_changes).toMatchObject({ changed: 7, created: 3, deleted: 0 });
    expect(data.object_changes.by_kind.created.map((o: { object_id: string }) => o.object_id)).toContain(ATTACKER_ACCOUNT);
    expect(data.object_changes.by_kind.mutated).toContainEqual({
      object_id: DONOR_SPOOL,
      type: "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a::spool::Spool",
      version: "856036007",
    });
  });

  it("leaves inputs, commands and object ids out by default", async () => {
    const data = JSON.parse((await tools.get("get_transaction")!({ digest: scallop.digest })).content[0].text);
    expect(data.commands).toBeUndefined();
    expect(data.inputs).toBeUndefined();
    expect(data.object_changes).toEqual({ changed: 7, created: 3, deleted: 0 });
  });

  it("decode_ptb resolves an executed transaction's PTB the way get_transaction does", async () => {
    const full = JSON.parse((await tools.get("get_transaction")!({ digest: scallop.digest, detail: "full" })).content[0].text);
    const decoded = JSON.parse((await tools.get("decode_ptb")!({ digest: scallop.digest })).content[0].text);
    expect(decoded.status).toBe("success");
    expect(decoded.commands).toEqual(full.commands);
    expect(decoded.inputs).toEqual(full.inputs);
  });

  it("narrows events, inputs and changed objects to the picked commands and counts the rest", async () => {
    const MINT = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
    const SPOOL = "0xec1ac7f4d01c5bf178ff4e62e523e7df7721453d81d4904a42a0ffc2686c843d";
    // Emission order: mint (command 1), two from the `user` module that
    // commands 3 to 7 all call, then redeem (command 8).
    const events = [
      { packageId: MINT, module: "mint", eventType: `${MINT}::mint::MintEvent`, sender: response.transaction.transaction.sender },
      { packageId: SPOOL, module: "user", eventType: `${SPOOL}::user::StakeEvent`, sender: response.transaction.transaction.sender },
      { packageId: SPOOL, module: "user", eventType: `${SPOOL}::user::RedeemEvent`, sender: response.transaction.transaction.sender },
      { packageId: MINT, module: "redeem", eventType: `${MINT}::redeem::RedeemEvent`, sender: response.transaction.transaction.sender },
    ];
    mockSui.ledgerService.getTransaction.mockResolvedValue({ response: { transaction: { ...response.transaction, events: { events } } } });
    const run = async (commands: number[]) =>
      JSON.parse((await tools.get("get_transaction")!({ digest: scallop.digest, detail: "full", commands })).content[0].text);

    const ends = await run([1, 8]);
    expect(ends.events.map((e: { command: number }) => e.command)).toEqual([1, 8]);
    expect(ends.events_omitted).toMatchObject({ count: 2, from_commands: [3, 4, 5, 6, 7] });
    expect(ends.events_omitted.next_call.args).toEqual({ digest: scallop.digest, detail: "full" });
    expect(ends.truncated).toBe(true);

    // The `user` events can have come from any of commands 3 to 7, so a pick
    // of command 5 keeps both and names every command they can belong to.
    const update = await run([5]);
    expect(update.events.map((e: { commands: number[] }) => e.commands)).toEqual([
      [3, 4, 5, 6, 7],
      [3, 4, 5, 6, 7],
    ]);
    expect(update.events_omitted.count).toBe(2);
    // update_points takes the donor spool (input 5) and the account command 3
    // made; only its inputs are listed, each with its index.
    expect(update.inputs.map((i: { index: number }) => i.index)).toContain(5);
    expect(update.inputs.find((i: { index: number }) => i.index === 5).object_id).toBe(DONOR_SPOOL);
    expect(update.inputs.length + update.inputs_omitted.count).toBe(ends.inputs.length + ends.inputs_omitted.count);
    expect(update.object_changes.by_kind.mutated.map((o: { object_id: string }) => o.object_id)).toEqual([DONOR_SPOOL]);
    expect(update.object_changes_omitted.count).toBeGreaterThan(0);
  });

  /**
   * For random event counts per command and random event sizes, with the
   * store off: following `events_page.next_call` from the first full call
   * lists every event exactly once, including when one command's events alone
   * pass the page budget, and with a `commands` pick every event those
   * commands can have emitted.
   */
  it("pages full-view events by position so next_call reaches every event exactly once", async () => {
    const MINT = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
    const SPOOL = "0xec1ac7f4d01c5bf178ff4e62e523e7df7721453d81d4904a42a0ffc2686c843d";
    const sender = response.transaction.transaction.sender;
    let seed = 7;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let round = 0; round < 25; round++) {
      // Emission order: mint (command 1), then `user` (commands 3 to 7), then redeem (command 8).
      const groups: Array<[string, string]> = [
        [MINT, "mint"],
        [SPOOL, "user"],
        [MINT, "redeem"],
      ];
      const events: Array<{ packageId: string; module: string; eventType: string; sender: string; id: number; pad: string }> = [];
      for (const [pkg, module] of groups) {
        const n = Math.floor(rand() * (round % 5 === 0 ? 400 : 60));
        for (let k = 0; k < n; k++) {
          events.push({ packageId: pkg, module, eventType: `${pkg}::${module}::E`, sender, id: events.length, pad: "x".repeat(Math.floor(rand() * 1200)) });
        }
      }
      mockSui.ledgerService.getTransaction.mockResolvedValue({
        response: { transaction: { ...response.transaction, events: { events: events.map(({ id: _id, pad: _pad, ...e }) => e) } } },
      });
      mockGqlQuery.mockImplementation(async (q: string) =>
        q.includes("events(first")
          ? {
              transaction: {
                effects: {
                  events: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: events.map((e) => ({ contents: { type: { repr: e.eventType }, json: { id: e.id, pad: e.pad } } })),
                  },
                },
              },
            }
          : {},
      );
      const pick = rand() < 0.4 ? [1 + Math.floor(rand() * 8)] : undefined;
      const expected = events
        .filter((e) => !pick || (e.module === "mint" ? [1] : e.module === "user" ? [3, 4, 5, 6, 7] : [8]).includes(pick[0]))
        .map((e) => e.id);

      const seen: number[] = [];
      let args: Record<string, unknown> | undefined = { digest: scallop.digest, detail: "full", ...(pick ? { commands: pick } : {}) };
      for (let calls = 0; args && calls < 200; calls++) {
        const data = JSON.parse((await tools.get("get_transaction")!(args)).content[0].text);
        seen.push(...data.events.map((e: { parsed: { id: number } }) => e.parsed.id));
        expect(JSON.stringify(data.events).length).toBeLessThan(45_000);
        if (pick && data.events_omitted) expect(data.events_omitted.next_call.args.commands).toBeUndefined();
        args = data.events_page?.next_call?.args;
      }
      expect(args).toBeUndefined();
      expect(seen).toEqual(expected);
    }
  });
});

describe("query_transactions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns filtered transactions from GraphQL", async () => {
    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: [
          {
            digest: "Tx1",
            sender: { address: "0xsender" },
            effects: {
              status: "SUCCESS",
              checkpoint: { sequenceNumber: 100 },
              timestamp: "2024-01-01T00:00:00Z",
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
      },
    });

    const handler = tools.get("query_transactions")!;
    const result = await handler({
      sender: "0xsender",
      affected_address: undefined,
      affected_object: undefined,
      function: undefined,
      after_checkpoint: undefined,
      before_checkpoint: undefined,
      limit: 10,
      after: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0].digest).toBe("Tx1");
    expect(data.has_next_page).toBe(false);
  });

  it("rejects multiple exclusive filters", async () => {
    const handler = tools.get("query_transactions")!;
    const result = await handler({
      sender: undefined,
      affected_address: "0xaddr",
      affected_object: "0xobj",
      function: undefined,
      after_checkpoint: undefined,
      before_checkpoint: undefined,
      limit: undefined,
      after: undefined,
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("Only one of");
  });

  const V1 = `0x${"1".repeat(64)}`;
  const V2 = `0x${"2".repeat(64)}`;
  const V3 = `0x${"3".repeat(64)}`;
  const versionsPage = (ids: string[]) => ({
    packageVersions: {
      nodes: ids.map((address, i) => ({ address, version: i + 1 })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  const qtx = (digest: string, cp: number) => ({
    digest,
    sender: { address: "0xsender" },
    effects: { status: "SUCCESS", checkpoint: { sequenceNumber: cp }, timestamp: new Date(cp * 1000).toISOString() },
  });
  const emptyTxPage = {
    transactions: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
    },
  };

  /**
   * A function filter matches calls through ONE package version, and each
   * version of an upgraded package holds its own share of the calls.
   */
  it("names the other versions of a function filter's package", async () => {
    mockGqlQuery.mockImplementation(async (q: string) =>
      q.includes("packageVersions") ? versionsPage([V1, V2, V3]) : emptyTxPage,
    );
    const handler = tools.get("query_transactions")!;
    const data = JSON.parse((await handler({ function: `${V1}::pool::swap` })).content[0].text);
    expect(data.function_scope).toMatchObject({ version: 1, version_count: 3, original_package: V1 });
    expect(data.function_scope.note).toMatch(/all_versions/);
  });

  it("reads every version of the lineage with all_versions, as one newest-first list", async () => {
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => {
      if (q.includes("packageVersions")) return versionsPage([V1, V2]);
      // One aliased connection per version, ascending like any `last:` page.
      const byVersion: Record<string, unknown[]> = {
        [`${V1}::pool::swap`]: [qtx("old-v1", 100), qtx("mid-v1", 300)],
        [`${V2}::pool::swap`]: [qtx("v2-a", 200), qtx("v2-b", 400)],
      };
      const out: Record<string, unknown> = {};
      for (const k of [0, 1]) {
        const fn = (v[`f${k}`] as { function: string }).function;
        out[`v${k}`] = {
          edges: (byVersion[fn] ?? []).map((node) => ({ cursor: `c-${(node as { digest: string }).digest}`, node })),
          pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
        };
      }
      return out;
    });
    const handler = tools.get("query_transactions")!;
    const data = JSON.parse(
      (await handler({ function: `${V1}::pool::swap`, all_versions: true, limit: 3 })).content[0].text,
    );

    expect(data.transactions.map((t: { digest: string }) => t.digest)).toEqual(["v2-b", "mid-v1", "v2-a"]);
    expect(data.versions_read).toHaveLength(2);
    // One call left unread in version 1, so there is a next page.
    expect(data.has_next_page).toBe(true);
    expect(typeof data.next_cursor).toBe("string");
  });

  /**
   * One document aliasing all 12 versions of a lineage exceeds the service's
   * 300-node cap. The service counts every field of every alias, so 10 fit
   * without commands and 5 with them.
   */
  it.each([
    [false, 10],
    [true, 5],
  ])("keeps each all_versions request under the service's node cap (include_functions %s)", async (includeFunctions, cap) => {
    const ids = Array.from({ length: 12 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);
    const seen: number[] = [];
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => {
      if (q.includes("packageVersions")) return versionsPage(ids);
      const aliases = Object.keys(v).filter((k) => /^f\d+$/.test(k)).length;
      seen.push(aliases);
      if (aliases > cap) throw new Error("GraphQL error: Query has over 300 nodes");
      const out: Record<string, unknown> = {};
      for (let k = 0; k < aliases; k++) {
        out[`v${k}`] = { edges: [], pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } };
      }
      return out;
    });
    const handler = tools.get("query_transactions")!;
    const result = await handler({ function: `${ids[0]}::pool::swap`, all_versions: true, include_functions: includeFunctions });
    expect(result.isError).toBeFalsy();
    expect(seen.reduce((a, b) => a + b, 0)).toBe(12);
  });

  it("lists every Move call of a transaction past the first page of commands", async () => {
    const digest = "FujboNeQt8NbbxzodUkhnna23DNQshKybq6ADLiokv8p";
    const commands = Array.from({ length: 60 }, (_, i) => ({
      __typename: "MoveCallCommand",
      function: { name: `f${i}`, module: { name: "m", package: { address: i < 55 ? V1 : V2 } } },
    }));
    const conn = pagedTxConnection(digest, commands, "commands");
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => {
      const more = conn.respond(q, v);
      if (more) return more;
      if (q.includes("packageVersions")) return versionsPage([V1, V2]);
      return {
        transactions: {
          nodes: [{ ...qtx(digest, 100), kind: { commands: conn.first } }],
          pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
        },
      };
    });
    const handler = tools.get("query_transactions")!;
    const data = JSON.parse(
      (await handler({ function: `${V1}::m`, include_functions: true })).content[0].text,
    );
    expect(data.transactions[0].move_calls).toHaveLength(60);
    expect(data.transactions[0].matched_calls).toBe(55);
  });

  // A filter is matched at its own granularity: other calls into the same
  // package are part of the PTB, not of the match.
  it.each([
    [`${V1}::m::f3`, 1],
    [`${V1}::m`, 2],
    [V1, 3],
  ])("counts as matched only the calls the filter %s names", async (filter, matched) => {
    const digest = "FujboNeQt8NbbxzodUkhnna23DNQshKybq6ADLiokv8p";
    const call = (pkg: string, module: string, name: string) => ({
      __typename: "MoveCallCommand",
      function: { name, module: { name: module, package: { address: pkg } } },
    });
    const commands = [call(V1, "m", "f3"), call(V1, "m", "f4"), call(V1, "other", "f3"), call(V2, "m", "f3")];
    const conn = pagedTxConnection(digest, commands, "commands");
    mockGqlQuery.mockImplementation(async (q: string) => {
      if (q.includes("packageVersions")) return versionsPage([V1]);
      return {
        transactions: {
          nodes: [{ ...qtx(digest, 100), kind: { commands: conn.first } }],
          pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
        },
      };
    });
    const handler = tools.get("query_transactions")!;
    const data = JSON.parse((await handler({ function: filter, include_functions: true })).content[0].text);
    expect(data.transactions[0].total_calls).toBe(4);
    expect(data.transactions[0].matched_calls).toBe(matched);
  });
});

/**
 * What the tool says when a transaction moved no coin.
 *
 * These assert on the handler's output rather than on the helpers it calls,
 * so a handler that reports an owner as a bare address, without its kind,
 * fails here.
 */
describe("get_transaction reports what a transaction touched", () => {
  const EMPTY = "F7xprc5y7LmkzMQqRjaEWexzupdtFTSPUXoF49GNepjY";

  /** A transaction with no commands, whose one changed object is its own gas coin. */
  function emptyTx(overrides: Record<string, unknown> = {}) {
    return {
      response: {
        transaction: {
          digest: EMPTY,
          timestamp: { seconds: 1700000000n, nanos: 0 },
          checkpoint: 50000n,
          transaction: {
            sender: "0xsender",
            kind: {
              data: {
                oneofKind: "programmableTransaction",
                programmableTransaction: { inputs: [], commands: [] },
              },
            },
          },
          effects: {
            status: { success: true },
            gasUsed: { computationCost: 1n, storageCost: 1n, storageRebate: 1n, nonRefundableStorageFee: 1n },
            epoch: 500n,
            changedObjects: [
              {
                objectId: "0xgascoin",
                objectType: "0x2::coin::Coin<0x2::sui::SUI>",
                idOperation: 1,
                inputState: 2,
                inputOwner: { kind: 1, address: "0xsender" },
                outputOwner: { kind: 1, address: "0xsender" },
              },
            ],
            ...(overrides.effects as object ?? {}),
          },
          events: { events: [] },
          balanceChanges: [],
        },
      },
    };
  }

  const run = async (payload: unknown, digest = EMPTY) => {
    mockSui.ledgerService.getTransaction.mockResolvedValue(payload);
    mockGqlQuery.mockResolvedValue({ transactionBlock: null });
    const r = await tools.get("get_transaction")!({ digest, max_event_field_bytes: 0 });
    return JSON.parse(r.content[0].text);
  };

  it("reports a command count of zero rather than only an empty actions list", async () => {
    const j = await run(emptyTx());
    expect(j.command_count).toBe(0);
    expect(j.actions).toEqual([]);
    expect(j.empty_transaction_note).toMatch(/ran no commands/);
  });

  it("counts the objects it touched", async () => {
    const j = await run(emptyTx());
    expect(j.object_changes).toEqual({ changed: 1, created: 0, deleted: 0 });
  });

  /**
   * A kiosk-held NFT is owned by the Kiosk object, so a sale between two
   * kiosks names both parties with the `object` kind rather than as wallets.
   */
  it("names each party's owner KIND, so a kiosk is not reported as a wallet", async () => {
    const kioskSale = emptyTx({
      effects: {
        status: { success: true },
        gasUsed: { computationCost: 1n, storageCost: 1n, storageRebate: 1n, nonRefundableStorageFee: 1n },
        epoch: 500n,
        changedObjects: [
          {
            objectId: "0xnft",
            objectType: "0xabc::popkins_nft::Popkins",
            idOperation: 1,
            inputState: 2,
            inputOwner: { kind: 2, address: "0xsellerkiosk" },
            outputOwner: { kind: 2, address: "0xbuyerkiosk" },
          },
        ],
      },
    });
    const j = await run(kioskSale);
    expect(j.object_transfers).toHaveLength(1);
    expect(j.object_transfers[0]).toMatchObject({
      kind: "transferred",
      from: { kind: "object", address: "0xsellerkiosk" },
      to: { kind: "object", address: "0xbuyerkiosk" },
    });
  });

  /** The note a capability handover carries is the loudest finding this tool has. */
  it("carries the note explaining what a transferred capability grants", async () => {
    const capMove = emptyTx({
      effects: {
        status: { success: true },
        gasUsed: { computationCost: 1n, storageCost: 1n, storageRebate: 1n, nonRefundableStorageFee: 1n },
        epoch: 500n,
        changedObjects: [
          {
            objectId: "0xcap",
            objectType: "0x2::package::UpgradeCap",
            idOperation: 1,
            inputState: 2,
            inputOwner: { kind: 1, address: "0xold" },
            outputOwner: { kind: 1, address: "0xnew" },
          },
        ],
      },
    });
    const j = await run(capMove);
    expect(j.object_transfers[0]).toMatchObject({ high_consequence: true });
    expect(j.object_transfers[0].note).toMatch(/publish new code/i);
  });

  it("omits object_transfers when nothing changed hands", async () => {
    const j = await run(emptyTx());
    expect(j.object_transfers).toBeUndefined();
  });

  /**
   * A transaction whose only object change is a coin created for an address
   * other than the sender. A coin is never listed in object_transfers or
   * created_for, so the recipient is named from the balance changes.
   */
  it("names the addresses that received coins when no other object moved", async () => {
    const XAUM = "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM";
    const drain = emptyTx({
      effects: {
        status: { success: true },
        gasUsed: { computationCost: 1n, storageCost: 1n, storageRebate: 1n, nonRefundableStorageFee: 1n },
        epoch: 1100n,
        changedObjects: [
          {
            objectId: "0xnewxaumcoin",
            objectType: `0x2::coin::Coin<${XAUM}>`,
            idOperation: 1,
            inputState: 1,
            outputOwner: { kind: 1, address: "0xbeneficiary" },
          },
        ],
      },
    });
    drain.response.transaction.balanceChanges = [
      { address: "0xsender", coinType: "0x2::sui::SUI", amount: "-106785456" },
      { address: "0xbeneficiary", coinType: XAUM, amount: "215600000000" },
    ] as never;
    mockSui.stateService.getCoinInfo.mockRejectedValue(Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" }));
    const j = await run(drain);
    expect(j.created_for).toBeUndefined();
    expect(j.coins_delivered_to).toEqual(["0xbeneficiary"]);
  });

  it("says decoding was skipped when max_event_field_bytes is 0", async () => {
    const withEvents = emptyTx();
    withEvents.response.transaction.events = {
      events: [
        { packageId: "0x2", module: "coin", eventType: "0x2::coin::CoinBalanceChange", sender: "0xsender" },
        { packageId: "0x2", module: "coin", eventType: "0x2::coin::CoinBalanceChange", sender: "0xsender" },
      ],
    } as never;
    const j = await run(withEvents);
    expect(j.events).toHaveLength(2);
    expect(j.events[0].parsed).toBeUndefined();
    expect(j.event_fields_omitted).toBe(2);
    expect(j.event_fields_budget_note).toMatch(/skipped because you set max_event_field_bytes=0/);
  });
});

/**
 * Funds that move without a coin object. The effects, inputs and gas payment
 * are real gRPC responses captured from mainnet (test/fixtures), with the
 * fixture's `"123n"` strings revived as the bigints the client returns.
 */
describe("get_transaction reports address-balance activity", () => {
  const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

  type Captured = (typeof fixture)["CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay"];
  function response(digest: keyof typeof fixture) {
    const fx: Captured = JSON.parse(JSON.stringify(fixture[digest]), (_k, v) =>
      typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    );
    return {
      response: {
        transaction: {
          digest,
          timestamp: { seconds: 1790000000n, nanos: 0 },
          checkpoint: 326000000n,
          transaction: {
            sender: fx.sender,
            gasPayment: fx.gasPayment,
            kind: {
              data: {
                oneofKind: "programmableTransaction",
                programmableTransaction: { inputs: fx.inputs, commands: [] },
              },
            },
          },
          effects: {
            status: { success: true },
            gasUsed: { computationCost: 100000n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n },
            epoch: 1254n,
            changedObjects: fx.changedObjects,
          },
          events: { events: [] },
          balanceChanges: fx.balanceChanges,
        },
      },
    };
  }

  const run = async (digest: "CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay" | "34q8kUTe8Uoe3f6cD5wKmS7ZqgYg3uX8J7nAJEuGeGTF" | "8eHgw5hBnALFJKPstXWcPgKjeh1av1CzFAz8n85Primr") => {
    mockSui.ledgerService.getTransaction.mockResolvedValue(response(digest));
    const r = await tools.get("get_transaction")!({ digest, max_event_field_bytes: 0 });
    return JSON.parse(r.content[0].text);
  };

  /**
   * CD2e4… redeemed 1951 MIST from the sender's address balance and sent it
   * on, paying gas from the address balance too. No object was written, so
   * no changed object and no custody note may be reported.
   */
  it("shows withdrawals and deposits instead of phantom object changes", async () => {
    const j = await run("CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay");
    expect(j.object_changes).toEqual({ changed: 0, created: 0, deleted: 0 });
    expect(j.object_changes_note).toBeUndefined();
    expect(j.address_balance_ops).toEqual([
      { owner: "0xb71effa1cc4425928e0bda7c3b690a356245e705b01b5380b5d4d1a3497c1d47", coin_type: SUI, op: "deposit", amount: "1951" },
      { owner: "0x7c8e2ceb0839680a3b1f7aa1021d45670405d92f3c88e79aa1d3aa8a600bbdbf", coin_type: SUI, op: "withdraw", amount: "101951" },
    ]);
    expect(j.funds_withdrawals).toEqual([{ amount: "1951", coin_type: SUI, source: "sender" }]);
    expect(j.gas_source).toBe("address_balance");
  });

  /**
   * 34q8k…: a 704,848 SUI gas coin was deleted and merged into its owner's
   * address balance while balance_changes showed only the -100k payment.
   */
  it("flags a coin folded into its owner's address balance", async () => {
    const j = await run("34q8kUTe8Uoe3f6cD5wKmS7ZqgYg3uX8J7nAJEuGeGTF");
    const own = j.address_balance_ops.find(
      (o: { owner: string }) => o.owner === "0xa727cd9023836d0ac8435918ece422bc0b6a90c3086a5eea0c65a497402e0be6",
    );
    expect(own.converted_from_coins).toEqual(["0x6b0e59544cd4d7c161e038fa13b6fb7314f442c1f86d2b0ce55576367469c40e"]);
    expect(own.note).toMatch(/no value moved/);
    expect(j.gas_source).toBe("coins_and_address_balance");
  });

  /**
   * 8eHgw5…: a multisig minted MessageFromCetus NFTs to two addresses other
   * than the sender.
   */
  it("lists objects minted to someone other than the sender", async () => {
    const j = await run("8eHgw5hBnALFJKPstXWcPgKjeh1av1CzFAz8n85Primr");
    expect(j.object_changes_note).toBeUndefined();
    expect(j.created_for.map((m: { to: { address: string } }) => m.to.address)).toEqual([
      "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06",
      "0xcd8962dad278d8b50fa0f9eb0186bfa4cbdecc6d59377214c88d0286a0ac9562",
    ]);
    expect(j.created_for[0]).toMatchObject({ type: "message_from_cetus::MessageFromCetus", kind: "created" });
    expect(j.gas_source).toBe("coins");
  });
});

describe("get_transactions with no well-formed digest", () => {
  beforeEach(() => vi.clearAllMocks());

  // A success with `returned: 0` would read as a lookup that found nothing.
  it("is an error that names the digests, and sends no request", async () => {
    const result = await tools.get("get_transactions")!({ digests: ["notadigest0OIl", "notadigest0OIl", "1".repeat(44)] });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe(
      `None of the digests is Base58: "notadigest0OIl", "${"1".repeat(44)}".`,
    );
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });
});
