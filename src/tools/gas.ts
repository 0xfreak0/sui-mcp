import { z } from "zod";
import { sui } from "../clients/grpc.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerGasTools(server: McpServer) {
  server.tool(
    "get_gas_estimate",
    "Estimate gas cost for a Sui transaction by simulating it. Returns breakdown of computation, storage, and rebate costs.",
    {
      transaction_bcs: z
        .string()
        .describe("Base64-encoded BCS transaction bytes"),
    },
    async ({ transaction_bcs }) => {
      const txBytes = Buffer.from(transaction_bcs, "base64");
      const result = await sui.simulateTransaction({
        transaction: txBytes,
        include: { effects: true },
      });
      const tx =
        result.$kind === "Transaction"
          ? result.Transaction
          : result.FailedTransaction;
      const gas = tx.effects?.gasUsed;

      const computation = BigInt(gas?.computationCost ?? 0);
      const storage = BigInt(gas?.storageCost ?? 0);
      const rebate = BigInt(gas?.storageRebate ?? 0);
      const total = computation + storage - rebate;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                total_gas_mist: total.toString(),
                total_gas_sui: Number(total) / 1_000_000_000,
                computation_cost: computation.toString(),
                storage_cost: storage.toString(),
                storage_rebate: rebate.toString(),
                status: tx.status,
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
