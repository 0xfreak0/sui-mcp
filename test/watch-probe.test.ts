import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlPage, pagedTxConnection } from "./helpers/service-shapes.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { fetchDeltaDetail } = await import("../src/utils/watch-probe.js");

const WATCHED = `0x${"a".repeat(64)}`;
const DIGEST = "FujboNeQt8NbbxzodUkhnna23DNQshKybq6ADLiokv8p";

beforeEach(() => {
  mockGqlQuery.mockReset();
});

describe("fetchDeltaDetail", () => {
  it("reads the watched address's row when it sorts past the first 50 balance changes", async () => {
    const changes = [
      ...Array.from({ length: 70 }, (_, i) => ({
        amount: "1",
        owner: { address: `0x${i.toString(16).padStart(64, "0")}` },
        coinType: { repr: "0x2::sui::SUI" },
      })),
      { amount: "-70", owner: { address: WATCHED }, coinType: { repr: "0x2::sui::SUI" } },
    ];
    const conn = pagedTxConnection(DIGEST, changes, "balanceChanges");
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) =>
      conn.respond(q, v) ?? { t0: { effects: { balanceChanges: conn.first, objectChanges: gqlPage([]) } } },
    );

    const { detail, requests } = await fetchDeltaDetail([DIGEST]);

    const d = detail.get(DIGEST)!;
    expect(d.balance_changes).toHaveLength(71);
    expect(d.balance_changes.find((b) => b.address === WATCHED)?.amount).toBe("-70");
    // The follow-up read is counted in what the poll reports it spent.
    expect(requests).toBe(2);
  });

  it("says when object changes ran past the page it read", async () => {
    mockGqlQuery.mockResolvedValue({
      t0: {
        effects: {
          balanceChanges: gqlPage([]),
          objectChanges: gqlPage([], { hasNextPage: true, endCursor: "more" }),
        },
      },
    });
    const { detail } = await fetchDeltaDetail([DIGEST]);
    expect(detail.get(DIGEST)!.object_changes_truncated).toBe(true);
  });
});
