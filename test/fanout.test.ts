import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyFanout } from "../src/utils/fanout.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/utils/store.js", () => ({
  getCachedFanout: () => null,
  saveFanout: () => false,
}));

const { measureFanout } = await import("../src/utils/fanout.js");

const ADDR = "0xaaa";

/**
 * One page of transactions. Each entry is the balance changes of one tx; the
 * subject's own change decides direction, so it must be present for
 * counterparties to be attributed to a side.
 */
const page = (
  txs: Array<Array<{ owner: string; amount: string; coin?: string }>>,
  hasPreviousPage = false,
  startCursor: string | undefined = "c",
) => ({
  transactions: {
    nodes: txs.map((changes) => ({
      effects: {
        balanceChanges: {
          nodes: changes.map((c) => ({
            amount: c.amount,
            owner: { address: c.owner },
            coinType: { repr: c.coin ?? "0x2::sui::SUI" },
          })),
        },
      },
    })),
    pageInfo: { hasPreviousPage, startCursor },
  },
});

/** Subject sends: subject negative, counterparty positive. */
const sendTo = (to: string, coin?: string) => [
  { owner: ADDR, amount: "-100", coin },
  { owner: to, amount: "100", coin },
];
/** Subject receives: subject positive, counterparty negative. */
const receiveFrom = (from: string, coin?: string) => [
  { owner: ADDR, amount: "100", coin },
  { owner: from, amount: "-100", coin },
];

beforeEach(() => vi.clearAllMocks());

describe("classifyFanout", () => {
  it("calls a very wide address a hub", () => {
    const r = classifyFanout(29_180);
    expect(r.classification).toBe("hub");
    expect(r.interpretation).toMatch(/tells you nothing|do not read/i);
  });

  it("flags a mid-range address as needing a control", () => {
    expect(classifyFanout(431).classification).toBe("distributor");
    expect(classifyFanout(431).interpretation).toMatch(/control/i);
  });

  it("treats a low-counterparty address as narrow", () => {
    expect(classifyFanout(12).classification).toBe("narrow");
  });

  // Calibrated against measured exchanges (205-440 counterparties per 600
  // recent txs) versus ordinary wallets (6-12). The gap is what makes a coarse
  // cut defensible; the exact boundaries are not precise.
  it("puts the boundaries where documented", () => {
    expect(classifyFanout(99).classification).toBe("narrow");
    expect(classifyFanout(100).classification).toBe("distributor");
    expect(classifyFanout(999).classification).toBe("distributor");
    expect(classifyFanout(1000).classification).toBe("hub");
  });
});

describe("measureFanout", () => {
  it("counts distinct counterparties, not transactions", async () => {
    gqlQuery.mockResolvedValueOnce(page([sendTo("0xbbb"), sendTo("0xbbb"), sendTo("0xccc")]));
    const r = await measureFanout(ADDR, 50);
    expect(r.recipient_count).toBe(2);
    expect(r.scanned_transactions).toBe(3);
  });

  // The bug this fixes: an exchange cold wallet receives from thousands and
  // sends to almost nobody, so an outbound-only scan called it "narrow".
  it("counts inbound counterparties, not just outbound", async () => {
    gqlQuery.mockResolvedValueOnce(
      page([receiveFrom("0xs1"), receiveFrom("0xs2"), sendTo("0xr1")]),
    );
    const r = await measureFanout(ADDR, 50);
    expect(r.sender_count).toBe(2);
    expect(r.recipient_count).toBe(1);
    expect(r.counterparty_count).toBe(3);
  });

  it("does not double-count an address seen on both sides", async () => {
    gqlQuery.mockResolvedValueOnce(page([sendTo("0xbbb"), receiveFrom("0xbbb")]));
    const r = await measureFanout(ADDR, 50);
    expect(r.recipient_count).toBe(1);
    expect(r.sender_count).toBe(1);
    expect(r.counterparty_count).toBe(1);
  });

  it("ignores the address's own balance changes", async () => {
    gqlQuery.mockResolvedValueOnce(page([[{ owner: ADDR, amount: "-109880" }]]));
    const r = await measureFanout(ADDR, 50);
    expect(r.counterparty_count).toBe(0);
  });

  it("counts distinct coin types", async () => {
    gqlQuery.mockResolvedValueOnce(
      page([sendTo("0xb", "0x2::sui::SUI"), sendTo("0xc", "0xusdc::usdc::USDC")]),
    );
    const r = await measureFanout(ADDR, 50);
    expect(r.coin_type_count).toBe(2);
  });

  // Shape, not size: this separates an exchange from a distribution wallet
  // when both have similar counterparty counts.
  it("reports flow shape from the out/in ratio", async () => {
    gqlQuery.mockResolvedValueOnce(
      page([sendTo("0xr1"), sendTo("0xr2"), sendTo("0xr3"), sendTo("0xr4"), receiveFrom("0xs1")]),
    );
    const disperser = await measureFanout(ADDR, 50);
    expect(disperser.out_in_ratio).toBe(4);
    expect(disperser.flow_shape).toBe("disperser");

    gqlQuery.mockResolvedValueOnce(page([sendTo("0xr1"), receiveFrom("0xs1")]));
    const balanced = await measureFanout(ADDR, 50);
    expect(balanced.flow_shape).toBe("balanced");

    // 4 in : 1 out = 0.25, clear of the 0.33 boundary. (Exactly 1/3 rounds to
    // 0.333 and is deliberately "balanced" — the cut is not meant to be sharp.)
    gqlQuery.mockResolvedValueOnce(
      page([
        receiveFrom("0xs1"),
        receiveFrom("0xs2"),
        receiveFrom("0xs3"),
        receiveFrom("0xs4"),
        sendTo("0xr1"),
      ]),
    );
    const collector = await measureFanout(ADDR, 50);
    expect(collector.flow_shape).toBe("collector");
  });

  it("reports an unknown shape when nothing was received", async () => {
    gqlQuery.mockResolvedValueOnce(page([sendTo("0xr1")]));
    const r = await measureFanout(ADDR, 50);
    expect(r.out_in_ratio).toBeNull();
    expect(r.flow_shape).toBe("unknown");
  });

  // `first` returns the OLDEST transactions, so a forward scan of a long-lived
  // address measures what it did years ago. This is the bug that made every
  // earlier fan-out number describe 2023.
  it("walks backwards from the newest transaction", async () => {
    gqlQuery.mockResolvedValueOnce(page([sendTo("0xb")], true, "cur1"));
    gqlQuery.mockResolvedValueOnce(page([sendTo("0xc")], false, undefined));
    await measureFanout(ADDR, 100);

    const [, firstVars] = gqlQuery.mock.calls[0];
    expect(firstVars).toHaveProperty("last");
    expect(firstVars).not.toHaveProperty("first");
    // Second page walks back from the first page's start cursor.
    expect(gqlQuery.mock.calls[1][1].before).toBe("cur1");
  });

  it("paginates until the budget is spent and reports truncation", async () => {
    gqlQuery
      .mockResolvedValueOnce(page([sendTo("0xb1")], true, "c1"))
      .mockResolvedValueOnce(page([sendTo("0xb2")], true, "c2"));
    const r = await measureFanout(ADDR, 2);
    expect(r.counterparty_count).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("is not truncated when the address runs out of transactions", async () => {
    gqlQuery.mockResolvedValueOnce(page([sendTo("0xbbb")], false));
    const r = await measureFanout(ADDR, 1000);
    expect(r.truncated).toBe(false);
  });

  it("handles an address with no activity", async () => {
    gqlQuery.mockResolvedValueOnce(page([], false));
    const r = await measureFanout(ADDR, 50);
    expect(r.counterparty_count).toBe(0);
    expect(r.classification).toBe("narrow");
  });

  it("stops when a page returns no cursor rather than looping", async () => {
    gqlQuery.mockResolvedValueOnce({
      transactions: {
        nodes: [{ effects: { balanceChanges: { nodes: [] } } }],
        pageInfo: { hasPreviousPage: true, startCursor: undefined },
      },
    });
    const r = await measureFanout(ADDR, 1000);
    expect(r.scanned_transactions).toBe(1);
    expect(gqlQuery).toHaveBeenCalledTimes(1);
  });
});
