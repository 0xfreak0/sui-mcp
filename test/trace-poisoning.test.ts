import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tool-level cover for the address-poisoning wiring in `trace_funds`.
 *
 * The detector itself is tested in `address-lookalike.test.ts`. What can only
 * be tested here is which addresses the trace hands it: a lookalike and the
 * address it imitates usually sit SEVERAL HOPS APART, so the comparison has to
 * run over the whole trace rather than per hop, and it has to include the
 * recipients the trace declined to follow.
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
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false }));
vi.mock("../src/utils/price-providers.js", () => ({ pricesForRanking: async () => new Map() }));
vi.mock("../src/utils/store.js", () => ({
  getCachedTransaction: () => null,
  saveTransaction: () => {},
}));

const { registerTraceTools } = await import("../src/tools/trace.js");

type Args = { digest: string; direction?: string; hops?: number };
let handler: (a: Args) => Promise<{ content: { text: string }[] }>;
registerTraceTools({
  tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
    if (n === "trace_funds") handler = h;
  },
} as never);

const run = async (a: Args) => {
  const r = await handler(a);
  const texts = r.content.map((c) => c.text);
  const json = texts.find((t) => t.trim().startsWith("{"));
  return { summary: texts[0]!, data: json ? JSON.parse(json) : null };
};

/** Two addresses that render identically once truncated: 4 leading, 5 trailing. */
const REAL = `0xd649a4${"1".repeat(53)}d7127`;
const FAKE = `0xd649ef${"2".repeat(53)}d7127`;
const PAYER = `0xaabbcc${"3".repeat(53)}90210`;
const MIDDLE = `0x112233${"4".repeat(53)}5f5f5`;

/** A transaction in the shape trace_funds' GraphQL query returns. */
const tx = (
  digest: string,
  sender: string,
  changes: [string, string][],
) => ({
  transaction: {
    digest,
    sender: { address: sender },
    effects: {
      status: "SUCCESS",
      timestamp: "2026-01-14T09:36:30Z",
      checkpoint: { sequenceNumber: "1" },
      balanceChanges: {
        nodes: changes.map(([address, amount]) => ({
          coinType: { repr: "0x2::sui::SUI" },
          amount,
          owner: { address },
        })),
      },
    },
    kind: { commands: { nodes: [] } },
  },
});

beforeEach(() => mockGqlQuery.mockReset());

describe("trace_funds — address poisoning across hops", () => {
  /**
   * Hop 1 pays MIDDLE and, as a second recipient the trace does not follow,
   * FAKE. Hop 2 is MIDDLE paying REAL. The two lookalikes therefore never share
   * a hop, and one of them is on an unfollowed branch — the case a per-hop or
   * followed-path-only check misses.
   */
  const twoHops = (q: string, v: Record<string, unknown> = {}) => {
    if (String(q).includes("transactions(")) {
      // Next-hop lookup, keyed on the address the trace is standing on.
      return Promise.resolve({
        transactions: { nodes: v.address === MIDDLE ? [{ digest: "hop2" }] : [] },
      });
    }
    if (v.digest === "hop2") {
      return Promise.resolve(tx("hop2", MIDDLE, [[MIDDLE, "-1000000000"], [REAL, "1000000000"]]));
    }
    return Promise.resolve(
      tx("hop1", PAYER, [
        [PAYER, "-2000000000"],
        [MIDDLE, "1500000000"],
        [FAKE, "500000000"],
      ]),
    );
  };

  it("pairs addresses that never shared a hop", async () => {
    mockGqlQuery.mockImplementation(twoHops);
    const { data } = await run({ digest: "hop1", direction: "forward", hops: 4 });
    const pairs = data.address_poisoning?.pairs ?? [];
    expect(pairs).toHaveLength(1);
    const found = [pairs[0].established, pairs[0].suspect].sort();
    expect(found).toEqual([REAL, FAKE].sort());
  });

  it("puts the warning in the summary, not only the payload", async () => {
    mockGqlQuery.mockImplementation(twoHops);
    const { summary } = await run({ digest: "hop1", direction: "forward", hops: 4 });
    expect(summary).toMatch(/close enough to be mistaken for one another/i);
  });

  it("omits the field entirely when nothing collides", async () => {
    mockGqlQuery.mockImplementation((q: string) => {
      if (String(q).includes("transactions(")) return Promise.resolve({ transactions: { nodes: [] } });
      return Promise.resolve(
        tx("hop1", PAYER, [[PAYER, "-1000000000"], [MIDDLE, "1000000000"]]),
      );
    });
    const { data, summary } = await run({ digest: "hop1", direction: "forward", hops: 4 });
    expect(data.address_poisoning).toBeUndefined();
    expect(summary).not.toMatch(/render identically/i);
  });
});
