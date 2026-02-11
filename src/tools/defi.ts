import { z } from "zod";
import { sui } from "../clients/grpc.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const POSITION_TYPES = {
  suilend: "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf::obligation::Obligation",
  cetus_lp: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position",
  navi: "0x834a86970ae93a73faf4fff16ae40bdb72b91c47be585fff19a2af60a19ddca3::storage::Obligation",
  scallop: "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf::obligation::Obligation",
  staked_sui: "0x3::staking_pool::StakedSui",
} as const;

type ProtocolName = keyof typeof POSITION_TYPES;

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

const READ_MASK = {
  paths: ["object_id", "version", "digest", "object_type", "owner", "json"],
};

interface PositionEntry {
  object_id: string;
  type: string;
  version?: string;
  content: unknown;
}

async function fetchPositions(
  address: string,
  protocol: ProtocolName,
): Promise<{ protocol: ProtocolName; positions: PositionEntry[]; error?: string }> {
  try {
    const listResult = await sui.listOwnedObjects({
      owner: address,
      type: POSITION_TYPES[protocol],
      limit: 50,
      cursor: null,
    });

    if (listResult.objects.length === 0) {
      return { protocol, positions: [] };
    }

    const positions = await Promise.all(
      listResult.objects.map(async (obj): Promise<PositionEntry> => {
        try {
          const { response } = await sui.ledgerService.getObject({
            objectId: obj.objectId,
            readMask: READ_MASK,
          });
          const full = response.object;
          return {
            object_id: obj.objectId,
            type: full?.objectType ?? obj.type ?? POSITION_TYPES[protocol],
            version: full?.version?.toString() ?? obj.version?.toString(),
            content: protoValueToJson(full?.json),
          };
        } catch {
          return {
            object_id: obj.objectId,
            type: obj.type ?? POSITION_TYPES[protocol],
            version: obj.version?.toString(),
            content: null,
          };
        }
      }),
    );

    return { protocol, positions };
  } catch (err) {
    return {
      protocol,
      positions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerDefiTools(server: McpServer) {
  server.tool(
    "get_defi_positions",
    "Find DeFi positions owned by a Sui wallet across major protocols: Suilend, Cetus LP, NAVI, Scallop, and staked SUI. Returns position objects with their on-chain content.",
    {
      address: z.string().describe("Wallet address (0x...)"),
    },
    async ({ address }) => {
      const protocols: ProtocolName[] = [
        "suilend", "cetus_lp", "navi", "scallop", "staked_sui",
      ];

      const results = await Promise.allSettled(
        protocols.map((p) => fetchPositions(address, p)),
      );

      const positions: Record<string, PositionEntry[]> = {};
      const errors: Record<string, string> = {};
      let totalPositions = 0;

      for (const result of results) {
        if (result.status === "fulfilled") {
          const { protocol, positions: pos, error } = result.value;
          positions[protocol] = pos;
          totalPositions += pos.length;
          if (error) errors[protocol] = error;
        }
      }

      const output: Record<string, unknown> = {
        address,
        positions,
        total_positions: totalPositions,
      };
      if (Object.keys(errors).length > 0) {
        output.errors = errors;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(output, null, 2),
        }],
      };
    },
  );
}
