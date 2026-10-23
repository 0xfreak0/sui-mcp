import { describe, it, expect, vi, beforeEach } from "vitest";
import { candidates, gqlTx, type HopSpec } from "./helpers/trace-shapes.js";
import { gqlPage } from "./helpers/service-shapes.js";

/**
 * trace_flow_graph's default response fits a budget: it keeps the largest
 * shares and every exit, and states what it left out. `detail: "full"`
 * returns every node and edge.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/archive-fallback.js", () => ({ withArchiveFallback: async () => null }));
vi.mock("../src/utils/identity.js", () => ({ describeAddresses: async () => new Map(), identityNote: () => null }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false, labelProvenance: () => null }));
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
vi.mock("../src/utils/fanout.js", () => ({
  measureFanout: async () => ({ classification: "narrow", counterparty_count: 2, scanned_transactions: 5, truncated: false }),
}));
vi.mock("../src/utils/store.js", () => ({ getCachedTransaction: () => null, saveTransaction: () => {}, saveResult: () => null }));

const { registerFlowGraphTools } = await import("../src/tools/flow-graph.js");

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
let traceFlowGraph!: Handler;
let findFlowPath!: Handler;
registerFlowGraphTools({
  tool: (name: string, _d: string, _s: unknown, handler: Handler) => {
    if (name === "trace_flow_graph") traceFlowGraph = handler;
  if (name === "find_flow_path") findFlowPath = handler;
  },
} as never);

const ATTACKER = `0xa1${"1".repeat(62)}`;
const RECIPIENTS = Array.from({ length: 45 }, (_, i) => `0xb${i.toString(16).padStart(63, "0")}`);
const SUI_BRIDGE_DEPOSIT = "0x000000000000000000000000000000000000000000000000000000000000000b::bridge::TokenDepositedEvent";
const DEPOSIT = { seq_num: "1", source_chain: 0, sender_address: "xKRFS6UEKXM8q3C7Q0rJnXTSCnU0w9/Tux+m6Ts8SzI=", target_chain: 10, target_address: "1vBbGb8sBcJkpka3dXBX13RmHFw=", token_type: 4, amount: "1000000000" };

/** The attacker pays 45 wallets; the smallest of them bridges its share out. */
const PAID = RECIPIENTS.map((_, i) => (i === 44 ? 10000000000n : 102000000000n + BigInt(i)));
const TOTAL = PAID.reduce((a, b) => a + b, 0n).toString();
const exploit: HopSpec = { digest: "USxhdMQhkMoYC52vEK6giwuQeu2F5SWuXeqS3EeyidB", sender: ATTACKER, checkpoint: 100, changes: [[ATTACKER, TOTAL]] };
const fanOut: HopSpec = {
  digest: "0xfan",
  sender: ATTACKER,
  checkpoint: 101,
  changes: [[ATTACKER, `-${TOTAL}`], ...RECIPIENTS.map((r, i): [string, string] => [r, PAID[i].toString()])],
};
const exit: HopSpec = { digest: "0xexit", sender: RECIPIENTS[44], checkpoint: 102, changes: [[RECIPIENTS[44], "-10000000000"]], events: [SUI_BRIDGE_DEPOSIT] };

beforeEach(() => {
  const all = new Map([exploit, fanOut, exit].map((h) => [h.digest, h]));
  const sent: Record<string, HopSpec[]> = { [ATTACKER]: [exploit, fanOut], [RECIPIENTS[44]]: [exit] };
  mockGqlQuery.mockReset();
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
    const q = String(query);
    if (q.includes("transactions(")) {
      return candidates(q.includes("sentAddress") ? (sent[String(vars.address)] ?? []) : [], q.includes("last:") ? "backward" : "forward");
    }
    if (q.includes("json")) {
      const h = all.get(String(vars.digest));
      return { transaction: { effects: { events: gqlPage((h?.events ?? []).map((repr) => ({ contents: { type: { repr }, json: DEPOSIT } }))) } } };
    }
    const h = all.get(String(vars.digest));
    return h ? gqlTx(h) : { transaction: null };
  });
});

const run = async (args: Record<string, unknown>) => { const res = await traceFlowGraph({ digest: "USxhdMQhkMoYC52vEK6giwuQeu2F5SWuXeqS3EeyidB", min_share: 0.0001, max_nodes: 150, ...args }); if (!res.content[1]) throw new Error(res.content[0].text); return JSON.parse(res.content[1].text); };

describe("trace_flow_graph output budget", () => {
  it("keeps the exit and the largest shares, and states what the default left out", async () => {
    const summary = await run({});
    const full = await run({ detail: "full" });
    expect(full.edges.length).toBeGreaterThan(45);
    expect(summary.truncated).toBe(true);
    expect(summary.edges.length).toBeLessThan(full.edges.length);
    expect(summary.omitted.lists.edges.count).toBe(full.edges.length - summary.edges.length);
    expect(summary.omitted.lists.nodes.count).toBe(full.nodes.length - summary.nodes.length);
    expect(summary.nodes.some((n: { kind: string }) => n.kind === "bridge_exit")).toBe(true);
    expect(summary.edges.some((e: { to: string }) => e.to.startsWith("exit:"))).toBe(true);
    // The kept wallets are the largest shares.
    const keptShares = summary.nodes.filter((n: { kind: string }) => n.kind === "address").map((n: { traced_share: number }) => n.traced_share);
    const allShares = full.nodes.filter((n: { kind: string }) => n.kind === "address").map((n: { traced_share: number }) => n.traced_share);
    const dropped = allShares.filter((s: number) => !keptShares.includes(s));
    expect(Math.max(...dropped)).toBeLessThanOrEqual(Math.min(...keptShares.filter((s: number) => s > 0.01)));
    expect(summary.terminals).toEqual(full.terminals);
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length);
  });

 it("lets a caller raise a transaction-read stop without changing other budgets", async () => {
  const limited = await run({ max_tx_reads: 1 });
  const expanded = await run({ max_tx_reads: 4000 });
  expect(limited.coverage.truncated).toBe(true);
  expect(expanded.coverage.truncated).toBe(false);
});
 it("pages terminal entries and pruned branch examples independently", async () => {
  const first = await run({});
  const terminal = first.terminals.find((g: { entry_count: number }) => g.entry_count > 15);
  expect(terminal.entries).toHaveLength(15);
  expect(terminal.entries_next_call).toMatchObject({ tool: "trace_flow_graph", repeat_with: { terminal_entry_offset: 15 } });
  const later = await run({ terminal_entry_offset: 15 });
  const laterGroup = later.terminals.find((g: { reason: string }) => g.reason === terminal.reason);
  expect(laterGroup.entries[0].node).not.toBe(terminal.entries[0].node);
  expect(laterGroup.entry_offset).toBe(15);

  const pruned = await run({ min_share: 0.03 });
  expect(pruned.largest_pruned_page.count).toBeGreaterThan(10);
  expect(pruned.largest_pruned_page.next_call).toMatchObject({ tool: "trace_flow_graph", repeat_with: { pruned_offset: 10 } });
  const prunedLater = await run({ min_share: 0.03, pruned_offset: 10 });
  expect(prunedLater.largest_pruned[0].address).not.toBe(pruned.largest_pruned[0].address);
 });
});

describe("find_flow_path path paging", () => {
 it("keeps a found result distinct from an empty page beyond the first path", async () => {
  const args = { from: ATTACKER, to: RECIPIENTS[44], window_start: 100, max_nodes: 100, min_share: 0.0001 };
  const first = await findFlowPath(args);
  const firstPage = JSON.parse(first.content[1].text);
  expect(firstPage.found).toBe(true);
  expect(firstPage.path_count).toBeGreaterThan(0);
  expect(firstPage.paths).toHaveLength(1);

  const later = await findFlowPath({ ...args, path_offset: 1 });
  const laterPage = JSON.parse(later.content[1].text);
  expect(laterPage).toMatchObject({ found: true, path_count: firstPage.path_count, path_offset: 1, paths: [] });
 });
});
