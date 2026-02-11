import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
                name: string;
                description?: string;
                address: { address: string };
                stakingPoolSuiBalance?: string;
                commissionRate?: number;
                nextEpochCommissionRate?: number;
                votingPower?: number;
                atRisk?: number;
                apy?: number;
                stakingPoolActivationEpoch?: number;
              }>;
            };
            totalStake?: string;
          };
        };
      }>(
        `query($first: Int) {
          epoch {
            epochId
            validatorSet {
              activeValidators(first: $first) {
                nodes {
                  name
                  description
                  address { address }
                  stakingPoolSuiBalance
                  commissionRate
                  nextEpochCommissionRate
                  votingPower
                  atRisk
                  apy
                  stakingPoolActivationEpoch
                }
              }
              totalStake
            }
          }
        }`,
        { first }
      );

      const nodes = data.epoch.validatorSet.activeValidators.nodes;

      const validators = nodes.map((v) => ({
        name: v.name,
        address: v.address.address,
        description: v.description ?? null,
        staking_pool_sui_balance: v.stakingPoolSuiBalance ?? null,
        commission_rate_bps: v.commissionRate ?? null,
        next_epoch_commission_rate_bps: v.nextEpochCommissionRate ?? null,
        voting_power: v.votingPower ?? null,
        apy: v.apy ?? null,
        at_risk: v.atRisk ?? null,
      }));

      if (sortField === "stake") {
        validators.sort((a, b) => {
          const aStake = BigInt(a.staking_pool_sui_balance ?? "0");
          const bStake = BigInt(b.staking_pool_sui_balance ?? "0");
          return bStake > aStake ? 1 : bStake < aStake ? -1 : 0;
        });
      } else if (sortField === "apy") {
        validators.sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0));
      } else if (sortField === "commission") {
        validators.sort(
          (a, b) =>
            (a.commission_rate_bps ?? 10000) - (b.commission_rate_bps ?? 10000)
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                epoch: data.epoch.epochId,
                total_stake: data.epoch.validatorSet.totalStake ?? null,
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
    "Get detailed info about a specific Sui validator including credentials, staking stats, commission, APY, and network addresses.",
    {
      address: z.string().describe("Validator address (0x...)"),
    },
    async ({ address }) => {
      const data = await gqlQuery<{
        address: {
          address: string;
          validatorCredentials?: {
            name?: string;
            description?: string;
            imageUrl?: string;
            projectUrl?: string;
            netAddress?: string;
            p2pAddress?: string;
            primaryAddress?: string;
            workerAddress?: string;
            protocolPubKey?: string;
            networkPubKey?: string;
            workerPubKey?: string;
            proofOfPossession?: string;
            operationCap?: { address: string };
            stakingPoolId?: string;
          };
        } | null;
        epoch: {
          epochId: number;
          validatorSet: {
            activeValidators: {
              nodes: Array<{
                name: string;
                address: { address: string };
                stakingPoolSuiBalance?: string;
                commissionRate?: number;
                nextEpochCommissionRate?: number;
                votingPower?: number;
                atRisk?: number;
                apy?: number;
              }>;
            };
          };
        };
      }>(
        `query($address: SuiAddress!) {
          address(address: $address) {
            address
            validatorCredentials {
              name
              description
              imageUrl
              projectUrl
              netAddress
              p2pAddress
              primaryAddress
              workerAddress
              protocolPubKey
              networkPubKey
              workerPubKey
              proofOfPossession
              operationCap { address }
              stakingPoolId
            }
          }
          epoch {
            epochId
            validatorSet {
              activeValidators(first: 200) {
                nodes {
                  name
                  address { address }
                  stakingPoolSuiBalance
                  commissionRate
                  nextEpochCommissionRate
                  votingPower
                  atRisk
                  apy
                }
              }
            }
          }
        }`,
        { address }
      );

      const credentials = data.address?.validatorCredentials ?? null;
      const activeValidator =
        data.epoch.validatorSet.activeValidators.nodes.find(
          (v) => v.address.address === address
        );

      const stakingStats = activeValidator
        ? {
            staking_pool_sui_balance:
              activeValidator.stakingPoolSuiBalance ?? null,
            commission_rate_bps: activeValidator.commissionRate ?? null,
            next_epoch_commission_rate_bps:
              activeValidator.nextEpochCommissionRate ?? null,
            voting_power: activeValidator.votingPower ?? null,
            apy: activeValidator.apy ?? null,
            at_risk: activeValidator.atRisk ?? null,
          }
        : null;

      const result: Record<string, unknown> = {
        address,
        epoch: data.epoch.epochId,
        in_active_set: !!activeValidator,
      };

      if (credentials) {
        result.credentials = {
          name: credentials.name ?? null,
          description: credentials.description ?? null,
          image_url: credentials.imageUrl ?? null,
          project_url: credentials.projectUrl ?? null,
          net_address: credentials.netAddress ?? null,
          p2p_address: credentials.p2pAddress ?? null,
          primary_address: credentials.primaryAddress ?? null,
          worker_address: credentials.workerAddress ?? null,
          staking_pool_id: credentials.stakingPoolId ?? null,
        };
      }

      if (stakingStats) {
        result.staking_stats = stakingStats;
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

      const positions: Array<{
        object_id: string;
        pool_id: string | null;
        principal_mist: string | null;
        stake_activation_epoch: string | null;
      }> = [];

      let totalStakedMist = BigInt(0);

      for (const obj of ownedRes.objects) {
        const { response: objRes } = await sui.ledgerService.getObject({
          objectId: obj.objectId,
          readMask: {
            paths: ["object_id", "version", "object_type", "json"],
          },
        });

        const json = protoValueToJson(objRes.object?.json) as Record<
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
          object_id: obj.objectId,
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
