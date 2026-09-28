import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient } from "./helpers/mock-grpc.js";

/**
 * find_funding_source's origin_fanout and get_address_fanout on the same
 * address are one measurement. A scan that read every transaction is not
 * truncated in either, and one the budget cut is truncated in both, with the
 * same counts and the budget stated.
 */

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
const mockSui = createMockClient();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../src/utils/price-providers.js", () => ({ pricesForRanking: async () => new Map() }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false }));
vi.mock("../src/utils/store.js", () => ({
  getCachedFanout: () => null,
  saveFanout: () => false,
  getCachedFirstFunder: () => null,
  saveFirstFunder: () => false,
  saveResult: () => null,
}));
vi.mock("../src/utils/identity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  describeAddresses: async (addrs: string[]) => new Map(addrs.map((a) => [a, { address: a, kind: "wallet" as const }])),
  identityNote: () => undefined,
}));

const { registerFundingTools } = await import("../src/tools/funding.js");
const tools = new Map<string, Function>();
registerFundingTools({ tool: (n: string, _d: string, _s: unknown, h: Function) => tools.set(n, h) } as never);
const run = async (name: string, args: Record<string, unknown>) =>
  JSON.parse((await tools.get(name)!(args)).content.at(-1).text);

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const SUBJECT = `0x${"5a".repeat(32)}`;
const ORIGIN = `0x${"0f".repeat(32)}`;
const party = (n: number) => `0x${(n + 1).toString(16).padStart(64, "0")}`;

const bc = (address: string, amount: string) => ({ amount, owner: { address }, coinType: { repr: SUI } });
const conn = <T>(nodes: T[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const transfer = (digest: string, from: string, to: string) => ({
  digest,
  sender: { address: from },
  gasInput: { gasSponsor: { address: from } },
  effects: {
    timestamp: "2024-01-01T00:00:00.000Z",
    checkpoint: { sequenceNumber: 1 },
    balanceChanges: conn([bc(from, "-1000000000"), bc(to, "1000000000")]),
  },
});

/** The origin's whole history, oldest first: every 40th a payment out, the rest inflows. */
let history: unknown[];

beforeEach(() => {
  mockSui.stateService.getCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
    throw new Error(`NOT_FOUND: no CoinMetadata for ${coinType}`);
  });
  gqlQuery.mockImplementation(async (q: string, vars: Record<string, unknown> = {}) => {
    const query = String(q);
    if (query.startsWith("query{p0:")) {
      const out: Record<string, unknown> = {};
      for (const m of query.matchAll(/(p\d+):transactions\(/g)) out[m[1]] = conn([]);
      return out;
    }
    if (query.includes("sentAddress")) {
      return { transactions: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } } };
    }
    if (query.includes("$last")) {
      // The fan-out scan, newest first through `before` cursors.
      const end = vars.before === undefined ? history.length : Number(vars.before);
      const start = Math.max(0, end - Number(vars.last));
      return {
        transactions: {
          nodes: history.slice(start, end),
          pageInfo: { hasPreviousPage: start > 0, startCursor: start > 0 ? String(start) : undefined },
        },
      };
    }
    if (query.includes("affectedAddress: $addr")) {
      const earliest = vars.addr === SUBJECT ? [transfer("Fund0001", ORIGIN, SUBJECT)] : [];
      return { transactions: { nodes: earliest } };
    }
    return { transactionEffects: null };
  });
});

const historyOf = (length: number) =>
  Array.from({ length }, (_, i) =>
    i % 40 === 0 ? transfer(`out${i}`, ORIGIN, party(10_000 + i / 40)) : transfer(`in${i}`, party(i % 60), ORIGIN),
  );

describe("origin_fanout and get_address_fanout agree on one address", () => {
  it.each([
    // Longer than a 300-transaction window, inside the default one.
    { length: 320, truncated: false, scanned: 320 },
    // Exactly the budget: the scan read the last transaction, so nothing is left.
    { length: 1000, truncated: false, scanned: 1000 },
    { length: 1001, truncated: true, scanned: 1000 },
  ])("a $length-transaction history reads truncated=$truncated in both", async ({ length, truncated, scanned }) => {
    history = historyOf(length);
    const traced = await run("find_funding_source", { address: SUBJECT, max_hops: 1 });
    const direct = await run("get_address_fanout", { address: ORIGIN });

    expect(traced.origin.address).toBe(ORIGIN);
    const origin = traced.origin_fanout;
    for (const r of [origin, direct]) {
      expect(r.truncated).toBe(truncated);
      expect(r.scanned_transactions).toBe(scanned);
      expect(r.max_transactions).toBe(1000);
    }
    expect(origin.recipient_count).toBe(direct.recipient_count);
    expect(origin.sender_count).toBe(direct.sender_count);
    expect(origin.counterparty_count).toBe(direct.counterparty_count);
    expect(origin.classification_provisional).toBe(direct.classification_provisional);
  });
});
