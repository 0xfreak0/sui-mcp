import { describe, expect, it, vi } from "vitest";

const { gqlQuery, readObjects, valueHeld } = vi.hoisted(() => ({
  gqlQuery: vi.fn(),
  readObjects: vi.fn(async () => new Map()),
  valueHeld: vi.fn(async () => ({ positions: [], unread: [] })),
}));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/utils/valuers/common.js", () => ({ readObjects }));
vi.mock("../src/utils/valuers/held-balances.js", () => ({ valueHeld }));
const { operatedSharedObjects, operatedLeadRow } = await import("../src/utils/operated-objects.js");

const owner = `0x${"b".repeat(64)}`;
const shared = (i: number) => `0x${"a".repeat(60)}${i.toString(16).padStart(4, "0")}`;

describe("operated shared-object scan", () => {
  it("names clipped candidates and input pages, then follows older sent transactions", async () => {
    gqlQuery.mockResolvedValueOnce({
      transactions: {
        pageInfo: { hasPreviousPage: true, startCursor: "older" },
        nodes: [{
          digest: "digest-one", kind: {
            inputs: {
              pageInfo: { hasNextPage: true },
              nodes: Array.from({ length: 21 }, (_, i) => ({ __typename: "SharedInput", address: shared(i), mutable: true })),
            }
          }
        }],
      }
    }).mockResolvedValueOnce({
      transactions: {
        pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [],
      }
    });
    const first = await operatedSharedObjects(owner, { owner }, { candidates: 2 });
    expect(first).toMatchObject({
      objects_read: 2, scan: {
        complete: false, has_previous: true, cursor: "older", candidates_truncated: true,
        incomplete_transactions: ["digest-one"],
      }
    });
    const older = await operatedSharedObjects(owner, { owner }, { before: first.scan.cursor, candidates: 21 });
    expect(older.scan.complete).toBe(true);
    expect(gqlQuery.mock.calls[1][1]).toMatchObject({ before: "older", n: 20 });
  });
  it("names every omitted co-controller and links to the object's full fields", async () => {
    const id = shared(3);
    const others = Array.from({ length: 12 }, (_, i) => shared(i + 50));
    gqlQuery.mockResolvedValueOnce({
      transactions: {
        pageInfo: { hasPreviousPage: false, startCursor: null },
        nodes: [{
          digest: "digest-two", kind: {
            inputs: {
              pageInfo: { hasNextPage: false }, nodes: [{ __typename: "SharedInput", address: id, mutable: true }],
            }
          }
        }],
      }
    });
    readObjects.mockResolvedValueOnce(new Map([[id, { type: "0xaa::vault::Vault", json: { owner: [owner, ...others] } }]]));
    const result = await operatedSharedObjects(owner, { owner });
    const lead = operatedLeadRow(result.leads[0]);
    expect(lead.listed_with).toHaveLength(10);
    expect(lead.listed_with_count).toBe(12);
    expect(lead.listed_with_next_call).toEqual({ tool: "get_object", args: { object_id: id } });
  });
});
