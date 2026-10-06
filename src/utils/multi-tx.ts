/**
 * Read up to 50 transactions in one GraphQL batch. A second, smaller batched
 * query reads object changes without adding a network call per ordinary digest.
 * Missing transactions use the gRPC archive fallback, whose effects include
 * complete changed-object records.
 *
 * Connections for commands and balances are completed. Events are a 50-row
 * page; object changes are read for up to five 50-row pages per transaction.
 * An incomplete read is flagged so callers can use get_transaction for depth.
 */

import type { GrpcTypes } from "@mysten/sui/grpc";
import { gqlQuery } from "../clients/graphql.js";
import { packageOfEventType } from "./event-json.js";
import { withArchiveFallback } from "./archive-fallback.js";
import {
  formatStatus,
  describeFailure,
  bigintToString,
  timestampToIso,
  failureKindFromGraphql,
  commandIndexFromGraphqlMessage,
  KIND_NOTES,
  type FailureDetail,
} from "./formatting.js";
import { isDigest } from "./digest.js";
import {
  BALANCE_CHANGES_SELECTION,
  COMMANDS_SELECTION,
  completeTxConnections,
  NESTED_PAGE_SIZE,
  OBJECT_CHANGE_PAGE,
  readAllObjectChanges,
  type GqlConnection,
} from "./tx-connections.js";
import type { GqlObjectChange, GrpcChangedObject } from "./object-flow.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "./gql-adapters.js";

/**
 * The null address, which is what a system transaction's sender is.
 *
 * GraphQL reports that as `sender: null` while gRPC reports the address. It is
 * normalised here so the batch tool and `get_transaction` describe one
 * transaction the same way.
 */
const SYSTEM_SENDER = `0x${"0".repeat(64)}`;

/** Digests per request. GraphQL's page cap, and a sane batch size. */
export const MAX_DIGESTS = 50;

/** Events fetched per transaction inside a batch. */
const EVENTS_PER_TX = 50;

/** At most ten object connections per GraphQL document. */
const OBJECT_BATCH_SIZE = 10;

const OBJECT_BATCH_QUERY = `query($keys: [String!]!) {
    multiGetTransactions(keys: $keys) {
        digest effects { objectChanges(first: ${NESTED_PAGE_SIZE}) { ${OBJECT_CHANGE_PAGE} } }
    }
}`;

async function objectChangesForBatch(keys: string[]): Promise<Map<string, { nodes: GqlObjectChange[]; truncated: boolean }>> {
  const results = new Map<string, { nodes: GqlObjectChange[]; truncated: boolean }>();
  for (let start = 0; start < keys.length; start += OBJECT_BATCH_SIZE) {
    const chunk = keys.slice(start, start + OBJECT_BATCH_SIZE);
    let rows: Array<{ effects?: { objectChanges?: GqlConnection<GqlObjectChange> | null } | null } | null> | undefined;
    try {
      const response = await gqlQuery<{ multiGetTransactions: typeof rows }>(OBJECT_BATCH_QUERY, { keys: chunk });
      rows = response.multiGetTransactions;
    } catch {
      // A failed batch is unknown, not evidence that these transactions moved no objects.
    }
    const read = await Promise.all(chunk.map(async (digest, i) => {
      const first = rows?.[i]?.effects?.objectChanges;
      if (!first || !Array.isArray(first.nodes)) return { nodes: [], truncated: true };
      // A first page that does not say it is the last is not read as complete.
      const page = first.pageInfo?.hasNextPage === false
        ? first
        : { nodes: first.nodes, pageInfo: { hasNextPage: true, endCursor: first.pageInfo?.endCursor } };
      const all = await readAllObjectChanges(digest, page);
      return { nodes: all.nodes, truncated: all.truncated };
    }));
    chunk.forEach((digest, i) => results.set(digest, read[i]!));
  }
  return results;
}

const MULTI_TX_QUERY = `query ($keys: [String!]!, $events: Int!) {
  multiGetTransactions(keys: $keys) {
    digest
    sender { address }
    kind {
      __typename
      ... on ProgrammableTransaction {
        ${COMMANDS_SELECTION}
      }
      # A distinct type from ProgrammableTransaction, and easy to miss: it
      # carries real Move calls (framework settlement, randomness) that a
      # fragment on ProgrammableTransaction alone never sees. Without it this
      # tool would report no protocols where get_transaction reports "Sui
      # Framework".
      ... on ProgrammableSystemTransaction {
        ${COMMANDS_SELECTION}
      }
    }
    effects {
      status
      # Why it failed. GraphQL exposes less than gRPC does: no clever-error
      # constant name, and sourceLineNumber / identifier can come back null.
      # The abort code, module and function are all here though, which is what
      # makes an abort readable.
      executionError {
        abortCode
        instructionOffset
        identifier
        constant
        sourceLineNumber
        message
        module { name package { address } }
        function { name }
      }
      timestamp
      epoch { epochId }
      checkpoint { sequenceNumber }
      ${BALANCE_CHANGES_SELECTION}
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
    commands?: GqlConnection<GqlCommandNode>;
  } | null;
  effects?: {
    status?: string;
    executionError?: GqlExecutionError | null;
    timestamp?: string | null;
    epoch?: { epochId?: number } | null;
    checkpoint?: { sequenceNumber?: number } | null;
    balanceChanges?: GqlConnection<GqlBalanceChangeNode>;
    events?: {
      pageInfo?: { hasNextPage?: boolean };
      nodes: Array<{ contents?: { type?: { repr?: string }; json?: unknown } }>;
    };
  } | null;
}

export interface GqlExecutionError {
  abortCode?: string | null;
  instructionOffset?: number | null;
  identifier?: string | null;
  constant?: string | null;
  sourceLineNumber?: number | null;
  message?: string | null;
  module?: { name?: string | null; package?: { address?: string | null } | null } | null;
  function?: { name?: string | null } | null;
}

/**
 * Map GraphQL's execution error onto the same shape gRPC produces, so a caller
 * reading `failure` does not have to know which transport served the batch.
 *
 * GraphQL reports no failure kind. `abortCode` is set for Move aborts only,
 * and every other failure is named from its message by
 * {@link failureKindFromGraphql}. `get_transaction` reads over gRPC and gets
 * the kind directly, along with details GraphQL does not expose — the same
 * breadth-here-depth-there boundary this file applies to events.
 */
export function failureFromGraphql(e: GqlExecutionError): FailureDetail {
  const kind = failureKindFromGraphql(e.message, e.abortCode);
  const out: FailureDetail = { kind };
  if (e.abortCode != null) {
    out.abort_code = String(e.abortCode);
  } else {
    const command = commandIndexFromGraphqlMessage(e.message);
    if (command !== undefined) out.command = command;
  }
  if (e.message) out.description = e.message;
  if (KIND_NOTES[kind]) out.note = KIND_NOTES[kind];
  const pkg = e.module?.package?.address;
  if (pkg || e.module?.name || e.function?.name || e.instructionOffset != null) {
    out.location = {
      ...(pkg ? { package: pkg } : {}),
      ...(e.module?.name ? { module: e.module.name } : {}),
      ...(e.function?.name ? { function: e.function.name } : {}),
      ...(e.instructionOffset != null ? { instruction: e.instructionOffset } : {}),
    };
  }
  // Populated only for a package built with clever errors, and carried
  // through rather than assumed absent.
  if (e.constant || e.identifier || e.sourceLineNumber != null) {
    out.clever_error = {
      ...(e.constant ? { constant_name: e.constant } : {}),
      ...(e.identifier ? { rendered: e.identifier } : {}),
      ...(e.sourceLineNumber != null ? { line_number: e.sourceLineNumber } : {}),
    };
  }
  return out;
}

export interface BatchedTx {
  digest: string;
  sender: string | null;
  status: string | null;
  /** Why it failed, when it did. Absent on success. */
  failure?: FailureDetail;
  timestamp: string | null;
  epoch: string | null;
  checkpoint: string | null;
  kind: string | null;
  /** `package::module::function` for each Move call, in order. */
  move_calls: string[];
  balance_changes: Array<{ address: string; coin_type: string; amount: string }>;
  /** Internal chain rows, rendered as custody and creations after protocol prefetch. */
  object_changes: { gql: GqlObjectChange[] } | { grpc: GrpcChangedObject[] };
  /** The object read failed, ran out of cursor, or reached its five-page bound. */
  object_changes_truncated?: boolean;
  event_count: number;
  events: Array<{ type: string | null; parsed: unknown }>;
  /** True for a system transaction — consensus, randomness, checkpoint plumbing. */
  is_system?: boolean;
  /** True when this came from the archive rather than the fullnode. */
  from_archive?: boolean;
  /** True when a follow-up read for balance changes failed, so the list is partial. */
  balance_changes_truncated?: boolean;
  /** True when a follow-up read for commands failed, so `move_calls` is partial. */
  move_calls_truncated?: boolean;
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
 * Checked before the request, because the server rejects the whole batch on
 * one malformed key, so a single typo among fifty digests would return
 * nothing at all. See {@link isDigest}.
 */

/** Map one gRPC transaction into the batch shape. */
function fromGrpc(res: GrpcTypes.GetTransactionResponse, digest: string): BatchedTx | null {
  const tx = res.transaction;
  if (!tx) return null;
  const e = tx.effects;
  const kind = tx.transaction?.kind;
  const calls: string[] = [];
  if (kind?.data.oneofKind === "programmableTransaction") {
    for (const cmd of kind.data.programmableTransaction.commands) {
      const c = cmd.command;
      if (c.oneofKind === "moveCall" && c.moveCall.package) {
        calls.push(`${c.moveCall.package}::${c.moveCall.module ?? "?"}::${c.moveCall.function ?? "?"}`);
      }
    }
  }
  const events = (tx.events?.events ?? []).map((ev) => ({ type: ev.eventType ?? null, parsed: null }));
  return {
    digest: tx.digest ?? digest,
    sender: tx.transaction?.sender ?? null,
    status: formatStatus(e?.status) ?? null,
    ...(describeFailure(e?.status) ? { failure: describeFailure(e?.status) } : {}),
    timestamp: timestampToIso(tx.timestamp) ?? null,
    epoch: bigintToString(e?.epoch) ?? null,
    checkpoint: bigintToString(tx.checkpoint) ?? null,
    kind: kind?.data.oneofKind ?? null,
    move_calls: calls,
    balance_changes: (tx.balanceChanges ?? [])
      .filter((b) => b.address && b.amount)
      .map((b) => ({ address: b.address!, coin_type: b.coinType ?? "", amount: b.amount! })),
    object_changes: { grpc: e?.changedObjects ?? [] },
    event_count: events.length,
    events,
    ...(kind?.data.oneofKind && kind.data.oneofKind !== "programmableTransaction"
      ? { is_system: true }
      : {}),
    from_archive: true,
    ...(events.length > 0
      ? {
          events_note:
            "The batch archive path reports event types without decoded fields. Use get_transaction on this digest to read the archive event JSON.",
        }
      : {}),
  };
}

/**
 * Retry misses one at a time through gRPC and the archive.
 *
 * Bounded: this is the slow path, and a caller who asked for fifty digests and
 * missed forty is usually holding the wrong digests rather than forty pruned
 * transactions.
 */
async function recoverFromArchive(
  digests: string[],
  limit: number,
): Promise<{ recovered: BatchedTx[]; stillMissing: string[]; attempted: number }> {
  const attempt = digests.slice(0, limit);
  const settled = await Promise.allSettled(
    attempt.map((digest) =>
      withArchiveFallback<GrpcTypes.GetTransactionResponse>(
        (client) =>
          client.ledgerService.getTransaction({
            digest,
            readMask: {
              paths: ["digest", "transaction", "effects", "events", "checkpoint", "timestamp", "balance_changes"],
            },
          }),
        (r) => !r.transaction,
      ).then((r) => fromGrpc(r, digest)),
    ),
  );
  const recovered: BatchedTx[] = [];
  const stillMissing: string[] = [...digests.slice(limit)];
  settled.forEach((s, i) => {
    const tx = s.status === "fulfilled" ? s.value : null;
    if (tx) recovered.push(tx);
    else stillMissing.push(attempt[i]);
  });
  return { recovered, stillMissing, attempted: attempt.length };
}

/** Fetch up to {@link MAX_DIGESTS} transactions in a single request. */
export async function fetchTransactions(
  digests: string[],
  archiveLimit = MAX_DIGESTS,
): Promise<MultiTxResult> {
  const unique = [...new Set(digests)].slice(0, MAX_DIGESTS);
  const keys = unique.filter(isDigest);
  const invalid = unique.filter((d) => !isDigest(d));
  const found: BatchedTx[] = [];
  const notFound: string[] = [];
  const packages = new Set<string>();
  if (keys.length === 0) return { found, not_found: notFound, invalid, packages: [] };

  // A GraphQL failure must not sink the whole batch. `graphql-request` throws on
  // any `errors` array — even beside partial data — and `get_transaction` is
  // gRPC-first and would still answer, so failing here outright would make the
  // batch strictly worse than the tool it replaces. Every digest goes to the
  // archive path instead.
  let r: { multiGetTransactions: Array<RawTx | null> };
  try {
    r = await gqlQuery<{ multiGetTransactions: Array<RawTx | null> }>(MULTI_TX_QUERY, {
      keys,
      events: EVENTS_PER_TX,
    });
  } catch {
    r = { multiGetTransactions: keys.map(() => null) };
  }

  // Balance changes and commands arrive 50 to a page; a transaction with more
  // is completed by digest before it is reported.
  const completed = await completeTxConnections(
    r.multiGetTransactions.map((tx, i) => ({
      digest: tx?.digest ?? keys[i],
      balanceChanges: tx?.effects?.balanceChanges,
      commands: tx?.kind?.commands,
    })),
  );

  const objectRows = await objectChangesForBatch(
    r.multiGetTransactions.flatMap((tx, i) =>
      tx && (tx.kind?.__typename || tx.effects?.balanceChanges?.nodes?.length || tx.effects?.events?.nodes?.length)
        ? [keys[i]] : []),
  );

  // Positional: entry i answers key i, and a null means nothing was found for
  // that digest rather than a dropped result.
  r.multiGetTransactions.forEach((tx, i) => {
    if (!tx) {
      notFound.push(keys[i]);
      return;
    }
    const e = tx.effects;
    // A record with no kind, no balances and no events is the HOLLOW shape a
    // pruned digest produces: digest and timestamp present, everything that
    // matters missing. Reporting it as a transaction that moved nothing is the
    // failure `trace_funds` already guards against, so it is absence here too.
    const hollow =
      !tx.kind?.__typename &&
      (e?.balanceChanges?.nodes?.length ?? 0) === 0 &&
      (e?.events?.nodes?.length ?? 0) === 0;
    if (hollow) {
      notFound.push(keys[i]);
      return;
    }
    const calls: string[] = [];
    for (const c of completed[i].commands) {
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

    const isSystem = Boolean(tx.kind?.__typename) && tx.kind!.__typename !== "ProgrammableTransaction";
    found.push({
      digest: tx.digest ?? keys[i],
      // Null from GraphQL on a transaction that plainly exists means the null
      // address, which is how gRPC reports it.
      sender: tx.sender?.address ?? (tx.kind?.__typename ? SYSTEM_SENDER : null),
      status: e?.status ? e.status.toLowerCase() : null,
      ...(e?.executionError ? { failure: failureFromGraphql(e.executionError) } : {}),
      timestamp: e?.timestamp ?? null,
      epoch: e?.epoch?.epochId != null ? String(e.epoch.epochId) : null,
      checkpoint: e?.checkpoint?.sequenceNumber != null ? String(e.checkpoint.sequenceNumber) : null,
      kind: tx.kind?.__typename ?? null,
      move_calls: calls,
      balance_changes: completed[i].balanceChanges
        .filter((b) => b.owner?.address && b.amount)
        .map((b) => ({
          address: b.owner!.address!,
          coin_type: b.coinType?.repr ?? "",
          amount: b.amount!,
        })),
      object_changes: { gql: objectRows.get(keys[i])?.nodes ?? [] },
      ...(objectRows.get(keys[i])?.truncated ? { object_changes_truncated: true } : {}),
      event_count: events.length,
      events,
      ...(isSystem ? { is_system: true } : {}),
      ...(completed[i].balanceChangesTruncated ? { balance_changes_truncated: true } : {}),
      ...(completed[i].commandsTruncated ? { move_calls_truncated: true } : {}),
      ...(truncated
        ? {
            events_truncated: true,
            events_note: `This transaction has more than ${EVENTS_PER_TX} events; only the first ${EVENTS_PER_TX} are shown. Call get_transaction on this digest for the complete set — it pages them to the end.`,
          }
        : {}),
    });
  });

  // Anything the fullnode missed gets the archive path the single tool uses.
  if (notFound.length > 0 && archiveLimit > 0) {
    const { recovered, stillMissing } = await recoverFromArchive(notFound, archiveLimit);
    for (const tx of recovered) {
      found.push(tx);
      for (const call of tx.move_calls) packages.add(call.split("::")[0]);
      for (const ev of tx.events) {
        const pkg = packageOfEventType(ev.type);
        if (pkg) packages.add(pkg);
      }
    }
    notFound.length = 0;
    notFound.push(...stillMissing);
  }

  return { found, not_found: notFound, invalid, packages: [...packages] };
}
