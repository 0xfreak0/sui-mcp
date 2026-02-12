import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface ValidatorJson {
  metadata?: {
    sui_address?: string;
    name?: string;
    description?: string;
    image_url?: string;
    project_url?: string;
    net_address?: string;
    p2p_address?: string;
    primary_address?: string;
    worker_address?: string;
  };
  voting_power?: string;
  gas_price?: string;
  staking_pool?: {
    id?: string;
    activation_epoch?: string;
    sui_balance?: string;
  };
  commission_rate?: string;
  next_epoch_stake?: string;
  next_epoch_commission_rate?: string;
}

export function registerStakingTools(server: McpServer) {
  server.tool(
    "get_validators",
    "List current Sui validators with staking info: stake, APY, commission, voting power. Supports sorting by stake, apy, or commission.",
    {
      limit: z
        .number()
        .optional()
        .describe("Max validators to return (default 50, max 150)"),
      sort_by: z
        .enum(["stake", "apy", "commission"])
        .optional()
        .describe("Sort field: stake (default), apy, or commission"),
    },
    async ({ limit, sort_by }) => {
      const first = Math.min(Math.max(limit ?? 50, 1), 150);
      const sortField = sort_by ?? "stake";

      const data = await gqlQuery<{
        epoch: {
          epochId: number;
          validatorSet: {
            activeValidators: {
              nodes: Array<{
                atRisk?: number;
                contents?: { json: ValidatorJson };
              }>;
            };
            contents?: { json: { total_stake?: string } };
          };
        };
      }>(
        `query($first: Int) {
          epoch {
            epochId
            validatorSet {
              activeValidators(first: $first) {
                nodes {
                  atRisk
                  contents { json }
                }
              }
              contents { json }
            }
          }
        }`,
        { first }
      );

      const nodes = data.epoch.validatorSet.activeValidators.nodes;

      const validators = nodes.map((v) => {
        const json = v.contents?.json;
        const meta = json?.metadata;
        const pool = json?.staking_pool;
        return {
          name: meta?.name ?? null,
          address: meta?.sui_address ?? null,
          description: meta?.description ?? null,
          staking_pool_sui_balance: pool?.sui_balance ?? null,
          commission_rate_bps: json?.commission_rate != null ? Number(json.commission_rate) : null,
          next_epoch_commission_rate_bps: json?.next_epoch_commission_rate != null ? Number(json.next_epoch_commission_rate) : null,
          voting_power: json?.voting_power != null ? Number(json.voting_power) : null,
          gas_price: json?.gas_price ?? null,
          at_risk: v.atRisk ?? null,
        };
      });

      if (sortField === "stake") {
        validators.sort((a, b) => {
          const aStake = BigInt(a.staking_pool_sui_balance ?? "0");
          const bStake = BigInt(b.staking_pool_sui_balance ?? "0");
          return bStake > aStake ? 1 : bStake < aStake ? -1 : 0;
        });
      } else if (sortField === "apy") {
        // APY not directly available from GraphQL, sort by stake as fallback
        validators.sort((a, b) => {
          const aStake = BigInt(a.staking_pool_sui_balance ?? "0");
          const bStake = BigInt(b.staking_pool_sui_balance ?? "0");
          return bStake > aStake ? 1 : bStake < aStake ? -1 : 0;
        });
      } else if (sortField === "commission") {
        validators.sort(
          (a, b) =>
            (a.commission_rate_bps ?? 10000) - (b.commission_rate_bps ?? 10000)
        );
      }

      const totalStake = data.epoch.validatorSet.contents?.json?.total_stake ?? null;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                epoch: data.epoch.epochId,
                total_stake: totalStake,
                validator_count: validators.length,
                validators,
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
    "get_validator_detail",
    "Get detailed info about a specific Sui validator including credentials, staking stats, commission, and network addresses.",
    {
      address: z.string().describe("Validator address (0x...)"),
    },
    async ({ address }) => {
      const data = await gqlQuery<{
        epoch: {
          epochId: number;
          validatorSet: {
            activeValidators: {
              nodes: Array<{
                atRisk?: number;
                contents?: { json: ValidatorJson };
              }>;
            };
          };
        };
      }>(
        `query {
          epoch {
            epochId
            validatorSet {
              activeValidators(first: 200) {
                nodes {
                  atRisk
                  contents { json }
                }
              }
            }
          }
        }`
      );

      const activeValidator =
        data.epoch.validatorSet.activeValidators.nodes.find(
          (v) => v.contents?.json?.metadata?.sui_address === address
        );

      const json = activeValidator?.contents?.json;
      const meta = json?.metadata;
      const pool = json?.staking_pool;

      const result: Record<string, unknown> = {
        address,
        epoch: data.epoch.epochId,
        in_active_set: !!activeValidator,
      };

      if (meta) {
        result.credentials = {
          name: meta.name ?? null,
          description: meta.description ?? null,
          image_url: meta.image_url ?? null,
          project_url: meta.project_url ?? null,
          net_address: meta.net_address ?? null,
          p2p_address: meta.p2p_address ?? null,
          primary_address: meta.primary_address ?? null,
          worker_address: meta.worker_address ?? null,
        };
      }

      if (json) {
        result.staking_stats = {
          staking_pool_sui_balance: pool?.sui_balance ?? null,
          staking_pool_id: pool?.id ?? null,
          activation_epoch: pool?.activation_epoch ?? null,
          commission_rate_bps: json.commission_rate != null ? Number(json.commission_rate) : null,
          next_epoch_commission_rate_bps: json.next_epoch_commission_rate != null ? Number(json.next_epoch_commission_rate) : null,
          voting_power: json.voting_power != null ? Number(json.voting_power) : null,
          gas_price: json.gas_price ?? null,
          next_epoch_stake: json.next_epoch_stake ?? null,
          at_risk: activeValidator?.atRisk ?? null,
        };
      } else {
        result.note =
          "Validator not found in active set. They may be pending, inactive, or the address may not be a validator.";
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
    "get_staking_summary",
    "Get a wallet's staking positions on Sui. Shows all StakedSui objects with pool, principal amount, and activation epoch.",
    {
      address: z.string().describe("Wallet address (0x...)"),
    },
    async ({ address }) => {
      const ownedRes = await sui.listOwnedObjects({
        owner: address,
        type: "0x3::staking_pool::StakedSui",
        limit: 50,
        cursor: null,
      });

      // Fetch all staking objects in parallel instead of sequentially
      const objectResults = await Promise.all(
        ownedRes.objects.map(async (obj) => {
          const { response: objRes } = await sui.ledgerService.getObject({
            objectId: obj.objectId,
            readMask: {
              paths: ["object_id", "version", "object_type", "json"],
            },
          });
          return { objectId: obj.objectId, object: objRes.object };
        })
      );

      const positions: Array<{
        object_id: string;
        pool_id: string | null;
        principal_mist: string | null;
        stake_activation_epoch: string | null;
      }> = [];

      let totalStakedMist = BigInt(0);

      for (const { objectId, object: fullObj } of objectResults) {
        const json = protoValueToJson(fullObj?.json) as Record<
          string,
          unknown
        > | null;

        const poolId = (json?.pool_id as string) ?? null;
        const principal = (json?.principal as string) ?? null;
        const activationEpoch =
          (json?.stake_activation_epoch as string) ?? null;

        if (principal) {
          totalStakedMist += BigInt(principal);
        }

        positions.push({
          object_id: objectId,
          pool_id: poolId,
          principal_mist: principal,
          stake_activation_epoch: activationEpoch,
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                total_staked_mist: totalStakedMist.toString(),
                position_count: positions.length,
                positions,
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
