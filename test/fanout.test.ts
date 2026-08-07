import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyFanout } from "../src/utils/fanout.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

const { measureFanout } = await import("../src/utils/fanout.js");

const ADDR = "0xaaa";

/** Build one page of outbound transactions with the given recipients. */
const page = (
  txs: Array<Array<{ owner: string; amount: string }>>,
  hasNextPage = false,
  endCursor = "c",
) => ({
  transactions: {
    nodes: txs.map((changes) => ({
      effects: {
        balanceChanges: {
          nodes: changes.map((c) => ({ amount: c.amount, owner: { address: c.owner } })),
        },
      },
    })),
    pageInfo: { hasNextPage, endCursor },
  },
});

beforeEach(() => vi.clearAllMocks());

describe("classifyFanout", () => {
  it("calls a wide distributor a hub, where shared funding means nothing", () => {
    const r = classifyFanout(29_180);
    expect(r.classification).toBe("hub");
    expect(r.interpretation).toMatch(/tells you nothing|do not read/i);
  });

  it("flags a mid-range distributor as needing a control", () => {
    expect(classifyFanout(2_431).classification).toBe("distributor");
    expect(classifyFanout(2_431).interpretation).toMatch(/control/i);
  });

  it("treats a narrow funder as meaningful", () => {
    expect(classifyFanout(4).classification).toBe("narrow");
  });

  it("puts the boundaries where documented", () => {
    expect(classifyFanout(499).classification).toBe("narrow");
    expect(classifyFanout(500).classification).toBe("distributor");
    expect(classifyFanout(9_999).classification).toBe("distributor");
    expect(classifyFanout(10_000).classification).toBe("hub");
  });
});

describe("measureFanout", () => {
  it("counts distinct recipients, not transactions", () => {
    // Same recipient paid three times is one recipient.
    gqlQuery.mockResolvedValueOnce(
      page([
        [{ owner: "0xbbb", amount: "100" }],
        [{ owner: "0xbbb", amount: "200" }],
        [{ owner: "0xccc", amount: "300" }],
      ]),
    );
    return measureFanout(ADDR, 50).then((r) => {
      expect(r.recipient_count).toBe(2);
      expect(r.scanned_transactions).toBe(3);
    });
  });

  it("ignores the address's own balance changes", async () => {
    // Gas costs show up as a negative change owned by the sender; counting
    // those would make every wallet look like it funds itself.
    gqlQuery.mockResolvedValueOnce(page([[{ owner: ADDR, amount: "-109880" }]]));
    const r = await measureFanout(ADDR, 50);
    expect(r.recipient_count).toBe(0);
  });

  it("ignores negative changes — those are people paying the address, not recipients", async () => {
    gqlQuery.mockResolvedValueOnce(
      page([
        [
          { owner: "0xbbb", amount: "-500" },
          { owner: "0xccc", amount: "500" },
        ],
      ]),
    );
    const r = await measureFanout(ADDR, 50);
    expect(r.recipient_count).toBe(1);
  });

  it("paginates until the budget is spent and reports truncation", async () => {
    gqlQuery
      .mockResolvedValueOnce(page([[{ owner: "0xb1", amount: "1" }]], true, "c1"))
      .mockResolvedValueOnce(page([[{ owner: "0xb2", amount: "1" }]], true, "c2"));

    const r = await measureFanout(ADDR, 2);
    expect(r.recipient_count).toBe(2);
    expect(r.scanned_transactions).toBe(2);
    // Still more to see — a lower bound must never look like a total.
    expect(r.truncated).toBe(true);
  });

  it("is not truncated when the address genuinely runs out of transactions", async () => {
    gqlQuery.mockResolvedValueOnce(page([[{ owner: "0xbbb", amount: "1" }]], false));
    const r = await measureFanout(ADDR, 1000);
    expect(r.truncated).toBe(false);
  });

  it("handles an address with no outbound activity", async () => {
    gqlQuery.mockResolvedValueOnce(page([], false));
    const r = await measureFanout(ADDR, 50);
    expect(r.recipient_count).toBe(0);
    expect(r.scanned_transactions).toBe(0);
    expect(r.classification).toBe("narrow");
  });

  it("stops when a page returns no cursor, rather than looping", async () => {
    gqlQuery.mockResolvedValueOnce({
      transactions: {
        nodes: [{ effects: { balanceChanges: { nodes: [] } } }],
        pageInfo: { hasNextPage: true, endCursor: undefined },
      },
    });
    const r = await measureFanout(ADDR, 1000);
    expect(r.scanned_transactions).toBe(1);
    expect(gqlQuery).toHaveBeenCalledTimes(1);
  });

  it("carries the classification through so callers get the reading, not just a number", async () => {
    const many = Array.from({ length: 40 }, (_, i) => [{ owner: `0x${i}`, amount: "1" }]);
    gqlQuery.mockResolvedValueOnce(page(many, false));
    const r = await measureFanout(ADDR, 100);
    expect(r.recipient_count).toBe(40);
    expect(r.classification).toBe("narrow");
    expect(r.interpretation).toBeTruthy();
  });
});
