import { z } from "zod";
import { sui, archive } from "../clients/grpc.js";
import { bigintToString, timestampToIso } from "../utils/formatting.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerChainTools(server: McpServer) {
  server.tool(
    "get_chain_info",
    "Get current Sui network info: chain ID, epoch, checkpoint height, timestamp, and reference gas price. Optionally pass an epoch number to get details for a specific epoch.",
    {
      epoch: z.string().optional().describe("Epoch number to query. Returns current epoch info if omitted."),
    },
    async ({ epoch }) => {
      if (epoch) {
        // Epoch-specific query
        const req = {
          epoch: BigInt(epoch),
          readMask: {
            paths: [
              "epoch", "first_checkpoint", "last_checkpoint",
              "start", "end", "reference_gas_price", "protocol_config",
            ],
          },
        };
        let res;
        try {
          ({ response: res } = await sui.ledgerService.getEpoch(req));
        } catch {
          ({ response: res } = await archive.ledgerService.getEpoch(req));
        }
        if (!res.epoch?.firstCheckpoint) {
          try {
            ({ response: res } = await archive.ledgerService.getEpoch(req));
          } catch { /* keep fullnode result */ }
        }
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

      // Default: current chain info
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
      const req = {
        checkpointId,
        readMask: { paths: ["sequence_number", "digest", "summary"] },
      };
      let res;
      try {
        ({ response: res } = await sui.ledgerService.getCheckpoint(req));
      } catch {
        ({ response: res } = await archive.ledgerService.getCheckpoint(req));
      }
      if ((sequence_number || digest) && !res.checkpoint?.summary) {
        try {
          ({ response: res } = await archive.ledgerService.getCheckpoint(req));
        } catch { /* keep fullnode result */ }
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
}
