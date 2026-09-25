import { z } from "zod";
import { type SuiNetwork, DEFAULT_NETWORK, isSuiNetwork, runWithNetwork } from "../config.js";
import { sui } from "../clients/grpc.js";
import { cleanErrorMessage, describeError, errorResult, isNotFound } from "../utils/errors.js";
import { isAddressSchema, isSuinsName } from "./args.js";
import { toolPolicy, withStructuredContent } from "./tool-meta.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The `network` argument injected into every tool that reads the chain.
 * Optional so callers can omit it and get {@link DEFAULT_NETWORK}; explicit
 * per call so testnet and mainnet queries can coexist in one session. The
 * description is repeated in every tool's schema, so it stays one line.
 */
export const NETWORK_DESCRIPTION = "Network: 'mainnet' (default) | 'testnet' | 'devnet'";

const networkParam = z.enum(["mainnet", "testnet", "devnet"]).optional().describe(NETWORK_DESCRIPTION);

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

/** Does this field, under its optional/default/describe wrappers, take an array? */
function takesArray(schema: z.ZodTypeAny): boolean {
  let node: z.ZodTypeAny | undefined = schema;
  while (node) {
    const def = node._def as { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    if (def.typeName === z.ZodFirstPartyTypeKind.ZodArray) return true;
    node = def.innerType ?? def.schema;
  }
  return false;
}

/**
 * Accept the argument shapes a model sends for "unset" and "one of these".
 *
 * `null` means the caller is leaving the argument out: an optional field falls
 * back to its default and a required one reports "Required". Without this,
 * `limit: null` reached a number coercion as 0 and returned an empty page with
 * `has_next_page: false`, which reads as "this address never sent anything".
 *
 * A bare string where the field takes a list becomes a one-item list, so
 * `digests: "abc"` works the same as `digests: ["abc"]`.
 *
 * Both run as a preprocess on the field, so the generated JSON schema is the
 * field's own.
 */
function lenientField(schema: z.ZodTypeAny): z.ZodTypeAny {
  const array = takesArray(schema);
  return z.preprocess(
    (v) => (v === null ? undefined : array && typeof v === "string" ? [v] : v),
    schema,
  );
}

/** A SuiNS name the call resolved, reported back beside the result. */
interface ResolvedName {
  name: string;
  address: string;
}

const RESOLVED_NOTE =
  "SuiNS names were resolved to the addresses above on this network, now. A name is a purchasable handle " +
  "that its owner can repoint at any time, so the address is what this result describes, not the name, " +
  "and the name is not evidence of identity.";

/** Resolve one SuiNS name on the active network, or explain why it cannot be. */
async function resolveSuinsName(name: string, network: SuiNetwork): Promise<string> {
  let target: string | undefined;
  try {
    const { response } = await sui.nameService.lookupName({ name });
    target = response.record?.targetAddress;
  } catch (err) {
    if (!isNotFound(err)) throw new Error(`Could not resolve ${name}: ${describeError(err, network)}`);
  }
  if (!target) {
    throw new Error(`${name} is not a registered SuiNS name with a target address on ${network}.`);
  }
  return target;
}

/**
 * Replace every SuiNS name in the address fields of `args` with the address
 * it points to. Returns the new args and the names resolved.
 */
async function resolveAddressNames(
  args: Record<string, unknown>,
  addressFields: string[],
  network: SuiNetwork,
): Promise<{ args: Record<string, unknown>; resolved: ResolvedName[] }> {
  const resolved: ResolvedName[] = [];
  const cache = new Map<string, string>();
  const resolveOne = async (value: unknown): Promise<unknown> => {
    if (typeof value !== "string" || !isSuinsName(value)) return value;
    let address = cache.get(value);
    if (!address) {
      address = await resolveSuinsName(value, network);
      cache.set(value, address);
      resolved.push({ name: value, address });
    }
    return address;
  };

  const out = { ...args };
  for (const field of addressFields) {
    const value = out[field];
    out[field] = Array.isArray(value) ? await Promise.all(value.map(resolveOne)) : await resolveOne(value);
  }
  return { args: out, resolved };
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Report resolved SuiNS names in the result: as a `resolved_from` field when
 * the tool answered with a JSON object, otherwise as a trailing text item.
 */
function reportResolved(result: ToolResult, resolved: ResolvedName[]): ToolResult {
  if (resolved.length === 0 || !result?.content) return result;
  const resolvedFrom = Object.fromEntries(resolved.map((r) => [r.name, r.address]));
  const [first, ...rest] = result.content;
  if (first?.type === "text" && first.text) {
    try {
      const parsed: unknown = JSON.parse(first.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const text = JSON.stringify(
          { ...parsed, resolved_from: resolvedFrom, resolved_from_note: RESOLVED_NOTE },
          null,
          first.text.includes("\n") ? 2 : undefined,
        );
        return { ...result, content: [{ ...first, text }, ...rest] };
      }
    } catch {
      // Not JSON: fall through to a separate item.
    }
  }
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text", text: JSON.stringify({ resolved_from: resolvedFrom, resolved_from_note: RESOLVED_NOTE }) },
    ],
  };
}

/**
 * Clean the message of an error a tool returned itself. Tools pass the raw
 * `err.message` into `errorResult`, so the same encoding and dumps reach the
 * reader by that route too.
 */
function cleanReturnedError(result: ToolResult, network: SuiNetwork): ToolResult {
  const first = result?.content?.[0];
  if (!result?.isError || first?.type !== "text" || !first.text) return result;
  try {
    const parsed = JSON.parse(first.text) as { error?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.error !== "string") return result;
    const error = cleanErrorMessage(parsed.error, network);
    if (error === parsed.error) return result;
    return {
      ...result,
      content: [{ ...first, text: JSON.stringify({ ...parsed, error }) }, ...result.content!.slice(1)],
    };
  } catch {
    return result;
  }
}

/**
 * Wrap an McpServer so every `server.tool(...)` registration transparently:
 *   1. gains an optional `network` argument in its input schema, unless the
 *      tool never reads the chain (`network: false` in `tool-meta.ts`),
 *   2. treats `null` arguments as absent and a bare string as a one-item list,
 *   3. resolves SuiNS names in address arguments (see `addressArg`) on the
 *      call's network, and reports them back as `resolved_from`,
 *   4. runs its handler inside {@link runWithNetwork}, so the shared `sui` /
 *      `archive` / `gqlQuery` clients resolve to that call's network,
 *   5. turns a thrown error into a one-line `errorResult`, rather than the
 *      SDK's raw `err.message`, and
 *   6. registers with its title, annotations, `_meta` and, where opted in,
 *      `structuredContent`, from {@link toolPolicy}.
 *
 * This keeps per-call network selection and tool metadata in ONE place
 * instead of threading them through every tool. Handlers are untouched: they
 * ignore the extra `network` key and read clients as before.
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
  const name = args[0];

  // Defensive: if the call is not `tool(name, …, handler)`, we don't
  // understand its shape — register it untouched rather than corrupt it.
  if (typeof handler !== "function" || typeof name !== "string") {
    return (server.tool.bind(server) as (...a: unknown[]) => unknown)(...args);
  }

  const head = args.slice(1, -1);
  const description = typeof head[0] === "string" ? head[0] : undefined;
  const schemaIdx = head.findIndex(isZodRawShape);
  const shape = schemaIdx >= 0 ? (head[schemaIdx] as z.ZodRawShape) : {};
  // Annotations a tool file passes itself win over the table.
  const ownAnnotations = head.find(
    (a, i) => i !== schemaIdx && !!a && typeof a === "object" && !Array.isArray(a),
  ) as ToolAnnotations | undefined;
  const addressFields = Object.keys(shape).filter((k) => isAddressSchema(shape[k]) !== null);
  const policy = toolPolicy(name);

  const wrappedHandler = (toolArgs: unknown, extra: unknown) => {
    const requested =
      policy.network && toolArgs && typeof toolArgs === "object" && "network" in toolArgs
        ? toolArgs.network
        : undefined;
    const network: SuiNetwork = isSuiNetwork(requested) ? requested : DEFAULT_NETWORK;
    return runWithNetwork(network, async () => {
      try {
        let callArgs = toolArgs;
        let resolved: ResolvedName[] = [];
        if (addressFields.length > 0 && toolArgs && typeof toolArgs === "object") {
          ({ args: callArgs, resolved } = await resolveAddressNames(
            toolArgs as Record<string, unknown>,
            addressFields,
            network,
          ));
        }
        const result = (await (handler as (a: unknown, e: unknown) => unknown)(callArgs, extra)) as ToolResult;
        const cleaned = reportResolved(cleanReturnedError(result, network), resolved);
        return policy.structured ? withStructuredContent(cleaned) : cleaned;
      } catch (err) {
        return errorResult(describeError(err, network));
      }
    });
  };

  const inputSchema: z.ZodRawShape = Object.fromEntries(
    Object.entries(shape).map(([k, v]) => [k, lenientField(v)]),
  );
  if (policy.network) inputSchema.network = lenientField(networkParam);

  return server.registerTool(
    name,
    {
      title: policy.title,
      ...(description !== undefined ? { description } : {}),
      inputSchema,
      annotations: { ...policy.annotations, ...ownAnnotations },
      ...(policy.meta ? { _meta: policy.meta } : {}),
    },
    wrappedHandler as Parameters<McpServer["registerTool"]>[2],
  );
}
