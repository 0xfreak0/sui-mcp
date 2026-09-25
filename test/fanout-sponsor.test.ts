import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/store.js", () => ({
  getCachedFanout: () => null,
  saveFanout: () => false,
  FANOUT_METHOD_VERSION: 1,
}));

const { measureFanout } = await import("../src/utils/fanout.js");

/** One page of transactions, all sponsored by `sponsor` for distinct senders. */
const page = (sponsor: string, senders: string[], hasPrevious: boolean) => ({
  transactions: {
    nodes: senders.map((s) => ({
      sender: { address: s },
      gasInput: { gasSponsor: { address: sponsor } },
      effects: { balanceChanges: { nodes: [] } },
    })),
    pageInfo: { hasPreviousPage: hasPrevious, startCursor: hasPrevious ? "cur" : undefined },
  },
});

const SPONSOR = "0x5905";
beforeEach(() => mockGqlQuery.mockReset());

describe("sponsor breadth is provisional when the scan is truncated", () => {
  /**
   * Narrow and popular are not symmetric. Measured on a mainnet sponsor, the
   * distinct-payee count went 1 -> 86 between a 100- and an 800-transaction
   * window, crossing from narrow to relayer. "Narrow" off a truncated scan
   * only ever means "not far enough".
   */
  it("marks a narrow reading provisional when it hit the budget", async () => {
    mockGqlQuery.mockResolvedValue(page(SPONSOR, ["0xa", "0xb"], true));
    const r = await measureFanout(SPONSOR, 2, false);
    expect(r.sponsor_shape).toBe("private_sponsor");
    expect(r.truncated).toBe(true);
    expect(r.sponsor_shape_provisional).toBe(true);
    expect(r.sponsor_interpretation).toMatch(/PROVISIONAL/);
  });

  it("does not mark it provisional when the scan reached the end", async () => {
    mockGqlQuery.mockResolvedValue(page(SPONSOR, ["0xa", "0xb"], false));
    const r = await measureFanout(SPONSOR, 50, false);
    expect(r.truncated).toBe(false);
    expect(r.sponsor_shape_provisional).toBeUndefined();
    expect(r.sponsor_interpretation).not.toMatch(/PROVISIONAL/);
  });

  /** `relayer` is proven by what was seen — more history cannot unsee it. */
  it("never marks a relayer provisional", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `0x${i}`);
    mockGqlQuery.mockResolvedValue(page(SPONSOR, many, true));
    const r = await measureFanout(SPONSOR, 25, false);
    expect(r.sponsor_shape).toBe("relayer");
    expect(r.truncated).toBe(true);
    expect(r.sponsor_shape_provisional).toBeUndefined();
  });

  /**
   * Absence off a truncated scan is not absence — but a complete scan seeing
   * no sponsorship needs no gloss.
   */
  it("caveats 'not a sponsor' only when the scan was cut short", async () => {
    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: [{ sender: { address: "0xee" }, gasInput: null, effects: { balanceChanges: { nodes: [] } } }],
        pageInfo: { hasPreviousPage: true, startCursor: "c" },
      },
    });
    const cut = await measureFanout("0x9e7", 1, false);
    expect(cut.sponsor_shape).toBe("not_a_sponsor");
    expect(cut.sponsor_interpretation).toMatch(/not evidence/i);

    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: [{ sender: { address: "0xee" }, gasInput: null, effects: { balanceChanges: { nodes: [] } } }],
        pageInfo: { hasPreviousPage: false },
      },
    });
    const done = await measureFanout("0x9e7", 50, false);
    expect(done.sponsor_interpretation).toBeUndefined();
  });
});
