import { z } from "zod";
import { addressArg } from "./args.js";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
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
    "Build an unsigned transaction to transfer a coin — SUI or any coin type — from one address to another. For SUI it splits from the gas coin; for other coins it draws the amount from the sender's coin objects and address balance together, so a sender holding the coin only in its address balance can still send it. Returns base64-encoded BCS bytes for simulation via simulate_transaction.",
    {
      sender: addressArg().describe("Sender address (0x...)"),
      recipient: addressArg().describe("Recipient address (0x...)"),
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

      // Other coins: the SDK's coinWithBalance intent resolves at build time
      // from both coin objects and the address balance (via a FundsWithdrawal
      // input redeemed by 0x2::coin::redeem_funds). Selecting from listCoins
      // alone found nothing for a sender holding the coin only in its address
      // balance. An insufficient total is reported by the SDK with the amount
      // required and available.
      tx.transferObjects([coinWithBalance({ type, balance: targetAmount })], recipient);
      tx.setSender(sender);
      return buildResult(tx, { sender, recipient, amount, coin_type: type });
    },
  );

  server.tool(
    "build_staking",
    "Build an unsigned transaction to stake or unstake SUI. action='stake' delegates SUI to a validator (needs validator_address + amount_mist); action='unstake' withdraws a StakedSui object (needs staked_sui_id). Returns base64-encoded BCS bytes for simulation via simulate_transaction.",
    {
      action: z.enum(["stake", "unstake"]).describe("'stake' to delegate SUI, 'unstake' to withdraw a StakedSui"),
      sender: addressArg().describe("Sender address (0x...)"),
      validator_address: addressArg().optional().describe("(stake) Validator address to stake with (0x...)"),
      amount_mist: z.string().optional().describe("(stake) Amount to stake in MIST (1 SUI = 1e9 MIST)"),
      staked_sui_id: addressArg().optional().describe("(unstake) Object ID of the StakedSui to withdraw"),
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
