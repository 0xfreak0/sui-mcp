import { describe, expect, it, vi } from "vitest";

const { fetchTx, loadFindings } = vi.hoisted(() => ({ fetchTx: vi.fn(), loadFindings: vi.fn() }));
vi.mock("../src/utils/store.js", () => ({
  EVIDENCE_TIERS: ["chain-derived", "indexer-attested", "heuristic"],
  storeStatus: () => ({ enabled: true }),
  loadFindings,
}));
vi.mock("../src/utils/trace-read.js", () => ({ fetchTx, formatAmount: (raw: string) => raw }));
vi.mock("../src/utils/valuation.js", () => ({ prefetchCoinScale: async () => undefined }));
vi.mock("../src/protocols/registry.js", () => ({ prefetchProtocolNames: async () => undefined, lookupProtocolDisplay: () => null }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null }));

const { registerFindingsTools } = await import("../src/tools/findings.js");
const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
registerFindingsTools({ tool: (name: string, _description: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) => handlers.set(name, handler) } as never);

const digests = Array.from({ length: 55 }, (_, i) => `digest-${i}`);

describe("export_case diagram paging", () => {
  it("makes every cited transaction reachable beyond fifty", async () => {
    loadFindings.mockReturnValue([{
      case_name: "case", title: "Finding", detail: null, confidence: null, evidence_tier: "chain-derived",
      addresses: [], evidence: [], digests,
    }]);
    fetchTx.mockReset().mockResolvedValue(null);
    const exportCase = handlers.get("export_case")!;

    const first = JSON.parse((await exportCase({ case_name: "case", format: "graph_json" })).content[0].text);
    expect(first.graph_scope).toEqual({ total_digests: 55, digest_offset: 0, digests_read: 50 });
    expect(first.next_call).toEqual({ tool: "export_case", repeat_with: { digest_offset: 50 } });
    expect(fetchTx.mock.calls.map(([digest]) => digest)).toEqual(digests.slice(0, 50));

    fetchTx.mockClear();
    const second = JSON.parse((await exportCase({ case_name: "case", format: "graph_json", digest_offset: 50 })).content[0].text);
    expect(second.graph_scope).toEqual({ total_digests: 55, digest_offset: 50, digests_read: 5 });
    expect(second.next_call).toBeUndefined();
    expect(fetchTx.mock.calls.map(([digest]) => digest)).toEqual(digests.slice(50));
  });
});
