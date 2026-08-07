import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithNetwork } from "../src/config.js";

const { reverseResolveBulk } = vi.hoisted(() => ({ reverseResolveBulk: vi.fn() }));
vi.mock("../src/utils/mvr-client.js", () => ({ reverseResolveBulk }));

const { clearMvrNameCache, getMvrName } = await import("../src/protocols/mvr-names.js");
const { lookupProtocol, lookupProtocolDisplay, prefetchProtocolNames, isCuratedProtocol } =
  await import("../src/protocols/registry.js");

// A real curated entry (Cetus) and a package that is in neither the registry
// nor, by default, MVR.
const CURATED = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const UNKNOWN = "0x00000000000000000000000000000000000000000000000000000000deadbeef";
const UNKNOWN2 = "0x00000000000000000000000000000000000000000000000000000000feedface";

const resolveTo = (map: Record<string, string | null>) =>
  reverseResolveBulk.mockImplementation(async (ids: string[]) =>
    new Map(ids.map((id) => [id, map[id] ?? null])),
  );

beforeEach(() => {
  vi.clearAllMocks();
  clearMvrNameCache();
});

describe("prefetchProtocolNames", () => {
  it("does not ask MVR about packages the curated registry already knows", async () => {
    await runWithNetwork("mainnet", () => prefetchProtocolNames([CURATED]));
    expect(reverseResolveBulk).not.toHaveBeenCalled();
  });

  it("asks MVR once, in bulk, for the unknown packages only", async () => {
    resolveTo({ [UNKNOWN]: "@alphafi/core" });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([CURATED, UNKNOWN, UNKNOWN2]));
    expect(reverseResolveBulk).toHaveBeenCalledTimes(1);
    expect(reverseResolveBulk.mock.calls[0][0].sort()).toEqual([UNKNOWN, UNKNOWN2].sort());
  });

  it("caches misses so a known-unregistered package is only asked about once", async () => {
    // MVR coverage is thin — most packages resolve to nothing — so not caching
    // the misses would mean re-querying the same dead IDs on every call.
    resolveTo({});
    await runWithNetwork("mainnet", () => prefetchProtocolNames([UNKNOWN]));
    await runWithNetwork("mainnet", () => prefetchProtocolNames([UNKNOWN]));
    expect(reverseResolveBulk).toHaveBeenCalledTimes(1);
  });

  it("leaves ids uncached when MVR fails, so an outage isn't sticky", async () => {
    reverseResolveBulk.mockRejectedValueOnce(new Error("MVR 503"));
    await expect(
      runWithNetwork("mainnet", () => prefetchProtocolNames([UNKNOWN])),
    ).resolves.toBeUndefined();
    expect(runWithNetwork("mainnet", () => getMvrName(UNKNOWN))).toBeNull();

    resolveTo({ [UNKNOWN]: "@later/success" });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([UNKNOWN]));
    expect(runWithNetwork("mainnet", () => getMvrName(UNKNOWN))).toBe("@later/success");
  });

  it("keeps caches separate per network", async () => {
    resolveTo({ [UNKNOWN]: "@mainnet-only/pkg" });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([UNKNOWN]));

    expect(runWithNetwork("mainnet", () => getMvrName(UNKNOWN))).toBe("@mainnet-only/pkg");
    // Same package ID on testnet is a different package; the mainnet answer
    // must not leak across.
    expect(runWithNetwork("testnet", () => getMvrName(UNKNOWN))).toBeNull();
  });
});

describe("lookupProtocol vs lookupProtocolDisplay", () => {
  it("display lookup surfaces an MVR name for an unknown package", async () => {
    resolveTo({ [UNKNOWN]: "@alphafi/core" });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([UNKNOWN]));

    const shown = runWithNetwork("mainnet", () => lookupProtocolDisplay(UNKNOWN));
    expect(shown).toEqual({ name: "@alphafi/core", type: "unknown", source: "mvr" });
  });

  // The trust boundary: fund tracing decides pass-through from lookupProtocol,
  // so an MVR name must never make an address look like a known protocol there.
  it("curated lookup stays null for an MVR-resolved package", async () => {
    resolveTo({ [UNKNOWN]: "@alphafi/core" });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([UNKNOWN]));

    expect(runWithNetwork("mainnet", () => lookupProtocol(UNKNOWN))).toBeNull();
    expect(isCuratedProtocol(UNKNOWN)).toBe(false);
  });

  it("curated data wins over MVR for the same package", async () => {
    // Even if MVR were asked directly, the hand-verified category must survive.
    resolveTo({ [CURATED]: "@cetuspackages/clmm" });
    await runWithNetwork("mainnet", () => prefetchProtocolNames([CURATED]));

    const shown = runWithNetwork("mainnet", () => lookupProtocolDisplay(CURATED));
    expect(shown?.name).toBe("Cetus");
    expect(shown?.type).toBe("dex");
    expect(shown?.source).toBeUndefined();
  });

  it("both lookups return null when nothing was prefetched", () => {
    expect(runWithNetwork("mainnet", () => lookupProtocolDisplay(UNKNOWN))).toBeNull();
    expect(runWithNetwork("mainnet", () => lookupProtocol(UNKNOWN))).toBeNull();
  });
});
