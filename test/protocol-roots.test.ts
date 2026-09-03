import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithNetwork } from "../src/config.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
const { reverseResolveBulk } = vi.hoisted(() => ({ reverseResolveBulk: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/utils/mvr-client.js", () => ({ reverseResolveBulk }));

const { clearPackageRootCache } = await import("../src/protocols/package-roots.js");
const { clearMvrNameCache } = await import("../src/protocols/mvr-names.js");
const { lookupProtocol, lookupProtocolDisplay, prefetchProtocolNames, isCuratedProtocol } =
  await import("../src/protocols/registry.js");

// Cetus v12: a real, live package version that protocols.json does not list.
// Its root (v1) is curated, so the lineage tier alone identifies it.
const CETUS_V12 = "0x75b2e9ecad34944b8d0c874e568c90db0cf9437f0d7392abfd4cb902972f3e40";
const CETUS_ROOT = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";

// NAVI's lending lineage: neither curated ID is the root, so this one only
// resolves through the generated protocol-roots.json.
const NAVI_ROOT = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
// Stands in for a version NAVI has not shipped yet: an ID nothing knows, whose
// only tie to the protocol is the lineage it resolves into.
const NAVI_FUTURE = "0x00000000000000000000000000000000000000000000000000000000000000a1";

const UNRELATED = "0x00000000000000000000000000000000000000000000000000000000deadbeef";

const lineages = (map: Record<string, string>) =>
  gqlQuery.mockImplementation(async (_q: string, vars: Record<string, string>) => {
    const out: Record<string, { nodes: Array<{ address: string }> }> = {};
    for (const [name, addr] of Object.entries(vars)) {
      const root = map[addr];
      out[`p${name.slice(1)}`] = { nodes: root ? [{ address: root }] : [] };
    }
    return out;
  });

const mvrResolvesTo = (map: Record<string, string>) =>
  reverseResolveBulk.mockImplementation(
    async (ids: string[]) => new Map(ids.map((id) => [id, map[id] ?? null])),
  );

beforeEach(() => {
  vi.clearAllMocks();
  clearPackageRootCache();
  clearMvrNameCache();
  mvrResolvesTo({});
});

describe("lineage tier", () => {
  it("identifies an uncurated package version from its curated root", async () => {
    lineages({ [CETUS_V12]: CETUS_ROOT });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([CETUS_V12]));

    // Not a display-only name: this carries the verified category, so the
    // pass-through test in trace.ts and parser selection in pools.ts keep
    // working across an upgrade instead of silently dropping the protocol.
    expect(runWithNetwork("mainnet", () => lookupProtocol(CETUS_V12))).toEqual({
      name: "Cetus",
      type: "dex",
    });
  });

  it("identifies a lineage whose root was never curated directly", async () => {
    // Every NAVI ID in protocols.json is mid-lineage; the root comes from the
    // generated roots file, which is the whole reason that file exists.
    lineages({ [NAVI_FUTURE]: NAVI_ROOT });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([NAVI_FUTURE]));

    expect(runWithNetwork("mainnet", () => lookupProtocol(NAVI_FUTURE))).toEqual({
      name: "NAVI",
      type: "lending",
    });
  });

  it("stays exact-match until a prefetch has run", () => {
    // Lookup is synchronous by contract. Skipping the prefetch degrades to the
    // behaviour this registry had before lineages existed — never to a hang.
    expect(runWithNetwork("mainnet", () => lookupProtocol(CETUS_V12))).toBeNull();
    expect(gqlQuery).not.toHaveBeenCalled();
  });

  it("does not resolve a lineage for a package the registry already knows", async () => {
    await runWithNetwork("mainnet", () => prefetchProtocolNames([CETUS_ROOT]));
    expect(gqlQuery).not.toHaveBeenCalled();
    expect(reverseResolveBulk).not.toHaveBeenCalled();
  });

  it("leaves an unrelated lineage unidentified", async () => {
    lineages({ [UNRELATED]: UNRELATED });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([UNRELATED]));
    expect(runWithNetwork("mainnet", () => lookupProtocol(UNRELATED))).toBeNull();
  });
});

describe("prefetchProtocolNames tiering", () => {
  it("asks MVR only about packages no lineage identified", async () => {
    lineages({ [CETUS_V12]: CETUS_ROOT, [UNRELATED]: UNRELATED });
    mvrResolvesTo({ [UNRELATED]: "@someone/thing" });

    await runWithNetwork("mainnet", () => prefetchProtocolNames([CETUS_V12, UNRELATED]));

    expect(reverseResolveBulk).toHaveBeenCalledTimes(1);
    expect(reverseResolveBulk.mock.calls[0][0]).toEqual([UNRELATED]);
  });

  it("still enriches display names for packages outside every known lineage", async () => {
    lineages({});
    mvrResolvesTo({ [UNRELATED]: "@someone/thing" });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([UNRELATED]));

    expect(runWithNetwork("mainnet", () => lookupProtocolDisplay(UNRELATED))).toEqual({
      name: "@someone/thing",
      type: "unknown",
      source: "mvr",
    });
  });

  it("falls back to MVR when lineage resolution is unavailable", async () => {
    gqlQuery.mockRejectedValue(new Error("502 Bad Gateway"));
    mvrResolvesTo({ [CETUS_V12]: "@cetuspackages/clmm" });

    await runWithNetwork("mainnet", () => prefetchProtocolNames([CETUS_V12]));

    expect(runWithNetwork("mainnet", () => lookupProtocolDisplay(CETUS_V12))).toEqual({
      name: "@cetuspackages/clmm",
      type: "unknown",
      source: "mvr",
    });
  });
});

describe("isCuratedProtocol", () => {
  it("reports only the shipped exact IDs, not lineage members", async () => {
    // It answers "is this ID in the file", which is what the prefetch filter
    // needs; lineage membership is a runtime fact and belongs to lookupProtocol.
    lineages({ [CETUS_V12]: CETUS_ROOT });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([CETUS_V12]));
    expect(isCuratedProtocol(CETUS_ROOT)).toBe(true);
    expect(isCuratedProtocol(CETUS_V12)).toBe(false);
  });
});
