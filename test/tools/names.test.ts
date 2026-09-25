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

  /** A name-service failure as @protobuf-ts's RpcError carries it: a status code and a percent-encoded message. */
  function rpcError(code: string, message = code) {
    return Object.assign(new Error(message), { name: "RpcError", code });
  }

  it("reports an unregistered name as null with a note", async () => {
    mockSui.nameService.lookupName.mockRejectedValue(rpcError("NOT_FOUND"));

    const result = await tools.get("resolve_name")!({ name: "doesnotexist.sui", address: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(data.address).toBeNull();
    expect(data.name_note).toMatch(/not a registered/);
  });

  it("says an expired name has expired", async () => {
    mockSui.nameService.lookupName.mockRejectedValue(rpcError("RESOURCE_EXHAUSTED", "name%20has%20expired"));

    const data = JSON.parse((await tools.get("resolve_name")!({ name: "old.sui" })).content[0].text);

    expect(data.address).toBeNull();
    expect(data.name_note).toMatch(/expired/);
  });

  it("rejects a malformed name", async () => {
    mockSui.nameService.lookupName.mockRejectedValue(
      rpcError("INVALID_ARGUMENT", "invalid%20domain:%20Name%20Service:%20Only%20lowercase%20letters,%20numbers,%20and%20hyphens%20are%20allowed"),
    );

    const result = await tools.get("resolve_name")!({ name: "bad name!!" });

    expect(result.isError).toBe(true);
  });

  it("does not report a failed lookup as no name", async () => {
    // A rate limit or an outage is not an unregistered name.
    mockSui.nameService.lookupName.mockRejectedValue(rpcError("UNAVAILABLE", "upstream connect error"));

    const result = await tools.get("resolve_name")!({ name: "alice.sui" });

    expect(result.isError).toBe(true);
  });

  it("keeps the half that answered when the other lookup fails", async () => {
    mockSui.nameService.lookupName.mockResolvedValue({ response: { record: { targetAddress: "0xaddr" } } });
    mockSui.nameService.reverseLookupName.mockRejectedValue(rpcError("UNAVAILABLE", "upstream connect error"));

    const data = JSON.parse((await tools.get("resolve_name")!({ name: "bob.sui", address: "0xaddr" })).content[0].text);

    expect(data.address).toBe("0xaddr");
    expect(data.name).toBeNull();
    expect(data.name_unavailable).toMatch(/upstream connect error/);
  });
});
