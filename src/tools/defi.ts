import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { protoValueToJson } from "../utils/proto.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const POSITION_TYPES = {
  suilend: "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf::obligation::Obligation",
  cetus_lp: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position",
  navi: "0x834a86970ae93a73faf4fff16ae40bdb72b91c47be585fff19a2af60a19ddca3::storage::Obligation",
  scallop: "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf::obligation::Obligation",
  staked_sui: "0x3::staking_pool::StakedSui",
  bluefin: "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::position::Position",
  bucket: "0x665188033384920a5bb5dcfb2ef21f54b4568d08b431718b97e02e5c184b92cc::account::Account",
} as const;

type ProtocolName = keyof typeof POSITION_TYPES;

const READ_MASK = {
  paths: ["object_id", "version", "digest", "object_type", "owner", "json"],
};

// ---------------------------------------------------------------------------
// Per-protocol extractors: pull actionable fields from raw on-chain JSON
// ---------------------------------------------------------------------------

type RawJson = Record<string, unknown>;

function extractSuilend(json: RawJson): Record<string, unknown> {
  // Obligation has deposits, borrows, and deposit/borrow values
  const deposits = json.deposits as unknown[] | undefined;
  const borrows = json.borrows as unknown[] | undefined;
  return {
    deposit_count: Array.isArray(deposits) ? deposits.length : 0,
    borrow_count: Array.isArray(borrows) ? borrows.length : 0,
    deposits: Array.isArray(deposits)
      ? deposits.map((d: unknown) => {
          const dep = d as RawJson;
          return {
            coin_type: dep.coin_type ?? dep.deposit_reserve,
            deposited_ctoken_amount: dep.deposited_ctoken_amount,
            market_value_usd: dep.market_value,
          };
        })
      : [],
    borrows: Array.isArray(borrows)
      ? borrows.map((b: unknown) => {
          const bor = b as RawJson;
          return {
            coin_type: bor.coin_type ?? bor.borrow_reserve,
            borrowed_amount: bor.borrowed_amount,
            market_value_usd: bor.market_value,
          };
        })
      : [],
    weighted_borrowed_value_usd: json.weighted_borrowed_value,
    allowed_borrow_value_usd: json.allowed_borrow_value,
    unhealthy_borrow_value_usd: json.unhealthy_borrow_value,
  };
}

function extractNavi(json: RawJson): Record<string, unknown> {
  // NAVI Obligation: similar structure to Suilend
  const supplies = json.supplies as unknown[] | undefined;
  const borrows = json.borrows as unknown[] | undefined;
  return {
    supply_count: Array.isArray(supplies) ? supplies.length : 0,
    borrow_count: Array.isArray(borrows) ? borrows.length : 0,
    supplies: Array.isArray(supplies)
      ? supplies.map((s: unknown) => {
          const sup = s as RawJson;
          return {
            pool_id: sup.pool_id ?? sup.asset,
            amount: sup.amount ?? sup.balance,
          };
        })
      : [],
    borrows: Array.isArray(borrows)
      ? borrows.map((b: unknown) => {
          const bor = b as RawJson;
          return {
            pool_id: bor.pool_id ?? bor.asset,
            amount: bor.amount ?? bor.balance,
          };
        })
      : [],
  };
}

function extractScallop(json: RawJson): Record<string, unknown> {
  // Scallop Obligation: collaterals and debts
  const collaterals = json.collaterals as unknown[] | undefined;
  const debts = json.debts as unknown[] | undefined;
  return {
    collateral_count: Array.isArray(collaterals) ? collaterals.length : 0,
    debt_count: Array.isArray(debts) ? debts.length : 0,
    collaterals: Array.isArray(collaterals)
      ? collaterals.map((c: unknown) => {
          const col = c as RawJson;
          return { asset: col.type ?? col.asset, amount: col.amount };
        })
      : [],
    debts: Array.isArray(debts)
      ? debts.map((d: unknown) => {
          const debt = d as RawJson;
          return { asset: debt.type ?? debt.asset, amount: debt.amount };
        })
      : [],
    lock_key: json.lock_key,
  };
}

function extractCetusLp(json: RawJson): Record<string, unknown> {
  // Cetus LP Position: pool, liquidity, ticks, fee owed
  return {
    pool: json.pool,
    liquidity: json.liquidity,
    tick_lower_index: json.tick_lower_index,
    tick_upper_index: json.tick_upper_index,
    fee_owed_a: json.fee_owed_a,
    fee_owed_b: json.fee_owed_b,
    reward_amount_owed_0: json.reward_amount_owed_0,
    reward_amount_owed_1: json.reward_amount_owed_1,
    reward_amount_owed_2: json.reward_amount_owed_2,
  };
}

function extractBluefin(json: RawJson): Record<string, unknown> {
  return {
    pool: json.pool,
    liquidity: json.liquidity,
    tick_lower_index: json.tick_lower_index,
    tick_upper_index: json.tick_upper_index,
    fee_growth_inside_a: json.fee_growth_inside_a,
    fee_growth_inside_b: json.fee_growth_inside_b,
  };
}

function extractStakedSui(json: RawJson): Record<string, unknown> {
  return {
    pool_id: json.pool_id,
    principal: json.principal,
    stake_activation_epoch: json.stake_activation_epoch,
  };
}

function extractBucket(json: RawJson): Record<string, unknown> {
  return {
    collateral_amount: json.collateral_amount,
    buck_amount: json.buck_amount,
  };
}

const EXTRACTORS: Record<ProtocolName, (json: RawJson) => Record<string, unknown>> = {
  suilend: extractSuilend,
  navi: extractNavi,
  scallop: extractScallop,
  cetus_lp: extractCetusLp,
  bluefin: extractBluefin,
  staked_sui: extractStakedSui,
  bucket: extractBucket,
};

// ---------------------------------------------------------------------------
// Position entry (now with extracted summary)
// ---------------------------------------------------------------------------

interface PositionEntry {
  object_id: string;
  type: string;
  version?: string;
  summary: Record<string, unknown>;
}

async function fetchPositions(
  address: string,
  protocol: ProtocolName,
): Promise<{ protocol: ProtocolName; positions: PositionEntry[]; truncated: boolean; error?: string }> {
  try {
    const listResult = await sui.listOwnedObjects({
      owner: address,
      type: POSITION_TYPES[protocol],
      limit: 50,
      cursor: null,
    });

    if (listResult.objects.length === 0) {
      return { protocol, positions: [], truncated: false };
    }

    const truncated = listResult.hasNextPage ?? false;
    const extractor = EXTRACTORS[protocol];

    const positions = await Promise.all(
      listResult.objects.map(async (obj): Promise<PositionEntry> => {
        try {
          const { response } = await sui.ledgerService.getObject({
            objectId: obj.objectId,
            readMask: READ_MASK,
          });
          const full = response.object;
          const rawJson = protoValueToJson(full?.json) as RawJson | null;
          return {
            object_id: obj.objectId,
            type: full?.objectType ?? obj.type ?? POSITION_TYPES[protocol],
            version: full?.version?.toString() ?? obj.version?.toString(),
            summary: rawJson ? extractor(rawJson) : {},
          };
        } catch {
          return {
            object_id: obj.objectId,
            type: obj.type ?? POSITION_TYPES[protocol],
            version: obj.version?.toString(),
            summary: {},
          };
        }
      }),
    );

    return { protocol, positions, truncated };
  } catch (err) {
    return {
      protocol,
      positions: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerDefiTools(server: McpServer) {
  server.tool(
    "get_defi_positions",
    "Find DeFi positions owned by a Sui wallet across major protocols: Suilend, Cetus LP, NAVI, Scallop, Bluefin, Bucket, and staked SUI. Returns extracted position summaries (deposits, borrows, liquidity, fees) instead of raw on-chain data.",
    {
      address: z.string().describe("Wallet address (0x...)"),
    },
    async ({ address }) => {
      const protocols: ProtocolName[] = [
        "suilend", "cetus_lp", "navi", "scallop", "staked_sui",
        "bluefin", "bucket",
      ];

      const results = await Promise.allSettled(
        protocols.map((p) => fetchPositions(address, p)),
      );

      const positions: Record<string, PositionEntry[]> = {};
      const errors: Record<string, string> = {};
      const truncatedProtocols: string[] = [];
      let totalPositions = 0;

      for (const result of results) {
        if (result.status === "fulfilled") {
          const { protocol, positions: pos, truncated, error } = result.value;
          if (pos.length > 0) {
            positions[protocol] = pos;
          }
          totalPositions += pos.length;
          if (truncated) truncatedProtocols.push(protocol);
          if (error) errors[protocol] = error;
        }
      }

      const output: Record<string, unknown> = {
        address,
        total_positions: totalPositions,
        positions,
      };
      if (truncatedProtocols.length > 0) {
        output.truncated_protocols = truncatedProtocols;
      }
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
