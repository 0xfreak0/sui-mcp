/**
 * Read whole transactions for attack analysis: every command, every event with
 * its decoded fields, every balance change and every changed object.
 *
 * gRPC, not GraphQL. GraphQL's nested connections (commands, events, balance
 * changes) page at 20 by default, and an exploit PTB is exactly the shape that
 * overflows them: the Nemo exploit ran 214 commands and emitted 103 events. A
 * gRPC `ExecutedTransaction` carries all of it in one message, and its events
 * carry their JSON rendering (`Event.json`), on the fullnode and on the
 * archive alike. Verified on mainnet: the archive returned decoded fields for
 * all 6 events of the Cetus exploit and all 103 of the Nemo one.
 *
 * `batchGetTransactions` takes many digests per request. Its limit is the
 * 4 MiB response, not a count: 100 Cetus exploit transactions came back in one
 * call and 200 overflowed it. Batches are 25, and a batch that still overflows
 * is read one digest at a time.
 */

import type { GrpcTypes, SuiGrpcClient } from "@mysten/sui/grpc";
import { sui, archive } from "../clients/grpc.js";
import { getNetworkConfig } from "../config.js";
import { gqlQuery } from "../clients/graphql.js";
import { protoValueToJson } from "./proto.js";
import { fetchEventJson } from "./event-json.js";
import type { AttackCall, AttackTx } from "./attack-analysis.js";

const READ_MASK = {
  paths: ["digest", "transaction", "effects", "events", "timestamp", "checkpoint", "balance_changes"],
};

/** Digests per batch request. See the module note on the 4 MiB limit. */
const BATCH = 25;

const COMMAND_KIND: Record<string, string> = {
  moveCall: "MoveCall",
  transferObjects: "TransferObjects",
  splitCoins: "SplitCoins",
  mergeCoins: "MergeCoins",
  publish: "Publish",
  makeMoveVector: "MakeMoveVector",
  upgrade: "Upgrade",
};

/** The gRPC argument kind for "an input of this PTB". */
const ARGUMENT_INPUT = 2;

/**
 * An `ExecutedTransaction` in the shape `attack-analysis.ts` reads. Pure, so
 * the mapping from the wire format is tested on a real response.
 */
export function fromGrpcTransaction(t: GrpcTypes.ExecutedTransaction): AttackTx {
  const data = t.transaction?.kind?.data;
  const ptb = data?.oneofKind === "programmableTransaction" ? data.programmableTransaction : null;
  const inputs = ptb?.inputs ?? [];
  const commandKinds: string[] = [];
  const calls: AttackCall[] = [];
  (ptb?.commands ?? []).forEach((cmd, i) => {
    const kind = cmd.command.oneofKind;
    commandKinds.push(kind ? (COMMAND_KIND[kind] ?? kind) : "Unknown");
    if (kind !== "moveCall") return;
    const mc = cmd.command.moveCall;
    const objectArgs = (mc.arguments ?? [])
      .filter((a) => a.kind === ARGUMENT_INPUT && a.input !== undefined)
      .map((a) => inputs[a.input!]?.objectId)
      .filter((id): id is string => Boolean(id));
    calls.push({
      command: i,
      package: mc.package ?? "",
      module: mc.module ?? "",
      function: mc.function ?? "",
      typeArguments: mc.typeArguments ?? [],
      objectArgs: [...new Set(objectArgs)],
    });
  });
  const ts = t.timestamp;
  return {
    digest: t.digest ?? "",
    sender: t.transaction?.sender ?? null,
    success: t.effects?.status?.success === true,
    timestampMs: ts ? Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1_000_000) : null,
    checkpoint: t.checkpoint !== undefined ? t.checkpoint.toString() : null,
    commandKinds,
    calls,
    events: (t.events?.events ?? []).map((e, index) => ({
      index,
      type: e.eventType ?? "",
      json: e.json ? (protoValueToJson(e.json) ?? null) : null,
    })),
    balanceChanges: (t.balanceChanges ?? []).map((b) => ({
      address: b.address ?? "",
      coinType: b.coinType ?? "",
      amount: b.amount ?? "0",
    })),
    objects: (t.effects?.changedObjects ?? []).map((o) => ({
      objectId: o.objectId ?? "",
      objectType: o.objectType ?? null,
    })),
  };
}

type Found = Map<string, GrpcTypes.ExecutedTransaction>;

async function batchRead(client: SuiGrpcClient, digests: string[], found: Found): Promise<void> {
  try {
    const { response } = await client.ledgerService.batchGetTransactions({ digests, readMask: READ_MASK });
    response.transactions.forEach((r, i) => {
      if (r.result.oneofKind === "transaction") found.set(digests[i], r.result.transaction);
    });
  } catch {
    // Most often the response limit. One at a time cannot overflow it.
    for (const digest of digests) {
      try {
        const { response } = await client.ledgerService.getTransaction({ digest, readMask: READ_MASK });
        if (response.transaction) found.set(digest, response.transaction);
      } catch {
        // NOT_FOUND here is pruning or a wrong digest; the caller retries the
        // archive and then reports what is still missing.
      }
    }
  }
}

export interface AttackRead {
  txs: AttackTx[];
  /** Digests neither the fullnode nor the archive returned. */
  missing: string[];
  served_by_archive: number;
  /** Transactions whose event fields could not be decoded. */
  events_undecoded: string[];
}

/**
 * Read transactions in full, fullnode first and the archive for whatever it
 * pruned. Output order follows `digests`.
 */
export async function readAttackTransactions(digests: string[]): Promise<AttackRead> {
  const found: Found = new Map();
  for (let i = 0; i < digests.length; i += BATCH) {
    await batchRead(sui, digests.slice(i, i + BATCH), found);
  }
  let servedByArchive = 0;
  const pruned = digests.filter((d) => !found.has(d));
  if (pruned.length > 0 && getNetworkConfig().archive !== null) {
    const before = found.size;
    for (let i = 0; i < pruned.length; i += BATCH) {
      await batchRead(archive, pruned.slice(i, i + BATCH), found);
    }
    servedByArchive = found.size - before;
  }

  const txs: AttackTx[] = [];
  const eventsUndecoded: string[] = [];
  for (const d of digests) {
    const t = found.get(d);
    if (!t) continue;
    const tx = fromGrpcTransaction(t);
    // Every node probed fills `Event.json`. Should one not, GraphQL decodes
    // the same events, joined by position only when the counts agree.
    if (tx.events.some((e) => e.json === null)) {
      const parsed = await fetchEventJson(d);
      if (parsed && parsed.length === tx.events.length) {
        tx.events = tx.events.map((e, i) => ({ ...e, json: e.json ?? parsed[i].json }));
      } else {
        eventsUndecoded.push(d);
      }
    }
    txs.push(tx);
  }
  return { txs, missing: digests.filter((d) => !found.has(d)), served_by_archive: servedByArchive, events_undecoded: eventsUndecoded };
}

const SENT_QUERY = `query ($filter: TransactionFilter, $first: Int, $after: String) {
  transactions(filter: $filter, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { digest }
  }
}`;

/**
 * Digests a sender signed inside a checkpoint window, oldest first, up to
 * `max`. `truncated` is proven by a further page, not inferred from a full one.
 */
export async function digestsSentBy(
  sender: string,
  window: { afterCheckpoint?: number; beforeCheckpoint?: number },
  max: number,
): Promise<{ digests: string[]; truncated: boolean }> {
  const filter: Record<string, unknown> = { sentAddress: sender };
  if (window.afterCheckpoint !== undefined) filter.afterCheckpoint = window.afterCheckpoint;
  if (window.beforeCheckpoint !== undefined) filter.beforeCheckpoint = window.beforeCheckpoint;
  const digests: string[] = [];
  let after: string | undefined;
  for (;;) {
    const r = await gqlQuery<{
      transactions: { pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: Array<{ digest: string }> };
    }>(SENT_QUERY, { filter, first: 50, after });
    for (const n of r.transactions.nodes) {
      if (digests.length === max) return { digests, truncated: true };
      digests.push(n.digest);
    }
    if (!r.transactions.pageInfo.hasNextPage) return { digests, truncated: false };
    const next = r.transactions.pageInfo.endCursor;
    if (!next) return { digests, truncated: true };
    after = next;
  }
}
