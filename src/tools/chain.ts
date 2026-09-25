import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import { bigintToString, timestampToIso } from "../utils/formatting.js";
import { checkpointBracket, type CheckpointBracket } from "../utils/checkpoint-time.js";
import { errorResult } from "../utils/errors.js";
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
        // A fullnode that has pruned an old epoch still returns an epoch object,
        // just without its checkpoint range — so emptiness is "no firstCheckpoint"
        // rather than "no epoch".
        const res = await withArchiveFallback(
          (client) => client.ledgerService.getEpoch(req),
          (r) => !r.epoch?.firstCheckpoint,
        );
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
    "Get a Sui checkpoint by sequence number, digest or timestamp, or the latest if none is given. Returns its timestamp, epoch and network transaction count. Use it to turn a checkpoint number into a time, or a time into a checkpoint: with `timestamp` it returns the checkpoint nearest that moment, plus the last checkpoint before it and the first at or after it, which are the exact edges for a checkpoint-range filter. query_transactions, query_events, build_timeline and aggregate_events also accept ISO times directly.",
    {
      sequence_number: z
        .string()
        .optional()
        .describe("Checkpoint sequence number"),
      digest: z.string().optional().describe("Checkpoint digest (Base58)"),
      timestamp: z
        .string()
        .optional()
        .describe("ISO 8601 time (2025-05-22T12:36:00Z) or 'now': return the checkpoint nearest it"),
    },
    async ({ sequence_number, digest, timestamp }) => {
      if ([sequence_number, digest, timestamp].filter(Boolean).length > 1) {
        return errorResult("Pass only one of sequence_number, digest or timestamp.");
      }
      let sequence = sequence_number;
      let fromTime: Record<string, unknown> | null = null;
      if (timestamp) {
        const ms = timestamp.trim().toLowerCase() === "now" ? Date.now() : Date.parse(timestamp);
        if (Number.isNaN(ms)) {
          return errorResult(`Could not parse timestamp '${timestamp}'. Use an ISO 8601 time such as 2025-05-22T12:36:00Z, or 'now'.`);
        }
        let bracket: CheckpointBracket;
        try {
          bracket = await checkpointBracket(ms);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        const { before, atOrAfter } = bracket;
        const nearest =
          before && atOrAfter
            ? ms - before.ms <= atOrAfter.ms - ms
              ? before
              : atOrAfter
            : (before ?? atOrAfter);
        if (!nearest) return errorResult(`No checkpoint found near ${timestamp}.`);
        sequence = String(nearest.seq);
        fromTime = {
          requested: new Date(ms).toISOString(),
          offset_ms: nearest.ms - ms,
          last_before: before ? { sequence_number: String(before.seq), timestamp: new Date(before.ms).toISOString() } : null,
          first_at_or_after: atOrAfter
            ? { sequence_number: String(atOrAfter.seq), timestamp: new Date(atOrAfter.ms).toISOString() }
            : null,
        };
      }
      const checkpointId = sequence
        ? { oneofKind: "sequenceNumber" as const, sequenceNumber: BigInt(sequence) }
        : digest
          ? { oneofKind: "digest" as const, digest }
          : { oneofKind: undefined };
      const req = {
        checkpointId,
        readMask: { paths: ["sequence_number", "digest", "summary"] },
      };
      // Only an explicitly requested checkpoint can be pruned. With neither arg
      // this returns the latest checkpoint, which the fullnode always has.
      const res = await withArchiveFallback(
        (client) => client.ledgerService.getCheckpoint(req),
        (r) => !!(sequence || digest) && !r.checkpoint?.summary,
      );
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
                ...(fromTime ? { resolved_from_timestamp: fromTime } : {}),
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
