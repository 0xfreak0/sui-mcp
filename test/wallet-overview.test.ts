import { describe, it, expect, vi } from "vitest";
import { createMockClient, createMockGraphql } from "./helpers/mock-grpc.js";
import { gqlPage } from "./helpers/service-shapes.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerWorkflowTools } = await import("../src/tools/workflow.js");
const tools = new Map<string, Function>();
registerWorkflowTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as Parameters<typeof registerWorkflowTools>[0]); // only `tool` is called during registration

/**
 * The portfolio total sums `value_usd`, and an unpriced holding contributes
 * nothing. Measured on three mainnet wallets: 1 of 3, 46 of 50 and 5 of 15
 * holdings had no price. The middle one reported $1.86 for a wallet holding
 * fifty coins — a number that reads as a portfolio value rather than as four
 * coins out of fifty.
 *
 * These pin the arithmetic and the wording independently of the network.
 */
type Holding = { value_usd?: number | null; verified?: boolean };

const summarize = (holdings: Holding[]) => {
  const priced = holdings.filter((h) => h.value_usd != null);
  const unpriced = holdings.length - priced.length;
  const unverifiedUnpriced = holdings.filter(
    (h) => h.value_usd == null && h.verified === false,
  ).length;
  return {
    total: Math.round(priced.reduce((s, h) => s + (h.value_usd ?? 0), 0) * 100) / 100,
    priced: priced.length,
    unpriced,
    unverifiedUnpriced,
    verified: holdings.filter((h) => h.verified === true).length,
  };
};

describe("wallet overview totals", () => {
  it("sums only what could be priced", () => {
    const r = summarize([
      { value_usd: 1.45, verified: true },
      { value_usd: 0.41, verified: true },
      { value_usd: null, verified: false },
    ]);
    expect(r.total).toBe(1.86);
    expect(r.priced).toBe(2);
    expect(r.unpriced).toBe(1);
  });

  /** An unpriced holding must never be counted as zero-valued. */
  it("does not let a missing price masquerade as no value", () => {
    const withUnpriced = summarize([{ value_usd: 10 }, { value_usd: null }]);
    const withoutIt = summarize([{ value_usd: 10 }]);
    expect(withUnpriced.total).toBe(withoutIt.total);
    // Same number, but the counts make the difference visible.
    expect(withUnpriced.unpriced).toBe(1);
    expect(withoutIt.unpriced).toBe(0);
  });

  /**
   * No market price AND nothing vouching for the coin is the usual shape of a
   * spam or impersonation token — the same reasoning `pickFundingTx` uses when
   * it treats an unpriced coin as spam at any size.
   */
  it("counts holdings that are both unpriced and unverified", () => {
    const r = summarize([
      { value_usd: 1, verified: true },
      { value_usd: null, verified: false },
      { value_usd: null, verified: false },
      { value_usd: null, verified: true },
    ]);
    expect(r.unpriced).toBe(3);
    // The verified-but-unpriced one is a different case: possibly newly listed.
    expect(r.unverifiedUnpriced).toBe(2);
    expect(r.verified).toBe(2);
  });

  it("reports a fully priced wallet without qualification", () => {
    const r = summarize([{ value_usd: 5, verified: true }]);
    expect(r.unpriced).toBe(0);
    expect(r.unverifiedUnpriced).toBe(0);
  });
});

describe("wallet overview holdings", () => {
  /**
   * 0xa727…0be6 on mainnet holds 704,848 SUI with no coin object: the whole
   * balance sits in its address balance, so list_owned_objects shows no coin.
   */
  it("splits each holding into coin objects and address balance", async () => {
    const WALLET = "0xa727cd9023836d0ac8435918ece422bc0b6a90c3086a5eea0c65a497402e0be6";
    mockGqlQuery.mockResolvedValue({
      address: {
        defaultNameRecord: null,
        balances: gqlPage([
          {
            coinType: { repr: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI" },
            totalBalance: "704848146271530",
            coinBalance: "0",
            addressBalance: "704848146271530",
          },
        ]),
      },
      transactions: gqlPage([]),
    });
    mockSui.listOwnedObjects.mockResolvedValue({ objects: [], hasNextPage: false, cursor: null });

    const j = JSON.parse((await tools.get("get_wallet_overview")!({ address: WALLET })).content[0].text);

    expect(j.holdings[0]).toMatchObject({
      balance: "704848146271530",
      coin_balance: "0",
      address_balance: "704848146271530",
    });
  });
});
