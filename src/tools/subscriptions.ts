import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MAX_SUBSCRIPTIONS = 50;

interface SubscriptionState {
  id: string;
  type: "address" | "object";
  target: string; // address or object_id
  last_checkpoint: number | null;
  last_version: string | null;
  created_at: string;
  last_polled_at: string | null;
  poll_count: number;
  new_items_total: number;
}

const subscriptions = new Map<string, SubscriptionState>();

function generateId(): string {
  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function evictOldest() {
  if (subscriptions.size < MAX_SUBSCRIPTIONS) return;
  // LRU: evict the subscription with the oldest last_polled_at
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, sub] of subscriptions) {
    const t = sub.last_polled_at
      ? new Date(sub.last_polled_at).getTime()
      : new Date(sub.created_at).getTime();
    if (t < oldestTime) {
      oldestTime = t;
      oldestKey = key;
    }
  }
  if (oldestKey) subscriptions.delete(oldestKey);
}

interface TxQueryResult {
  transactions: {
    nodes: Array<{
      digest: string;
      sender?: { address: string };
      effects?: {
        status: string;
        timestamp?: string;
        checkpoint?: { sequenceNumber: number };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

export function registerSubscriptionTools(server: McpServer) {
  server.tool(
    "subscribe_address",
    "Subscribe to (or poll) new transactions on a Sui address. Creates a subscription on first call, then returns new transactions since the last poll on subsequent calls with the same subscription_id.",
    {
      address: z.string().describe("Sui address to monitor"),
      subscription_id: z
        .string()
        .optional()
        .describe("Existing subscription ID to poll. Omit to create new subscription."),
    },
    async ({ address, subscription_id }) => {
      let sub: SubscriptionState;

      if (subscription_id) {
        const existing = subscriptions.get(subscription_id);
        if (!existing) return errorResult(`Subscription ${subscription_id} not found`);
        if (existing.type !== "address" || existing.target !== address) {
          return errorResult(`Subscription ${subscription_id} does not match address ${address}`);
        }
        sub = existing;
      } else {
        evictOldest();
        sub = {
          id: generateId(),
          type: "address",
          target: address,
          last_checkpoint: null,
          last_version: null,
          created_at: new Date().toISOString(),
          last_polled_at: null,
          poll_count: 0,
          new_items_total: 0,
        };
        subscriptions.set(sub.id, sub);
      }

      // Query for new transactions
      const query = `
        query($address: SuiAddress!, $first: Int, $afterCheckpoint: Int) {
          transactions(
            filter: { affectedAddress: $address, afterCheckpoint: $afterCheckpoint }
            first: $first
          ) {
            nodes {
              digest
              sender { address }
              effects {
                status
                timestamp
                checkpoint { sequenceNumber }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `;

      const data = await gqlQuery<TxQueryResult>(query, {
        address,
        first: 20,
        afterCheckpoint: sub.last_checkpoint ?? undefined,
      });

      const transactions = data.transactions.nodes.map((n) => ({
        digest: n.digest,
        sender: n.sender?.address,
        status: n.effects?.status?.toLowerCase(),
        checkpoint: n.effects?.checkpoint?.sequenceNumber,
        timestamp: n.effects?.timestamp,
      }));

      // Update subscription state
      const latestCheckpoint = transactions.reduce<number | null>(
        (max, tx) => {
          if (tx.checkpoint == null) return max;
          return max == null || tx.checkpoint > max ? tx.checkpoint : max;
        },
        sub.last_checkpoint
      );

      sub.last_checkpoint = latestCheckpoint;
      sub.last_polled_at = new Date().toISOString();
      sub.poll_count++;
      sub.new_items_total += transactions.length;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                subscription_id: sub.id,
                address,
                new_transaction_count: transactions.length,
                last_checkpoint: sub.last_checkpoint,
                poll_count: sub.poll_count,
                has_more: data.transactions.pageInfo.hasNextPage,
                transactions,
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
    "subscribe_object",
    "Subscribe to (or poll) changes on a Sui object. Creates a subscription on first call, then checks for version changes on subsequent calls.",
    {
      object_id: z.string().describe("Object ID to monitor (0x...)"),
      subscription_id: z
        .string()
        .optional()
        .describe("Existing subscription ID to poll. Omit to create new subscription."),
    },
    async ({ object_id, subscription_id }) => {
      let sub: SubscriptionState;

      if (subscription_id) {
        const existing = subscriptions.get(subscription_id);
        if (!existing) return errorResult(`Subscription ${subscription_id} not found`);
        if (existing.type !== "object" || existing.target !== object_id) {
          return errorResult(`Subscription ${subscription_id} does not match object ${object_id}`);
        }
        sub = existing;
      } else {
        evictOldest();
        sub = {
          id: generateId(),
          type: "object",
          target: object_id,
          last_checkpoint: null,
          last_version: null,
          created_at: new Date().toISOString(),
          last_polled_at: null,
          poll_count: 0,
          new_items_total: 0,
        };
        subscriptions.set(sub.id, sub);
      }

      const { response: res } = await sui.ledgerService.getObject({
        objectId: object_id,
        readMask: {
          paths: ["object_id", "version", "digest", "object_type"],
        },
      });
      const obj = res.object;
      const currentVersion = obj?.version?.toString() ?? null;
      const hasChanged = sub.last_version != null && currentVersion != null
        ? BigInt(currentVersion) > BigInt(sub.last_version)
        : false;

      const previousVersion = sub.last_version;
      sub.last_version = currentVersion;
      sub.last_polled_at = new Date().toISOString();
      sub.poll_count++;
      if (hasChanged) sub.new_items_total++;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                subscription_id: sub.id,
                object_id,
                has_changed: hasChanged,
                previous_version: previousVersion,
                current_version: currentVersion,
                object_type: obj?.objectType,
                poll_count: sub.poll_count,
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
    "list_subscriptions",
    "List all active subscriptions with their stats.",
    {},
    async () => {
      const subs = [...subscriptions.values()].map((s) => ({
        subscription_id: s.id,
        type: s.type,
        target: s.target,
        poll_count: s.poll_count,
        new_items_total: s.new_items_total,
        last_polled_at: s.last_polled_at,
        created_at: s.created_at,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count: subs.length,
                max_subscriptions: MAX_SUBSCRIPTIONS,
                subscriptions: subs,
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
    "unsubscribe",
    "Remove a subscription by its ID.",
    {
      subscription_id: z.string().describe("Subscription ID to remove"),
    },
    async ({ subscription_id }) => {
      const existed = subscriptions.delete(subscription_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                subscription_id,
                removed: existed,
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
