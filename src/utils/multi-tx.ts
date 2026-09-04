/**
 * Reading many transactions in one request.
 *
 * `get_transaction` answers one digest and, for depth, is the right tool: it
 * pages events to completion and decodes commands from gRPC. But an
 * investigation routinely holds a handful of digests at once — the outputs of a
 * fan-out, the evidence on a cluster edge, a set of hops someone wants compared
 * — and reading them one at a time costs a round trip *and a model turn* each.
 * Measured on ten digests: 0.80s sequential, 0.10s as a single `multiGetTransactions`.
 * The latency is the smaller half; ten tool calls becoming one is the point.
 *
 * One query carries everything needed: sender, status, timing, balance changes,
 * Move call targets, and events with their decoded fields.
 *
 * Events are the one place this trades depth for breadth. The connection is
 * asked for a page and reports whether more exist, rather than being paged to
 * exhaustion for every transaction in a batch — that would put a batch of fifty
 * back into dozens of requests. A transaction with more events says so and
 * names `get_transaction` as the way to read all of them, so the limit is
 * visible rather than a silent truncation.
 */

import { fromBase58 } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { packageOfEventType } from "./event-json.js";

/** Digests per request. GraphQL's page cap, and a sane batch size. */
export const MAX_DIGESTS = 50;

/** Events fetched per transaction inside a batch. */
const EVENTS_PER_TX = 50;

const MULTI_TX_QUERY = `query ($keys: [String!]!, $events: Int!) {
  multiGetTransactions(keys: $keys) {
    digest
    sender { address }
    kind {
      __typename
      ... on ProgrammableTransaction {
        commands(first: 30) {
          nodes {
            __typename
            ... on MoveCallCommand {
              function { name module { name package { address } } }
            }
          }
        }
      }
    }
    effects {
      status
      timestamp
      epoch { epochId }
      checkpoint { sequenceNumber }
      balanceChanges { nodes { amount owner { address } coinType { repr } } }
      events(first: $events) {
        pageInfo { hasNextPage }
        nodes { contents { type { repr } json } }
      }
    }
  }
}`;

interface RawTx {
  digest?: string;
  sender?: { address?: string } | null;
  kind?: {
    __typename?: string;
    commands?: {
      nodes: Array<{
        __typename?: string;
        function?: { name?: string; module?: { name?: string; package?: { address?: string } } } | null;
      }>;
    };
  } | null;
  effects?: {
    status?: string;
    timestamp?: string | null;
    epoch?: { epochId?: number } | null;
    checkpoint?: { sequenceNumber?: number } | null;
    balanceChanges?: { nodes: Array<{ amount?: string; owner?: { address?: string }; coinType?: { repr?: string } }> };
    events?: {
      pageInfo?: { hasNextPage?: boolean };
      nodes: Array<{ contents?: { type?: { repr?: string }; json?: unknown } }>;
    };
  } | null;
}

export interface BatchedTx {
  digest: string;
  sender: string | null;
  status: string | null;
  timestamp: string | null;
  epoch: string | null;
  checkpoint: string | null;
  kind: string | null;
  /** `package::module::function` for each Move call, in order. */
  move_calls: string[];
  balance_changes: Array<{ address: string; coin_type: string; amount: string }>;
  event_count: number;
  events: Array<{ type: string | null; parsed: unknown }>;
  /** True when the transaction has more events than the batch fetched. */
  events_truncated?: boolean;
  events_note?: string;
}

export interface MultiTxResult {
  found: BatchedTx[];
  /** Digests the node returned nothing for — pruned, or simply wrong. */
  not_found: string[];
  /** Digests that are not Base58 at all, rejected without a request. */
  invalid: string[];
  /** Every package implicated, for one protocol prefetch across the batch. */
  packages: string[];
}

/**
 * A digest must be Base58 that decodes to exactly 32 bytes.
 *
 * Checked before the request, because the server rejects the WHOLE batch on one
 * malformed key — a single typo among fifty digests returned nothing at all.
 * The alphabet alone is not enough: a run of 44 `1`s is valid Base58 and
 * decodes to 44 zero bytes, which the server refuses on length. Decoding is the
 * only check that matches what it will accept.
 */
function isDigest(d: string): boolean {
  try {
    return fromBase58(d).length === 32;
  } catch {
    return false;
  }
}

/** Fetch up to {@link MAX_DIGESTS} transactions in a single request. */
export async function fetchTransactions(digests: string[]): Promise<MultiTxResult> {
  const unique = [...new Set(digests)].slice(0, MAX_DIGESTS);
  const keys = unique.filter(isDigest);
  const invalid = unique.filter((d) => !isDigest(d));
  const found: BatchedTx[] = [];
  const notFound: string[] = [];
  const packages = new Set<string>();
  if (keys.length === 0) return { found, not_found: notFound, invalid, packages: [] };

  const r = await gqlQuery<{ multiGetTransactions: Array<RawTx | null> }>(MULTI_TX_QUERY, {
    keys,
    events: EVENTS_PER_TX,
  });

  // Positional: entry i answers key i, and a null means nothing was found for
  // that digest rather than a dropped result.
  r.multiGetTransactions.forEach((tx, i) => {
    if (!tx) {
      notFound.push(keys[i]);
      return;
    }
    const e = tx.effects;
    const calls: string[] = [];
    for (const c of tx.kind?.commands?.nodes ?? []) {
      const f = c.function;
      const pkg = f?.module?.package?.address;
      if (!pkg) continue;
      calls.push(`${pkg}::${f?.module?.name ?? "?"}::${f?.name ?? "?"}`);
      packages.add(pkg);
    }
    const events = (e?.events?.nodes ?? []).map((n) => {
      const type = n.contents?.type?.repr ?? null;
      const pkg = packageOfEventType(type);
      if (pkg) packages.add(pkg);
      return { type, parsed: n.contents?.json ?? null };
    });
    const truncated = Boolean(e?.events?.pageInfo?.hasNextPage);

    found.push({
      digest: tx.digest ?? keys[i],
      sender: tx.sender?.address ?? null,
      status: e?.status ?? null,
      timestamp: e?.timestamp ?? null,
      epoch: e?.epoch?.epochId != null ? String(e.epoch.epochId) : null,
      checkpoint: e?.checkpoint?.sequenceNumber != null ? String(e.checkpoint.sequenceNumber) : null,
      kind: tx.kind?.__typename ?? null,
      move_calls: calls,
      balance_changes: (e?.balanceChanges?.nodes ?? [])
        .filter((b) => b.owner?.address && b.amount)
        .map((b) => ({
          address: b.owner!.address!,
          coin_type: b.coinType?.repr ?? "",
          amount: b.amount!,
        })),
      event_count: events.length,
      events,
      ...(truncated
        ? {
            events_truncated: true,
            events_note: `This transaction has more than ${EVENTS_PER_TX} events; only the first ${EVENTS_PER_TX} are shown. Call get_transaction on this digest for the complete set — it pages them to the end.`,
          }
        : {}),
    });
  });

  return { found, not_found: notFound, invalid, packages: [...packages] };
}
