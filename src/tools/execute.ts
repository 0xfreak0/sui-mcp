import { z } from "zod";
import { sui } from "../clients/grpc.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerExecuteTools(server: McpServer) {
  server.tool(
    "simulate_transaction",
    "Dry-run a Sui transaction without signing, sending, or spending anything. Takes Base64 BCS transaction bytes — build them with build_transaction — and returns the effects it WOULD have: status, gas cost, emitted events, balance and object changes. Use it to check whether a transaction succeeds and what it costs before committing, or to see what an unfamiliar payload actually does. This server holds no keys and cannot execute anything.",
    {
      transaction_bcs: z
        .string()
        .describe("Base64-encoded BCS transaction bytes"),
    },
    async ({ transaction_bcs }) => {
      const txBytes = Buffer.from(transaction_bcs, "base64");
      const result = await sui.simulateTransaction({
        transaction: txBytes,
        include: {
          effects: true,
          events: true,
          balanceChanges: true,
        },
      });
      const tx =
        result.$kind === "Transaction"
          ? result.Transaction
          : result.FailedTransaction;
      const gas = tx.effects?.gasUsed;
      const events = tx.events?.map((e) => ({
        event_type: e.eventType,
        package_id: e.packageId,
        module: e.module,
        sender: e.sender,
      }));
      const balanceChanges = tx.balanceChanges?.map((bc) => ({
        address: bc.address,
        coin_type: bc.coinType,
        amount: bc.amount,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: tx.status,
                gas: gas
                  ? {
                      computation_cost: gas.computationCost,
                      storage_cost: gas.storageCost,
                      storage_rebate: gas.storageRebate,
                      non_refundable_storage_fee: gas.nonRefundableStorageFee,
                    }
                  : null,
                events,
                balance_changes: balanceChanges,
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
