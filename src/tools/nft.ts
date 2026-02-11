import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { formatOwner } from "../utils/formatting.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function protoValueToJson(val?: any): unknown {
  if (!val) return undefined;
  const kind = val.kind;
  if (!kind) return null;
  switch (kind.oneofKind) {
    case "nullValue":
      return null;
    case "numberValue":
      return kind.numberValue;
    case "stringValue":
      return kind.stringValue;
    case "boolValue":
      return kind.boolValue;
    case "structValue": {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(kind.structValue.fields)) {
        obj[k] = protoValueToJson(v);
      }
      return obj;
    }
    case "listValue":
      return kind.listValue.values.map(protoValueToJson);
    default:
      return null;
  }
}

function extractDisplay(content: unknown): Record<string, string | null> {
  const display: Record<string, string | null> = {
    name: null,
    description: null,
    image_url: null,
    project_url: null,
  };
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const c = content as Record<string, unknown>;
    if (typeof c.name === "string") display.name = c.name;
    if (typeof c.description === "string") display.description = c.description;
    // Check multiple possible image fields
    for (const field of ["image_url", "img_url", "url", "thumbnail"]) {
      if (typeof c[field] === "string" && !display.image_url) {
        display.image_url = c[field] as string;
      }
    }
    if (typeof c.project_url === "string") display.project_url = c.project_url;
  }
  return display;
}

export function registerNftTools(server: McpServer) {
  server.tool(
    "list_nfts",
    "List NFTs (non-coin objects) owned by a wallet address. Filters out coin objects and extracts display metadata like name, description, and image URL.",
    {
      address: z.string().describe("Owner wallet address (0x...)"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Max NFTs to return (default 50, max 200)"),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from previous response"),
    },
    async ({ address, limit, cursor }) => {
      const effectiveLimit = Math.min(Math.max(limit ?? 50, 1), 200);

      const res = await sui.listOwnedObjects({
        owner: address,
        limit: effectiveLimit,
        cursor: cursor ?? null,
      });

      // Filter out coin objects
      const nonCoinObjects = res.objects.filter(
        (obj) => !obj.type?.includes("0x2::coin::Coin<")
      );

      // Fetch full details for each non-coin object (up to effectiveLimit)
      const toFetch = nonCoinObjects.slice(0, effectiveLimit);

      const nfts = await Promise.all(
        toFetch.map(async (obj) => {
          try {
            const { response } = await sui.ledgerService.getObject({
              objectId: obj.objectId,
              readMask: {
                paths: [
                  "object_id",
                  "version",
                  "digest",
                  "object_type",
                  "json",
                ],
              },
            });
            const full = response.object;
            const content = protoValueToJson(full?.json);
            const display = extractDisplay(content);

            return {
              object_id: full?.objectId ?? obj.objectId,
              type: full?.objectType ?? obj.type ?? "unknown",
              name: display.name,
              description: display.description,
              image_url: display.image_url,
              content,
            };
          } catch {
            return {
              object_id: obj.objectId,
              type: obj.type ?? "unknown",
              name: null,
              description: null,
              image_url: null,
              content: null,
            };
          }
        })
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                nfts,
                total_found: nfts.length,
                next_cursor: res.cursor ?? null,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_nft_details",
    "Get full details of a specific NFT object including display metadata, owner, and raw content.",
    {
      object_id: z.string().describe("The NFT object ID (0x...)"),
    },
    async ({ object_id }) => {
      const { response } = await sui.ledgerService.getObject({
        objectId: object_id,
        readMask: {
          paths: [
            "object_id",
            "version",
            "digest",
            "object_type",
            "owner",
            "previous_transaction",
            "storage_rebate",
            "json",
          ],
        },
      });

      const obj = response.object;
      const content = protoValueToJson(obj?.json);
      const display = extractDisplay(content);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                object_id: obj?.objectId,
                type: obj?.objectType,
                version: obj?.version?.toString(),
                digest: obj?.digest,
                owner: formatOwner(obj?.owner),
                previous_transaction: obj?.previousTransaction,
                display,
                content,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
