import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: query }));

import { listConfiguredCoins, cachedConfiguredCoins, resetCoinMapCache } from "../src/utils/deny-list-probe.js";

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

  it("does not restart a scan when more pages have no cursor", async () => {
    query.mockResolvedValueOnce(response(true, null));
    const scan = await listConfiguredCoins();
    expect(scan.complete).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("retries a partial cached scan rather than claiming a clean result", async () => {
    query.mockResolvedValueOnce(response(true, null))
      .mockResolvedValueOnce(response(false, null));
    expect((await cachedConfiguredCoins()).complete).toBe(false);
    expect((await cachedConfiguredCoins()).complete).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
