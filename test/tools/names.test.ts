import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockSui,
}));

const { registerNameTools } = await import("../../src/tools/names.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerNameTools(mockServer);

describe("resolve_name", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves name to address", async () => {
    mockSui.nameService.lookupName.mockResolvedValue({
      response: { record: { targetAddress: "0xresolved" } },
    });

    const handler = tools.get("resolve_name")!;
    const result = await handler({ name: "example.sui", address: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(data.address).toBe("0xresolved");
  });

  it("reverse-resolves address to name", async () => {
    mockSui.nameService.reverseLookupName.mockResolvedValue({
      response: { record: { name: "alice.sui" } },
    });

    const handler = tools.get("resolve_name")!;
    const result = await handler({ name: undefined, address: "0xalice" });
    const data = JSON.parse(result.content[0].text);

    expect(data.name).toBe("alice.sui");
  });

  it("performs bidirectional lookup when both provided", async () => {
    mockSui.nameService.lookupName.mockResolvedValue({
      response: { record: { targetAddress: "0xaddr" } },
    });
    mockSui.nameService.reverseLookupName.mockResolvedValue({
      response: { record: { name: "bob.sui" } },
    });

    const handler = tools.get("resolve_name")!;
    const result = await handler({ name: "bob.sui", address: "0xaddr" });
    const data = JSON.parse(result.content[0].text);

    expect(data.address).toBe("0xaddr");
    expect(data.name).toBe("bob.sui");
  });

  it("returns error when neither name nor address provided", async () => {
    const handler = tools.get("resolve_name")!;
    const result = await handler({ name: undefined, address: undefined });

    expect(result.isError).toBe(true);
  });

  it("handles lookup failure gracefully", async () => {
    mockSui.nameService.lookupName.mockRejectedValue(new Error("not found"));

    const handler = tools.get("resolve_name")!;
    const result = await handler({ name: "doesnotexist.sui", address: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(data.address).toBeNull();
  });
});
