import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
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
  timestamp: string | null;
  checkpoint: string | null;
}

// Use GraphQL to fetch transactions — gRPC archive doesn't return balance_changes
const TX_QUERY = `
  query($digest: String!) {
    transaction(digest: $digest) {
      digest
      sender { address }
      effects {
        status
        timestamp
        checkpoint { sequenceNumber }
        balanceChanges {
          nodes {
            coinType { repr }
            amount
            owner { address }
          }
        }
      }
    }
  }
`;

interface GqlTxResult {
  transaction: {
    digest: string;
    sender?: { address: string };
    effects?: {
      status: string;
      timestamp?: string;
      checkpoint?: { sequenceNumber: number };
      balanceChanges?: {
        nodes: Array<{
          coinType?: { repr: string };
          amount?: string;
          owner?: { address: string };
        }>;
      };
    };
  } | null;
}

interface FetchedTx {
  sender: string | null;
  balanceChanges: BalanceChangeInfo[];
  timestamp: string | null;
  checkpoint: number | null;
}

async function fetchTx(digest: string): Promise<FetchedTx | null> {
  const data = await gqlQuery<GqlTxResult>(TX_QUERY, { digest });
  const tx = data.transaction;
  if (!tx) return null;

  const balanceChanges = (tx.effects?.balanceChanges?.nodes ?? []).map((n) => ({
    address: n.owner?.address ?? "",
    coin_type: n.coinType?.repr ?? "",
    amount: n.amount ?? "0",
  }));

  return {
    sender: tx.sender?.address ?? null,
    balanceChanges,
    timestamp: tx.effects?.timestamp ?? null,
    checkpoint: tx.effects?.checkpoint?.sequenceNumber ?? null,
  };
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
  // Build query with only the variables actually used to avoid GraphQL validation errors
  const isForward = direction === "forward";
  const query = isForward
    ? `query($address: SuiAddress!, $first: Int, $afterCheckpoint: Int) {
        transactions(
          filter: { affectedAddress: $address, afterCheckpoint: $afterCheckpoint }
          first: $first
        ) {
          nodes { digest effects { checkpoint { sequenceNumber } timestamp } }
          pageInfo { hasNextPage endCursor }
        }
      }`
    : `query($address: SuiAddress!, $last: Int, $beforeCheckpoint: Int) {
        transactions(
          filter: { affectedAddress: $address, beforeCheckpoint: $beforeCheckpoint }
          last: $last
        ) {
          nodes { digest effects { checkpoint { sequenceNumber } timestamp } }
          pageInfo { hasNextPage endCursor }
        }
      }`;

  const variables: Record<string, unknown> = { address };
  if (isForward) {
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
    "(Advanced — multi-hop) Trace fund flow from a transaction. Follow money forward to recipients or backward to the sender's funding source. Makes sequential API calls per hop (up to 10).",
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

        const sender = tx.sender;
        let changes = tx.balanceChanges;

        if (coin_type) {
          changes = changes.filter((c) => c.coin_type === coin_type);
        }

        const checkpointNum = tx.checkpoint ?? undefined;

        traceHops.push({
          hop: hop + 1,
          digest: currentDigest,
          sender,
          balance_changes: changes,
          timestamp: tx.timestamp,
          checkpoint: tx.checkpoint?.toString() ?? null,
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
