import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tool-level cover for the address-poisoning wiring in `get_transaction_history`.
 *
 * One thing here is load-bearing and easy to undo: the comparison runs over
 * every address on the page, NOT over `counterparties`. A poisoning wallet
 * sends dust, so in the victim's history it is the SENDER of its transaction
 * and its balance change is negative — and counterparty extraction drops both
 * senders and negative changes, which is correct for "where did value go" and
 * would have missed every real case. Verified on mainnet.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
vi.mock("../src/protocols/registry.js", () => ({
  prefetchProtocolNames: async () => {},
  lookupProtocol: () => null,
  lookupProtocolDisplay: () => null,
}));

const { registerHistoryTools } = await import("../src/tools/history.js");

type Args = { address: string; limit?: number };
let handler: (a: Args) => Promise<{ content: { text: string }[] }>;
registerHistoryTools({
  tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => { handler = h; },
} as never);

const run = async (a: Args) => JSON.parse((await handler(a)).content[0].text);

const VICTIM = `0x6b28df${"7".repeat(53)}04ac9`;
/** The address the lookalike imitates: 3 leading, 4 trailing. */
const REAL = `0x7a4c19${"8".repeat(53)}de50f`;
const FAKE = `0x7a41c6${"9".repeat(53)}de50f`;

const node = (digest: string, sender: string, changes: [string, string][]) => ({
  digest,
  sender: { address: sender },
  effects: {
    status: "SUCCESS",
    timestamp: "2026-05-23T16:49:59Z",
    balanceChanges: {
      nodes: changes.map(([address, amount]) => ({
        coinType: { repr: "0x2::sui::SUI" },
        amount,
        owner: { address },
      })),
    },
  },
  kind: { commands: { nodes: [] } },
});

/** A page as `last:` returns it: ascending, with both directions' page info. */
const page = (nodes: unknown[]) => ({
  transactions: {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
  },
});

beforeEach(() => mockGqlQuery.mockReset());

describe("get_transaction_history — address poisoning", () => {
  /**
   * The real mainnet shape: the lookalike SENDS 0.001 SUI to the victim, so it
   * appears only as `sender` with a negative balance change. The victim also
   * deals with the imitated address in an ordinary transfer.
   */
  const poisonedPage = page([
    node("dust", FAKE, [[VICTIM, "1000000"], [FAKE, "-2097880"]]),
    node("real", REAL, [[VICTIM, "5000000000"], [REAL, "-5002000000"]]),
    node("back", VICTIM, [[VICTIM, "-2000000000"], [REAL, "2000000000"]]),
  ]);

  it("flags a lookalike that only ever appears as a sender", async () => {
    mockGqlQuery.mockResolvedValue(poisonedPage);
    const r = await run({ address: VICTIM });
    expect(r.address_poisoning.pairs).toHaveLength(1);
    expect(r.address_poisoning.pairs[0].suspect).toBe(FAKE);
    expect(r.address_poisoning.pairs[0].established).toBe(REAL);
    expect(r.address_poisoning.pairs[0].direction_known).toBe(true);
  });

  /**
   * Two addresses that both only ever sent once and received nothing are
   * indistinguishable, and naming one the impostor would be inventing the
   * evidence. The collision is still reported; the roles are not.
   */
  it("reports the collision without roles when nothing separates them", async () => {
    mockGqlQuery.mockResolvedValue(
      page([
        node("dustA", FAKE, [[VICTIM, "1000000"], [FAKE, "-2097880"]]),
        node("dustB", REAL, [[VICTIM, "1000000"], [REAL, "-2097880"]]),
      ]),
    );
    const r = await run({ address: VICTIM });
    expect(r.address_poisoning.pairs).toHaveLength(1);
    expect(r.address_poisoning.pairs[0].direction_known).toBe(false);
    expect(r.address_poisoning.pairs[0].note).toMatch(/cannot be told from this data/i);
  });

  it("does not put the sender into counterparties as a side effect", async () => {
    // The poisoning check widened the comparison set; it must not have widened
    // what the tool reports as a counterparty, which means value received.
    mockGqlQuery.mockResolvedValue(poisonedPage);
    const r = await run({ address: VICTIM });
    const all = r.transactions.flatMap((t: { counterparties: { address: string }[] }) =>
      t.counterparties.map((c) => c.address),
    );
    expect(all).not.toContain(FAKE);
    // Rows are newest first, so the page's last transaction leads.
    expect(all).toEqual([REAL, VICTIM, VICTIM]);
  });

  /**
   * The subject leads the comparison set, so a lookalike of the wallet being
   * investigated is caught even when the imitated address is the subject
   * itself — the case that targets transfers between someone's own wallets.
   */
  it("compares the subject address itself", async () => {
    const twin = `0x6b28df${"1".repeat(53)}04ac9`;
    mockGqlQuery.mockResolvedValue(
      page([node("dust", twin, [[VICTIM, "1000000"], [twin, "-2097880"]])]),
    );
    const r = await run({ address: VICTIM });
    expect(r.address_poisoning.pairs[0].suspect).toBe(twin);
    expect(r.address_poisoning.pairs[0].established).toBe(VICTIM);
  });

  it("omits the field when nothing collides", async () => {
    mockGqlQuery.mockResolvedValue(
      page([node("plain", REAL, [[VICTIM, "5000000000"], [REAL, "-5002000000"]])]),
    );
    const r = await run({ address: VICTIM });
    expect(r.address_poisoning).toBeUndefined();
  });

  it("survives a page with no balance changes at all", async () => {
    mockGqlQuery.mockResolvedValue(page([node("empty", REAL, [])]));
    const r = await run({ address: VICTIM });
    expect(r.address_poisoning).toBeUndefined();
    expect(r.transactions).toHaveLength(1);
  });
});
