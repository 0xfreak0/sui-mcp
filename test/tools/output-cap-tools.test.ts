import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient } from "../helpers/mock-grpc.js";
import { gqlPage, notFoundError } from "../helpers/service-shapes.js";

/**
 * A capped tool keeps its flagged rows whatever the budget, reports every
 * other row it left out, and computes its totals over all of them.
 */

const mockSui = createMockClient();
const mockGqlQuery = vi.fn();
vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../../src/utils/price-providers.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
vi.mock("../../src/utils/names.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  batchResolveNames: async () => new Map(),
}));
vi.mock("../../src/utils/identity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  describeAddresses: async (addrs: string[]) => new Map(addrs.map((a) => [a, { address: a, kind: "wallet" as const }])),
  fetchKinds: async (addrs: string[]) => new Map(addrs.map((a) => [a, { kind: a === PACKAGE ? ("package" as const) : ("wallet" as const) }])),
  identityNote: () => undefined,
}));

const { registerFlowTools } = await import("../../src/tools/flows.js");
const { registerTransactionTools } = await import("../../src/tools/transactions.js");
const { resetLiveCoinScale } = await import("../../src/utils/valuation.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlers = new Map<string, Handler>();
const server = { tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never;
registerFlowTools(server);
registerTransactionTools(server);

async function run(tool: string, args: Record<string, unknown>) {
  const r = await handlers.get(tool)!(args);
  const text = r.content.map((c) => c.text).join("\n");
  expect(r.isError, text.slice(0, 400)).toBeFalsy();
  return JSON.parse(text);
}

const FAKE = `0x${"fa4e".repeat(16)}::fake::FAKE`;
/** A package counterparty ranked last, below `top`. */
const PACKAGE = `0x${"9a".repeat(32)}`;
const A = `0xa1${"1".repeat(62)}`;
/** Carries the shipped "Bybit reserve wallet" label. */
const BYBIT = "0x60dd01bc037e2c1ea2aaf02187701f9f4453ba323338d2f2f521957065b0984d";
const payer = (i: number) => `0x${(0xb00000 + i).toString(16).padStart(64, "0")}`;
const digest = (i: number) => `D${String(i).padStart(3, "0")}${"x".repeat(40)}`;

beforeEach(() => {
  vi.clearAllMocks();
  resetLiveCoinScale();
  mockSui.stateService.getCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
    if (coinType === FAKE) return { response: { coinType: FAKE, metadata: { name: "Fake", symbol: "FAKE", decimals: 2 } } };
    throw notFoundError(`Coin type ${coinType} not found`);
  });
});

describe("summarize_address_flows", () => {
  /** 120 payers into A, largest first, then a package and a labelled exchange paying the least. */
  const payments = [
    ...Array.from({ length: 120 }, (_, i) => [payer(i), String((120 - i) * 1000)] as const),
    [PACKAGE, "2"] as const,
    [BYBIT, "1"] as const,
  ];
  const node = ([from, amount]: readonly [string, string], i: number) => ({
    digest: digest(i),
    sender: { address: from },
    gasInput: { gasSponsor: { address: from } },
    kind: { commands: gqlPage([]) },
    effects: {
      status: "SUCCESS",
      timestamp: `2025-10-15T13:${String(i % 60).padStart(2, "0")}:00Z`,
      checkpoint: { sequenceNumber: 1000 + i },
      gasEffects: { gasSummary: { computationCost: "0", storageCost: "0", storageRebate: "0" } },
      balanceChanges: gqlPage([
        { coinType: { repr: FAKE }, amount: `-${amount}`, owner: { address: from } },
        { coinType: { repr: FAKE }, amount, owner: { address: A } },
      ]),
      events: gqlPage([]),
    },
  });

  beforeEach(() => {
    const nodes = payments.map(node);
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      if (!String(query).includes("transactions(filter")) return {};
      const before = vars.before ? Number(vars.before) : nodes.length;
      const from = Math.max(0, before - 50);
      return {
        transactions: {
          nodes: nodes.slice(from, before),
          pageInfo: { hasPreviousPage: from > 0, startCursor: from > 0 ? String(from) : null },
        },
      };
    });
  });

  it("keeps the labelled and the package payer past the budget, reports the rest, and totals every payer", async () => {
    const d = await run("summarize_address_flows", { address: A, top: 1 });
    const total = payments.reduce((s, [, a]) => s + BigInt(a), 0n);
    expect(d.coins[0].raw.in).toBe(total.toString());
    expect(d.inflow_source_count).toBe(payments.length);

    const listed = d.inflow_sources.map((r: { address: string }) => r.address);
    expect(listed).toContain(BYBIT);
    expect(d.inflow_sources.find((r: { address: string }) => r.address === PACKAGE).kind).toBe("package");
    expect(listed.length).toBeLessThan(payments.length);
    expect(d.truncated).toBe(true);
    const omitted = d.omitted.lists.inflow_sources;
    expect(listed.length + omitted.count).toBe(payments.length);
    // No coin is priced here, so every omitted payer is counted as unpriced.
    expect(omitted.unpriced).toBe(omitted.count);
    expect(listed).not.toContain(omitted.first.address);
    expect(d.omitted.next_call).toEqual({ tool: "summarize_address_flows", repeat_with: { detail: "full" } });
  });

  it("lists every payer with detail full", async () => {
    const d = await run("summarize_address_flows", { address: A, detail: "full" });
    expect(d.inflow_sources).toHaveLength(payments.length);
    expect(d.truncated).toBeUndefined();
  });

  it("reports the lookalike check with no pairs when nothing collides", async () => {
    // A subject with ordinary entropy, so the report is not the vanity-subject disclosure.
    const subject = "0x3f1c9a27d4e85b6093ae7c1f2d4b58e6a09c3d7f1e2b4a6c8d0f1e3a5b7c9d2e";
    const d = await run("summarize_address_flows", { address: subject });
    expect(d.address_poisoning.pairs).toEqual([]);
    expect(d.address_poisoning.subject_excluded).toBeUndefined();
    expect(d.address_poisoning.addresses_compared).toBeGreaterThan(0);
  });
});

describe("get_transaction", () => {
  const DIGEST = "7pTrudZb57z2acJFvC2CnBCuaU6RA1UpU9auDZQEESit";
  const SENDER = `0xc3${"3".repeat(62)}`;
  const recipients = Array.from({ length: 199 }, (_, i) => payer(i));
  const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
  /** The sender pays 199 addresses in SUI, the last the most, and receives an unverified coin nobody vouches for. */
  const changes = [
    { address: SENDER, coinType: SUI, amount: `-${199 * 1000 + 999_000}` },
    ...recipients.map((r, i) => ({ address: r, coinType: SUI, amount: i === 198 ? "1000000" : "1000" })),
    ...recipients.map((r) => ({ address: r, coinType: FAKE, amount: "-1" })),
    { address: SENDER, coinType: FAKE, amount: "199" },
  ];

  beforeEach(() => {
    mockSui.ledgerService.getTransaction.mockResolvedValue({
      response: {
        transaction: {
          digest: DIGEST,
          timestamp: { seconds: 1760000000n, nanos: 0 },
          checkpoint: 1000n,
          transaction: {
            sender: SENDER,
            kind: { data: { oneofKind: "programmableTransaction", programmableTransaction: { inputs: [], commands: [] } } },
          },
          effects: { status: { success: true }, changedObjects: [] },
          events: { events: [] },
          balanceChanges: changes,
        },
      },
    });
    mockGqlQuery.mockResolvedValue({});
  });

  it("keeps the sender's change and the largest credit in a verified coin, and counts every change", async () => {
    const d = await run("get_transaction", { digest: DIGEST });
    expect(d.balance_change_count).toBe(changes.length);
    const sui = d.balance_changes.filter((b: { coin_type: string }) => b.coin_type === SUI).map((b: { address: string }) => b.address);
    expect(sui).toContain(SENDER);
    expect(sui).toContain(recipients[198]);
    const listed = d.balance_changes;
    expect(listed.length + d.omitted.lists.balance_changes.count).toBe(changes.length);
    expect(d.omitted.next_call).toEqual({ tool: "get_transaction", repeat_with: { detail: "full" } });
  });

  it("lists every change with detail full", async () => {
    const d = await run("get_transaction", { digest: DIGEST, detail: "full" });
    expect(d.balance_changes).toHaveLength(changes.length);
  });
});

describe("get_transaction events", () => {
  const DIGEST = "7pTrudZb57z2acJFvC2CnBCuaU6RA1UpU9auDZQEESit";
  const CALLED = `0x${"c0".repeat(32)}`;
  const OTHER = `0x${"d0".repeat(32)}`;
  /** 120 swaps from the called package differing only in amount, then 120 distinct events from a package it never called. */
  const events = [
    ...Array.from({ length: 120 }, (_, i) => ({ pkg: CALLED, type: `${CALLED}::market::SwapEvent`, json: { market: "0xm", amount: String(1000 + i), note: "x".repeat(60) } })),
    ...Array.from({ length: 120 }, (_, i) => ({ pkg: OTHER, type: `${OTHER}::log::Entry`, json: { tag: `entry-${"abcdefghij"[i % 10]}${i}`, note: "y".repeat(120) } })),
  ];

  beforeEach(() => {
    mockSui.ledgerService.getTransaction.mockResolvedValue({
      response: {
        transaction: {
          digest: DIGEST,
          timestamp: { seconds: 1760000000n, nanos: 0 },
          checkpoint: 1000n,
          transaction: {
            sender: A,
            kind: {
              data: {
                oneofKind: "programmableTransaction",
                programmableTransaction: {
                  inputs: [],
                  commands: [{ command: { oneofKind: "moveCall", moveCall: { package: CALLED, module: "market", function: "swap", typeArguments: [] } } }],
                },
              },
            },
          },
          effects: { status: { success: true }, changedObjects: [] },
          events: { events: events.map((e) => ({ packageId: e.pkg, module: e.type.split("::")[1], eventType: e.type, sender: A })) },
          balanceChanges: [],
        },
      },
    });
    mockGqlQuery.mockImplementation(async (query: string) =>
      String(query).includes("events(")
        ? { transaction: { effects: { events: { pageInfo: { hasNextPage: false }, nodes: events.map((e) => ({ contents: { type: { repr: e.type }, json: e.json } })) } } } }
        : {},
    );
  });

  it("folds the called package's swaps into one row, keeps it, and pages the rest", async () => {
    const d = await run("get_transaction", { digest: DIGEST });
    expect(d.event_count).toBe(events.length);
    const swaps = d.events.find((e: { event_type: string }) => e.event_type === `${CALLED}::market::SwapEvent`);
    expect(swaps).toMatchObject({ index: 0, count: 120, varying: { amount: { total: String(120 * 1000 + (119 * 120) / 2), min: "1000", max: "1119" } } });
    expect(d.omitted.folded.events).toEqual({ entries: events.length, rows: 121 });
    const others = d.events.filter((e: { package_id: string }) => e.package_id === OTHER);
    expect(others.length + d.omitted.lists.events.count).toBe(120);
    expect(others.length).toBeLessThan(120);
  });

  it("lists every event unfolded with detail full, one page after another", async () => {
    const listed: Array<{ parsed: { amount: string } }> = [];
    let args: Record<string, unknown> | undefined = { digest: DIGEST, detail: "full" };
    while (args) {
      const d = await run("get_transaction", args);
      listed.push(...d.events);
      args = d.events_page?.next_call?.args;
    }
    expect(listed).toHaveLength(events.length);
    expect(listed[5].parsed.amount).toBe("1005");
  });
});
