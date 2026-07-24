import { describe, it, expect } from "vitest";
import { z } from "zod";
import { withNetworkParam } from "../../src/tools/with-network.js";
import { getNetwork } from "../../src/config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
