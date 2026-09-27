import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithNetwork } from "../src/config.js";
import { getPackageCustody, clearPackageCustodyCache, protocolsSignedBy } from "../src/protocols/package-custody.js";
import {
  lookupPackageTrust,
  lookupProtocol,
  lookupProtocolDisplay,
  prefetchProtocolCustody,
  prefetchProtocolNames,
  readProtocolCustody,
} from "../src/protocols/registry.js";
import { decodeTransaction } from "../src/protocols/decoder.js";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { createRequire } from "node:module";
import { clearMvrNameCache } from "../src/protocols/mvr-names.js";

const protocolRoots = createRequire(import.meta.url)("../src/data/protocol-roots.json") as { roots: Record<string, { name: string }> };

// vi.mock is hoisted above the imports, so every module sees these stubs.
const { gqlQuery, reverseResolveBulk } = vi.hoisted(() => ({ gqlQuery: vi.fn(), reverseResolveBulk: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/utils/mvr-client.js", () => ({ reverseResolveBulk }));

// Scallop's spool lineage (the exploited v2 and two later versions) as mainnet
// reports it. v2 was published by the key that also upgraded Scallop's curated
// core lineage, whose root is SCALLOP_CORE.
const SPOOL_V2 = "0xec1ac7f4d01c5bf178ff4e62e523e7df7721453d81d4904a42a0ffc2686c843d";
const SPOOL_V3 = "0x7c4fdabe81c31b19a45d1e572a52a539997a90903fbb5bfab71480abe0fa62c3";
const SPOOL_V4 = "0x472fc7d4c3534a8ec8c2f5d7a557a43050eab057aaab853e8910968ddc84fc9f";
const SCALLOP_UPGRADER = "0x1226a80ef40bd2e70c6a285b045b9b5d29915a2c5a2d57a2d3032cbdd89a8d5c";
const SCALLOP_CORE = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
/** Published Pyth's, Pyth Lazer's and Wormhole's roots alike. */
const PYTH_WORMHOLE_DEPLOYER = "0xe9ca39d84ead6a433860a7a3e283d75e53f01ab237f29cc78dbb05da1c93252d";
const STRANGER = `0x${"5a".repeat(32)}`;

const node = (address: string, version: number, publisher: string, checkpoint: number) => ({
  address,
  version,
  previousTransaction: { sender: { address: publisher }, effects: { checkpoint: { sequenceNumber: checkpoint } } },
});

/** Answer the lineage batch with v2 signed by `publisher`, then v3 and v4 by the same key. */
function chain(publisher: string) {
  const versions = [node(SPOOL_V2, 2, publisher, 100), node(SPOOL_V3, 3, publisher, 200), node(SPOOL_V4, 4, publisher, 300)];
  gqlQuery.mockImplementation(async (query: string, vars: Record<string, string>) =>
    Object.fromEntries(
      Object.keys(vars).map((k) => [`p${k.slice(1)}`, { nodes: query.includes("last:") ? versions : [{ address: vars[k] }] }]),
    ),
  );
}

const onMainnet = <T>(fn: () => T) => runWithNetwork("mainnet", fn);

const withCustody = { custody: true };

beforeEach(() => {
  vi.clearAllMocks();
  reverseResolveBulk.mockResolvedValue(new Map());
  clearPackageCustodyCache();
  clearMvrNameCache();
});

describe("package custody", () => {
  it("names a package after the curated protocol whose key published this version, for display only", async () => {
    chain(SCALLOP_UPGRADER);
    await onMainnet(() => prefetchProtocolCustody([SPOOL_V2]));
    expect(onMainnet(() => lookupProtocolDisplay(SPOOL_V2, withCustody))).toMatchObject({ name: "Scallop", source: "publisher" });
    const custody = onMainnet(() => getPackageCustody(SPOOL_V2));
    expect(custody?.address).toBe(SCALLOP_UPGRADER);
    expect(protocolRoots.roots[custody!.shared_with]?.name).toBe("Scallop");
    // Behaviour-gating identification stays curated-only.
    expect(onMainnet(() => lookupProtocol(SPOOL_V2))).toBeNull();
  });

  it("names nobody, and vouches for nothing, when the version's publisher signed no curated lineage", async () => {
    chain(STRANGER);
    await onMainnet(() => prefetchProtocolCustody([SPOOL_V2]));
    expect(onMainnet(() => lookupProtocolDisplay(SPOOL_V2, withCustody))).toBeNull();
    expect(onMainnet(() => lookupPackageTrust(SPOOL_V2, null)).basis).toBeNull();
  });

  it("names neither protocol for a key two curated protocols share, yet counts it as publisher-verified", async () => {
    chain(PYTH_WORMHOLE_DEPLOYER);
    await onMainnet(() => prefetchProtocolCustody([SPOOL_V2]));
    expect(onMainnet(() => getPackageCustody(SPOOL_V2))).toBeNull();
    const trust = onMainnet(() => lookupPackageTrust(SPOOL_V2, null));
    expect(trust.basis).toBe("publisher");
    expect(trust.protocols).toEqual(expect.arrayContaining(["Pyth", "Wormhole"]));
  });

  it("judges a version superseded only by versions published by the transaction's checkpoint", async () => {
    chain(SCALLOP_UPGRADER);
    await onMainnet(() => prefetchProtocolCustody([SPOOL_V2]));
    expect(onMainnet(() => lookupPackageTrust(SPOOL_V2, 150)).superseded).toBeNull();
    expect(onMainnet(() => lookupPackageTrust(SPOOL_V2, 250)).superseded).toEqual({ version: 2, newest_version: 3, newest: SPOOL_V3 });
    expect(onMainnet(() => lookupPackageTrust(SPOOL_V2, null)).superseded).toEqual({ version: 2, newest_version: 4, newest: SPOOL_V4 });
    expect(onMainnet(() => lookupPackageTrust(SPOOL_V4, null)).superseded).toBeNull();
  });

  it("leaves a lookup that does not ask for custody unchanged after another tool prefetched it", async () => {
    chain(SCALLOP_UPGRADER);
    await onMainnet(() => prefetchProtocolCustody([SPOOL_V2]));
    expect(onMainnet(() => lookupProtocolDisplay(SPOOL_V2))).toBeNull();
  });

  it("keeps a package's own Move Registry name for display, and never counts that name as trust", async () => {
    reverseResolveBulk.mockResolvedValue(new Map([[SPOOL_V2, "@scallop/spool"]]));
    chain(STRANGER);
    await onMainnet(async () => {
      await prefetchProtocolNames([SPOOL_V2]);
      await prefetchProtocolCustody([SPOOL_V2]);
    });
    expect(onMainnet(() => lookupProtocolDisplay(SPOOL_V2, withCustody))).toMatchObject({ name: "@scallop/spool", source: "mvr" });
    expect(onMainnet(() => lookupPackageTrust(SPOOL_V2, null)).basis).toBeNull();
  });

  it("vouches for a curated package by the registry, and still reads whether the call used a superseded version", async () => {
    const versions = [node(SCALLOP_CORE, 1, STRANGER, 10), node(SPOOL_V4, 2, STRANGER, 20)];
    gqlQuery.mockResolvedValue({ p0: { nodes: versions } });
    await onMainnet(() => prefetchProtocolCustody([SCALLOP_CORE]));
    const trust = onMainnet(() => lookupPackageTrust(SCALLOP_CORE, null));
    expect(trust.basis).toBe("curated");
    expect(trust.superseded).toEqual({ version: 1, newest_version: 2, newest: SPOOL_V4 });
  });

  it("leaves a failed read uncached, so the next call asks again", async () => {
    gqlQuery.mockRejectedValueOnce(new Error("503"));
    expect(await onMainnet(() => prefetchProtocolCustody([SPOOL_V2]))).toEqual({ skipped: [], failed: [SPOOL_V2] });
    expect(onMainnet(() => getPackageCustody(SPOOL_V2))).toBeNull();
    chain(SCALLOP_UPGRADER);
    await onMainnet(() => prefetchProtocolCustody([SPOOL_V2]));
    expect(onMainnet(() => getPackageCustody(SPOOL_V2))?.protocol).toBe("Scallop");
  });

  it("answers nothing off mainnet, where the curated data does not apply", async () => {
    chain(SCALLOP_UPGRADER);
    await runWithNetwork("testnet", () => prefetchProtocolCustody([SPOOL_V2]));
    expect(gqlQuery).not.toHaveBeenCalled();
  });

  describe("naming a called package in a decoded transaction", () => {
    const call = (pkg: string) =>
      ({ command: { oneofKind: "moveCall", moveCall: { package: pkg, module: "swap", function: "take_fee", typeArguments: [] } } }) as unknown as GrpcTypes.Command;

    it("names it after the curated protocol whose key published it when this call read its publisher", async () => {
      chain(SCALLOP_UPGRADER);
      const read = await onMainnet(() => readProtocolCustody([SPOOL_V2]));
      const decoded = onMainnet(() => decodeTransaction([call(SPOOL_V2)], [], undefined, { custodyFor: read.custodyFor }));
      expect(decoded.protocols).toEqual(["Scallop"]);
      expect(decoded.actions).toEqual(["Call swap::take_fee on Scallop"]);
    });

    it("does not name it from a cache another call filled when this call's read failed", async () => {
      gqlQuery.mockRejectedValueOnce(new Error("503"));
      const read = await onMainnet(() => readProtocolCustody([SPOOL_V2]));
      expect(read.unread.failed).toEqual([SPOOL_V2]);
      chain(SCALLOP_UPGRADER);
      await onMainnet(() => prefetchProtocolCustody([SPOOL_V2]));
      const decoded = onMainnet(() => decodeTransaction([call(SPOOL_V2)], [], undefined, { custodyFor: read.custodyFor }));
      expect(decoded.protocols).toEqual([]);
    });
  });

  describe("protocolsSignedBy", () => {
    it("names every curated protocol whose lineage the address signed, and nothing for other keys or off mainnet", () => {
      expect(onMainnet(() => protocolsSignedBy(SCALLOP_UPGRADER))).toEqual(["Scallop"]);
      expect(onMainnet(() => protocolsSignedBy(PYTH_WORMHOLE_DEPLOYER))).toEqual(expect.arrayContaining(["Pyth", "Wormhole"]));
      expect(onMainnet(() => protocolsSignedBy(STRANGER))).toEqual([]);
      expect(runWithNetwork("testnet", () => protocolsSignedBy(SCALLOP_UPGRADER))).toEqual([]);
    });
  });
});
