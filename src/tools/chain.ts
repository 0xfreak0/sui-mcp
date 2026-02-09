import { z } from "zod";
import { sui, archive } from "../clients/grpc.js";
import { bigintToString, timestampToIso } from "../utils/formatting.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerChainTools(server: McpServer) {
  server.tool(
    "get_chain_info",
    "Get current Sui network info: chain ID, epoch, checkpoint height, timestamp",
    {},
    async () => {
      const { response: res } = await sui.ledgerService.getServiceInfo({});
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                chain_id: res.chainId,
                chain: res.chain,
                epoch: bigintToString(res.epoch),
                checkpoint_height: bigintToString(res.checkpointHeight),
                timestamp: timestampToIso(res.timestamp),
                lowest_available_checkpoint: bigintToString(
                  res.lowestAvailableCheckpoint
                ),
                lowest_available_checkpoint_objects: bigintToString(
                  res.lowestAvailableCheckpointObjects
                ),
                server: res.server,
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
    "get_checkpoint",
    "Get a Sui checkpoint by sequence number or digest. Returns latest if neither is provided.",
    {
      sequence_number: z
        .string()
        .optional()
        .describe("Checkpoint sequence number"),
      digest: z.string().optional().describe("Checkpoint digest (Base58)"),
    },
    async ({ sequence_number, digest }) => {
      const checkpointId = sequence_number
        ? { oneofKind: "sequenceNumber" as const, sequenceNumber: BigInt(sequence_number) }
        : digest
          ? { oneofKind: "digest" as const, digest }
          : { oneofKind: undefined };
      const req = { checkpointId };
      let { response: res } = await sui.ledgerService.getCheckpoint(req);
      // Fall back to archive for pruned checkpoints
      if (!res.checkpoint && (sequence_number || digest)) {
        ({ response: res } = await archive.ledgerService.getCheckpoint(req));
      }
      const cp = res.checkpoint;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                sequence_number: bigintToString(cp?.sequenceNumber),
                digest: cp?.digest,
                epoch: bigintToString(cp?.summary?.epoch),
                timestamp: timestampToIso(cp?.summary?.timestamp),
                total_network_transactions: bigintToString(
                  cp?.summary?.totalNetworkTransactions
                ),
                previous_digest: cp?.summary?.previousDigest,
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
    "get_epoch",
    "Get Sui epoch info. Returns current epoch if no epoch number specified.",
    {
      epoch: z.string().optional().describe("Epoch number"),
    },
    async ({ epoch }) => {
      const { response: res } = await sui.ledgerService.getEpoch({
        epoch: epoch ? BigInt(epoch) : undefined,
        readMask: {
          paths: [
            "epoch", "first_checkpoint", "last_checkpoint",
            "start", "end", "reference_gas_price", "protocol_config",
          ],
        },
      });
      const ep = res.epoch;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                epoch: bigintToString(ep?.epoch),
                first_checkpoint: bigintToString(ep?.firstCheckpoint),
                last_checkpoint: bigintToString(ep?.lastCheckpoint),
                start: timestampToIso(ep?.start),
                end: timestampToIso(ep?.end),
                reference_gas_price: bigintToString(ep?.referenceGasPrice),
                protocol_version: bigintToString(
                  ep?.protocolConfig?.protocolVersion
                ),
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
