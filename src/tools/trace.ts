import { z } from "zod";
import { sui, archive } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { timestampToIso } from "../utils/formatting.js";
import type { GrpcTypes } from "@mysten/sui/grpc";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface BalanceChangeInfo {
  address: string;
  coin_type: string;
  amount: string;
}

interface HopResult {
  hop: number;
  digest: string;
  sender: string | null;
  balance_changes: BalanceChangeInfo[];
  timestamp: string | undefined;
  checkpoint: string | undefined;
}

async function fetchTx(digest: string) {
  const req = {
    digest,
    readMask: {
      paths: [
        "digest", "transaction", "effects",
        "checkpoint", "timestamp", "balance_changes",
      ],
    },
  };
  let res: GrpcTypes.GetTransactionResponse;
  try {
    ({ response: res } = await sui.ledgerService.getTransaction(req));
  } catch {
    ({ response: res } = await archive.ledgerService.getTransaction(req));
  }
  return res.transaction;
}

interface TxQueryPage {
  transactions: {
    nodes: Array<{
      digest: string;
      effects?: {
        checkpoint?: { sequenceNumber: number };
        timestamp?: string;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

async function findNextTx(
  address: string,
  afterCheckpoint?: number,
  direction: "forward" | "backward" = "forward",
): Promise<string | null> {
  // Query transactions affecting this address near the given checkpoint
  const query = `
    query($address: SuiAddress!, $first: Int, $last: Int, $afterCheckpoint: Int, $beforeCheckpoint: Int) {
      transactions(
        filter: {
          affectedAddress: $address
          ${direction === "forward" ? "afterCheckpoint: $afterCheckpoint" : "beforeCheckpoint: $beforeCheckpoint"}
        }
        ${direction === "forward" ? "first: $first" : "last: $last"}
      ) {
        nodes {
          digest
          effects {
            checkpoint { sequenceNumber }
            timestamp
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const variables: Record<string, unknown> = { address };
  if (direction === "forward") {
    variables.first = 1;
    variables.afterCheckpoint = afterCheckpoint;
  } else {
    variables.last = 1;
    variables.beforeCheckpoint = afterCheckpoint;
  }

  const data = await gqlQuery<TxQueryPage>(query, variables);
  const node = data.transactions.nodes[0];
  return node?.digest ?? null;
}

export function registerTraceTools(server: McpServer) {
  server.tool(
    "trace_funds",
    "Trace fund flow from a transaction. Follow money forward to recipients or backward to the sender's funding source. Follows balance changes across transaction hops.",
    {
      digest: z.string().describe("Starting transaction digest (Base58)"),
      direction: z
        .enum(["forward", "backward"])
        .describe("Direction to trace: 'forward' follows recipients, 'backward' follows sender"),
      hops: z
        .number()
        .optional()
        .describe("Max hops to follow (default 3, max 10)"),
      coin_type: z
        .string()
        .optional()
        .describe("Filter by coin type (e.g. 0x2::sui::SUI). If omitted, traces all coins."),
    },
    async ({ digest, direction, hops, coin_type }) => {
      const maxHops = Math.min(hops ?? 3, 10);
      const traceHops: HopResult[] = [];
      let currentDigest: string | null = digest;

      for (let hop = 0; hop < maxHops && currentDigest; hop++) {
        const tx = await fetchTx(currentDigest);
        if (!tx) break;

        const sender = tx.transaction?.sender ?? null;
        let changes: BalanceChangeInfo[] = (tx.balanceChanges ?? []).map(
          (bc: GrpcTypes.BalanceChange) => ({
            address: bc.address ?? "",
            coin_type: bc.coinType ?? "",
            amount: bc.amount ?? "0",
          })
        );

        if (coin_type) {
          changes = changes.filter((c) => c.coin_type === coin_type);
        }

        const checkpoint = tx.checkpoint?.toString();
        const checkpointNum = tx.checkpoint ? Number(tx.checkpoint) : undefined;

        traceHops.push({
          hop: hop + 1,
          digest: currentDigest,
          sender,
          balance_changes: changes,
          timestamp: timestampToIso(tx.timestamp),
          checkpoint,
        });

        // Determine next address to follow
        let nextAddress: string | null = null;
        if (direction === "forward") {
          // Find recipient: address with positive balance change that isn't the sender
          for (const c of changes) {
            if (c.address !== sender && BigInt(c.amount) > 0n) {
              nextAddress = c.address;
              break;
            }
          }
        } else {
          // Follow the sender backwards
          nextAddress = sender;
        }

        if (!nextAddress) break;

        // Find next transaction
        currentDigest = await findNextTx(
          nextAddress,
          checkpointNum,
          direction,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                starting_digest: digest,
                direction,
                coin_type: coin_type ?? "all",
                hop_count: traceHops.length,
                hops: traceHops,
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
