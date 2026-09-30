import { beforeEach, describe, expect, it, vi } from "vitest";
import { candidates, gqlTx, type HopSpec } from "./helpers/trace-shapes.js";

const mockGqlQuery = vi.fn();
const mockFanout = vi.fn();
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
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: mockFanout }));
vi.mock("../src/utils/store.js", () => ({ getCachedTransaction: () => null, saveTransaction: () => {} }));

const { registerFlowGraphTools } = await import("../src/tools/flow-graph.js");
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
registerFlowGraphTools({
  tool: (name: string, _description: string, _schema: unknown, handler: Handler) => { handlers[name] = handler; },
} as never);

const A = `0x${"a1".repeat(32)}`;
const B = `0x${"b2".repeat(32)}`;
const C = `0x${"c3".repeat(32)}`;
const UNREAD = "synthetic-unread-hub-balances";
const pay: HopSpec = { digest: "synthetic-payment", sender: A, checkpoint: 100, changes: [[A, "-1000000000"], [B, "1000000000"]] };

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockFanout.mockReset();
  mockFanout.mockRejectedValue(new Error(`Incomplete balance changes for ${UNREAD}`));
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
    if (query.includes("transactions(")) {
      return candidates(query.includes("sentAddress") && vars.address === A ? [pay] : [], query.includes("last:") ? "backward" : "forward");
    }
    return vars.digest === pay.digest ? gqlTx(pay) : { transaction: null };
  });
});

describe.each(["trace_flow_graph", "find_flow_path"])("%s unread hub stops", (tool) => {
  it.each(["json", "graph_json", "mermaid", "csv"])("preserves the failure reason in %s", async (format) => {
    const args = tool === "trace_flow_graph" ? { address: A } : { from: A, to: C };
    const result = await handlers[tool]!({ ...args, format });
    if (format === "mermaid" || format === "csv") {
      expect(result.content[0]!.text).toContain(UNREAD);
      expect(result.content[0]!.text).toContain(B);
      return;
    }
    const json = JSON.parse(result.content[format === "json" ? 1 : 0]!.text);
    const explored = tool === "find_flow_path" ? json.explored : json;
    const terminal = explored.terminals?.find((entry: { reason: string }) => entry.reason === "read_failed");
    expect(terminal?.entries[0]?.detail).toContain(UNREAD);
    expect(terminal?.entries[0]?.detail).toContain(B);
    expect((tool === "find_flow_path" ? explored.coverage.forward : explored.coverage).truncated).toBe(true);
    if (format === "json") {
      expect(result.content[0]!.text).toContain(UNREAD);
      if (tool === "find_flow_path") expect(json.result).toBe("search incomplete");
    }
  });
});
