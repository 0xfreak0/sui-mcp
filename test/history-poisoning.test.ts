import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tool-level cover for the address-poisoning wiring in `get_transaction_history`.
 *
 * The comparison runs over every address on the page, NOT over
 * `counterparties`. A poisoning wallet sends dust, so in the victim's history
 * it is the SENDER of its transaction and its balance change is negative.
 * Counterparty extraction drops both senders and negative changes, which
 * suits "where did value go" and would hide the poisoner.
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

describe("get_transaction_history — which one existed first decides only the poisoning shape", () => {
  // Mainnet addresses: victim V, real recipient R and its lookalike L.
  const V = "0x5e455d9536112e97a185affcb7ab5887c080f340883526487844d964babe0b93";
  const R = "0x6b74e92cfc7890b7a4a48c933bb8da38bb2897f3962f33af20f5f7101d2d93cf";
  const L = "0x6b745225460cf4aeebe5edb4e381474a58abf206aa34dd838eb6570edd67b3cf";
  const OPERATOR = "0x7c8e2ceb0839680a3b1f7aa1021d45670405d92f3c88e79aa1d3aa8a600bbdbf";
  const HOT = "0x62f36b79d7ea8ae189491854edd9318b29c75346792177b230a95f333ffa53ad";
  const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
  const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

  /** A transaction at `at`, with [owner, amount, coin] balance changes. */
  const tx = (digest: string, sender: string, at: string, changes: [string, string, string?][]) => ({
    digest,
    sender: { address: sender },
    effects: {
      status: "SUCCESS",
      timestamp: at,
      balanceChanges: {
        nodes: changes.map(([address, amount, coin]) => ({ coinType: { repr: coin ?? SUI }, amount, owner: { address } })),
      },
    },
    kind: { commands: { nodes: [] } },
  });

  it("does not call the real recipient the impostor when the victim paid the lookalike first", async () => {
    // The victim pays L by mistake, notices, then re-pays R. Both received
    // and both appear once, so only first-seen order is left, and it would
    // name R, first seen later in this page, the impostor.
    mockGqlQuery.mockResolvedValue(
      page([
        tx("loss", V, "2026-09-09T09:30:00.000Z", [[V, "-1190000000"], [L, "1188330952"]]),
        tx("repay", V, "2026-09-09T09:45:00.000Z", [[V, "-1190000000"], [R, "1188330952"]]),
      ]),
    );
    const [pair] = (await run({ address: V })).address_poisoning.pairs;
    expect(pair.direction_known).toBe(false);
    expect(pair.direction_basis).toBeUndefined();
  });

  it("stays undecided when the page starts at the dust, after the payment it imitated", async () => {
    // The trigger payment to R sits before the page. The page opens on L's
    // dust, then the loss to L, then a later payment to R: L is first seen
    // only because the page boundary cut off R's earlier appearance.
    mockGqlQuery.mockResolvedValue(
      page([
        tx("dust", L, "2026-09-09T09:31:00.000Z", [[L, "-20", USDC], [V, "20", USDC], [OPERATOR, "-2000000"]]),
        tx("loss", V, "2026-09-09T09:40:00.000Z", [[V, "-1190000000"], [L, "1188330952"]]),
        tx("repay", V, "2026-09-09T09:45:00.000Z", [[V, "-1190000000"], [R, "1188330952"]]),
      ]),
    );
    const [pair] = (await run({ address: V })).address_poisoning.pairs;
    expect(pair.direction_known).toBe(false);
  });

  it("names the lookalike that first appears dusting the victim seconds after the real payment", async () => {
    // The victim's history as mainnet returns it: the lookalike's first row
    // is its 20-raw-USDC dust, 3.9 s after the payment to R, with the
    // operator paying gas.
    mockGqlQuery.mockResolvedValue(
      page([
        tx("DAQuKgGF", HOT, "2026-09-09T17:51:11.710Z", [[HOT, "-1189350000"], [V, "1187350000"]]),
        tx("FGKEgbqE", V, "2026-09-09T17:54:29.969Z", [[V, "-209800000", USDC], [R, "209800000", USDC], [V, "-2000000"]]),
        tx("FH4S9fEm", L, "2026-09-09T17:54:33.917Z", [[L, "-20", USDC], [V, "20", USDC], [OPERATOR, "-2000000"]]),
        tx("8Z4iMqvG", V, "2026-09-09T18:18:25.063Z", [[V, "-1190330952"], [L, "1188330952"]]),
      ]),
    );
    const [pair] = (await run({ address: V })).address_poisoning.pairs;
    expect(pair).toMatchObject({ established: R, suspect: L, direction_known: true, direction_basis: "lifecycle" });
  });
});
