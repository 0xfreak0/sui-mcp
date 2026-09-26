import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `find_flow_path` must reach a 5-level forward search (address root, four
 * real transfers, then a bridge exit) at the tool's default `max_hops`. The
 * loop stops expanding once `forward_levels >= max_hops`, and the exit is
 * only recorded while expanding the fifth level's job, so a limit of 4 finds
 * no path. The fixture's 0.631 SUI crosses four real transfers before a
 * CCTP exit.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/archive-fallback.js", () => ({
  withArchiveFallback: async () => null,
}));
vi.mock("../src/utils/identity.js", () => ({
  describeAddresses: async () => new Map(),
  identityNote: () => null,
}));
vi.mock("../src/utils/labels.js", () => ({
  getLabel: () => null,
  isSink: () => false,
  labelProvenance: () => null,
}));
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
const mockFanout = vi.fn();
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: mockFanout }));
vi.mock("../src/utils/store.js", () => ({
  getCachedTransaction: () => null,
  saveTransaction: () => {},
}));

// vi.mock calls above are hoisted; the module under test is imported
// dynamically afterward so it picks up the mocked dependencies, matching
// trace-object-flow.test.ts and trace-next-tx.test.ts in this suite.
const { registerFlowGraphTools } = await import("../src/tools/flow-graph.js");

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
let findFlowPath!: Handler;
registerFlowGraphTools({
  tool: (n: string, _d: string, _s: unknown, h: Handler) => {
    if (n === "find_flow_path") findFlowPath = h;
  },
} as never);

const run = async (args: Record<string, unknown>) => {
  const r = await findFlowPath(args);
  const json = r.content.map((c) => c.text).find((t) => t.trim().startsWith("{"))!;
  return JSON.parse(json);
};

const START = `0xa0${"1".repeat(62)}`;
const NODE_A = `0xa1${"2".repeat(62)}`;
const NODE_B = `0xa2${"3".repeat(62)}`;
const NODE_C = `0xa3${"4".repeat(62)}`;
const NODE_D = `0xa4${"4".repeat(62)}`;
const ETH_DEST = "0xeb8a15d28dd54231e7e950f5720bc3d7af77b443";
const CCTP_PKG = "0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

interface Hop {
  digest: string;
  sender: string;
  checkpoint: number;
  from: string;
  to: string;
  amount: string;
  exit?: boolean;
}

/** A straight-line chain: START sends four transfers on, the last a CCTP burn. */
const hops: Hop[] = [
  { digest: "d1", sender: START, checkpoint: 100, from: START, to: NODE_A, amount: "1000000000" },
  { digest: "d2", sender: NODE_A, checkpoint: 200, from: NODE_A, to: NODE_B, amount: "1000000000" },
  { digest: "d3", sender: NODE_B, checkpoint: 300, from: NODE_B, to: NODE_C, amount: "1000000000" },
  { digest: "d4", sender: NODE_C, checkpoint: 400, from: NODE_C, to: NODE_D, amount: "1000000000" },
  { digest: "d5", sender: NODE_D, checkpoint: 500, from: NODE_D, to: "", amount: "1000000000", exit: true },
];

function gqlTxFor(h: Hop) {
  const changes = h.exit
    ? [{ coinType: { repr: SUI }, amount: `-${h.amount}`, owner: { address: h.sender } }]
    : [
        { coinType: { repr: SUI }, amount: `-${h.amount}`, owner: { address: h.from } },
        { coinType: { repr: SUI }, amount: h.amount, owner: { address: h.to } },
      ];
  return {
    transaction: {
      digest: h.digest,
      sender: { address: h.sender },
      gasInput: { gasSponsor: { address: h.sender } },
      signatures: [],
      effects: {
        status: "SUCCESS",
        timestamp: "2024-05-04T12:00:00Z",
        checkpoint: { sequenceNumber: h.checkpoint },
        gasEffects: { gasSummary: { computationCost: 0, storageCost: 0, storageRebate: 0 } },
        balanceChanges: { pageInfo: { hasNextPage: false }, nodes: changes },
        events: {
          pageInfo: { hasNextPage: false },
          nodes: h.exit ? [{ contents: { type: { repr: `${CCTP_PKG}::deposit_for_burn::DepositForBurn` } } }] : [],
        },
        objectChanges: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
      kind: {
        commands: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: h.exit
            ? [
                {
                  __typename: "MoveCallCommand",
                  function: { name: "deposit_for_burn_with_caller_with_package_auth", module: { name: "deposit_for_burn", package: { address: CCTP_PKG } } },
                },
              ]
            : [],
        },
      },
    },
  };
}

function candidatesFor(h: Hop | undefined) {
  if (!h) return { transactions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
  const changes = h.exit
    ? [{ coinType: { repr: SUI }, amount: `-${h.amount}`, owner: { address: h.sender } }]
    : [
        { coinType: { repr: SUI }, amount: `-${h.amount}`, owner: { address: h.from } },
        { coinType: { repr: SUI }, amount: h.amount, owner: { address: h.to } },
      ];
  return {
    transactions: {
      nodes: [
        {
          digest: h.digest,
          sender: { address: h.sender },
          gasInput: { gasSponsor: { address: h.sender } },
          effects: {
            gasEffects: { gasSummary: { computationCost: 0, storageCost: 0, storageRebate: 0 } },
            balanceChanges: { pageInfo: { hasNextPage: false }, nodes: changes },
          },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockFanout.mockReset();
  mockFanout.mockResolvedValue({ classification: "narrow", counterparty_count: 1, scanned_transactions: 5, truncated: false });
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
    const q = String(query);
    if (q.includes("transactions(")) return candidatesFor(hops.find((h) => h.sender === String(vars.address)));
    if (q.includes("events(first: $first")) {
      const h = hops.find((h2) => h2.digest === String(vars.digest));
      if (!h?.exit) return { transaction: { effects: { events: { pageInfo: { hasNextPage: false }, nodes: [] } } } };
      return {
        transaction: {
          effects: {
            events: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  contents: {
                    type: { repr: `${CCTP_PKG}::deposit_for_burn::DepositForBurn` },
                    json: {
                      nonce: "1",
                      amount: h.amount,
                      depositor: h.sender,
                      mint_recipient: `0x000000000000000000000000${ETH_DEST.slice(2)}`,
                      destination_domain: 0,
                      burn_token: "0x3f2e28d163e25042ac7c9543c15675af5aa5d3c27dbc656a67f37f4293a3fdef",
                    },
                  },
                },
              ],
            },
          },
        },
      };
    }
    const h = hops.find((h2) => h2.digest === String(vars.digest));
    return h ? gqlTxFor(h) : { transaction: null };
  });
});

describe("find_flow_path — default max_hops must reach a bridge exit five levels out", () => {
  it("finds the path at the tool's default limits", async () => {
    const data = await run({ from: START, to: `eip155:1:${ETH_DEST}` });
    expect(data.found).toBe(true);
    expect(data.paths[0].steps.at(-1).digests).toContain("d5");
  });

  it("still fails to find it at max_hops 4 — the level before the exit is recorded", async () => {
    const data = await run({ from: START, to: `eip155:1:${ETH_DEST}`, max_hops: 4 });
    expect(data.found).toBe(false);
  });
});
