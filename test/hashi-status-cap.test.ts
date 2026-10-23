import { describe, expect, it, vi } from "vitest";
import { runWithNetwork } from "../src/config.js";
import { readHashiRequestStates } from "../src/utils/bridge/hashi-status.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

const ids = Array.from({ length: 25 }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`);

describe("Hashi request status batches", () => {
  it("reads every request beyond the former twenty-request cap", async () => {
    gqlQuery.mockImplementation(async (query: string) => {
      const matches = [...query.matchAll(/o(\d+): transactions\(filter: \{ affectedObject: "(0x[0-9a-f]+)" \}/g)];
      return Object.fromEntries(matches.map(([, alias]) => [
        `o${alias}`,
        { pageInfo: { hasNextPage: false }, nodes: [] },
      ]));
    });

    const states = await runWithNetwork("testnet", () => readHashiRequestStates(ids));
    expect(gqlQuery).toHaveBeenCalledTimes(4); // Eight aliases per document.
    expect(states.size).toBe(ids.length);
    expect([...states.keys()]).toEqual(ids);
    expect(states.get(ids[24])?.status).toBe("requested");
  });
});
