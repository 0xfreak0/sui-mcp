import { describe, it, expect, afterEach } from "vitest";
import { addSessionLabel, allLabels, removeSessionLabel } from "../src/utils/labels.js";
import { registerLabelTools } from "../src/tools/labels.js";

type Args = { action: "list"; detail?: "summary" | "full" };
let handler: (args: Args) => Promise<{ content: { text: string }[] }>;
registerLabelTools({
  tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
    handler = h;
  },
} as never);

const run = async (args: Args) => JSON.parse((await handler(args)).content[0].text);

const MINE = "0x00000000000000000000000000000000000000000000000000000000c0ffee01";

describe("manage_labels list", () => {
  afterEach(() => {
    removeSessionLabel(MINE);
  });

  it("keeps a label added here past the cap and counts every label", async () => {
    // Added after the shipped set, so it sits last in registry order and
    // would be the first row a plain budget drops.
    addSessionLabel(MINE, { label: "Case wallet", category: "malicious" });
    const total = allLabels().length;

    const summary = await run({ action: "list" });
    expect(summary.truncated).toBe(true);
    expect(summary.count).toBe(total);
    expect(summary.by_source.session).toBe(1);
    expect(Object.values(summary.by_category as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(total);
    expect(summary.labels.some((l: { address: string }) => l.address === MINE)).toBe(true);
    expect(summary.labels.length + summary.omitted.lists.labels.count).toBe(total);
    expect(summary.omitted.next_call).toEqual({ tool: "manage_labels", repeat_with: { detail: "full" } });

    const full = await run({ action: "list", detail: "full" });
    expect(full.truncated).toBeUndefined();
    expect(full.labels).toHaveLength(total);
  });
});
