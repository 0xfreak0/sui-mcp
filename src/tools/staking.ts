import { z } from "zod";
import {
  fetchActiveValidators,
  findValidatorByAddress,
  type ValidatorJson,
} from "../utils/validators.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { protoValueToJson } from "../utils/proto.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";


export function registerStakingTools(server: McpServer) {
  server.tool(
    "get_validators",
    "List current Sui validators (stake, commission, voting power), or — when `address` is given — return detailed info for that one validator (credentials, staking stats, network addresses). Supports sorting when listing.",
    {
      address: z
        .string()
        .optional()
        .describe("If set, return details for this one validator instead of the full list (0x...)"),
      limit: z
        .number()
        .optional()
        .describe("Max validators to return when listing (default 50, max 150)"),
      sort_by: z
        .enum(["stake", "commission"])
        .optional()
        .describe("Sort field when listing: stake (default) or commission"),
    },
    async ({ address, limit, sort_by }) => {
      // Detail branch — a single validator.
      if (address) {
        const set = await fetchActiveValidators();
        const av = findValidatorByAddress(set, address);
        const j = av?.contents?.json;
        const m = j?.metadata;
        const pool = j?.staking_pool;
        const result: Record<string, unknown> = { address, epoch: set.epochId, in_active_set: !!av };
        if (m) {
          result.credentials = {
            name: m.name ?? null,
            description: m.description ?? null,
            image_url: m.image_url ?? null,
            project_url: m.project_url ?? null,
            net_address: m.net_address ?? null,
            p2p_address: m.p2p_address ?? null,
            primary_address: m.primary_address ?? null,
            worker_address: m.worker_address ?? null,
          };
        }
        if (j) {
          result.staking_stats = {
            staking_pool_sui_balance: pool?.sui_balance ?? null,
            staking_pool_id: pool?.id ?? null,
            activation_epoch: pool?.activation_epoch ?? null,
            commission_rate_bps: j.commission_rate != null ? Number(j.commission_rate) : null,
            next_epoch_commission_rate_bps: j.next_epoch_commission_rate != null ? Number(j.next_epoch_commission_rate) : null,
            voting_power: j.voting_power != null ? Number(j.voting_power) : null,
            gas_price: j.gas_price ?? null,
            next_epoch_stake: j.next_epoch_stake ?? null,
            at_risk: av?.atRisk ?? null,
          };
        } else {
          result.note = "Validator not found in active set. They may be pending, inactive, or the address may not be a validator.";
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }

      // Ranking needs the whole set. Asking for `first: N` and sorting the
      // result ranks whichever N the service returned first, not the top N.
      const limitN = Math.max(limit ?? 50, 1);
      const sortField = sort_by ?? "stake";
      const set = await fetchActiveValidators();

      const nodes = set.validators;

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
      } else if (sortField === "commission") {
        validators.sort(
          (a, b) =>
            (a.commission_rate_bps ?? 10000) - (b.commission_rate_bps ?? 10000)
        );
      }

      // Sorted over the whole set, then cut — so "top N by stake" is the real
      // top N rather than the first page reordered.
      const shown = validators.slice(0, limitN);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                epoch: set.epochId,
                total_stake: set.totalStake,
                active_validator_count: validators.length,
                ...(set.truncated
                  ? {
                      truncated: true,
                      note: "Validator set pagination hit its page budget; counts and ranking cover only what was fetched.",
                    }
                  : {}),
                validator_count: shown.length,
                validators: shown,
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
      const truncated = ownedRes.hasNextPage ?? false;

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
                truncated,
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

