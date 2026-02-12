import { z } from "zod";
import { sui, archive } from "../clients/grpc.js";
import { clampPageSize } from "../utils/pagination.js";
import { protoValueToJson } from "../utils/proto.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerObjectTools(server: McpServer) {
  server.tool(
    "get_object",
    "Get a Sui object by its ID. Returns type, owner, version, content (JSON), and digest.",
    {
      object_id: z.string().describe("The object ID (0x...)"),
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
      let res;
      try {
        ({ response: res } = await sui.ledgerService.getObject(req));
      } catch {
        ({ response: res } = await archive.ledgerService.getObject(req));
      }
      // Fall back to archive if fullnode returned empty data for a versioned request
      if (!res.object && version) {
        try {
          ({ response: res } = await archive.ledgerService.getObject(req));
        } catch { /* keep fullnode result */ }
      }
      const obj = res.object;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                object_id: obj?.objectId,
                version: obj?.version?.toString(),
                digest: obj?.digest,
                object_type: obj?.objectType,
                owner: formatOwner(obj?.owner),
                previous_transaction: obj?.previousTransaction,
                storage_rebate: obj?.storageRebate?.toString(),
                content: protoValueToJson(obj?.json),
                balance: obj?.balance?.toString(),
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
    "list_owned_objects",
    "List objects owned by a Sui address. Supports type filtering and pagination.",
    {
      owner: z.string().describe("Owner address (0x...)"),
      object_type: z
        .string()
        .optional()
        .describe("Filter by object type (e.g. 0x2::coin::Coin<0x2::sui::SUI>)"),
      limit: z.number().optional().describe("Max results (default 50, max 1000)"),
      cursor: z.string().optional().describe("Pagination cursor from previous response"),
    },
    async ({ owner, object_type, limit, cursor }) => {
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
    "List dynamic fields of a Sui object. Returns field names, types, and values.",
    {
      parent_id: z.string().describe("Parent object ID (0x...)"),
      limit: z.number().optional().describe("Max results (default 50, max 1000)"),
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

import { formatOwner } from "../utils/formatting.js";


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

