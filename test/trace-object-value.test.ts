import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * trace_funds follows valued objects that outweigh the coin flow: a drain of
 * stakes moves them to a collector and credits the signer only a decoy.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({
  sui: { stateService: { getCoinInfo: async () => ({ response: { metadata: { decimals: 9 } } }) } },
  archive: {},
}));
vi.mock("../src/utils/archive-fallback.js", () => ({ withArchiveFallback: async () => null }));
vi.mock("../src/utils/identity.js", () => ({ describeAddresses: async () => new Map(), identityNote: () => null }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false }));
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
vi.mock("../src/utils/recent-prices.js", () => ({ fetchRecentHistory: async () => ({ quotes: new Map(), unanswered: new Map() }) }));
vi.mock("../src/utils/store.js", () => ({ getCachedTransaction: () => null, saveTransaction: () => {} }));
const measureFanout = vi.fn(async () => null);
vi.mock("../src/utils/fanout.js", () => ({ measureFanout }));

const FROM = `0x8c4f${"1".repeat(58)}5ee8`;
const TO = `0xeda2${"2".repeat(58)}6c2b`;
const STAKE = `0x${"5".repeat(64)}`;
const STAKE_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::StakedSui";
const DECOY = `0x${"d".repeat(64)}::srt::SRT`;

let stakeUsd: number | null = 2500;
vi.mock("../src/utils/position-value.js", () => ({ readerFor: () => "staked_sui" }));
vi.mock("../src/utils/moved-value.js", () => ({
  readMovedObjects: async (digests: string[]) => ({ txs: digests.map((digest) => ({ digest, checkpoint: digest, moved: [] })), unread: [] }),
  valueMovedObjects: async (_moved: unknown, digest: string) => ({
    rows: digest === "drawdown" ? [
      {
        object_id: STAKE,
        type: STAKE_TYPE,
        from: TO,
        to: TO,
        protocol: "Sui staking",
        kind: "staked_sui",
        usd: -2500,
        changed_in_place: true,
        usd_after: 0,
        estimate: false,
        tier: "price-provider",
        method: "synthetic",
      },
    ] : [
      {
        object_id: STAKE,
        type: STAKE_TYPE,
        from: FROM,
        to: TO,
        protocol: "Sui staking",
        kind: "staked_sui",
        usd: stakeUsd,
        estimate: false,
        tier: "price-provider",
        method: "synthetic",
      },
    ],
    unread: [],
  }),
}));

// Imported after the mocks above, which the factories close over.
const { registerTraceTools } = await import("../src/tools/trace.js");

let handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
registerTraceTools({
  tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
    if (n === "trace_funds") handler = h;
  },
} as never);

const run = async (a: Record<string, unknown>) => {
  const texts = (await handler(a)).content.map((c) => c.text);
  return JSON.parse(texts.find((t) => t.trim().startsWith("{"))!);
};

const addrOwner = (a: string) => ({ __typename: "AddressOwner", address: { address: a } });
const txOf = (digest: string, sender: string, changes: Array<[string, string, string]>, objectChanges: unknown[]) => ({
  transaction: {
    digest,
    sender: { address: sender },
    effects: {
      status: "SUCCESS",
      timestamp: "2024-08-10T00:16:17Z",
      checkpoint: { sequenceNumber: digest === "drain" ? 100 : 101 },
      balanceChanges: { nodes: changes.map(([owner, coin, amount]) => ({ coinType: { repr: coin }, amount, owner: { address: owner } })) },
      objectChanges: { nodes: objectChanges },
    },
    kind: { commands: { nodes: [{ __typename: "TransferObjectsCommand" }] } },
  },
});
const drain = txOf(
  "drain",
  FROM,
  [
    [FROM, "0x2::sui::SUI", "-2100000"],
    [FROM, DECOY, "404300000000"],
  ],
  [
    {
      address: STAKE,
      idCreated: false,
      idDeleted: false,
      inputState: { asMoveObject: { contents: { type: { repr: STAKE_TYPE } } }, owner: addrOwner(FROM) },
      outputState: { asMoveObject: { contents: { type: { repr: STAKE_TYPE } } }, owner: addrOwner(TO) },
    },
  ],
);
const unstake = txOf("unstake", TO, [[TO, "0x2::sui::SUI", "1000000000000"]], []);

beforeEach(() => {
  stakeUsd = 2500;
  mockGqlQuery.mockReset();
  mockGqlQuery.mockImplementation(async (q: string, vars: Record<string, unknown> = {}) => {
    const filter = vars.f as { affectedObject?: string } | undefined;
    if (filter?.affectedObject === STAKE) return { transactions: { nodes: [{ digest: "unstake", effects: { checkpoint: { sequenceNumber: 101 } } }] } };
    if (String(q).includes("transactions(")) return { transactions: { nodes: [] } };
    if (vars.digest === "drain") return drain;
    if (vars.digest === "unstake") return unstake;
    return { transaction: null };
  });
});

describe("trace_funds keeps the object trail through in-place changes", () => {
  it("passes a fee collection that leaves the position in place and reaches the close", async () => {
    const fee = txOf("fee", TO, [[TO, "0x2::sui::SUI", "5000000000"]], []);
    const close = txOf("close", TO, [[TO, "0x2::sui::SUI", "900000000000"]], [
      {
        address: STAKE,
        idCreated: false,
        idDeleted: true,
        inputState: { asMoveObject: { contents: { type: { repr: STAKE_TYPE } } }, owner: addrOwner(TO) },
        outputState: null,
      },
    ]);
    mockGqlQuery.mockImplementation(async (q: string, vars: Record<string, unknown> = {}) => {
      const filter = vars.f as { affectedObject?: string } | undefined;
      if (filter?.affectedObject === STAKE) {
        return {
          transactions: {
            nodes: [
              { digest: "drain", effects: { checkpoint: { sequenceNumber: 100 } } },
              { digest: "fee", effects: { checkpoint: { sequenceNumber: 101 } } },
              { digest: "close", effects: { checkpoint: { sequenceNumber: 102 } } },
            ],
          },
        };
      }
      if (String(q).includes("transactions(")) return { transactions: { nodes: [] } };
      if (vars.digest === "drain") return drain;
      if (vars.digest === "fee") return fee;
      if (vars.digest === "close") return close;
      return { transaction: null };
    });
    const d = await run({ digest: "drain", direction: "forward", hops: 3 });

    expect(d.hops.map((h: { digest: string }) => h.digest)).toEqual(["drain", "fee", "close"]);
    expect(d.hops[1].basis).toBe("object");
  });
});

describe("trace_funds leaves a position emptied in place for its payout", () => {
  it("follows the coins a full withdrawal paid out instead of the empty position", async () => {
    const PAYEE = `0x${"7".repeat(64)}`;
    const drawdown = txOf("drawdown", TO, [[TO, "0x2::sui::SUI", "-5000"], [PAYEE, "0x2::sui::SUI", "900000000000"]], []);
    const payee = txOf("payee", PAYEE, [[PAYEE, "0x2::sui::SUI", "-900000000000"]], []);
    mockGqlQuery.mockImplementation(async (q: string, vars: Record<string, unknown> = {}) => {
      const filter = vars.f as { affectedObject?: string } | undefined;
      if (filter?.affectedObject === STAKE) {
        return { transactions: { nodes: [{ digest: "drawdown", effects: { checkpoint: { sequenceNumber: 101 } } }] } };
      }
      if (String(q).includes("transactions(")) return { transactions: { nodes: [] } };
      if (vars.digest === "drain") return drain;
      if (vars.digest === "drawdown") return drawdown;
      if (vars.digest === "payee") return payee;
      return { transaction: null };
    });
    const d = await run({ digest: "drain", direction: "forward", hops: 3 });

    expect(d.hops[1].digest).toBe("drawdown");
    expect(d.hops[1].basis).not.toBe("object");
  });
});

describe("trace_funds follows valued objects", () => {
  it("follows stakes worth more than the coin flow to their recipient's next transaction", async () => {
    const d = await run({ digest: "drain", direction: "forward", hops: 3 });

    expect(d.hops[0].basis).toBe("object");
    expect(d.hops[0].object_values[0]).toMatchObject({ object_id: STAKE, usd: 2500 });
    // Object custody is precise, so the holder's fan-out is not asked.
    expect(measureFanout).not.toHaveBeenCalledWith(TO, expect.anything());
    expect(d.hops[1].digest).toBe("unstake");
    expect(d.hops[1].sender).toBe(TO);
  });

  it("keeps to the coin when the objects have no price", async () => {
    stakeUsd = null;
    const d = await run({ digest: "drain", direction: "forward", hops: 3 });

    expect(d.hops[0].basis).not.toBe("object");
    expect(d.hops.map((h: { sender: string }) => h.sender)).not.toContain(TO);
  });
});
