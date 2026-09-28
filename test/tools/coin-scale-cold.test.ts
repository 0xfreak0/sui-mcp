import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockClient, type MockSuiClient } from "../helpers/mock-grpc.js";
import { gqlPage, notFoundError } from "../helpers/service-shapes.js";
import { candidates, gqlTx, type HopSpec } from "../helpers/trace-shapes.js";

/**
 * Every tool that formats or values a coin amount reads that coin's decimals
 * from CoinMetadata first (`prefetchCoinScale`), so its answer does not
 * depend on what an earlier call in the process happened to warm.
 *
 * `coinScale` answers from a process-wide cache. A tool that skips the warm-up
 * formats a coin outside the curated list at an assumed 9 decimals in a cold
 * process and at its real scale once any other call has cached it: FAKE here
 * would read 0.000123456 instead of 1234.56. Each tool below runs once, cold,
 * against a service that serves FAKE's CoinMetadata (2 decimals).
 */

const mockSui = createMockClient() as MockSuiClient & {
  ledgerService: { batchGetTransactions: ReturnType<typeof vi.fn> };
};
mockSui.ledgerService.batchGetTransactions = vi.fn();
const mockGqlQuery = vi.fn();
vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
// No coin has a price, so no provider's decimals can stand in for CoinMetadata.
vi.mock("../../src/utils/price-providers.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
// The Aftermath price request get_wallet_overview makes goes nowhere in a test.
vi.mock("../../src/tools/prices.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchAftermathPrices: async () => null,
}));
vi.mock("../../src/utils/names.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  batchResolveNames: async () => new Map(),
}));
vi.mock("../../src/utils/fanout.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  measureFanout: async (address: string) => ({
    address,
    classification: "narrow",
    counterparty_count: 2,
    scanned_transactions: 5,
    truncated: false,
    sponsor_shape: "not_a_sponsor",
  }),
}));

const { resetLiveCoinScale } = await import("../../src/utils/valuation.js");
const { resetStore, saveFinding } = await import("../../src/utils/store.js");
const { registerFlowGraphTools } = await import("../../src/tools/flow-graph.js");
const { registerScreeningTools } = await import("../../src/tools/screening.js");
const { registerAttackTools } = await import("../../src/tools/attack.js");
const { registerAggregateTools } = await import("../../src/tools/aggregate.js");
const { registerFindingsTools } = await import("../../src/tools/findings.js");
const { registerObjectTools } = await import("../../src/tools/objects.js");
const { registerTraceTools } = await import("../../src/tools/trace.js");
const { registerTransactionTools } = await import("../../src/tools/transactions.js");
const { registerHistoryTools } = await import("../../src/tools/history.js");
const { registerTimelineTools } = await import("../../src/tools/timeline.js");
const { registerCoinTools } = await import("../../src/tools/coins.js");
const { registerFlowTools } = await import("../../src/tools/flows.js");
const { registerFundingTools } = await import("../../src/tools/funding.js");
const { registerWorkflowTools } = await import("../../src/tools/workflow.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlers = new Map<string, Handler>();
const server = { tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never;
for (const register of [
  registerFlowGraphTools,
  registerScreeningTools,
  registerAttackTools,
  registerAggregateTools,
  registerFindingsTools,
  registerObjectTools,
  registerTraceTools,
  registerTransactionTools,
  registerHistoryTools,
  registerTimelineTools,
  registerCoinTools,
  registerFlowTools,
  registerFundingTools,
  registerWorkflowTools,
]) {
  register(server);
}

/** A coin no curated list carries. Its CoinMetadata declares 2 decimals. */
const FAKE = `0x${"fa4e".repeat(16)}::fake::FAKE`;
const RAW = "123456";
/** RAW at FAKE's own scale. At the assumed 9 it would read 0.000123456. */
const REAL = "1234.56";

const A = `0xa1${"1".repeat(62)}`;
const B = `0xb2${"2".repeat(62)}`;
const HOT = `0xc3${"3".repeat(62)}`;
const DEPOSIT = `0xd4${"4".repeat(62)}`;
const SPONSOR = `0xe5${"5".repeat(62)}`;
const DIGEST = "7pTrudZb57z2acJFvC2CnBCuaU6RA1UpU9auDZQEESit";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

/** A pays B RAW of FAKE, as GraphQL returns the transaction. */
const payment: HopSpec = {
  digest: DIGEST,
  sender: A,
  checkpoint: 1000,
  changes: [
    [A, `-${RAW}`, FAKE],
    [B, RAW, FAKE],
  ],
};

/** The same transaction as gRPC's ledger service returns it. */
const grpcPayment = {
  digest: DIGEST,
  timestamp: { seconds: 1760000000n, nanos: 0 },
  checkpoint: 1000n,
  transaction: {
    sender: A,
    kind: { data: { oneofKind: "programmableTransaction", programmableTransaction: { inputs: [], commands: [] } } },
  },
  effects: { status: { success: true }, changedObjects: [] },
  events: { events: [] },
  balanceChanges: [
    { address: A, coinType: FAKE, amount: `-${RAW}` },
    { address: B, coinType: FAKE, amount: RAW },
  ],
};

/**
 * The payment as a node of a `transactions(...)` page, carrying every field
 * the list-reading tools select between them.
 */
const listNode = {
  digest: DIGEST,
  sender: { address: A },
  gasInput: { gasSponsor: { address: A } },
  effects: {
    status: "SUCCESS",
    timestamp: "2025-10-15T13:30:00Z",
    checkpoint: { sequenceNumber: 1000 },
    gasEffects: { gasSummary: { computationCost: 0, storageCost: 0, storageRebate: 0 } },
    balanceChanges: gqlPage([
      { coinType: { repr: FAKE }, amount: `-${RAW}`, owner: { address: A } },
      { coinType: { repr: FAKE }, amount: RAW, owner: { address: B } },
    ]),
    events: gqlPage([]),
    objectChanges: gqlPage([]),
  },
  kind: { __typename: "ProgrammableTransaction", commands: gqlPage([]) },
};
const listPage = {
  transactions: {
    nodes: [listNode],
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  },
};

let route: (query: string, vars: Record<string, unknown>) => unknown;
const storeDir = mkdtempSync(join(tmpdir(), "coin-scale-cold-"));

beforeEach(() => {
  vi.clearAllMocks();
  resetLiveCoinScale();
  mockSui.stateService.getCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
    if (coinType === FAKE) {
      return { response: { coinType: FAKE, metadata: { name: "Fake", symbol: "FAKE", decimals: 2 } } };
    }
    throw notFoundError(`Coin type ${coinType} not found`);
  });
  mockSui.ledgerService.batchGetTransactions.mockResolvedValue({
    response: { transactions: [{ result: { oneofKind: "transaction", transaction: grpcPayment } }] },
  });
  mockSui.ledgerService.getTransaction.mockResolvedValue({ response: { transaction: grpcPayment } });
  route = (query) => (query.includes("transactions(") ? candidates([]) : gqlTx(payment));
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => route(String(query), vars));
});

afterAll(() => rmSync(storeDir, { recursive: true, force: true }));

async function runCold(tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await handlers.get(tool)!(args);
  const text = r.content.map((c) => c.text).join("\n");
  expect(r.isError, text.slice(0, 400)).toBeFalsy();
  return text;
}

/** Formatted at FAKE's own scale, and nowhere marked or scaled as a guess. */
function expectRealScale(text: string) {
  expect(mockSui.stateService.getCoinInfo).toHaveBeenCalledWith({ coinType: FAKE });
  expect(text).toContain(REAL);
  expect(text).not.toContain("0.000123456");
  expect(text).not.toContain("assumed scale");
  expect(text).not.toMatch(/"(decimals_source|coin_scale)":\s*"assumed"/);
}

describe("amount-formatting tools read a coin's decimals before formatting it", () => {
  it("trace_flow_graph", async () => {
    expectRealScale(await runCold("trace_flow_graph", { digest: DIGEST, coin_type: FAKE, format: "graph_json" }));
  });

  it("find_flow_path", async () => {
    route = (query, vars) =>
      query.includes("transactions(")
        ? candidates(query.includes("sentAddress") && vars.address === A ? [payment] : [])
        : gqlTx(payment);
    expectRealScale(await runCold("find_flow_path", { from: A, to: B, coin_type: FAKE }));
  });

  it("trace_funds", async () => {
    expectRealScale(await runCold("trace_funds", { digest: DIGEST, direction: "forward", hops: 1 }));
  });

  it("get_transaction", async () => {
    expectRealScale(await runCold("get_transaction", { digest: DIGEST }));
  });

  it("get_transaction_history", async () => {
    route = () => listPage;
    expectRealScale(await runCold("get_transaction_history", { address: A, limit: 1 }));
  });

  it("build_timeline", async () => {
    route = () => listPage;
    expectRealScale(await runCold("build_timeline", { addresses: [A] }));
  });

  it("summarize_address_flows", async () => {
    route = () => listPage;
    expectRealScale(await runCold("summarize_address_flows", { address: A }));
  });

  it("screen_address", async () => {
    // A pays a labelled exchange wallet, so the exposure's legs are formatted.
    const BYBIT = "0x60dd01bc037e2c1ea2aaf02187701f9f4453ba323338d2f2f521957065b0984d";
    const toExchange = JSON.parse(JSON.stringify(listPage).replaceAll(B, BYBIT));
    route = () => toExchange;
    expectRealScale(await runCold("screen_address", { address: A }));
  });

  it("find_funding_source", async () => {
    const empty = { transactions: { nodes: [], pageInfo: listPage.transactions.pageInfo } };
    route = (_query, vars) => (vars.addr === B ? listPage : empty);
    expectRealScale(await runCold("find_funding_source", { address: B, max_hops: 1 }));
  });

  it("get_balance", async () => {
    mockSui.getBalance.mockResolvedValue({ balance: { coinType: FAKE, balance: RAW, coinBalance: RAW, addressBalance: "0" } });
    expectRealScale(await runCold("get_balance", { owner: A, coin_type: FAKE }));
  });

  it("get_wallet_overview with prices", async () => {
    route = (query) =>
      query.includes("balances(")
        ? {
            address: { defaultNameRecord: null, balances: { nodes: [{ coinType: { repr: FAKE }, totalBalance: RAW, coinBalance: RAW, addressBalance: "0" }], pageInfo: { hasNextPage: false, endCursor: null } } },
            transactions: { nodes: [] },
          }
        : gqlTx(payment);
    expectRealScale(await runCold("get_wallet_overview", { address: A, include_prices: true }));
  });

  it("classify_deposit_address", async () => {
    // Customer A deposits into DEPOSIT, which sweeps the whole balance to HOT
    // with SPONSOR paying gas: the shape the tool formats sweep amounts for.
    const node = (digest: string, sender: string, sponsor: string, changes: Array<[string, string]>) => ({
      digest,
      sender: { address: sender },
      gasInput: { gasSponsor: { address: sponsor } },
      effects: {
        timestamp: "2025-10-15T13:00:00Z",
        balanceChanges: gqlPage(changes.map(([owner, amount]) => ({ amount, owner: { address: owner }, coinType: { repr: FAKE } }))),
      },
    });
    route = () => ({
      address: { balances: { nodes: [], pageInfo: { hasNextPage: false } } },
      transactions: {
        nodes: [
          node("FGKEgbqE4CpMuMjCNbumGWXANJv8Zb4bsSuDkbSZmcGs", A, A, [[A, `-${RAW}`], [DEPOSIT, RAW]]),
          node("2N68SBHPz55abA1X4xXbRRYKkcrijnwo6QtNzUaWb2Ha", DEPOSIT, SPONSOR, [[DEPOSIT, `-${RAW}`], [HOT, RAW]]),
        ],
        pageInfo: { hasPreviousPage: false },
      },
    });
    expectRealScale(await runCold("classify_deposit_address", { address: DEPOSIT }));
  });

  it("analyze_attack_tx", async () => {
    expectRealScale(await runCold("analyze_attack_tx", { digest: DIGEST, attacker: B }));
  });

  it("summarize_incident_losses", async () => {
    expectRealScale(await runCold("summarize_incident_losses", { digests: [DIGEST], attacker: B }));
  });

  it("aggregate_events with group_pnl", async () => {
    route = () => ({
      events: {
        nodes: [
          {
            sender: { address: A },
            contents: { type: { repr: `0x${"ab".repeat(32)}::pay::Paid` }, json: { amount: RAW } },
            transaction: { digest: DIGEST },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    expectRealScale(await runCold("aggregate_events", { sender: A, group_pnl: true, max_events: 50 }));
  });

  it("export_case", async () => {
    process.env.SUI_STORE_PATH = join(storeDir, "store.db");
    resetStore();
    saveFinding({
      case_name: "cold",
      title: "A paid B",
      detail: null,
      confidence: "high",
      addresses: [A, B],
      digests: [DIGEST],
      evidence: [],
    });
    try {
      expectRealScale(await runCold("export_case", { case_name: "cold", format: "graph_json" }));
    } finally {
      delete process.env.SUI_STORE_PATH;
      resetStore();
    }
  });

  it("get_object", async () => {
    const BANK = `0x44${"6".repeat(62)}`;
    route = () => ({ object: { asMoveObject: { contents: { display: null } } } });
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: { object: { objectId: BANK, version: 7n, objectType: `0x${"58".repeat(32)}::pool::Bank`, owner: { kind: 3, version: 5n } } },
    });
    mockSui.listBalances.mockResolvedValue({
      balances: [{ coinType: FAKE, balance: RAW, coinBalance: "0", addressBalance: RAW }],
      hasNextPage: false,
      cursor: null,
    });
    expectRealScale(await runCold("get_object", { object_id: BANK }));
  });
});
