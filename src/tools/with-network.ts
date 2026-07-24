import { z } from "zod";
import { type SuiNetwork, DEFAULT_NETWORK, isSuiNetwork, runWithNetwork } from "../config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The `network` argument injected into every tool. Optional so existing callers
 * (and the LLM) can omit it and get {@link DEFAULT_NETWORK}; explicit per-call
 * so testnet and mainnet queries can coexist in one session.
 */
const networkParam = z
  .enum(["mainnet", "testnet", "devnet"])
  .optional()
  .describe(
    "Which Sui network to run this call against: 'mainnet' (default), 'testnet', or " +
      "'devnet'. Set this per-call — different tool calls in the same session can target " +
      "different networks (e.g. to compare a value on testnet against mainnet).",
  );

/**
 * Does `value` look like a Zod raw shape (the schema arg to `server.tool`)?
 * Every value in a raw shape is a Zod type (has `safeParse`); an annotations
 * object's values are booleans/strings, so it won't match. An empty object is
 * treated as a (paramless) schema.
 */
function isZodRawShape(value: unknown): value is z.ZodRawShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => !!v && typeof (v as { safeParse?: unknown }).safeParse === "function",
  );
}

/**
 * Wrap an McpServer so every `server.tool(...)` registration transparently:
 *   1. gains an optional `network` argument in its input schema, and
 *   2. runs its handler inside {@link runWithNetwork}, so the shared `sui` /
 *      `archive` / `gqlQuery` clients resolve to that call's network.
 *
 * This keeps per-call network selection in ONE place instead of threading a
 * parameter through all ~40 tools. Handlers are untouched — they ignore the
 * extra `network` key and read clients as before.
 */
export function withNetworkParam(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "tool") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => registerToolWithNetwork(target, args);
    },
  });
}

function registerToolWithNetwork(server: McpServer, args: unknown[]): unknown {
  const handler = args[args.length - 1];
  const tool = server.tool.bind(server) as (...a: unknown[]) => unknown;

  // Defensive: if the last arg isn't the handler, we don't understand this
  // call shape — register it untouched rather than corrupt it.
  if (typeof handler !== "function") {
    return tool(...args);
  }

  const head = args.slice(0, -1);
  const wrappedHandler = (toolArgs: unknown, extra: unknown) => {
    const requested = (toolArgs as { network?: unknown })?.network;
    const network: SuiNetwork = isSuiNetwork(requested) ? requested : DEFAULT_NETWORK;
    return runWithNetwork(network, () => handler(toolArgs, extra));
  };

  const schemaIdx = head.findIndex(isZodRawShape);
  if (schemaIdx >= 0) {
    const merged = { ...(head[schemaIdx] as z.ZodRawShape), network: networkParam };
    const newHead = [...head];
    newHead[schemaIdx] = merged;
    return tool(...newHead, wrappedHandler);
  }

  // Paramless tool (no schema arg): add one so `network` is still accepted.
  return tool(...head, { network: networkParam }, wrappedHandler);
}
