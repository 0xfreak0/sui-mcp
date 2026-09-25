import { z } from "zod";
import { numArg, addressArg } from "./args.js";
import {
  fetchActiveValidators,
  findValidatorByAddress,
  type ValidatorJson,
} from "../utils/validators.js";
import { gqlQuery } from "../clients/graphql.js";
import { listOwnedWithJson } from "../utils/owned-objects.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const STAKED_SUI_TYPE = "0x3::staking_pool::StakedSui";
/** Positions read before a total is refused. About 250 characters each. */
const MAX_STAKE_POSITIONS = 1000;

export function registerStakingTools(server: McpServer) {
  server.tool(
    "get_validators",
    "List current Sui validators (stake, commission, voting power), or — when `address` is given — return detailed info for that one validator (credentials, staking stats, network addresses). Supports sorting when listing.",
    {
      address: addressArg()
        .optional()
        .describe("If set, return details for this one validator instead of the full list (0x...)"),
      limit: numArg()
        .int()
        .min(1)
        .max(150)
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
    "Get a wallet's staking positions: every StakedSui object with its validator pool, principal, and activation epoch, and the total principal. Worth calling during an investigation or a net-worth check, because staked SUI does NOT appear in get_balance — a wallet that looks nearly empty can hold a large staked position, and the stake also ties it to a specific validator.",
    {
      address: addressArg().describe("Wallet address (0x...)"),
    },
    async ({ address }) => {
      const { objects, complete } = await listOwnedWithJson(address, STAKED_SUI_TYPE, MAX_STAKE_POSITIONS);

      let totalStakedMist = 0n;
      const positions = objects.map((o) => {
        const principal = typeof o.json?.principal === "string" ? o.json.principal : null;
        if (principal) totalStakedMist += BigInt(principal);
        return {
          object_id: o.objectId,
          pool_id: typeof o.json?.pool_id === "string" ? o.json.pool_id : null,
          principal_mist: principal,
          stake_activation_epoch:
            typeof o.json?.stake_activation_epoch === "string" ? o.json.stake_activation_epoch : null,
        };
      });
      // A position whose principal could not be read makes the sum short.
      const summed = complete && positions.every((p) => p.principal_mist !== null);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                total_staked_mist: summed ? totalStakedMist.toString() : null,
                ...(summed
                  ? {}
                  : {
                      total_unavailable: complete
                        ? "A position's principal could not be read, so no total is given."
                        : `The wallet holds more than ${MAX_STAKE_POSITIONS} StakedSui objects; these are the first ${positions.length} and no total is given.`,
                    }),
                position_count: positions.length,
                truncated: !complete,
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

