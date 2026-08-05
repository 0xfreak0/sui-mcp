import { z } from "zod";
import { Transaction } from "@mysten/sui/transactions";
import { sui } from "../clients/grpc.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SUI_TYPE = "0x2::sui::SUI";

/** True for SUI in any normalization (0x2::sui::SUI or the full 32-byte form). */
function isSuiType(t: string): boolean {
  return /^0x0*2::sui::SUI$/.test(t.trim());
}

async function buildResult(tx: Transaction, extra: Record<string, unknown>) {
  const bytes = await tx.build({ client: sui });
  const transaction_bcs = Buffer.from(bytes).toString("base64");
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ transaction_bcs, ...extra }, null, 2) }],
  };
}

export function registerPtbTools(server: McpServer) {
  server.tool(
    "build_transfer",
    "Build an unsigned transaction to transfer a coin — SUI or any coin type — from one address to another. For SUI it splits from the gas coin; for other coins it selects and merges the sender's coins to cover the amount. Returns base64-encoded BCS bytes for simulation via simulate_transaction.",
    {
      sender: z.string().describe("Sender address (0x...)"),
      recipient: z.string().describe("Recipient address (0x...)"),
      amount: z
        .string()
        .describe("Amount in the coin's smallest unit (raw, no decimals; for SUI this is MIST — 1 SUI = 1e9 MIST)"),
      coin_type: z
        .string()
        .optional()
        .describe("Full coin type string (default 0x2::sui::SUI)"),
    },
    async ({ sender, recipient, amount, coin_type }) => {
      const type = coin_type ?? SUI_TYPE;
      const targetAmount = BigInt(amount);
      const tx = new Transaction();

      // SUI: split straight from the gas coin (simplest, standard path).
      if (isSuiType(type)) {
        const coin = tx.splitCoins(tx.gas, [targetAmount]);
        tx.transferObjects([coin], recipient);
        tx.setSender(sender);
        return buildResult(tx, { sender, recipient, amount, coin_type: type });
      }

      // Other coins: gather enough of the sender's coins, merge, split, transfer.
      const listResult = await sui.listCoins({ owner: sender, coinType: type, limit: 50, cursor: null });
      const coins = listResult.objects;
      if (!coins || coins.length === 0) {
        return errorResult(`No coins of type ${type} found for address ${sender}`);
      }

      const sortedCoins = [...coins].sort((a, b) => {
        const balA = BigInt(a.balance);
        const balB = BigInt(b.balance);
        return balB > balA ? 1 : balB < balA ? -1 : 0;
      });

      const selectedCoins: typeof sortedCoins = [];
      let accumulated = 0n;
      for (const coin of sortedCoins) {
        selectedCoins.push(coin);
        accumulated += BigInt(coin.balance);
        if (accumulated >= targetAmount) break;
      }
      if (accumulated < targetAmount) {
        return errorResult(
          `Insufficient balance. Needed ${amount} but only found ${accumulated.toString()} across ${coins.length} coins of type ${type}`,
        );
      }

      const primaryCoinRef = tx.object(selectedCoins[0].objectId);
      if (selectedCoins.length > 1) {
        tx.mergeCoins(primaryCoinRef, selectedCoins.slice(1).map((c) => tx.object(c.objectId)));
      }
      if (accumulated === targetAmount && selectedCoins.length === 1) {
        tx.transferObjects([primaryCoinRef], recipient);
      } else {
        const splitCoin = tx.splitCoins(primaryCoinRef, [targetAmount]);
        tx.transferObjects([splitCoin], recipient);
      }
      tx.setSender(sender);
      return buildResult(tx, { sender, recipient, amount, coin_type: type, coins_used: selectedCoins.length });
    },
  );

  server.tool(
    "build_staking",
    "Build an unsigned transaction to stake or unstake SUI. action='stake' delegates SUI to a validator (needs validator_address + amount_mist); action='unstake' withdraws a StakedSui object (needs staked_sui_id). Returns base64-encoded BCS bytes for simulation via simulate_transaction.",
    {
      action: z.enum(["stake", "unstake"]).describe("'stake' to delegate SUI, 'unstake' to withdraw a StakedSui"),
      sender: z.string().describe("Sender address (0x...)"),
      validator_address: z.string().optional().describe("(stake) Validator address to stake with (0x...)"),
      amount_mist: z.string().optional().describe("(stake) Amount to stake in MIST (1 SUI = 1e9 MIST)"),
      staked_sui_id: z.string().optional().describe("(unstake) Object ID of the StakedSui to withdraw"),
    },
    async ({ action, sender, validator_address, amount_mist, staked_sui_id }) => {
      const tx = new Transaction();

      if (action === "stake") {
        if (!validator_address || !amount_mist) {
          return errorResult("stake requires validator_address and amount_mist.");
        }
        const coin = tx.splitCoins(tx.gas, [BigInt(amount_mist)]);
        tx.moveCall({
          target: "0x3::sui_system::request_add_stake",
          arguments: [tx.object("0x5"), coin, tx.pure.address(validator_address)],
        });
        tx.setSender(sender);
        return buildResult(tx, { action, sender, validator_address, amount_mist });
      }

      // unstake
      if (!staked_sui_id) {
        return errorResult("unstake requires staked_sui_id.");
      }
      tx.moveCall({
        target: "0x3::sui_system::request_withdraw_stake",
        arguments: [tx.object("0x5"), tx.object(staked_sui_id)],
      });
      tx.setSender(sender);
      return buildResult(tx, { action, sender, staked_sui_id });
    },
  );
}
