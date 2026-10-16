import { describe, expect, it, vi } from "vitest";
import { readLiquidityOrigin } from "../src/utils/liquidity-origin.js";

const { gqlQuery, objectEndKind } = vi.hoisted(() => ({ gqlQuery: vi.fn(), objectEndKind: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/utils/object-end.js", () => ({ objectEndKind }));

const pad = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
const CETUS = pad("1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb");
const SUI = `${pad("2")}::sui::SUI`;
const COIN = `${pad("c0")}::coin::COIN`;
const PUBLISHER = pad("ab");
const BUYER = pad("cd");
const POOL = pad("01");
const CLOSED = pad("p1");
const WRAPPED = pad("p2");

describe("liquidity origin", () => {
  it("says whether an initial position that left top level was closed or wrapped, and who did it", async () => {
    // A position the publisher closed had its liquidity removed; one wrapped into a burn certificate may still hold it.
    // Both read as a null current object, so only the last touch's effects tell them apart.
    const position = (id: string) => ({
      address: id, idCreated: true,
      outputState: { owner: { address: { address: PUBLISHER } }, asMoveObject: { contents: { type: { repr: `${CETUS}::position::Position` }, json: { pool: POOL, liquidity: "100" } } } },
    });
    gqlQuery.mockImplementation(async (query: string, vars: { id?: string }) => {
      if (query.includes("objectVersions")) return { objectVersions: { nodes: [{ previousTransaction: { digest: "create" } }] } };
      if (query.includes("objectChanges")) {
        return {
          transaction: {
            effects: {
              objectChanges: { nodes: [{ address: POOL, idCreated: true, outputState: null }, position(CLOSED), position(WRAPPED)], pageInfo: { hasNextPage: false } },
              balanceChanges: { nodes: [], pageInfo: { hasNextPage: false } },
            }
          }
        };
      }
      if (query.includes("current: object")) {
        return { current: null, touches: { nodes: [{ digest: vars.id === CLOSED ? "close" : "wrap", sender: { address: vars.id === CLOSED ? PUBLISHER : BUYER } }] } };
      }
      return {
        transactions: {
          nodes: [{
            digest: "close", sender: { address: PUBLISHER },
            effects: {
              events: { nodes: [{ contents: { type: { repr: `${CETUS}::pool::RemoveLiquidityEvent` }, json: { pool: POOL, liquidity: "100" } } }], pageInfo: { hasNextPage: false } },
              balanceChanges: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          }],
          pageInfo: { hasPreviousPage: false },
        }
      };
    });
    objectEndKind.mockImplementation(async (id: string) => id === CLOSED ? "deleted" : "wrapped");
    const origin = await readLiquidityOrigin({ pool_id: POOL, protocol: "cetus", object_type: `${CETUS}::pool::Pool<${COIN}, ${SUI}>`, token_a: COIN, token_b: SUI }, null, PUBLISHER);
    expect(origin.positions).toEqual([
      expect.objectContaining({ position_id: CLOSED, minted_to: PUBLISHER, current_owner: null, ended: "deleted", ended_by: PUBLISHER, ended_by_publisher: true }),
      expect.objectContaining({ position_id: WRAPPED, current_owner: null, ended: "wrapped", ended_by: BUYER, ended_by_publisher: false }),
    ]);
    expect(origin.recent_removals).toMatchObject({ matches: [{ digest: "close", sender: PUBLISHER, sender_is_publisher: true }] });
  });

  it("states an unread end rather than guessing deleted or wrapped", async () => {
    gqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("objectVersions")) return { objectVersions: { nodes: [{ previousTransaction: { digest: "create" } }] } };
      if (query.includes("objectChanges")) {
        return {
          transaction: {
            effects: {
              objectChanges: {
                nodes: [{ address: POOL, idCreated: true, outputState: null }, {
                  address: CLOSED, idCreated: true,
                  outputState: { owner: { address: { address: PUBLISHER } }, asMoveObject: { contents: { type: { repr: `${CETUS}::position::Position` }, json: { pool: POOL, liquidity: "1" } } } },
                }], pageInfo: { hasNextPage: false }
              },
              balanceChanges: { nodes: [], pageInfo: { hasNextPage: false } },
            }
          }
        };
      }
      if (query.includes("current: object")) return { current: null, touches: { nodes: [{ digest: "close", sender: { address: PUBLISHER } }] } };
      return { transactions: { nodes: [], pageInfo: { hasPreviousPage: true } } };
    });
    objectEndKind.mockRejectedValue(new Error("archive unavailable"));
    const origin = await readLiquidityOrigin({ pool_id: POOL, protocol: "cetus", object_type: `${CETUS}::pool::Pool<${COIN}, ${SUI}>`, token_a: COIN, token_b: SUI }, null, PUBLISHER);
    expect(origin.positions![0]).toMatchObject({ end_unavailable: "archive unavailable" });
    expect(origin.positions![0]).not.toHaveProperty("ended");
  });
});
