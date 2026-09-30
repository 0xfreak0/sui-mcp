import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBase58 } from "@mysten/sui/utils";
import type { GqlBalanceChangeNode } from "../src/utils/gql-adapters.js";
import type { StateSnapshot } from "../src/utils/state-delta.js";
import type { PricePoint } from "../src/utils/valuation.js";
import { roundTripsOf } from "../src/utils/round-trip.js";
import { gqlPage, pagedTxConnection } from "./helpers/service-shapes.js";

const { mockGqlQuery } = vi.hoisted(() => ({ mockGqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const SENDER = `0x${"a".repeat(64)}`;
const VAULT = `0x${"b".repeat(64)}`;
const POSITION = `0x${"c".repeat(64)}`;
const PACKAGE = `0x${"d".repeat(64)}`;
const CASH = `${PACKAGE}::cash::CASH`;
const OTHER = `${PACKAGE}::other::OTHER`;
const SHARE = `${PACKAGE}::share::SHARE`;
const ENTRY = toBase58(new Uint8Array(32).fill(17));
const EXIT = toBase58(new Uint8Array(32).fill(18));
const ENTRY_TIME = "2025-01-01T00:00:00.000Z";
const PRICES = new Map<string, PricePoint>([CASH, OTHER, SHARE].map((coin) => [
  coin, { price: 1, publishTime: 0, source: "defillama", decimals: 0 },
]));
const STATE: StateSnapshot = {
  objects: [{
    objectId: VAULT, objectType: `${PACKAGE}::vault::Vault`, role: "shared", parent: null,
    before: { supply: "200" }, after: { supply: "100" }, balances: {}, supplies: { supply: SHARE },
  }],
  skipped: [], unavailable: [], layout_unread: [],
};
const change = (coin: string, amount: number, address = SENDER): GqlBalanceChangeNode => ({
  coinType: { repr: coin }, amount: String(amount), owner: { address },
});
const filler = (count: number) => Array.from({ length: count }, (_, i) =>
  change(CASH, 1, `0x${(i + 1).toString(16).padStart(64, "0")}`),
);

function exit(kind: "share" | "position", payments: Array<[string, number]>): Parameters<typeof roundTripsOf>[0] {
  return {
    digest: EXIT, sender: SENDER, success: true, timestampMs: Date.parse(ENTRY_TIME) + 60_000,
    checkpoint: "100", gas: null,
    balanceChanges: [
      ...payments.map(([coinType, amount]) => ({ address: SENDER, coinType, amount: String(amount) })),
      ...(kind === "share" ? [{ address: SENDER, coinType: SHARE, amount: "-100" }] : []),
    ],
    objects: kind === "share" ? [] : [{ objectId: POSITION, objectType: `${PACKAGE}::position::Position`, inputVersion: "1" }],
  };
}

function serveEntry(kind: "share" | "position", rows: GqlBalanceChangeNode[], failure?: "continuation" | "missing") {
  const conn = pagedTxConnection(ENTRY, rows, "balanceChanges");
  const first = {
    digest: ENTRY, sender: { address: SENDER },
    effects: { status: "SUCCESS", timestamp: ENTRY_TIME, balanceChanges: failure === "missing" ? null : conn.first },
  };
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
    if (vars.digest === ENTRY) {
      if (failure === "continuation") throw new Error("synthetic continuation unavailable");
      const more = conn.respond(query, vars);
      if (more) return more;
    }
    if (query.includes("transactions(") && vars.object === (kind === "share" ? VAULT : POSITION)) {
      return { transactions: { nodes: kind === "share" ? [first] : [first, {
        digest: EXIT, sender: { address: SENDER },
        effects: { status: "SUCCESS", timestamp: new Date(Date.parse(ENTRY_TIME) + 60_000).toISOString(), balanceChanges: gqlPage([]) },
      }] } };
    }
    throw new Error("unexpected synthetic query");
  });
}

beforeEach(() => {
  mockGqlQuery.mockReset();
});

describe("round-trip entry balance-change pages", () => {
  it("includes a share entry's payment after row 50 in its prorated cost", async () => {
    serveEntry("share", [change(SHARE, 200), change(CASH, -20), ...filler(48), change(OTHER, -180)]);

    const result = await roundTripsOf(exit("share", [[CASH, 120], [OTHER, 120]]), STATE, PRICES);

    expect(result).toEqual({
      trips: [{ kind: "share", unit: SHARE, vault: VAULT, entry_digest: ENTRY, entry_time: ENTRY_TIME,
        paid_usd: 100, received_usd: 240, factor: 2.4, basis: "same-coins" }],
      unread: [],
    });
  });

  it("finds a share credit after row 50 rather than skipping the entry", async () => {
    serveEntry("share", [change(CASH, -100), ...filler(49), change(SHARE, 200)]);

    const result = await roundTripsOf(exit("share", [[CASH, 120]]), STATE, PRICES);

    expect(result).toEqual({
      trips: [{ kind: "share", unit: SHARE, vault: VAULT, entry_digest: ENTRY, entry_time: ENTRY_TIME,
        paid_usd: 50, received_usd: 120, factor: 2.4, basis: "same-coins" }],
      unread: [],
    });
  });

  it("includes a position's payment after row 50 in its whole creating-transaction cost", async () => {
    serveEntry("position", [change(CASH, -20), ...filler(49), change(OTHER, -180)]);

    const result = await roundTripsOf(exit("position", [[CASH, 120], [OTHER, 120]]), undefined, PRICES);

    expect(result).toEqual({
      trips: [{ kind: "position", unit: POSITION, vault: null, entry_digest: ENTRY, entry_time: ENTRY_TIME,
        paid_usd: 200, received_usd: 240, factor: 1.2, basis: "same-coins" }],
      unread: [],
    });
  });

  it.each(["share", "position"] as const)("leaves an incomplete %s entry unread instead of scoring its first page", async (kind) => {
    const shares = kind === "share" ? [change(SHARE, 200)] : [];
    serveEntry(kind, [...shares, change(CASH, -20), ...filler(49 - shares.length), change(OTHER, -180)], "continuation");

    const result = await roundTripsOf(exit(kind, [[CASH, 120], [OTHER, 120]]), kind === "share" ? STATE : undefined, PRICES);

    expect(result).toEqual({ trips: [], unread: [kind === "share" ? SHARE : POSITION] });
  });

  it.each(["share", "position"] as const)("leaves a %s entry with no balance-change connection unread", async (kind) => {
    serveEntry(kind, [], "missing");

    const result = await roundTripsOf(exit(kind, [[CASH, 120]]), kind === "share" ? STATE : undefined, PRICES);

    expect(result).toEqual({ trips: [], unread: [kind === "share" ? SHARE : POSITION] });
  });
});
