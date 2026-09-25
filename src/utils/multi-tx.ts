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
 * `multiGetTransactions` reads the fullnode only, and mainnet prunes
 * continuously — digests sampled 200k checkpoints back disappeared mid-test.
 * Anything the batch misses is therefore retried one at a time through the same
 * archive path `get_transaction` uses, because a batch tool that quietly knows
 * less than the single tool is a trap: the caller reached for it to save round
 * trips, not to accept a worse answer.
 *
 * The archive cannot decode event fields — gRPC carries no parsed JSON and the
 * pruned transaction is gone from GraphQL — so recovered events arrive typed
 * but unparsed, and say so. That is the one thing `get_transaction` also cannot
 * do for a pruned digest, so the two remain equally capable.
 *
 * Events are the one place this trades depth for breadth. The connection is
 * asked for a page and reports whether more exist, rather than being paged to
 * exhaustion for every transaction in a batch — that would put a batch of fifty
 * back into dozens of requests. A transaction with more events says so and
 * names `get_transaction` as the way to read all of them, so the limit is
 * visible rather than a silent truncation.
 */

import type { GrpcTypes } from "@mysten/sui/grpc";
import { gqlQuery } from "../clients/graphql.js";
import { packageOfEventType } from "./event-json.js";
import { withArchiveFallback } from "./archive-fallback.js";
import { formatStatus, describeFailure, bigintToString, timestampToIso, type FailureDetail } from "./formatting.js";
import { isDigest } from "./digest.js";
import { BALANCE_CHANGES_SELECTION, COMMANDS_SELECTION, completeTxConnections, type GqlConnection } from "./tx-connections.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "./gql-adapters.js";

/**
 * The null address, which is what a system transaction's sender is.
 *
 * GraphQL reports that as `sender: null` while gRPC reports the address, so the
 * batch tool and `get_transaction` disagreed on 15 of 24 real digests until this
 * was normalised. Two tools describing one transaction differently is worse
 * than either description alone.
 */
const SYSTEM_SENDER = `0x${"0".repeat(64)}`;

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
        ${COMMANDS_SELECTION}
      }
      # A distinct type from ProgrammableTransaction, and easy to miss: it
      # carries real Move calls (framework settlement, randomness) that a
      # fragment on ProgrammableTransaction alone never sees. Omitting it made
      # this tool report no protocols where get_transaction reported "Sui
      # Framework", on 7 of 24 cross-checked digests.
      ... on ProgrammableSystemTransaction {
        ${COMMANDS_SELECTION}
      }
    }
    effects {
      status
      # Why it failed. GraphQL exposes less than gRPC does: no clever-error
      # constant name, and sourceLineNumber / identifier came back null on every
      # mainnet failure sampled. The abort code, module and function are all
      # here though, which is what makes an abort readable.
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

interface GqlExecutionError {
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
 * The kind is always `MOVE_ABORT` here: GraphQL only populates
 * `executionError` for aborts, and reports every other failure as a bare
 * `FAILURE` status. `get_transaction` reads over gRPC and distinguishes all of
 * them — the same breadth-here-depth-there boundary this file applies to
 * events.
 */
function failureFromGraphql(e: GqlExecutionError): FailureDetail {
  const out: FailureDetail = { kind: "MOVE_ABORT" };
  if (e.abortCode != null) out.abort_code = String(e.abortCode);
  if (e.message) out.description = e.message;
  const pkg = e.module?.package?.address;
  if (pkg || e.module?.name || e.function?.name || e.instructionOffset != null) {
    out.location = {
      ...(pkg ? { package: pkg } : {}),
      ...(e.module?.name ? { module: e.module.name } : {}),
      ...(e.function?.name ? { function: e.function.name } : {}),
      ...(e.instructionOffset != null ? { instruction: e.instructionOffset } : {}),
    };
  }
  // Null on every mainnet failure sampled, but populated for a package built
  // with clever errors — carried through rather than assumed absent.
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
 * Checked before the request, because the server rejects the WHOLE batch on one
 * malformed key — a single typo among fifty digests returned nothing at all.
 * See {@link isDigest}.
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
    event_count: events.length,
    events,
    ...(kind?.data.oneofKind && kind.data.oneofKind !== "programmableTransaction"
      ? { is_system: true }
      : {}),
    from_archive: true,
    ...(events.length > 0
      ? {
          events_note:
            "Recovered from the archive, where events carry a type but no decoded fields — the parsed values live only in GraphQL, which no longer has this transaction.",
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
