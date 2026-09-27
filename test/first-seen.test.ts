import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFirstSeen } from "../src/utils/identity.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

const WALLET = `0x${"a1".repeat(32)}`;
const FUNDER = `0x${"b2".repeat(32)}`;
const OTHER = `0x${"c3".repeat(32)}`;
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const change = (owner: string, amount: string) => ({ owner: { address: owner }, amount, coinType: { repr: SUI } });

function oldest(sender: string, changes: ReturnType<typeof change>[], hasNextPage = false) {
  gqlQuery.mockResolvedValueOnce({
    transactions: {
      nodes: [
        {
          digest: "FakeDigest1111111111111111111111111111111111",
          sender: { address: sender },
          effects: {
            timestamp: "2026-01-02T03:04:05.000Z",
            checkpoint: { sequenceNumber: 123 },
            balanceChanges: { nodes: changes, pageInfo: { hasNextPage, endCursor: hasNextPage ? "c" : null } },
          },
        },
      ],
    },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("readFirstSeen", () => {
  it("marks another sender's payment to the wallet as its first inflow", async () => {
    oldest(FUNDER, [change(FUNDER, "-5000"), change(WALLET, "5000")]);
    const seen = await readFirstSeen(WALLET);
    expect(seen).toEqual({
      digest: "FakeDigest1111111111111111111111111111111111",
      timestamp: "2026-01-02T03:04:05.000Z",
      checkpoint: "123",
      sender: FUNDER,
      received: [{ coin_type: SUI, amount: "5000" }],
      first_inflow: true,
    });
  });

  it("does not call a transaction the wallet sent itself its first inflow", async () => {
    oldest(WALLET, [change(WALLET, "700"), change(OTHER, "-700")]);
    expect((await readFirstSeen(WALLET))?.first_inflow).toBe(false);
  });

  it("says a gain is unknown, not absent, when the balance changes run past the page read", async () => {
    oldest(FUNDER, [change(OTHER, "10")], true);
    const seen = await readFirstSeen(WALLET);
    expect(seen?.received).toEqual([]);
    expect(seen?.first_inflow).toBeNull();
  });

  it("reports no first transaction when none affects the address", async () => {
    gqlQuery.mockResolvedValueOnce({ transactions: { nodes: [] } });
    expect(await readFirstSeen(WALLET)).toBeNull();
  });
});
