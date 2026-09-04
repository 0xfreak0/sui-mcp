import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));

const { registerTraceTools } = await import("../src/tools/trace.js");

/**
 * findNextTx is not exported, so this drives it through the registered tool and
 * asserts on the GraphQL query it issues. The query *is* the contract — which
 * filter and which checkpoint bound — and three bugs lived in exactly that
 * contract while the pure hop-selection function was fully tested.
 */
const tools = new Map<string, Function>();
registerTraceTools({
  tool: (name: string, _d: string, _s: unknown, handler: Function) => tools.set(name, handler),
} as never);
const traceFunds = tools.get("trace_funds")!;

const CP = 500;
const START = "0xstart";
const ACTOR = "0xactor";
const RECIPIENT = "0xrecipient";

/** A hop whose sender pays RECIPIENT, so the trace wants to follow them. */
const hopTx = {
  transaction: {
    digest: START,
    sender: { address: ACTOR },
    effects: {
      timestamp: "2026-01-01T00:00:00.000Z",
      checkpoint: { sequenceNumber: CP },
      balanceChanges: {
        nodes: [
          { owner: { address: ACTOR }, amount: "-1000", coinType: { repr: "0x2::sui::SUI" } },
          { owner: { address: RECIPIENT }, amount: "1000", coinType: { repr: "0x2::sui::SUI" } },
        ],
      },
    },
    kind: { commands: { nodes: [] } },
  },
};

/** Calls captured against the transactions(...) query, i.e. findNextTx. */
function nextTxCalls() {
  return mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("transactions("));
}

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockGqlQuery.mockImplementation(async (query: string) => {
    if (String(query).includes("transactions(")) return { transactions: { nodes: [] } };
    return hopTx;
  });
});

describe("findNextTx — forward", () => {
  it("filters on sentAddress, not affectedAddress", async () => {
    // "The next transaction AFFECTING R" includes anyone paying R. Following
    // that attributed a third party's transaction to the subject, and after the
    // custody check landed it made an intact trace stop with custody_break
    // because R had merely received something before spending.
    await traceFunds({ digest: START, direction: "forward", hops: 2 });

    const [query, vars] = nextTxCalls()[0];
    expect(query).toContain("sentAddress");
    expect(query).not.toContain("affectedAddress");
    expect(vars.address).toBe(RECIPIENT);
  });

  it("asks from cp-1 so a same-checkpoint spend is not skipped", async () => {
    // afterCheckpoint is exclusive — verified against mainnet. Passing the
    // hop's own checkpoint skipped everything in it, and same-checkpoint
    // forwarding is what a script does: the adversarial case, not an edge case.
    await traceFunds({ digest: START, direction: "forward", hops: 2 });

    const [, vars] = nextTxCalls()[0];
    expect(vars.afterCheckpoint).toBe(CP - 1);
  });

  it("does not return the hop it is standing on", async () => {
    // Widening the window to include the current checkpoint means the current
    // transaction comes back in the results; picking it would loop forever.
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (String(query).includes("transactions(")) {
        return { transactions: { nodes: [{ digest: START }, { digest: "0xnext" }] } };
      }
      return hopTx;
    });

    await traceFunds({ digest: START, direction: "forward", hops: 2 });
    // The second hop fetched 0xnext, not START again.
    const fetched = mockGqlQuery.mock.calls
      .filter(([q]) => String(q).includes("transaction(digest"))
      .map(([, v]) => v.digest);
    expect(fetched).toContain("0xnext");
  });

  it("requests more than one candidate, so the current tx cannot crowd out the answer", async () => {
    await traceFunds({ digest: START, direction: "forward", hops: 2 });
    const [, vars] = nextTxCalls()[0];
    expect(vars.first).toBeGreaterThan(1);
  });
});

describe("findNextTx — backward", () => {
  it("keeps affectedAddress, because a funder is by definition someone else", async () => {
    await traceFunds({ digest: START, direction: "backward", hops: 2 });
    const [query] = nextTxCalls()[0];
    expect(query).toContain("affectedAddress");
    expect(query).not.toContain("sentAddress");
  });
});
