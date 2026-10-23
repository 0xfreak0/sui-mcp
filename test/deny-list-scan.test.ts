import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: query }));

import { listConfiguredCoins, cachedConfiguredCoins, resetCoinMapCache, readCoinRestrictions } from "../src/utils/deny-list-probe.js";

const coin = Buffer.from("2::sample::SAMPLE").toString("base64");
const field = { name: { json: { per_type_key: coin } }, value: { address: "0xcafe" } };
const response = (hasNextPage: boolean, endCursor: string | null) => ({
  object: { dynamicFields: { nodes: [field], pageInfo: { hasNextPage, endCursor } } },
});

beforeEach(() => {
  query.mockReset();
  resetCoinMapCache();
});

describe("configured coin scan completeness", () => {
  it("reports a page cap as incomplete and never caches that negative scope", async () => {
    query.mockResolvedValueOnce(response(true, "next"))
      .mockResolvedValueOnce(response(false, null));

    const capped = await listConfiguredCoins(1);
    expect(capped.complete).toBe(false);
    expect(capped.map.size).toBe(1);
    // The next scan can finish after a previously incomplete enumeration.
    const first = await cachedConfiguredCoins();
    expect(first.complete).toBe(true);
    const second = await cachedConfiguredCoins();
    expect(second.complete).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("reaches regulated coins past the former 25-page limit", async () => {
    let page = 0;
    query.mockImplementation(() => {
      page++;
      return response(page < 26, page < 26 ? `page-${page}` : null);
    });
    const scan = await cachedConfiguredCoins();
    expect(scan.complete).toBe(true);
    expect(query).toHaveBeenCalledTimes(26);
  });

  it("does not restart a scan when more pages have no cursor", async () => {
    query.mockResolvedValueOnce(response(true, null));
    const scan = await listConfiguredCoins();
    expect(scan.complete).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a page when the endpoint repeats a cursor", async () => {
    query.mockResolvedValueOnce(response(true, "next"))
      .mockResolvedValueOnce(response(true, "next"));
    const scan = await listConfiguredCoins();
    expect(scan.complete).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("retries a partial cached scan rather than claiming a clean result", async () => {
    query.mockResolvedValueOnce(response(true, null))
      .mockResolvedValueOnce(response(false, null));
    expect((await cachedConfiguredCoins()).complete).toBe(false);
    expect((await cachedConfiguredCoins()).complete).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("retains enumerated configs after a later page fails and retries on the next request", async () => {
    query.mockResolvedValueOnce(response(true, "next"))
      .mockRejectedValueOnce(new Error("GraphQL timeout"))
      .mockResolvedValueOnce(response(false, null));
    const partial = await cachedConfiguredCoins();
    expect(partial.complete).toBe(false);
    expect([...partial.map.values()]).toEqual(["0xcafe"]);
    expect((await cachedConfiguredCoins()).complete).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });
});

describe("coin restriction scan continuation", () => {
  it("resumes at the first unread page without declaring a partial pause state clear", async () => {
    const denied = (address: string) => ({
      name: { type: { repr: "0x2::deny_list::AddressKey" }, json: { pos0: address } },
      value: { json: { data: { newer_value_epoch: "1", newer_value: true } } },
    });
    query.mockImplementation(async (_gql: string, vars: { cursor: string | null }) => ({
      object: {
        dynamicFields: {
          nodes: [denied(vars.cursor ? "0x2" : "0x1")],
          pageInfo: { hasNextPage: !vars.cursor, endCursor: vars.cursor ? null : "page-2" },
        }
      },
    }));
    const first = await readCoinRestrictions("0x2::sui::SUI", "0xcafe", 5, 1);
    expect(first).toMatchObject({
      truncated: true, next_cursor: "page-2", globally_paused: null,
      denied: [{ address: "0x1", active: true }]
    });
    const second = await readCoinRestrictions("0x2::sui::SUI", "0xcafe", 5, 1, first.next_cursor);
    expect(second).toMatchObject({
      truncated: false, globally_paused: null,
      denied: [{ address: "0x2", active: true }]
    });
    expect(query.mock.calls.map(([, variables]) => variables.cursor)).toEqual([null, "page-2"]);
  });
});
