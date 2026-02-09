import { z } from "zod";
import { sui } from "../clients/grpc.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerExecuteTools(server: McpServer) {
  server.tool(
    "simulate_transaction",
    "Simulate a Sui transaction without executing it. Returns predicted effects, gas cost, events, and object changes.",
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

  server.tool(
    "execute_transaction",
    "Execute a signed Sui transaction. Requires both the transaction BCS and signatures.",
    {
      transaction_bcs: z
        .string()
        .describe("Base64-encoded BCS transaction bytes"),
      signatures: z
        .array(z.string())
        .describe("Array of base64-encoded signatures"),
    },
    async ({ transaction_bcs, signatures }) => {
      const txBytes = Buffer.from(transaction_bcs, "base64");
      const result = await sui.executeTransaction({
        transaction: txBytes,
        signatures,
        include: { effects: true },
      });
      const tx =
        result.$kind === "Transaction"
          ? result.Transaction
          : result.FailedTransaction;
      const gas = tx.effects?.gasUsed;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                digest: tx.digest,
                status: tx.status,
                epoch: tx.epoch,
                gas: gas
                  ? {
                      computation_cost: gas.computationCost,
                      storage_cost: gas.storageCost,
                      storage_rebate: gas.storageRebate,
                      non_refundable_storage_fee: gas.nonRefundableStorageFee,
                    }
                  : null,
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
