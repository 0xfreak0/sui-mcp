import { describe, it, expect, beforeEach } from "vitest";
import {
  addSessionLabel,
  allLabels,
  getLabel,
  isSink,
  isSinkCategory,
  removeSessionLabel,
} from "../src/utils/labels.js";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("isSinkCategory", () => {
  it("treats cex/bridge/mixer/malicious/burn as sinks", () => {
    for (const c of ["cex", "bridge", "mixer", "malicious", "burn"] as const) {
      expect(isSinkCategory(c)).toBe(true);
    }
  });
  it("does not treat protocol/defi/validator/other as sinks", () => {
    for (const c of ["protocol", "defi", "validator", "other"] as const) {
      expect(isSinkCategory(c)).toBe(false);
    }
  });
});

describe("static labels", () => {
  it("ships the zero address as a burn sink", () => {
    const label = getLabel(ZERO);
    expect(label?.category).toBe("burn");
    expect(label?.source).toBe("curated");
    expect(isSink(ZERO)).toBe(true);
  });

  it("returns null for an unlabeled address", () => {
    expect(getLabel("0x1234567890abcdef")).toBeNull();
    expect(isSink("0x1234567890abcdef")).toBe(false);
  });
});

describe("session labels", () => {
  const addr = "0xabc0000000000000000000000000000000000000000000000000000000000099";

  beforeEach(() => {
    removeSessionLabel(addr);
  });

  it("adds and looks up a session label, normalizing the address", () => {
    addSessionLabel(addr, { label: "Attacker #1", category: "malicious", confidence: "high" });
    // Look up with a differently-cased / whitespaced form → same identity.
    const found = getLabel(`  ${addr.toUpperCase().replace("0X", "0x")}  `);
    expect(found?.label).toBe("Attacker #1");
    expect(found?.source).toBe("session");
    expect(isSink(addr)).toBe(true);
  });

  it("session labels take precedence over static", () => {
    addSessionLabel(ZERO, { label: "Reclassified", category: "cex" });
    expect(getLabel(ZERO)?.label).toBe("Reclassified");
    expect(getLabel(ZERO)?.source).toBe("session");
    // Cleanup so other tests see the static value again.
    removeSessionLabel(ZERO);
    expect(getLabel(ZERO)?.source).toBe("curated");
  });

  it("removeSessionLabel reports whether one existed and never removes static", () => {
    expect(removeSessionLabel(addr)).toBe(false);
    addSessionLabel(addr, { label: "x", category: "other" });
    expect(removeSessionLabel(addr)).toBe(true);
    // Static entry is untouched by removal.
    removeSessionLabel(ZERO);
    expect(getLabel(ZERO)?.category).toBe("burn");
  });

  it("allLabels includes static + session with precedence", () => {
    addSessionLabel(addr, { label: "Bridge X", category: "bridge" });
    const all = allLabels();
    const found = all.find((l) => l.label === "Bridge X");
    expect(found?.category).toBe("bridge");
    // Zero address still present from static.
    expect(all.some((l) => l.category === "burn")).toBe(true);
    removeSessionLabel(addr);
  });
});
