import { z } from "zod";
import { numArg, addressArg, timePointArg } from "./args.js";
import {
  fetchActiveValidators,
  findValidatorByAddress,
  type ValidatorJson,
} from "../utils/validators.js";
import { gqlQuery } from "../clients/graphql.js";
import { capPayload } from "../utils/output-cap.js";
import { getNetwork } from "../config.js";
import { listOwnedWithJson } from "../utils/owned-objects.js";
import { historicalStaking } from "../utils/historical-staking.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const STAKED_SUI_TYPE = "0x3::staking_pool::StakedSui";
/** Positions read before a total is refused. About 250 characters each. */
const MAX_STAKE_POSITIONS = 1000;

export function registerStakingTools(server: McpServer) {
  server.tool(
    "get_validators",
    "List current Sui validators, or return detailed info for one `address` (credentials, staking stats, network addresses). The default summary shows name, address, stake, commission, voting power and at-risk status within a compact output budget; at-risk validators are always kept. Ranking, active_validator_count and total_stake cover the whole set; validator_count counts the rows shown. `detail: full` returns every full row unless `limit` is set. Omitted rows and fields name a same-network full call without a limit.",
    {
      address: addressArg()
        .optional()
        .describe("If set, return details for this one validator instead of the full list (0x...)"),
      limit: numArg()
        .int()
        .min(1)
        .max(150)
        .optional()
        .describe("When listing, keep at most N validators; summary also keeps at-risk rows beyond N. The summary output budget still applies."),
      sort_by: z
        .enum(["stake", "commission"])
        .optional()
        .describe("Sort field when listing: stake (default) or commission"),
      detail: z.enum(["summary", "full"]).optional()
        .describe("Listing detail: summary (default) caps compact rows; full returns all fields without a size cap. Ignored for an address lookup."),
    },
    async ({ address, limit, sort_by, detail }) => {
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
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      // Ranking needs the whole set. Asking for `first: N` and sorting the
      // result ranks whichever N the service returned first, not the top N.
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

      const summary = detail !== "full";
      const fullPayload = {
        epoch: set.epochId,
        total_stake: set.totalStake,
        active_validator_count: validators.length,
        ...(set.truncated
          ? {
              truncated: true,
              note: "Validator set pagination hit its page budget; counts and ranking cover only what was fetched.",
            }
          : {}),
        validator_count: validators.length,
        validators,
      };
      const rows = summary
        ? validators.map((v) => ({
            name: v.name,
            address: v.address,
            staking_pool_sui_balance: v.staking_pool_sui_balance,
            commission_rate_bps: v.commission_rate_bps,
            voting_power: v.voting_power,
            at_risk: v.at_risk,
          }))
        : validators;
      const nextCall = {
        tool: "get_validators",
        args: { network: getNetwork(), sort_by: sortField, detail: "full" },
      };
      type Row = (typeof rows)[number];
      const { payload, resultId } = capPayload(
        "get_validators",
        { network: getNetwork(), limit, sort_by, detail },
        { ...fullPayload, validators: rows },
        {
          validators: {
            budget: summary ? 6_000 : Number.POSITIVE_INFINITY,
            limit,
            keep: summary ? (v: Row) => (v.at_risk ?? 0) > 0 : undefined,
            brief: (v: Row) => ({
              name: v.name,
              address: v.address,
              staking_pool_sui_balance: v.staking_pool_sui_balance,
              commission_rate_bps: v.commission_rate_bps,
            }),
          },
        },
        {
          full: false,
          stored: fullPayload,
          next_call: nextCall,
          ...(summary ? { paged: { validators: validators.map((_, i) => i) } } : {}),
        },
      );
      payload.validator_count = (payload.validators as Row[]).length;
      if (summary) {
        payload.truncated = true;
        payload.omitted = {
          ...(payload.omitted as Record<string, unknown> | undefined),
          fields: ["validators.description", "validators.next_epoch_commission_rate_bps", "validators.gas_price"],
          next_call: nextCall,
          ...(resultId && !payload.omitted
            ? { result: { uri: `sui://results/${resultId}` } }
            : {}),
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    }
  );

  server.tool(
    "get_staking_summary",
    "Get directly held StakedSui positions and principal, now or at as_of (date/checkpoint). Historical reads include transfers and split/joined stakes; rewards are separate estimates. Incomplete history gives no total. Excludes wrapped stakes and liquid-staking tokens.",
    {
      address: addressArg().describe("Wallet address (0x...)"),
      as_of: timePointArg().optional()
        .describe("ISO 8601 date or checkpoint string; holdings at the end of the last checkpoint at or before it."),
      max_transactions: numArg().int().min(1).max(10000).optional()
        .describe("Historical replay budget per direction (default 1000); also bounds object-change pages."),
      detail: z.enum(["summary", "full"]).optional().describe("summary caps displayed positions; full returns every read position."),
    },
    async ({ address, as_of, max_transactions, detail }) => {
      if (as_of !== undefined) {
        const historical = await historicalStaking(address, as_of, max_transactions);
        const args = { address, as_of, max_transactions, network: getNetwork(), detail: "full" };
        const { payload } = capPayload("get_staking_summary", args, historical,
          { positions: { budget: 6000 } }, { full: detail === "full", next_call: { tool: "get_staking_summary", args } });
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      }
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

      const result = {
        address,
        total_staked_mist: summed ? totalStakedMist.toString() : null,
        ...(summed ? {} : {
          total_unavailable: complete
            ? "A position's principal could not be read, so no total is given."
            : `The holdings walk stopped after ${positions.length} positions; no total is given.`,
        }),
        position_count: positions.length,
        complete: summed,
        positions,
        rewards_included: false,
        scope: "Directly held StakedSui principal only; excludes wrapped/object-owned stakes, FungibleStakedSui and liquid-staking tokens.",
      };
      const args = { address, network: getNetwork(), detail: "full" };
      const { payload } = capPayload("get_staking_summary", args, result,
        { positions: { budget: 6000 } }, { full: detail === "full", next_call: { tool: "get_staking_summary", args } });
      payload.truncated = !complete || !!payload.omitted;
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    }
  );
}

