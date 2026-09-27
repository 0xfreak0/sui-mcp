import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
const getCachedFanout = vi.fn(() => null as unknown);
vi.mock("../src/utils/store.js", () => ({
  getCachedFanout,
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
beforeEach(() => {
  mockGqlQuery.mockReset();
  getCachedFanout.mockReset();
  getCachedFanout.mockReturnValue(null);
});

describe("sponsor breadth is provisional when the scan is truncated", () => {
  /**
   * Narrow and popular are not symmetric. A sponsor's distinct-payee count
   * grows with the window, so a longer scan can move it from narrow to
   * relayer. "Narrow" off a truncated scan only ever means "not far enough".
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

describe("an operator that funds the wallets it sponsors is not a relayer", () => {
  const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
  const OPERATOR = "0x7c8e2ceb0839680a3b1f7aa1021d45670405d92f3c88e79aa1d3aa8a600bbdbf";
  const lookalike = (i: number) => `0x5aad${i.toString(16).padStart(60, "0")}`;
  const change = (owner: string, amount: string) => ({ owner: { address: owner }, amount, coinType: { repr: SUI } });

  /** 9FuGZMtL…: the operator, paying its own gas, seeds a lookalike with 1,533 MIST. */
  const seed = (to: string) => ({
    digest: `seed-${to}`,
    sender: { address: OPERATOR },
    gasInput: { gasSponsor: { address: OPERATOR } },
    effects: { balanceChanges: { nodes: [change(to, "1533"), change(OPERATOR, "-101533")] } },
  });
  /** 132ZLNFk…: the lookalike sends dust to its target, and the operator pays the gas. */
  const dust = (from: string) => ({
    digest: `dust-${from}`,
    sender: { address: from },
    gasInput: { gasSponsor: { address: OPERATOR } },
    effects: {
      balanceChanges: {
        nodes: [
          change("0x555bf90903ad18a90fa585fbc7f4b31945964c87f341eca53df9c04bd30365f6", "1533"),
          change(from, "-1533"),
          change(OPERATOR, "-100000"),
        ],
      },
    },
  });
  const nodes = Array.from({ length: 25 }, (_, i) => [seed(lookalike(i)), dust(lookalike(i))]).flat();

  it("calls a sponsor that paid most of the addresses it sponsors an operator", async () => {
    mockGqlQuery.mockResolvedValue({
      transactions: { nodes, pageInfo: { hasPreviousPage: true, startCursor: "c" } },
    });
    const r = await measureFanout(OPERATOR, 50, false);
    expect(r.sponsored_address_count).toBe(25);
    expect(r.sponsored_and_paid_count).toBe(25);
    expect(r.sponsor_shape).toBe("operator");
    expect(r.sponsor_interpretation).not.toMatch(/noise/);
    expect(r.sponsor_interpretation).toMatch(/sent a coin to 25 of them/);
    // Each funded-and-sponsored pair is proven by its two transactions.
    expect(r.sponsor_shape_provisional).toBeUndefined();
  });

  it("keeps a public gas station that never paid its sponsored senders a relayer", async () => {
    // A public gas station sponsoring 25 strangers' transfers and paying none
    // of them: its only balance change is its own gas.
    const STATION = "0xe98aaadcdf0dfdbaf182b91269566adc413401c423229bfc4b690e884e25e3ee";
    const stranger = (i: number) => `0xdeaf${i.toString(16).padStart(60, "0")}`;
    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: Array.from({ length: 25 }, (_, i) => ({
          digest: `relay-${i}`,
          sender: { address: stranger(i) },
          gasInput: { gasSponsor: { address: STATION } },
          effects: {
            balanceChanges: {
              nodes: [change(stranger(i), "-5000000"), change(`0xdef${i}`, "5000000"), change(STATION, "-2000000")],
            },
          },
        })),
        pageInfo: { hasPreviousPage: false },
      },
    });
    const r = await measureFanout(STATION, 50, false);
    expect(r.sponsored_address_count).toBe(25);
    expect(r.sponsored_and_paid_count).toBe(0);
    expect(r.sponsor_shape).toBe("relayer");
    // Breadth cannot tell a relayer from an operator funding its wallets from a
    // second address, so the reading states what was measured and clears no link.
    expect(r.sponsor_interpretation).toMatch(/25\+ distinct addresses/);
    expect(r.sponsor_interpretation).toMatch(/sent a coin to 0 of them/);
    expect(r.sponsor_interpretation).not.toMatch(/not evidence|noise/i);
  });

  it("reads the operator shape back from the store with the same interpretation", async () => {
    getCachedFanout.mockReturnValue({
      account: `sui:mainnet:${OPERATOR}`,
      recipient_count: 377,
      sender_count: 0,
      counterparty_count: 377,
      coin_type_count: 5,
      out_in_ratio: null,
      flow_shape: "unknown",
      sponsored_address_count: 377,
      sponsored_and_paid_count: 377,
      sponsored_transaction_count: 500,
      sponsor_shape: "operator",
      scanned_transactions: 1000,
      truncated: 1,
      measured_at: 0,
      age_ms: 5,
    });
    const r = await measureFanout(OPERATOR, 1000);
    expect(r.cached).toBe(true);
    expect(r.sponsored_and_paid_count).toBe(377);
    expect(r.sponsor_shape).toBe("operator");
    expect(r.sponsor_interpretation).toMatch(/sent a coin to 377 of them/);
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });
});
