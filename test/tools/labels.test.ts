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
    // Flagged as an error, not a result whose body happens to say so: a
    // client that only checks isError would otherwise read it as success.
    const res = await manageLabels({ action: "add", address: ADDR });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/required/i);
  });

  it("errors when lookup has no address", async () => {
    const data = await call({ action: "lookup" });
    expect(data.error).toMatch(/required/i);
  });
});

describe("manage_labels export/import round-trip", () => {
  const EVM = "eip155:1:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
  const PHANTOM_SUI =
    "sui:mainnet:0x0000000000000000000000005aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

  beforeEach(() => {
    removeSessionLabel(EVM);
    removeSessionLabel(PHANTOM_SUI);
  });

  it("exports a chain-qualified account, not a bare address", async () => {
    await call({ action: "add", address: EVM, label: "Wormhole ETH", category: "bridge" });
    const data = await call({ action: "export" });
    const row = data.labels.find((l: { label: string }) => l.label === "Wormhole ETH");
    expect(row.address).toBe(EVM);
  });

  it("round-trips a cross-chain label without re-filing it on Sui", async () => {
    // Exporting a bare address and re-importing it resolved against the
    // CURRENT network, which minted a phantom Sui account by zero-padding a
    // 20-byte EVM address. Because `bridge` is a sink category, that phantom
    // would silently terminate future Sui traces at an address belonging to
    // nobody.
    await call({ action: "add", address: EVM, label: "Wormhole ETH", category: "bridge" });
    const exported = await call({ action: "export" });

    await call({ action: "import", labels: exported.labels });

    const after = await call({ action: "export" });
    const accounts = after.labels
      .filter((l: { label: string }) => l.label === "Wormhole ETH")
      .map((l: { address: string }) => l.address);
    expect(accounts).toEqual([EVM]);
    expect(accounts).not.toContain(PHANTOM_SUI);
  });

  it("still accepts a bare address on import, for hand-written files", async () => {
    await call({
      action: "import",
      labels: [{ address: ADDR, label: "Hand written", category: "cex" }],
    });
    const found = await call({ action: "lookup", address: ADDR });
    expect(found.label.label).toBe("Hand written");
  });

  // A malformed reference was looked up as it was and answered "label: null",
  // which reads as an address that was checked and carries no label.
  it("refuses a lookup, add or remove of something that is not an address", async () => {
    for (const args of [
      { action: "lookup", address: "0xZZ12" },
      { action: "lookup", address: `0x${"a".repeat(65)}` },
      { action: "add", address: "not-an-address", label: "x", category: "cex" },
      { action: "remove", address: "0x12\u0000ab" },
    ]) {
      const res = await manageLabels(args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    const ok = await call({ action: "lookup", address: "eip155:1:0x135477aa627a3bcc3223bde10dd8e7c55a1f645c" });
    expect(ok.account).toMatch(/^eip155:1:/);
  });
});
