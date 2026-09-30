import { z } from "zod";
import { numArg, addressArg, coinTypeArg, timePointArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { errorResult } from "../utils/errors.js";
import { formatCoinAmount } from "../utils/coin-amount.js";
import { prefetchCoinScale } from "../utils/valuation.js";
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
    "Read one coin's liquid balance for a Sui address or object, now or at a past time/checkpoint; the default coin is SUI. The total includes Coin<T> objects and address-balance funds, so no coin objects does not mean no funds. Only its defining module can withdraw an object's address balance. This excludes staking and DeFi positions: check get_staking_summary and get_defi_positions before assessing holdings; use get_wallet_overview for every coin. Historical reads are direct within the consistent range (about the last hour), reconstructed for older points and exact only when complete:true. Reconstruction stops at max_transactions; an incomplete result has balance:null and reached_checkpoint marks progress. Reconstructed coin_balance and address_balance are null; anchor has the split at its checkpoint.",
    {
      owner: addressArg().optional().describe("Owner address (0x...). Required; `address` is accepted in its place."),
      address: addressArg().optional().describe("Alias for `owner`."),
      coin_type: coinTypeArg()
        .optional()
        .describe("Coin type (default: 0x2::sui::SUI)"),
      at_checkpoint: numArg()
        .int()
        .nonnegative()
        .optional()
        .describe("Balance as of the end of this checkpoint. Give this or `at`, not both."),
      at: timePointArg()
        .optional()
        .describe(
          "ISO 8601 time: use the last checkpoint at or before it. Give this or at_checkpoint, not both.",
        ),
      max_transactions: numArg()
        .int()
        .min(1)
        .max(MAX_MAX_TRANSACTIONS)
        .optional()
        .describe(
          `Reconstruction transaction limit (default ${DEFAULT_MAX_TRANSACTIONS}, max ${MAX_MAX_TRANSACTIONS}); ignored for current or consistent-range reads.`,
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
        // Every path below formats the amount, which needs the coin's own
        // decimals for a coin no curated list knows.
        const [range] = await Promise.all([readBalanceRange(), prefetchCoinScale([coinType])]);
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
              }),
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
            }),
          }],
        };
      }

      const res = await sui.getBalance({
        owner,
        coinType: coin_type,
      });
      await prefetchCoinScale([res.balance.coinType]);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              coin_type: res.balance.coinType,
              balance: res.balance.balance,
              balance_formatted: formatCoinAmount(res.balance.balance, res.balance.coinType),
              coin_balance: res.balance.coinBalance,
              address_balance: res.balance.addressBalance,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_coin_info",
    "Get on-chain metadata for a token/coin given its exact coin type string (e.g. '0x2::sui::SUI'). Returns name, symbol, decimals, description, icon URL, and total supply. If you only have a name or symbol, use search_token first to find the coin type.",
    {
      coin_type: coinTypeArg()
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
            text: JSON.stringify({
              coin_type: res.coinType,
              name: meta?.name,
              symbol: meta?.symbol,
              decimals: meta?.decimals,
              description: meta?.description,
              icon_url: meta?.iconUrl,
              total_supply: treasury?.totalSupply?.toString(),
            }),
          },
        ],
      };
    }
  );
}
