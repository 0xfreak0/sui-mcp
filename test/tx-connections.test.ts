import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlPage, pagedTxConnection } from "./helpers/service-shapes.js";

/**
 * Balance changes and commands are nested GraphQL connections: the service
 * returns 50 at most per page and says so only through `pageInfo`. The shape
 * below is FujboNeQt8Nbb…'s, an airdrop with 202 balance changes where the
 * payer's debit sorts after every recipient.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { completeTxConnections, readAllBalanceChanges } = await import("../src/utils/tx-connections.js");

const PAYER = `0x${"d".repeat(64)}`;
const AIRDROP = "FujboNeQt8NbbxzodUkhnna23DNQshKybq6ADLiokv8p";

const airdrop = () => [
  ...Array.from({ length: 200 }, (_, i) => ({
    coinType: { repr: "0xc::my_coin::MY_COIN" },
    amount: "1000000000",
    owner: { address: `0x${i.toString(16).padStart(64, "0")}` },
  })),
  { coinType: { repr: "0x2::sui::SUI" }, amount: "-288999560", owner: { address: PAYER } },
  { coinType: { repr: "0xc::my_coin::MY_COIN" }, amount: "-200000000000", owner: { address: PAYER } },
];

beforeEach(() => {
  mockGqlQuery.mockReset();
});

describe("completeTxConnections", () => {
  it("reads every balance change of a transaction past the first page, payer included", async () => {
    const conn = pagedTxConnection(AIRDROP, airdrop(), "balanceChanges");
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => conn.respond(q, v));

    const [done] = await completeTxConnections([{ digest: AIRDROP, balanceChanges: conn.first }]);

    expect(done.balanceChanges).toHaveLength(202);
    expect(done.balanceChanges.filter((b) => b.owner?.address === PAYER)).toHaveLength(2);
    expect(done.balanceChangesTruncated).toBe(false);
    expect(done.reads).toBe(4);
  });

  it("costs nothing for a transaction whose first page is its whole list", async () => {
    const done = await completeTxConnections([
      { digest: "a", balanceChanges: gqlPage([{ amount: "1", owner: { address: PAYER } }]) },
    ]);
    expect(mockGqlQuery).not.toHaveBeenCalled();
    expect(done[0].balanceChanges).toHaveLength(1);
    expect(done[0].reads).toBe(0);
  });

  it("says the list is incomplete when a follow-up read fails", async () => {
    const conn = pagedTxConnection(AIRDROP, airdrop(), "balanceChanges");
    mockGqlQuery.mockImplementation(async () => {
      throw new Error("429 Too Many Requests");
    });

    const r = await readAllBalanceChanges(AIRDROP, conn.first);

    expect(r.truncated).toBe(true);
    expect(r.nodes).toHaveLength(50);
  });

  it("completes commands through the transaction's kind", async () => {
    const commands = Array.from({ length: 201 }, () => ({ __typename: "TransferObjectsCommand" }));
    const conn = pagedTxConnection(AIRDROP, commands, "commands");
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => conn.respond(q, v));

    const [done] = await completeTxConnections([{ digest: AIRDROP, commands: conn.first }]);

    expect(done.commands).toHaveLength(201);
    expect(done.commandsTruncated).toBe(false);
  });
});
