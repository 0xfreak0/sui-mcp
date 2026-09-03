import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithNetwork } from "../src/config.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

const { getPackageRoot, prefetchPackageRoots, clearPackageRootCache, ROOT_BATCH_SIZE } =
  await import("../src/protocols/package-roots.js");

// Real Cetus lineage: v14 and v12 both descend from the v1 root.
const CETUS_V14 = "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3";
const CETUS_V12 = "0x75b2e9ecad34944b8d0c874e568c90db0cf9437f0d7392abfd4cb902972f3e40";
const CETUS_ROOT = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const NOT_A_PACKAGE = "0x0000000000000000000000000000000000000000000000000000000000000005";

/**
 * Stand in for the aliased batch query: every `a<i>` variable is answered with
 * the root the map gives it, under the matching `p<i>` alias. An address with
 * no entry answers with an empty node list, which is what the real endpoint
 * returns for a non-package or an unknown ID (verified on mainnet).
 */
const lineages = (map: Record<string, string>) =>
  gqlQuery.mockImplementation(async (_q: string, vars: Record<string, string>) => {
    const out: Record<string, { nodes: Array<{ address: string }> }> = {};
    for (const [name, addr] of Object.entries(vars)) {
      const root = map[addr];
      out[`p${name.slice(1)}`] = { nodes: root ? [{ address: root }] : [] };
    }
    return out;
  });

beforeEach(() => {
  vi.clearAllMocks();
  clearPackageRootCache();
});

describe("prefetchPackageRoots", () => {
  it("resolves an upgraded package to its lineage root", async () => {
    lineages({ [CETUS_V12]: CETUS_ROOT });
    await runWithNetwork("mainnet", () => prefetchPackageRoots([CETUS_V12]));
    expect(runWithNetwork("mainnet", () => getPackageRoot(CETUS_V12))).toBe(CETUS_ROOT);
  });

  it("batches within the server's per-request query limit", async () => {
    // The GraphQL service rejects a request carrying more than 21 queries that
    // "require dedicated access to a backing store" — measured against mainnet,
    // which answered 21 aliases with RESOURCE_EXHAUSTED. One request per batch,
    // each strictly under that cap.
    expect(ROOT_BATCH_SIZE).toBeLessThan(21);

    lineages({});
    const ids = Array.from(
      { length: ROOT_BATCH_SIZE + 3 },
      (_, i) => "0x" + String(i).padStart(64, "0"),
    );
    await runWithNetwork("mainnet", () => prefetchPackageRoots(ids));

    expect(gqlQuery).toHaveBeenCalledTimes(2);
    for (const [, vars] of gqlQuery.mock.calls) {
      expect(Object.keys(vars as object).length).toBeLessThanOrEqual(ROOT_BATCH_SIZE);
    }
  });

  it("asks once per package, hit or miss", async () => {
    // A miss is a real answer — a non-package never becomes a package — so
    // caching it stops a dead ID being re-queried on every decode.
    lineages({ [CETUS_V12]: CETUS_ROOT });
    await runWithNetwork("mainnet", () => prefetchPackageRoots([CETUS_V12, NOT_A_PACKAGE]));
    await runWithNetwork("mainnet", () => prefetchPackageRoots([CETUS_V12, NOT_A_PACKAGE]));
    expect(gqlQuery).toHaveBeenCalledTimes(1);
    expect(runWithNetwork("mainnet", () => getPackageRoot(NOT_A_PACKAGE))).toBeNull();
  });

  it("keeps caches separate per network", async () => {
    lineages({ [CETUS_V12]: CETUS_ROOT });
    await runWithNetwork("mainnet", () => prefetchPackageRoots([CETUS_V12]));

    expect(runWithNetwork("mainnet", () => getPackageRoot(CETUS_V12))).toBe(CETUS_ROOT);
    // The same ID on testnet is an unrelated package; a mainnet lineage must
    // not answer for it.
    expect(runWithNetwork("testnet", () => getPackageRoot(CETUS_V12))).toBeNull();
  });

  it("leaves ids uncached when the query fails, so an outage isn't sticky", async () => {
    gqlQuery.mockRejectedValueOnce(new Error("502 Bad Gateway"));
    await expect(
      runWithNetwork("mainnet", () => prefetchPackageRoots([CETUS_V12])),
    ).resolves.toBeUndefined();
    expect(runWithNetwork("mainnet", () => getPackageRoot(CETUS_V12))).toBeNull();

    lineages({ [CETUS_V12]: CETUS_ROOT });
    await runWithNetwork("mainnet", () => prefetchPackageRoots([CETUS_V12]));
    expect(runWithNetwork("mainnet", () => getPackageRoot(CETUS_V12))).toBe(CETUS_ROOT);
  });

  it("treats short and padded forms of an address as one package", async () => {
    lineages({ "0x0000000000000000000000000000000000000000000000000000000000000002": "0x0000000000000000000000000000000000000000000000000000000000000002" });
    await runWithNetwork("mainnet", () => prefetchPackageRoots(["0x2"]));
    expect(runWithNetwork("mainnet", () => getPackageRoot("0x2"))).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    );
    // And the padded form must not trigger a second lookup for the same package.
    await runWithNetwork("mainnet", () =>
      prefetchPackageRoots(["0x0000000000000000000000000000000000000000000000000000000000000002"]),
    );
    expect(gqlQuery).toHaveBeenCalledTimes(1);
  });
});

describe("getPackageRoot", () => {
  it("returns null rather than blocking when nothing has been prefetched", () => {
    // Callers decode synchronously; an unprefetched ID degrades to "unknown",
    // never to a network call on the critical path.
    expect(runWithNetwork("mainnet", () => getPackageRoot(CETUS_V14))).toBeNull();
    expect(gqlQuery).not.toHaveBeenCalled();
  });
});
