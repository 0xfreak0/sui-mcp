import { describe, it, expect } from "vitest";
import {
  candidatesForProtocol,
  summarizeLineage,
  type LineageEntry,
} from "../src/utils/package-lineage.js";

const v = (version: number, emitting: boolean, address = `0x${version}`): LineageEntry => ({
  address,
  version,
  emitting,
});

describe("summarizeLineage", () => {
  it("orders versions newest first", () => {
    const s = summarizeLineage([v(10, false), v(14, true), v(12, true)]);
    expect(s.versions.map((x) => x.version)).toEqual([14, 12, 10]);
    expect(s.latest_version).toBe(14);
  });

  it("returns only the emitting ids as query targets", () => {
    const s = summarizeLineage([v(12, true), v(13, false), v(14, true)]);
    expect(s.emitting_package_ids).toEqual(["0x14", "0x12"]);
  });

  // The real mainnet shape: three Cetus versions emitting at once. Collapsing
  // this to "the latest package" drops two thirds of the protocol's activity
  // while looking like a complete answer.
  it("tells the caller to query every emitting version, not just the newest", () => {
    const s = summarizeLineage([v(12, true), v(13, true), v(14, true)]);
    expect(s.emitting_package_ids).toHaveLength(3);
    expect(s.guidance).toMatch(/ALL of them|all of them/);
    expect(s.guidance).toMatch(/drop/i);
  });

  it("names the single active version when there is only one", () => {
    const s = summarizeLineage([v(1, false), v(2, true, "0xlive")]);
    expect(s.guidance).toContain("0xlive");
    expect(s.all_dormant).toBe(false);
  });

  // A redeploy mints an ID outside the upgrade lineage, so version-walking
  // cannot find it. Saying so beats implying the protocol is dead.
  it("flags a fully dormant lineage and explains what it cannot rule out", () => {
    const s = summarizeLineage([v(1, false), v(2, false)]);
    expect(s.all_dormant).toBe(true);
    expect(s.emitting_package_ids).toEqual([]);
    expect(s.guidance).toMatch(/redeploy/i);
    expect(s.guidance).toMatch(/widen the window/i);
  });

  it("handles an empty lineage without claiming dormancy", () => {
    const s = summarizeLineage([]);
    expect(s.all_dormant).toBe(false);
    expect(s.latest_version).toBeNull();
    expect(s.guidance).toMatch(/No package lineage/i);
  });

  it("carries a sample event type through", () => {
    const s = summarizeLineage([
      { address: "0xa", version: 3, emitting: true, sample_event_type: "pool::SwapEvent" },
    ]);
    expect(s.versions[0].sample_event_type).toBe("pool::SwapEvent");
  });
});

describe("candidatesForProtocol", () => {
  const registry = {
    "0xa": { name: "Cetus", type: "dex" },
    "0xb": { name: "Cetus", type: "dex" },
    "0xc": { name: "Bucket", type: "stablecoin" },
    "0xd": { name: "BucketV2", type: "stablecoin" },
  };

  it("returns every recorded id for a protocol", () => {
    expect(candidatesForProtocol(registry, "Cetus").sort()).toEqual(["0xa", "0xb"]);
  });

  it("matches case-insensitively", () => {
    expect(candidatesForProtocol(registry, "cetus")).toHaveLength(2);
    expect(candidatesForProtocol(registry, "  CETUS ")).toHaveLength(2);
  });

  // A substring match would fold an unrelated team's package into the answer,
  // and a wrong package produces an empty result that looks authoritative.
  it("does not match on substrings", () => {
    expect(candidatesForProtocol(registry, "Bucket")).toEqual(["0xc"]);
  });

  it("returns nothing for an unknown name", () => {
    expect(candidatesForProtocol(registry, "Nonexistent")).toEqual([]);
  });
});
