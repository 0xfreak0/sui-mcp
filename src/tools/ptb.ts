import { z } from "zod";
import { Transaction } from "@mysten/sui/transactions";
import { sui } from "../clients/grpc.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPtbTools(server: McpServer) {
  server.tool(
    "build_transfer_sui",
    "Build an unsigned transaction to transfer SUI from one address to another. Returns base64-encoded BCS bytes for signing and execution via execute_transaction.",
    {
      sender: z.string().describe("Sender address (0x...)"),
      recipient: z.string().describe("Recipient address (0x...)"),
      amount_mist: z
        .string()
        .describe("Amount to transfer in MIST (1 SUI = 1000000000 MIST)"),
    },
    async ({ sender, recipient, amount_mist }) => {
      const tx = new Transaction();
      const coin = tx.splitCoins(tx.gas, [BigInt(amount_mist)]);
      tx.transferObjects([coin], recipient);
      tx.setSender(sender);

      const bytes = await tx.build({ client: sui });
      const transaction_bcs = Buffer.from(bytes).toString("base64");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { transaction_bcs, sender, recipient, amount_mist },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "build_transfer_coin",
    "Build an unsigned transaction to transfer any coin type from one address to another. Automatically selects and merges coins to cover the requested amount. Returns base64-encoded BCS bytes for signing and execution via execute_transaction.",
    {
      sender: z.string().describe("Sender address (0x...)"),
      recipient: z.string().describe("Recipient address (0x...)"),
      coin_type: z
        .string()
        .describe("Full coin type string (e.g. 0x2::sui::SUI)"),
      amount: z
        .string()
        .describe("Amount to transfer in smallest unit (raw, no decimals)"),
    },
    async ({ sender, recipient, coin_type, amount }) => {
      const targetAmount = BigInt(amount);

      const listResult = await sui.listCoins({
        owner: sender,
        coinType: coin_type,
        limit: 50,
        cursor: null,
      });

      const coins = listResult.objects;
      if (!coins || coins.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error:
                    "No coins of type " +
                    coin_type +
                    " found for address " +
                    sender,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const sortedCoins = [...coins].sort((a, b) => {
        const balA = BigInt(a.balance);
        const balB = BigInt(b.balance);
        return balB > balA ? 1 : balB < balA ? -1 : 0;
      });

      const selectedCoins: typeof sortedCoins = [];
      let accumulated = BigInt(0);
      for (const coin of sortedCoins) {
        selectedCoins.push(coin);
        accumulated += BigInt(coin.balance);
        if (accumulated >= targetAmount) break;
      }

      if (accumulated < targetAmount) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error:
                    "Insufficient balance. Needed " +
                    amount +
                    " but only found " +
                    accumulated.toString() +
                    " across " +
                    coins.length +
                    " coins of type " +
                    coin_type,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const tx = new Transaction();
      const primaryCoinRef = tx.object(selectedCoins[0].objectId);

      if (selectedCoins.length > 1) {
        const otherCoinRefs = selectedCoins
          .slice(1)
          .map((c) => tx.object(c.objectId));
        tx.mergeCoins(primaryCoinRef, otherCoinRefs);
      }

      if (accumulated === targetAmount && selectedCoins.length === 1) {
        tx.transferObjects([primaryCoinRef], recipient);
      } else {
        const splitCoin = tx.splitCoins(primaryCoinRef, [targetAmount]);
        tx.transferObjects([splitCoin], recipient);
      }

      tx.setSender(sender);
      const bytes = await tx.build({ client: sui });
      const transaction_bcs = Buffer.from(bytes).toString("base64");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                transaction_bcs,
                sender,
                recipient,
                coin_type,
                amount,
                coins_used: selectedCoins.length,
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
    "build_stake_sui",
    "Build an unsigned transaction to stake SUI with a validator. Returns base64-encoded BCS bytes for signing and execution via execute_transaction.",
    {
      sender: z.string().describe("Sender address (0x...)"),
      validator_address: z
        .string()
        .describe("Validator address to stake with (0x...)"),
      amount_mist: z
        .string()
        .describe("Amount to stake in MIST (1 SUI = 1000000000 MIST)"),
    },
    async ({ sender, validator_address, amount_mist }) => {
      const tx = new Transaction();
      const coin = tx.splitCoins(tx.gas, [BigInt(amount_mist)]);
      tx.moveCall({
        target: "0x3::sui_system::request_add_stake",
        arguments: [
          tx.object("0x5"),
          coin,
          tx.pure.address(validator_address),
        ],
      });
      tx.setSender(sender);

      const bytes = await tx.build({ client: sui });
      const transaction_bcs = Buffer.from(bytes).toString("base64");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { transaction_bcs, sender, validator_address, amount_mist },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "build_unstake_sui",
    "Build an unsigned transaction to unstake (withdraw) a StakedSui object. Returns base64-encoded BCS bytes for signing and execution via execute_transaction.",
    {
      sender: z.string().describe("Sender address (0x...)"),
      staked_sui_id: z
        .string()
        .describe("Object ID of the StakedSui to withdraw"),
    },
    async ({ sender, staked_sui_id }) => {
      const tx = new Transaction();
      tx.moveCall({
        target: "0x3::sui_system::request_withdraw_stake",
        arguments: [tx.object("0x5"), tx.object(staked_sui_id)],
      });
      tx.setSender(sender);

      const bytes = await tx.build({ client: sui });
      const transaction_bcs = Buffer.from(bytes).toString("base64");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { transaction_bcs, sender, staked_sui_id },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
