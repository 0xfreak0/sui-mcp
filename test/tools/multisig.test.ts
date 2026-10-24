import { describe, it, expect, vi, beforeEach } from "vitest";
import fixtures from "../fixtures/signatures.json" with { type: "json" };

const mockGqlQuery = vi.fn();
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerMultisigTools } = await import("../../src/tools/multisig.js");

const tools = new Map<string, Function>();
registerMultisigTools({
  tool: (name: string, _d: string, _s: unknown, handler: Function) => tools.set(name, handler),
} as never);
const analyze = tools.get("analyze_multisig")!;

/** A sent page that always claims another, like a busy wallet's history. */
const sentPage = (signatures: string[], digest: string) => ({
  transactions: {
    pageInfo: { hasNextPage: true, endCursor: `after-${digest}` },
    nodes: [{ digest, effects: { timestamp: null }, gasInput: null, signatures: signatures.map((signatureBytes) => ({ signatureBytes })) }],
  },
});

beforeEach(() => { mockGqlQuery.mockReset(); });

describe("analyze_multisig", () => {
  it("answers after one page for a wallet that signs with its own single key", async () => {
    // Non-multisig signatures count toward the loop's target, so a wallet that
    // signs with its own key is answered from one page, not its whole history.
    let calls = 0;
    mockGqlQuery.mockImplementation(async () => {
      if (++calls > 20) throw new Error("paged past the first page");
      return sentPage(fixtures.ed25519.signatures, `d${calls}`);
    });
    const res = await analyze({ address: fixtures.ed25519.address });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/is not a multisig wallet: it signed d1 with its own ed25519 key/);
    expect(calls).toBe(1);
  });

  it("reports transactions sent in the address's name but signed by someone else", async () => {
    // The address's only transaction carries no signature of its own: a
    // multisig at another address authorized it.
    mockGqlQuery.mockResolvedValue({
      transactions: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ digest: "B2eGLFo", effects: null, gasInput: null, signatures: fixtures.ms_2of3.signatures.map((signatureBytes) => ({ signatureBytes })) }],
      },
    });
    const res = await analyze({ address: fixtures.ed25519.address });
    expect(res.content[0].text).toMatch(/none carries its own signature: they were authorized by 0xa1eb94d1/);
  });

  it("continues past a scanned segment with only foreign signatures without claiming the address never sent", async () => {
    mockGqlQuery.mockImplementation(async (_query: string, vars: { before: string | null }) => ({
      transactions: {
        pageInfo: { hasPreviousPage: !vars.before, startCursor: vars.before ? null : "older" },
        nodes: [{
          digest: vars.before ? "tx-old" : "tx-new", effects: null, gasInput: null,
          signatures: fixtures.ms_2of3.signatures.map((signatureBytes) => ({ signatureBytes }))
        }],
      },
    }));
    const initial = JSON.parse((await analyze({ address: fixtures.ed25519.address, max_transactions: 1 })).content[0].text);
    expect(initial).toMatchObject({
      committee: null, history_complete: false,
      next_call: { tool: "analyze_multisig", repeat_with: { cursor: "older" } },
    });
    const last = JSON.parse((await analyze({
      address: fixtures.ed25519.address, max_transactions: 1, cursor: initial.next_call.repeat_with.cursor,
    })).content[0].text);
    expect(last.history_complete).toBe(false);
    expect(last.next_call).toBeUndefined();
    expect(last.note).toMatch(/combine it with prior segments/);
    expect(mockGqlQuery.mock.calls.map(([, vars]) => vars.before)).toEqual([null, "older"]);
  });
  it("walks an advancing empty page without declaring the history complete", async () => {
    mockGqlQuery.mockImplementation(async (_query: string, vars: { before: string | null }) => ({
      transactions: vars.before
        ? {
          pageInfo: { hasPreviousPage: false, startCursor: null },
          nodes: [{ digest: "old", signatures: fixtures.ms_2of3.signatures.map((signatureBytes) => ({ signatureBytes })) }],
        }
        : { pageInfo: { hasPreviousPage: true, startCursor: "older" }, nodes: [] },
    }));
    const result = await analyze({ address: fixtures.ed25519.address, max_transactions: 1 });
    expect(mockGqlQuery.mock.calls.map(([, vars]) => vars.before)).toEqual([null, "older"]);
    expect(result.content[0].text).toContain("has sent 1 transaction(s) in the 1 examined");
});

  it("does not treat an empty stale cursor as the end of history", async () => {
    mockGqlQuery.mockResolvedValue({
      transactions: { pageInfo: { hasPreviousPage: true, startCursor: "stale" }, nodes: [] },
    });
    const result = JSON.parse((await analyze({ address: fixtures.ed25519.address, cursor: "stale" })).content[0].text);
    expect(result).toMatchObject({ committee: null, history_complete: false });
    expect(result.next_call).toBeUndefined();
    expect(mockGqlQuery).toHaveBeenCalledTimes(1);
  });

  it("bounds advancing empty pages and resumes after the last read", async () => {
    let pages = 0;
    mockGqlQuery.mockImplementation(async () => ({
      transactions: { pageInfo: { hasPreviousPage: true, startCursor: `older-${++pages}` }, nodes: [] },
    }));
    const first = JSON.parse((await analyze({ address: fixtures.ed25519.address, max_transactions: 1 })).content[0].text);
    expect(first).toMatchObject({
      transactions_examined: 0, scan_stop: "read_budget", scan_reads: 20,
      next_call: { tool: "analyze_multisig", repeat_with: { cursor: "older-20" } },
});
    expect(mockGqlQuery).toHaveBeenCalledTimes(20);
  });
});
