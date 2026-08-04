import { describe, it, expect, beforeEach } from "vitest";
import { registerLabelTools } from "../../src/tools/labels.js";
import { removeSessionLabel } from "../../src/utils/labels.js";

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerLabelTools(mockServer);
const manageLabels = tools.get("manage_labels")!;

const ADDR = "0xabc0000000000000000000000000000000000000000000000000000000000042";

async function call(args: Record<string, unknown>) {
  const res = await manageLabels(args);
  return JSON.parse(res.content[0].text);
}

describe("manage_labels", () => {
  beforeEach(() => removeSessionLabel(ADDR));

  it("lists labels including the shipped zero-address burn entry", async () => {
    const data = await call({ action: "list" });
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.labels.some((l: { category: string }) => l.category === "burn")).toBe(true);
  });

  it("adds a session label and reports sink status", async () => {
    const data = await call({
      action: "add",
      address: ADDR,
      label: "SomeCEX deposit",
      category: "cex",
      confidence: "high",
    });
    expect(data.added.label).toBe("SomeCEX deposit");
    expect(data.added.source).toBe("session");
    expect(data.is_sink).toBe(true);
  });

  it("looks up a previously added label", async () => {
    await call({ action: "add", address: ADDR, label: "Bridge", category: "bridge" });
    const data = await call({ action: "lookup", address: ADDR });
    expect(data.label.label).toBe("Bridge");
    expect(data.is_sink).toBe(true);
  });

  it("removes a session label", async () => {
    await call({ action: "add", address: ADDR, label: "temp", category: "other" });
    const data = await call({ action: "remove", address: ADDR });
    expect(data.removed).toBe(true);
    const after = await call({ action: "lookup", address: ADDR });
    expect(after.label).toBeNull();
  });

  it("errors when add is missing required fields", async () => {
    const data = await call({ action: "add", address: ADDR });
    expect(data.error).toMatch(/required/i);
  });

  it("errors when lookup has no address", async () => {
    const data = await call({ action: "lookup" });
    expect(data.error).toMatch(/required/i);
  });
});
