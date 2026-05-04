import { z } from "zod";
import { MVR_URL, moveRegistryUrl } from "../config.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function requireMvr(): string | null {
  return MVR_URL;
}

async function mvrFetch(path: string, init?: RequestInit): Promise<unknown> {
  const base = requireMvr();
  if (!base) {
    throw new Error("Move Registry is not available on this network (devnet has no MVR endpoint).");
  }
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "message" in (body as object)
        ? (body as { message: unknown }).message
        : text || res.statusText;
    throw new Error(`MVR ${res.status}: ${msg}`);
  }
  return body;
}

export function registerMvrTools(server: McpServer) {
  server.tool(
    "mvr_resolve",
    "Resolve one or more Move Registry (MVR) names to their on-chain package IDs. Names use the form '@org/app' (latest version) or '@org/app/N' for a pinned version. Use this to translate human-readable package names like '@suins/core' or '@deepbook/core' into addresses for use with other tools.",
    {
      names: z
        .array(z.string())
        .min(1)
        .describe("One or more MVR names, e.g. ['@suins/core', '@deepbook/core/4']."),
    },
    async ({ names }) => {
      try {
        if (names.length === 1) {
          try {
            const data = (await mvrFetch(`/resolution/${names[0]}`)) as { package_id?: string };
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ resolution: { [names[0]]: { package_id: data?.package_id ?? null } } }, null, 2),
                },
              ],
            };
          } catch (e) {
            const msg = (e as Error).message;
            if (/^MVR 400:/.test(msg)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ resolution: { [names[0]]: { package_id: null } } }, null, 2),
                  },
                ],
              };
            }
            throw e;
          }
        }
        const data = (await mvrFetch("/resolution/bulk", {
          method: "POST",
          body: JSON.stringify({ names }),
        })) as { resolution: Record<string, { package_id: string | null }> };
        const resolution: Record<string, { package_id: string | null }> = {};
        for (const n of names) resolution[n] = data.resolution[n] ?? { package_id: null };
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ resolution }, null, 2) }],
        };
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );

  server.tool(
    "mvr_reverse_resolve",
    "Reverse-lookup MVR names from one or more package addresses. Useful for enriching raw addresses (e.g. from get_package or transaction decoders) with their canonical '@org/app' name. Returns null for addresses with no registered name.",
    {
      package_ids: z
        .array(z.string())
        .min(1)
        .describe("One or more package addresses (0x...)."),
    },
    async ({ package_ids }) => {
      try {
        if (package_ids.length === 1) {
          try {
            const data = (await mvrFetch(`/reverse-resolution/${package_ids[0]}`)) as { name?: string };
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { resolution: { [package_ids[0]]: { name: data?.name ?? null } } },
                    null,
                    2,
                  ),
                },
              ],
            };
          } catch {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ resolution: { [package_ids[0]]: { name: null } } }, null, 2),
                },
              ],
            };
          }
        }
        const data = (await mvrFetch("/reverse-resolution/bulk", {
          method: "POST",
          body: JSON.stringify({ package_ids }),
        })) as { resolution: Record<string, { name: string | null }> };
        const resolution: Record<string, { name: string | null }> = {};
        for (const id of package_ids) resolution[id] = data.resolution[id] ?? { name: null };
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ resolution }, null, 2) }],
        };
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );

  server.tool(
    "mvr_get_package_info",
    "Get the full Move Registry record for a single package name: metadata (description, homepage, icon), current version, on-chain package_address, the package_info object ID, and git source info (repo, branch, path) when registered.",
    {
      name: z
        .string()
        .describe("MVR name, e.g. '@suins/core'. Optionally version-pinned: '@suins/core/3'."),
    },
    async ({ name }) => {
      try {
        const data = (await mvrFetch(`/names/${name}`)) as Record<string, unknown>;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...data, registry_url: moveRegistryUrl(name) }, null, 2),
            },
          ],
        };
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );

  server.tool(
    "mvr_search",
    "Browse or search the Move Registry for packages. Searches name and description; returns one page (default 20 results) with a cursor for pagination. Pass `is_linked: true` to limit results to packages actually published on the current network.",
    {
      search: z
        .string()
        .optional()
        .describe("Substring to match against name or description. Omit to list all."),
      limit: z.number().int().min(1).max(50).optional().describe("Page size (default 20, max 50)."),
      cursor: z.string().optional().describe("Opaque cursor from a previous response's next_cursor."),
      is_linked: z
        .boolean()
        .optional()
        .describe("If true, only return packages with a published package on mainnet or testnet."),
    },
    async ({ search, limit, cursor, is_linked }) => {
      try {
        const params = new URLSearchParams();
        if (search) params.set("search", search);
        if (limit !== undefined) params.set("limit", String(limit));
        if (cursor) params.set("cursor", cursor);
        if (is_linked !== undefined) params.set("is_linked", String(is_linked));
        const qs = params.toString();
        const data = await mvrFetch(`/names${qs ? `?${qs}` : ""}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );

  server.tool(
    "mvr_resolve_struct",
    "Resolve fully-qualified Move struct names (e.g. '@suins/core::config::Config') to their canonical type tag using the type's defining-package address. No generics — for parameterized types include them as '<...>' and the registry will reject the request. Bulk-friendly.",
    {
      types: z
        .array(z.string())
        .min(1)
        .describe(
          "One or more struct paths, each '@org/app::module::Type'. Version-pinned names ('@org/app/N::module::Type') also accepted.",
        ),
    },
    async ({ types }) => {
      try {
        if (types.length === 1) {
          const data = (await mvrFetch(`/struct-definition/${types[0]}`)) as { type_tag?: string };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { resolution: { [types[0]]: { type_tag: data?.type_tag ?? null } } },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const data = (await mvrFetch("/struct-definition/bulk", {
          method: "POST",
          body: JSON.stringify({ types }),
        })) as { resolution: Record<string, { type_tag: string | null }> };
        const resolution: Record<string, { type_tag: string | null }> = {};
        for (const t of types) resolution[t] = data.resolution[t] ?? { type_tag: null };
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ resolution }, null, 2) }],
        };
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );
}
