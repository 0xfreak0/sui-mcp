import { z } from "zod";
import { numArg, addressArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import { clampPageSize } from "../utils/pagination.js";
import { protoValueToJson } from "../utils/proto.js";
import { formatOwner } from "../utils/formatting.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The Display standard, which is NOT in the object's own fields.
 *
 * `0x2::display::Display<T>` is a template registered per TYPE and rendered
 * per object, so an NFT's name and image usually live nowhere in its struct.
 * Verified on a mainnet collection: `contents.json` holds
 * `id, number, index, attributes, metadata_version` and nothing human-readable,
 * while the rendered Display carries creator, description and image_url. The
 * field-guessing below finds nothing there, so `get_object` promised display
 * metadata and returned none for exactly the objects it was written for.
 *
 * gRPC has no rendered Display, so this is GraphQL — the same exception, for
 * the same reason, as event field JSON.
 */
const DISPLAY_QUERY = `
  query($id: SuiAddress!) {
    object(address: $id) {
      asMoveObject { contents { display { output } } }
    }
  }
`;

async function fetchDisplayStandard(objectId: string): Promise<Record<string, string> | null> {
  try {
    const d = await gqlQuery<{
      object?: { asMoveObject?: { contents?: { display?: { output?: Record<string, unknown> | null } | null } | null } | null };
    }>(DISPLAY_QUERY, { id: objectId });
    const out = d.object?.asMoveObject?.contents?.display?.output;
    if (!out) return null;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === "string" && v) clean[k] = v;
    }
    return Object.keys(clean).length ? clean : null;
  } catch {
    // Supplementary. The object read already succeeded and is the answer.
    return null;
  }
}

function extractDisplay(content: unknown): Record<string, string | null> | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const c = content as Record<string, unknown>;
  const display: Record<string, string | null> = {};
  let hasAny = false;
  if (typeof c.name === "string") { display.name = c.name; hasAny = true; }
  if (typeof c.description === "string") { display.description = c.description; hasAny = true; }
  for (const field of ["image_url", "img_url", "url", "thumbnail"]) {
    if (typeof c[field] === "string" && !display.image_url) {
      display.image_url = c[field] as string;
      hasAny = true;
    }
  }
  if (typeof c.project_url === "string") { display.project_url = c.project_url; hasAny = true; }
  return hasAny ? display : null;
}

export function registerObjectTools(server: McpServer) {
  server.tool(
    "get_object",
    "Get a Sui object by its ID. Returns type, owner, version, content (JSON), and digest. Automatically extracts display metadata (name, description, image_url) for NFTs.",
    {
      object_id: addressArg().describe("The object ID (0x...)"),
      version: z.string().optional().describe("Specific version to fetch"),
    },
    async ({ object_id, version }) => {
      const readMask = {
        paths: [
          "object_id", "version", "digest", "object_type", "owner",
          "previous_transaction", "storage_rebate", "json", "balance",
        ],
      };
      const req = {
        objectId: object_id,
        version: version ? BigInt(version) : undefined,
        readMask,
      };
      // Only a versioned read is expected to hit pruned state; the latest
      // version of a live object being absent means it genuinely doesn't exist,
      // and asking the archive would just cost a round trip to learn the same.
      const res = await withArchiveFallback(
        (client) => client.ledgerService.getObject(req),
        (r) => !r.object && !!version,
      );
      const obj = res.object;
      const content = protoValueToJson(obj?.json);
      // The struct's own fields first, because they cost nothing. Only when
      // they carry nothing is the rendered Display worth a second request.
      let display: Record<string, string | null> | null = extractDisplay(content);
      let displaySource: "object_fields" | "display_standard" | undefined = display
        ? "object_fields"
        : undefined;
      if (!display && obj?.objectId) {
        const rendered = await fetchDisplayStandard(obj.objectId);
        if (rendered) {
          display = rendered;
          displaySource = "display_standard";
        }
      }

      const result: Record<string, unknown> = {
        object_id: obj?.objectId,
        version: obj?.version?.toString(),
        digest: obj?.digest,
        object_type: obj?.objectType,
        owner: formatOwner(obj?.owner),
        previous_transaction: obj?.previousTransaction,
        storage_rebate: obj?.storageRebate?.toString(),
        content,
        balance: obj?.balance?.toString(),
      };

      if (display) {
        result.display = display;
        result.display_source = displaySource;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "list_owned_objects",
    "List raw objects owned by a Sui address with optional type filter and pagination. For NFTs specifically, prefer list_nfts (resolves kiosk storage, extracts display metadata). For a wallet summary, prefer get_wallet_overview.",
    {
      owner: addressArg().optional().describe("Owner address (0x...). Required; `address` is accepted in its place."),
      address: addressArg().optional().describe("Alias for `owner`."),
      object_type: z
        .string()
        .optional()
        .describe("Filter by object type (e.g. 0x2::coin::Coin<0x2::sui::SUI>)"),
      limit: numArg().int().min(1).max(1000).optional().describe("Max results (default 50, max 1000)"),
      cursor: z.string().optional().describe("Pagination cursor from previous response"),
    },
    async ({ owner: ownerArg, address, object_type, limit, cursor }) => {
      const owner = ownerArg ?? address;
      if (!owner) return errorResult("Pass the wallet to list as `owner` (or `address`).");
      const res = await sui.listOwnedObjects({
        owner,
        type: object_type,
        limit: clampPageSize(limit),
        cursor: cursor ?? null,
      });
      const objects = res.objects.map((obj) => ({
        object_id: obj.objectId,
        version: obj.version,
        object_type: obj.type,
        digest: obj.digest,
        owner: formatOwnerSdk(obj.owner),
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { objects, next_cursor: res.cursor },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "list_dynamic_fields",
    "(Developer) List dynamic fields of a Sui object. Returns field names, types, and values. Useful for inspecting on-chain tables, kiosk contents, or other dynamic collections.",
    {
      parent_id: addressArg().describe("Parent object ID (0x...)"),
      limit: numArg().int().min(1).max(1000).optional().describe("Max results (default 50, max 1000)"),
      cursor: z.string().optional().describe("Pagination cursor from previous response"),
    },
    async ({ parent_id, limit, cursor }) => {
      const res = await sui.listDynamicFields({
        parentId: parent_id,
        limit: clampPageSize(limit),
        cursor: cursor ?? null,
      });
      const fields = res.dynamicFields.map((df) => ({
        field_id: df.fieldId,
        type: df.type,
        value_type: df.valueType,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                dynamic_fields: fields,
                has_next_page: res.hasNextPage,
                next_cursor: res.cursor,
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

function formatOwnerSdk(owner: import("@mysten/sui/client").SuiClientTypes.ObjectOwner): string {
  switch (owner.$kind) {
    case "AddressOwner":
      return `address:${owner.AddressOwner}`;
    case "ObjectOwner":
      return `object:${owner.ObjectOwner}`;
    case "Shared":
      return `shared(initial_version:${owner.Shared.initialSharedVersion})`;
    case "Immutable":
      return "immutable";
    case "ConsensusAddressOwner":
      return `consensus:${owner.ConsensusAddressOwner}`;
    default:
      return "unknown";
  }
}
