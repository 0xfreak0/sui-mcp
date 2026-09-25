import { z } from "zod";
import { numArg, addressArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { errorResult } from "../utils/errors.js";
import { formatCoinAmount } from "../utils/coin-amount.js";
import { checkpointAt } from "../utils/checkpoint-time.js";
import {
  DEFAULT_MAX_TRANSACTIONS,
  MAX_MAX_TRANSACTIONS,
  canonicalCoinType,
  checkpointAtOrBefore,
  readBalanceAt,
  readBalanceRange,
  reconstructBalance,
} from "../utils/historical-balance.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCoinTools(server: McpServer) {
  server.tool(
    "get_balance",
    "Get the liquid balance of one coin type for a Sui address or object (defaults to SUI), now or at a past time or checkpoint. `balance` is the total the owner can spend: `coin_balance` is held as Coin<T> objects and `address_balance` sits in the owner's address balance, which holds funds without any coin object, so a wallet with no coins can still hold a large balance. For an object id, `address_balance` is funds held by the object itself, which only its defining module can withdraw. Staked SUI and value locked in DeFi positions do not appear here, so a wallet that looks nearly empty may not be: pair it with get_staking_summary and get_defi_positions before concluding anything about what an address holds. For every coin at once, use get_wallet_overview. With `at` or `at_checkpoint`, a checkpoint inside GraphQL's consistent range (about the last hour) is read directly (`method: consistent_read`). An older one is reconstructed (`method: reconstructed`): the balance at a recent anchor checkpoint minus the owner's balance changes in every transaction after the requested checkpoint, which is exact when `complete` is true. Reconstruction reads at most `max_transactions`; when that runs out, `complete` is false, `balance` is null and `reached_checkpoint` says how far back the scan got. A reconstructed balance has no coin/address split (`coin_balance` and `address_balance` are null); `anchor` carries the split at the anchor checkpoint.",
    {
      owner: addressArg().optional().describe("Owner address (0x...). Required; `address` is accepted in its place."),
      address: addressArg().optional().describe("Alias for `owner`."),
      coin_type: z
        .string()
        .optional()
        .describe("Coin type (default: 0x2::sui::SUI)"),
      at_checkpoint: numArg()
        .int()
        .nonnegative()
        .optional()
        .describe("Balance as of the end of this checkpoint. Give this or `at`, not both."),
      at: z
        .string()
        .optional()
        .describe(
          "Balance as of this time (ISO 8601, e.g. 2025-09-07T16:00:00Z): the last checkpoint stamped at or before it. Give this or `at_checkpoint`, not both.",
        ),
      max_transactions: numArg()
        .int()
        .min(1)
        .max(MAX_MAX_TRANSACTIONS)
        .optional()
        .describe(
          `Most transactions a reconstruction reads (default ${DEFAULT_MAX_TRANSACTIONS}, max ${MAX_MAX_TRANSACTIONS}). Each page of 50 is one request. Ignored for a current or consistent-range read.`,
        ),
    },
    async ({ owner: ownerArg, address, coin_type, at_checkpoint, at, max_transactions }) => {
      const owner = ownerArg ?? address;
      if (!owner) return errorResult("Pass the wallet to read as `owner` (or `address`).");
      if (at_checkpoint != null || at != null) {
        if (at_checkpoint != null && at != null) return errorResult("Pass `at` or `at_checkpoint`, not both.");
        const atMs = at != null ? Date.parse(at.trim()) : undefined;
        if (atMs !== undefined && Number.isNaN(atMs)) {
          return errorResult(`Could not parse at '${at}' as a time. Use ISO 8601 (2025-09-07T16:00:00Z), or pass a checkpoint as at_checkpoint.`);
        }
        const coinType = canonicalCoinType(coin_type ?? "0x2::sui::SUI");
        if (!coinType) return errorResult(`'${coin_type}' is not a coin type. Use the full type, e.g. 0x2::sui::SUI.`);

        const range = await readBalanceRange();
        if (!range) {
          return errorResult("Could not read the checkpoint range GraphQL serves balance reads for, so the balance at a past point cannot be placed. Retry.");
        }
        const newest = range.last;
        let checkpoint: number;
        let checkpointTimestamp: string | null = null;
        if (atMs !== undefined) {
          const point = await checkpointAtOrBefore(
            atMs,
            newest.timestamp ? { seq: newest.sequenceNumber, ms: Date.parse(newest.timestamp) } : undefined,
          );
          if (!point) return errorResult(`${at} is before the first checkpoint; nothing was held then.`);
          checkpoint = point.checkpoint;
          checkpointTimestamp = point.timestamp;
        } else {
          checkpoint = at_checkpoint!;
        }
        if (checkpoint > newest.sequenceNumber) {
          return errorResult(
            `Checkpoint ${checkpoint} is later than the newest checkpoint GraphQL has indexed, ${newest.sequenceNumber} (${newest.timestamp ?? "time unknown"}).`,
          );
        }
        const asked = { at: at ?? null, at_checkpoint: checkpoint };

        if (checkpoint >= range.first.sequenceNumber) {
          const bal = await readBalanceAt(owner, coinType, checkpoint);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                coin_type: bal.coin_type,
                method: "consistent_read",
                complete: true,
                ...asked,
                checkpoint_timestamp: bal.timestamp ?? checkpointTimestamp,
                balance: bal.balance,
                balance_formatted: formatCoinAmount(bal.balance, bal.coin_type),
                coin_balance: bal.coin_balance,
                address_balance: bal.address_balance,
                transactions_scanned: 0,
              }, null, 2),
            }],
          };
        }

        if (checkpointTimestamp === null) {
          const cp = await checkpointAt(checkpoint).catch(() => null);
          checkpointTimestamp = cp ? new Date(cp.ms).toISOString() : null;
        }
        const result = await reconstructBalance({
          owner,
          coinType,
          at: checkpoint,
          range,
          maxTransactions: max_transactions ?? DEFAULT_MAX_TRANSACTIONS,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              coin_type: coinType,
              method: "reconstructed",
              ...asked,
              checkpoint_timestamp: checkpointTimestamp,
              ...result,
            }, null, 2),
          }],
        };
      }

      const res = await sui.getBalance({
        owner,
        coinType: coin_type,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                coin_type: res.balance.coinType,
                balance: res.balance.balance,
                balance_formatted: formatCoinAmount(res.balance.balance, res.balance.coinType),
                coin_balance: res.balance.coinBalance,
                address_balance: res.balance.addressBalance,
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
    "get_coin_info",
    "Get on-chain metadata for a token/coin given its exact coin type string (e.g. '0x2::sui::SUI'). Returns name, symbol, decimals, description, icon URL, and total supply. If you only have a name or symbol, use search_token first to find the coin type.",
    {
      coin_type: z
        .string()
        .describe("Coin type (e.g. 0x2::sui::SUI)"),
    },
    async ({ coin_type }) => {
      // Use low-level client for full data including supply
      const { response: res } = await sui.stateService.getCoinInfo({
        coinType: coin_type,
      });
      const meta = res.metadata;
      const treasury = res.treasury;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                coin_type: res.coinType,
                name: meta?.name,
                symbol: meta?.symbol,
                decimals: meta?.decimals,
                description: meta?.description,
                icon_url: meta?.iconUrl,
                total_supply: treasury?.totalSupply?.toString(),
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
