import { describe, it, expect, vi, beforeEach } from "vitest";
import { GQL_MAX_PAGE_SIZE, pagedTxConnection } from "./helpers/service-shapes.js";
import type { GqlBalanceChangeNode } from "../src/utils/gql-adapters.js";
import type { DeltaScan } from "../src/utils/historical-balance.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { ownerCoinDelta, balanceAt, reconstructBalance, anchorCheckpoint } = await import(
  "../src/utils/historical-balance.js"
);

const OWNER = "0x" + "a".repeat(64);
const OTHER = "0x" + "b".repeat(64);
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

const change = (owner: string, amount: bigint | number, coinType = SUI): GqlBalanceChangeNode => ({
  owner: { address: owner },
  amount: String(amount),
  coinType: { repr: coinType },
});

interface ChainTx {
  digest: string;
  checkpoint: number;
  changes: GqlBalanceChangeNode[];
}

/**
 * A chain the way GraphQL serves it: balances readable only inside
 * [first, last], transactions filtered by the exclusive checkpoint bounds and
 * paged with `last`/`before` in ascending order.
 */
function serve(opts: {
  initial: bigint;
  txs: ChainTx[];
  range: { first: number; last: number };
  extra?: (q: string, v: Record<string, unknown>) => unknown;
}) {
  const txs = [...opts.txs].sort((a, b) => a.checkpoint - b.checkpoint);
  const truth = (cp: number) =>
    txs.filter((t) => t.checkpoint <= cp).reduce((s, t) => s + ownerCoinDelta(t.changes, OWNER, SUI), opts.initial);
  const seen = { balanceAt: [] as number[], scans: [] as Record<string, unknown>[] };
  mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown> = {}) => {
    const extra = opts.extra?.(q, v);
    if (extra !== undefined) return extra;
    if (q.includes("address(address: $owner, atCheckpoint")) {
      const cp = Number(v.checkpoint);
      seen.balanceAt.push(cp);
      if (cp < opts.range.first || cp > opts.range.last) throw new Error("Request is outside consistent range");
      const total = truth(cp).toString();
      return {
        checkpoint: { timestamp: "2026-01-01T00:00:00Z" },
        address: { balance: { coinType: { repr: SUI }, totalBalance: total, coinBalance: total, addressBalance: "0" } },
      };
    }
    if (q.includes("transactions(filter: { affectedAddress: $owner")) {
      seen.scans.push(v);
      const inWindow = txs.filter((t) => t.checkpoint > Number(v.afterCp) && t.checkpoint < Number(v.beforeCp));
      const last = Number(v.last);
      if (!(last >= 1 && last <= GQL_MAX_PAGE_SIZE)) throw new Error(`bad page size ${last}`);
      const end = v.before === undefined ? inWindow.length : Number(v.before);
      const start = Math.max(0, end - last);
      return {
        transactions: {
          nodes: inWindow.slice(start, end).map((t) => ({
            digest: t.digest,
            effects: {
              timestamp: `cp-${t.checkpoint}`,
              checkpoint: { sequenceNumber: t.checkpoint },
              balanceChanges:
                t.changes.length > GQL_MAX_PAGE_SIZE
                  ? pagedTxConnection(t.digest, t.changes, "balanceChanges").first
                  : { pageInfo: { hasNextPage: false, endCursor: null }, nodes: t.changes },
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: start > 0, startCursor: String(start) },
        },
      };
    }
    throw new Error(`unexpected query: ${q.slice(0, 80)}`);
  });
  return { truth, seen };
}

beforeEach(() => {
  mockGqlQuery.mockReset();
});

describe("ownerCoinDelta", () => {
  it("sums only the owner's changes in the coin, whatever spelling the type uses", () => {
    const changes = [
      change(OWNER, -1_000n),
      change(OWNER, 250n, "0x2::sui::SUI"),
      change(OTHER, 999_999n),
      change(OWNER, 5_000_000n, USDC),
      change(OWNER, 30n),
    ];
    expect(ownerCoinDelta(changes, OWNER, SUI)).toBe(-720n);
    expect(ownerCoinDelta(changes, OWNER, USDC)).toBe(5_000_000n);
  });

  it("keeps amounts beyond 2^53 exact", () => {
    const big = 2n ** 60n + 1n;
    expect(ownerCoinDelta([change(OWNER, big), change(OWNER, -1n)], OWNER, SUI)).toBe(2n ** 60n);
  });
});

describe("balanceAt", () => {
  const scan = (delta: bigint, extra: Partial<DeltaScan> = {}): DeltaScan => ({
    delta,
    transactions_scanned: 3,
    complete: true,
    reached_checkpoint: 10,
    reached_timestamp: null,
    budget_exhausted: false,
    incomplete_transactions: [],
    ...extra,
  });

  it("subtracts what happened after the point from the anchor balance", () => {
    expect(balanceAt("1000", scan(400n))).toBe(600n);
    expect(balanceAt("1000", scan(-250n))).toBe(1250n);
  });

  it("gives no number for a scan that did not read everything", () => {
    expect(balanceAt("1000", scan(400n, { complete: false, budget_exhausted: true }))).toBeNull();
    expect(balanceAt("1000", scan(400n, { incomplete_transactions: ["D1"] }))).toBeNull();
  });

  it("gives no number when the arithmetic goes negative", () => {
    expect(balanceAt("100", scan(101n))).toBeNull();
  });
});

describe("reconstructBalance", () => {
  const range = { first: { sequenceNumber: 9_000, timestamp: null }, last: { sequenceNumber: 10_000, timestamp: null } };

  it("reads the anchor balance and scans up to the same checkpoint, so a later transaction counts on neither side", async () => {
    const anchor = anchorCheckpoint(range);
    expect(anchor).toBeGreaterThanOrEqual(9_000);
    expect(anchor).toBeLessThanOrEqual(10_000);
    const { truth, seen } = serve({
      initial: 10_000n,
      range: { first: 9_000, last: 10_000 },
      txs: [
        { digest: "D100", checkpoint: 100, changes: [change(OWNER, 500n)] },
        { digest: "D200", checkpoint: 200, changes: [change(OWNER, -120n), change(OTHER, 120n)] },
        { digest: "D300", checkpoint: 300, changes: [change(OWNER, 7n, USDC)] },
        { digest: "D9500", checkpoint: 9_500, changes: [change(OWNER, 1_000n)] },
        // Past the anchor: in the chain, outside both reads.
        { digest: "DLATE", checkpoint: anchor + 1, changes: [change(OWNER, -9_999n)] },
      ],
    });
    for (const at of [0, 100, 150, 200, 300, 8_999]) {
      const r = await reconstructBalance({ owner: OWNER, coinType: SUI, at, range, maxTransactions: 100 });
      expect(r.complete).toBe(true);
      expect(r.balance).toBe(truth(at).toString());
      expect(BigInt(r.anchor.balance) - BigInt(r.change_since!)).toBe(truth(at));
    }
    expect(new Set(seen.balanceAt)).toEqual(new Set([anchor]));
    for (const s of seen.scans) expect(s.beforeCp).toBe(anchor + 1);
    expect(seen.scans.map((s) => s.afterCp)).toContain(150);
  });

  it("counts a change that sorts past the first page of a transaction's balance changes", async () => {
    const airdrop = [...Array.from({ length: 60 }, (_, i) => change("0x" + i.toString(16).padStart(64, "c"), 1n)), change(OWNER, -60n)];
    const conn = pagedTxConnection("DAIR", airdrop, "balanceChanges");
    const { truth } = serve({
      initial: 1_000n,
      range: { first: 9_000, last: 10_000 },
      txs: [{ digest: "DAIR", checkpoint: 500, changes: airdrop }],
      extra: (q, v) => conn.respond(q, v),
    });
    const r = await reconstructBalance({ owner: OWNER, coinType: SUI, at: 499, range, maxTransactions: 100 });
    expect(r.balance).toBe(truth(499).toString());
    expect(r.change_since).toBe("-60");
  });

  it("gives no number when a transaction's balance changes could not all be read", async () => {
    const airdrop = [...Array.from({ length: 60 }, () => change(OTHER, 1n)), change(OWNER, -60n)];
    serve({
      initial: 1_000n,
      range: { first: 9_000, last: 10_000 },
      txs: [{ digest: "DAIR", checkpoint: 500, changes: airdrop }],
      extra: (q) => {
        if (q.includes("transactionEffects(digest")) throw new Error("503");
        return undefined;
      },
    });
    const r = await reconstructBalance({ owner: OWNER, coinType: SUI, at: 499, range, maxTransactions: 100 });
    expect(r.complete).toBe(false);
    expect(r.balance).toBeNull();
    expect(r.change_since).toBeNull();
    expect(r.incomplete_transactions).toEqual(["DAIR"]);
  });

  describe("budget", () => {
    const txs: ChainTx[] = Array.from({ length: 120 }, (_, i) => ({
      digest: `D${i}`,
      checkpoint: 1_000 + i * 10,
      changes: [change(OWNER, i % 2 ? 3n : -1n)],
    }));

    it("stops at max_transactions with no balance and says how far back it read", async () => {
      serve({ initial: 50_000n, range: { first: 9_000, last: 10_000 }, txs });
      const r = await reconstructBalance({ owner: OWNER, coinType: SUI, at: 0, range, maxTransactions: 70 });
      expect(r.complete).toBe(false);
      expect(r.balance).toBeNull();
      expect(r.balance_formatted).toBeNull();
      expect(r.change_since).toBeNull();
      expect(r.transactions_scanned).toBe(70);
      // The 70 newest are D50..D119; everything after D50's checkpoint was read.
      expect(r.reached_checkpoint).toBe(1_000 + 50 * 10);
      expect(r.note).toContain("1500");
    });

    it("is complete when the budget covers exactly what is there", async () => {
      const { truth } = serve({ initial: 50_000n, range: { first: 9_000, last: 10_000 }, txs });
      const r = await reconstructBalance({ owner: OWNER, coinType: SUI, at: 0, range, maxTransactions: 120 });
      expect(r.complete).toBe(true);
      expect(r.transactions_scanned).toBe(120);
      expect(r.balance).toBe(truth(0).toString());
    });
  });
});
