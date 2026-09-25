import { z } from "zod";
import { numArg, addressArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCoinTools(server: McpServer) {
  server.tool(
    "get_balance",
    "Get the liquid balance of one coin type for a Sui address or object (defaults to SUI), optionally at a historical checkpoint. `balance` is the total the owner can spend: `coin_balance` is held as Coin<T> objects and `address_balance` sits in the owner's address balance, which holds funds without any coin object, so a wallet with no coins can still hold a large balance. For an object id, `address_balance` is funds held by the object itself, which only its defining module can withdraw. Staked SUI and value locked in DeFi positions do not appear here, so a wallet that looks nearly empty may not be: pair it with get_staking_summary and get_defi_positions before concluding anything about what an address holds. For every coin at once, use get_wallet_overview.",
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
        .describe(
          "Balance as of this checkpoint. GraphQL answers this only inside its consistent range, roughly the most recent hour of checkpoints; an older checkpoint returns an error that names the available range.",
        ),
    },
    async ({ owner: ownerArg, address, coin_type, at_checkpoint }) => {
      const owner = ownerArg ?? address;
      if (!owner) return errorResult("Pass the wallet to read as `owner` (or `address`).");
      if (at_checkpoint != null) {
        const coinType = coin_type ?? "0x2::sui::SUI";
        const outside = await outsideBalanceRange(at_checkpoint);
        if (outside) return errorResult(outside);
        const data = await gqlQuery<{
          address: {
            balance: { coinType: { repr: string }; totalBalance: string; coinBalance: string | null; addressBalance: string | null } | null;
          } | null;
        }>(
          `query($owner: SuiAddress!, $coinType: String!, $checkpoint: UInt53) {
            address(address: $owner, atCheckpoint: $checkpoint) {
              balance(coinType: $coinType) {
                coinType { repr }
                totalBalance
                coinBalance
                addressBalance
              }
            }
          }`,
          { owner, coinType, checkpoint: at_checkpoint }
        );
        const bal = data.address?.balance;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              coin_type: bal?.coinType.repr ?? coinType,
              balance: bal?.totalBalance ?? "0",
              coin_balance: bal?.coinBalance ?? "0",
              address_balance: bal?.addressBalance ?? "0",
              at_checkpoint,
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

/**
 * Why `checkpoint` cannot be answered, or null when it is inside the range
 * GraphQL serves balance reads for.
 *
 * The service answers a checkpoint outside that range with "Request is outside
 * consistent range", which names neither the range nor how far off the
 * request was. The range is about an hour and moves with the chain, so it is
 * read from `serviceConfig` rather than assumed.
 */
async function outsideBalanceRange(checkpoint: number): Promise<string | null> {
  const data = await gqlQuery<{
    serviceConfig: {
      availableRange: {
        first: { sequenceNumber: number; timestamp: string | null } | null;
        last: { sequenceNumber: number; timestamp: string | null } | null;
      } | null;
    } | null;
  }>(`query {
    serviceConfig {
      availableRange(type: "Address", field: "balance") {
        first { sequenceNumber timestamp }
        last { sequenceNumber timestamp }
      }
    }
  }`).catch(() => null);
  const range = data?.serviceConfig?.availableRange;
  if (!range?.first || !range.last) return null;
  const { first, last } = range;
  if (checkpoint >= first.sequenceNumber && checkpoint <= last.sequenceNumber) return null;
  return (
    `Checkpoint ${checkpoint} is outside the range GraphQL answers balance reads for: checkpoints ` +
    `${first.sequenceNumber} (${first.timestamp ?? "?"}) to ${last.sequenceNumber} (${last.timestamp ?? "?"}), ` +
    `about the most recent hour. A balance at an older checkpoint cannot be read directly; ` +
    `the address's balance changes since then (get_transaction_history) are the evidence for it.`
  );
}
