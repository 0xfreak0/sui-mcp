import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { createMockClient } from "../helpers/mock-grpc.js";
import { grpcError, notFoundError } from "../helpers/service-shapes.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mockSui = createMockClient();
vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));

const { withNetworkParam } = await import("../../src/tools/with-network.js");
const { getNetwork } = await import("../../src/config.js");
const { addressArg, addressListArg, numArg, boolArg } = await import("../../src/tools/args.js");

interface Registered {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: unknown, extra?: unknown) => unknown;
}

// Minimal fake server that records what `server.tool(...)` was called with.
function fakeServer() {
  const registered: Registered[] = [];
  const server = {
    tool(...args: unknown[]) {
      const handler = args[args.length - 1] as Registered["handler"];
      const head = args.slice(0, -1);
      registered.push({
        name: head[0] as string,
        description: (typeof head[1] === "string" ? head[1] : "") as string,
        schema: (head.find((a) => a && typeof a === "object") ?? {}) as Record<string, unknown>,
        handler,
      });
    },
    // A non-tool method to confirm the proxy passes other members through.
    resource() {
      /* noop */
    },
  } as unknown as McpServer;
  return { server, registered };
}

describe("withNetworkParam", () => {
  it("injects an optional `network` param into a tool's schema", () => {
    const { server, registered } = fakeServer();
    const wrapped = withNetworkParam(server);

    wrapped.tool("get_thing", "desc", { id: z.string() }, async () => ({ content: [] }));

    expect(registered).toHaveLength(1);
    expect(Object.keys(registered[0].schema).sort()).toEqual(["id", "network"]);
    // The injected param is a Zod type and optional (accepts undefined).
    const net = registered[0].schema.network as z.ZodTypeAny;
    expect(net.safeParse(undefined).success).toBe(true);
    expect(net.safeParse("testnet").success).toBe(true);
    expect(net.safeParse("localnet").success).toBe(false);
  });

  it("runs the handler in the requested network's context", async () => {
    const { server, registered } = fakeServer();
    const wrapped = withNetworkParam(server);

    let seen: string | undefined;
    wrapped.tool("probe", "desc", {}, async () => {
      seen = getNetwork();
      return { content: [] };
    });

    await registered[0].handler({ network: "testnet" });
    expect(seen).toBe("testnet");
  });

  it("defaults to mainnet when no network is supplied", async () => {
    const { server, registered } = fakeServer();
    const wrapped = withNetworkParam(server);

    let seen: string | undefined;
    wrapped.tool("probe", "desc", {}, async () => {
      seen = getNetwork();
      return { content: [] };
    });

    await registered[0].handler({});
    expect(seen).toBe("mainnet");
  });

  it("ignores an invalid network value and falls back to the default", async () => {
    const { server, registered } = fakeServer();
    const wrapped = withNetworkParam(server);

    let seen: string | undefined;
    wrapped.tool("probe", "desc", {}, async () => {
      seen = getNetwork();
      return { content: [] };
    });

    await registered[0].handler({ network: "bogus" });
    expect(seen).toBe("mainnet");
  });

  it("still passes the original args through to the handler", async () => {
    const { server, registered } = fakeServer();
    const wrapped = withNetworkParam(server);

    let received: unknown;
    wrapped.tool("probe", "desc", { id: z.string() }, async (args: unknown) => {
      received = args;
      return { content: [] };
    });

    await registered[0].handler({ id: "0xabc", network: "devnet" });
    expect(received).toEqual({ id: "0xabc", network: "devnet" });
  });

  it("injects a schema for a paramless (no-schema) tool registration", () => {
    const { server, registered } = fakeServer();
    const wrapped = withNetworkParam(server);

    // (name, description, handler) — no schema arg.
    wrapped.tool("bare", "desc", async () => ({ content: [] }));

    expect(Object.keys(registered[0].schema)).toEqual(["network"]);
  });
});

/** Parse `args` through a registered tool's schema, the way the SDK does before calling it. */
function parseLikeSdk(schema: Record<string, unknown>, args: unknown) {
  return z.object(schema as z.ZodRawShape).safeParse(args);
}

describe("withNetworkParam: argument shapes", () => {
  // Many clients send null for an optional they mean to leave unset. It used
  // to reach numArg as Number(null) = 0, and `limit: 0` answered with an empty
  // page and has_next_page:false.
  it("treats null as unset, so the field's default applies", () => {
    const { server, registered } = fakeServer();
    withNetworkParam(server).tool(
      "probe",
      "desc",
      {
        limit: numArg().int().min(1).max(50).optional().default(10),
        hops: numArg().optional(),
        include_prices: boolArg().optional(),
        coin_type: z.string().optional(),
      },
      async () => ({ content: [] }),
    );
    const r = parseLikeSdk(registered[0].schema, {
      limit: null,
      hops: null,
      include_prices: null,
      coin_type: null,
      network: null,
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ limit: 10 });
  });

  it("still reports a required field sent as null", () => {
    const { server, registered } = fakeServer();
    withNetworkParam(server).tool("probe", "desc", { address: addressArg() }, async () => ({ content: [] }));
    const r = parseLikeSdk(registered[0].schema, { address: null });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0].message).toBe("Required");
  });

  it("accepts a single string where a list is expected", () => {
    const { server, registered } = fakeServer();
    withNetworkParam(server).tool(
      "probe",
      "desc",
      { addresses: addressListArg().min(1), digests: z.array(z.string()).optional() },
      async () => ({ content: [] }),
    );
    const r = parseLikeSdk(registered[0].schema, { addresses: "0x2", digests: "abc" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ addresses: [`0x${"0".repeat(63)}2`], digests: ["abc"] });
  });
});

describe("withNetworkParam: SuiNS names in address arguments", () => {
  const TARGET = `0x${"ab".repeat(32)}`;
  beforeEach(() => vi.clearAllMocks());

  it("resolves a name on the call's network and reports it as resolved_from", async () => {
    mockSui.nameService.lookupName.mockResolvedValue({
      response: { record: { name: "example.sui", targetAddress: TARGET } },
    });
    const { server, registered } = fakeServer();
    let received: unknown;
    withNetworkParam(server).tool("probe", "desc", { address: addressArg() }, async (args: unknown) => {
      received = (args as { address: string }).address;
      return { content: [{ type: "text", text: JSON.stringify({ address: received }, null, 2) }] };
    });
    const result = (await registered[0].handler({ address: "example.sui" })) as {
      content: Array<{ text: string }>;
    };
    expect(received).toBe(TARGET);
    expect(mockSui.nameService.lookupName).toHaveBeenCalledWith({ name: "example.sui" });
    const data = JSON.parse(result.content[0].text);
    expect(data.address).toBe(TARGET);
    expect(data.resolved_from).toEqual({ "example.sui": TARGET });
    expect(data.resolved_from_note).toMatch(/not evidence of identity/);
  });

  it("answers an unregistered name with an error rather than calling the tool", async () => {
    mockSui.nameService.lookupName.mockRejectedValue(notFoundError("name not found"));
    const { server, registered } = fakeServer();
    const handler = vi.fn();
    withNetworkParam(server).tool("probe", "desc", { address: addressArg() }, handler);
    const result = (await registered[0].handler({ address: "nobody.sui", network: "testnet" })) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/nobody\.sui is not a registered SuiNS name .* on testnet/);
  });
});

describe("withNetworkParam: errors", () => {
  it("turns a thrown gRPC error into one decoded line", async () => {
    const { server, registered } = fakeServer();
    withNetworkParam(server).tool("probe", "desc", {}, async () => {
      throw grpcError("PERMISSION_DENIED", "invalid%20owner:%20Unable%20to%20parse%20Address");
    });
    const result = (await registered[0].handler({})) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe(
      "7 PERMISSION_DENIED: invalid owner: Unable to parse Address",
    );
  });

  it("names the network on a not-found, thrown or returned", async () => {
    const { server, registered } = fakeServer();
    const wrapped = withNetworkParam(server);
    wrapped.tool("thrower", "desc", {}, async () => {
      throw notFoundError("Transaction 9xYz not found");
    });
    wrapped.tool("returner", "desc", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ error: "NOT_FOUND" }) }],
      isError: true,
    }));
    const thrown = (await registered[0].handler({})) as { content: Array<{ text: string }> };
    expect(JSON.parse(thrown.content[0].text).error).toMatch(
      /Transaction 9xYz not found \(looked up on mainnet; if it came from another network, pass network: 'testnet' or 'devnet'\)/,
    );
    const returned = (await registered[1].handler({ network: "testnet" })) as { content: Array<{ text: string }> };
    expect(JSON.parse(returned.content[0].text).error).toBe(
      "Not found (looked up on testnet; if it came from another network, pass network: 'mainnet' or 'devnet')",
    );
  });
});
