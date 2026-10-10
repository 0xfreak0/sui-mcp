import { describe, expect, it } from "vitest";
import { diffData, staleSources } from "../scripts/data-sync-summary.mjs";
import { addChangelogSection, nextPatch } from "../scripts/data-release-prep.mjs";

const base = {
  generated_at: "2026-10-05",
  epoch: 1270,
  checkpoint: 330000000,
  labels: {
    "sui:mainnet:0xa": {
      label: "Validator A",
      retrieved_at: "2026-10-05",
      chain_state: { epoch: 1270, checkpoint: 330000000, operation_cap_object_version: 7, operation_cap_source_tx: "abc" },
    },
  },
  sources: [{ id: "validators", count: 1, retrieved_at: "2026-10-05", source_url: "https://a.example/v1" }],
};

describe("weekly data-sync release decision", () => {
  it("opens no release when only run stamps moved: dates, epochs, checkpoints, cap versions, document URLs", () => {
    const next = structuredClone(base);
    next.generated_at = "2026-10-12";
    next.epoch = 1277;
    next.checkpoint = 332600000;
    Object.assign(next.labels["sui:mainnet:0xa"], { retrieved_at: "2026-10-12" });
    Object.assign(next.labels["sui:mainnet:0xa"].chain_state, { epoch: 1277, checkpoint: 332600000, operation_cap_object_version: 9, operation_cap_source_tx: "def" });
    Object.assign(next.sources[0], { retrieved_at: "2026-10-12", source_url: "https://a.example/v2" });
    expect(diffData(base, next)).toEqual([]);
  });

  it("does not release a source that only went stale, but still reports it", () => {
    const next = structuredClone(base);
    Object.assign(next.sources[0], { stale: true, stale_reason: "timeout" });
    Object.assign(next.labels["sui:mainnet:0xa"], { stale: true, stale_since: "2026-10-12" });
    expect(diffData(base, next)).toEqual([]);
    expect(staleSources(next)).toEqual(["validators"]);
  });

  it("reports added, removed and edited labels and sources by key", () => {
    const next = structuredClone(base);
    next.labels["sui:mainnet:0xa"].label = "Validator A (renamed)";
    next.labels["sui:mainnet:0xb"] = { label: "Validator B" };
    next.sources[0].count = 2;
    expect(diffData(base, next)).toEqual([
      { key: "labels", added: ["sui:mainnet:0xb"], removed: [], changed: ["sui:mainnet:0xa"] },
      { key: "sources", added: [], removed: [], changed: ["validators"] },
    ]);
  });

  it("treats a file that is not committed yet as all additions", () => {
    expect(diffData(null, base)).toEqual([
      { key: "labels", added: ["sui:mainnet:0xa"], removed: [], changed: [] },
      { key: "sources", added: ["validators"], removed: [], changed: [] },
    ]);
  });
});

describe("data release preparation", () => {
  it("bumps the patch and refuses to guess past a prerelease", () => {
    expect(nextPatch("1.27.9")).toBe("1.27.10");
    expect(() => nextPatch("2.0.0-rc.1")).toThrow();
  });

  it("turns Unreleased into the release section, so merged entries ship under the version that carries them", () => {
    const out = addChangelogSection("# Changelog\n\n## Unreleased\n\n### Added\n- Thing.\n\n## 1.27.0 (2026-10-06)\n", "1.27.1", "2026-10-12", "- **Data refresh.** x.");
    expect(out).toBe("# Changelog\n\n## 1.27.1 (2026-10-12)\n\n### Data\n- **Data refresh.** x.\n\n### Added\n- Thing.\n\n## 1.27.0 (2026-10-06)\n");
  });

  it("opens a new section above the last release when nothing is unreleased", () => {
    const out = addChangelogSection("# Changelog\n\n## 1.27.0 (2026-10-06)\n\nBody.\n", "1.27.1", "2026-10-12", "- **Data refresh.** x.");
    expect(out).toBe("# Changelog\n\n## 1.27.1 (2026-10-12)\n\n### Data\n- **Data refresh.** x.\n\n## 1.27.0 (2026-10-06)\n\nBody.\n");
  });
});
