/**
 * Read whole transactions for attack analysis: every command, every event with
 * its decoded fields, every balance change and every changed object.
 *
 * Reads use gRPC. GraphQL's nested connections (commands, events, balance
 * changes) page at 20 by default, and an exploit PTB, with hundreds of commands
 * and events, overflows them. A gRPC `ExecutedTransaction` carries all of it in
 * one message, and its events carry their JSON rendering (`Event.json`), on the
 * fullnode and on the archive alike.
 *
 * `batchGetTransactions` takes many digests per request. Its limit is the
 * 4 MiB response size rather than a digest count. Batches are 25, and a batch
 * that still overflows is read one digest at a time.
 */

import type { GrpcTypes, SuiGrpcClient } from "@mysten/sui/grpc";
import { sui, archive } from "../clients/grpc.js";
import { getNetworkConfig } from "../config.js";
import { gqlQuery } from "../clients/graphql.js";
import { protoValueToJson } from "./proto.js";
import { fetchEventJson } from "./event-json.js";
import type { ArgRef, AttackCall, AttackInput, AttackTx, PureArg } from "./attack-analysis.js";
import { readGrpcObjectChanges } from "./object-flow.js";
import { gasPaidOf } from "./payouts.js";

const READ_MASK = {
  paths: ["digest", "transaction", "effects", "events", "timestamp", "checkpoint", "balance_changes"],
};

/** Digests per batch request. See the module note on the 4 MiB limit. */
const BATCH = 25;
/** Bound multi-get concurrency without serializing every page of a busy incident. */
const BATCH_CONCURRENCY = 4;

const COMMAND_KIND: Record<string, string> = {
  moveCall: "MoveCall",
  transferObjects: "TransferObjects",
  splitCoins: "SplitCoins",
  mergeCoins: "MergeCoins",
  publish: "Publish",
  makeMoveVector: "MakeMoveVector",
  upgrade: "Upgrade",
};

/** gRPC argument kinds. */
const ARGUMENT_GAS = 1;
const ARGUMENT_INPUT = 2;
const ARGUMENT_RESULT = 3;

/** gRPC `Owner.kind` of a consensus object, and of an object owned by another object. */
const OWNER_SHARED = 3;
const OWNER_OBJECT = 2;
const OWNER_ADDRESS = 1;
const OWNER_CONSENSUS_ADDRESS = 5;

/** gRPC `ChangedObject` input and output states. */
const INPUT_EXISTS = 2;
const OUTPUT_OBJECT_WRITE = 2;

/** gRPC `UnchangedConsensusObject.kind` of a consensus object read and not changed. */
const READ_ONLY_ROOT = 1;

/** gRPC `Input.kind` of a shared object input. */
const INPUT_SHARED = 3;

/** Byte lengths a Move unsigned integer takes in BCS: u8 through u256. */
const UINT_WIDTHS = new Set([1, 2, 4, 8, 16, 32]);

/**
 * A pure input as the caller sent it: its length, and its value read as a
 * little-endian unsigned integer when the length is one an integer can have.
 * The Move type is not known here, so a 32-byte address reads as a u256 too;
 * callers compare these values against numbers, never display them as such.
 */
export function readPureArg(bytes: Uint8Array): PureArg {
  if (!UINT_WIDTHS.has(bytes.length)) return { bytes: bytes.length, uint: null };
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return { bytes: bytes.length, uint: v.toString() };
}

/**
 * The unsigned integers a pure input can carry. A length that is an integer
 * width reads as one value; a ULEB128 length followed by exactly that many
 * 8- or 16-byte words reads as a `vector<u64>` or `vector<u128>`. A pure of any
 * other length (an address list, a string, a signature) carries none.
 */
export function pureValues(bytes: Uint8Array): string[] {
  const whole = readPureArg(bytes).uint;
  let n = 0;
  let pos = 0;
  while (pos < bytes.length && pos < 5) {
    const b = bytes[pos];
    n += (b & 0x7f) * 2 ** (7 * pos);
    pos++;
    if ((b & 0x80) === 0) break;
  }
  const rest = bytes.length - pos;
  const out = whole !== null ? [whole] : [];
  for (const width of [8, 16]) {
    if (n === 0 || rest !== n * width) continue;
    for (let i = 0; i < n; i++) out.push(readPureArg(bytes.subarray(pos + i * width, pos + (i + 1) * width)).uint!);
  }
  return out;
}

function argRef(a: GrpcTypes.Argument): ArgRef | null {
  if (a.kind === ARGUMENT_INPUT && a.input !== undefined) return { input: a.input };
  if (a.kind === ARGUMENT_RESULT && a.result !== undefined) return { result: a.result };
  if (a.kind === ARGUMENT_GAS) return { gas: true };
  return null;
}

/**
 * An `ExecutedTransaction` in the shape `attack-analysis.ts` reads. Pure, so
 * the mapping from the wire format is tested on a real response.
 */
export function fromGrpcTransaction(t: GrpcTypes.ExecutedTransaction): AttackTx {
  const data = t.transaction?.kind?.data;
  const ptb = data?.oneofKind === "programmableTransaction" ? data.programmableTransaction : null;
  const inputs = ptb?.inputs ?? [];
  // A shared input taken mutably, for effects that do not carry the input owner.
  const sharedInputs = new Set(inputs.filter((i) => i.kind === INPUT_SHARED && i.mutable && i.objectId).map((i) => i.objectId!));
  const commandKinds: string[] = [];
  const calls: AttackCall[] = [];
  const vectors: NonNullable<AttackTx["vectors"]> = [];
  (ptb?.commands ?? []).forEach((cmd, i) => {
    const kind = cmd.command.oneofKind;
    commandKinds.push(kind ? (COMMAND_KIND[kind] ?? kind) : "Unknown");
    if (kind === "makeMoveVector") {
      vectors.push({ command: i, elements: (cmd.command.makeMoveVector.elements ?? []).flatMap((a) => argRef(a) ?? []) });
      return;
    }
    if (kind !== "moveCall") return;
    const mc = cmd.command.moveCall;
    const inputArgs = (mc.arguments ?? [])
      .filter((a) => a.kind === ARGUMENT_INPUT && a.input !== undefined)
      .map((a) => inputs[a.input!])
      .filter((inp): inp is GrpcTypes.Input => inp !== undefined);
    const objectArgs = inputArgs.map((inp) => inp.objectId).filter((id): id is string => Boolean(id));
    const pureArgs = inputArgs.flatMap((inp) => (inp.pure ? [readPureArg(inp.pure)] : []));
    calls.push({
      command: i,
      package: mc.package ?? "",
      module: mc.module ?? "",
      function: mc.function ?? "",
      typeArguments: mc.typeArguments ?? [],
      objectArgs: [...new Set(objectArgs)],
      pureArgs,
      args: (mc.arguments ?? []).flatMap((a) => argRef(a) ?? []),
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
    bcs: t.transaction?.bcs?.value ?? null,
    movements: readGrpcObjectChanges(t.effects?.changedObjects ?? []),
    gas: gasPaidOf(t.effects?.gasUsed, t.transaction?.gasPayment?.owner),
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
    objects: (t.effects?.changedObjects ?? []).map((o) => {
      const kind = o.inputOwner?.kind ?? o.outputOwner?.kind;
      const parent = kind === OWNER_OBJECT ? (o.inputOwner?.address ?? o.outputOwner?.address ?? null) : null;
      return {
        objectId: o.objectId ?? "",
        objectType: o.objectType ?? null,
        shared:
          o.inputOwner?.kind === OWNER_SHARED ||
          o.inputOwner?.kind === OWNER_CONSENSUS_ADDRESS ||
          (o.objectId !== undefined && sharedInputs.has(o.objectId)),
        parent,
        inputVersion: o.inputState === INPUT_EXISTS && o.inputVersion !== undefined ? o.inputVersion.toString() : null,
        outputVersion: o.outputState === OUTPUT_OBJECT_WRITE && o.outputVersion !== undefined ? o.outputVersion.toString() : null,
        heldBy:
          o.inputOwner?.kind === OWNER_ADDRESS && o.outputOwner?.kind === OWNER_ADDRESS && o.inputOwner.address === o.outputOwner.address
            ? (o.inputOwner.address ?? null)
            : null,
      };
    }),
    readShared: (t.effects?.unchangedConsensusObjects ?? []).flatMap((u) =>
      u.kind === READ_ONLY_ROOT && u.objectId && u.version !== undefined ? [{ objectId: u.objectId, version: u.version.toString(), objectType: u.objectType ?? null }] : [],
    ),
    inputs: inputs.map((inp): AttackInput => ({
      objectId: inp.objectId ?? null,
      bytes: inp.pure?.length ?? 0,
      values: inp.pure ? pureValues(inp.pure) : [],
    })),
    vectors,
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
  for (let i = 0; i < digests.length; i += BATCH * BATCH_CONCURRENCY) {
    const batches = Array.from({ length: Math.min(BATCH_CONCURRENCY, Math.ceil((digests.length - i) / BATCH)) },
      (_, n) => digests.slice(i + n * BATCH, i + (n + 1) * BATCH));
    await Promise.all(batches.map((batch) => batchRead(sui, batch, found)));
  }
  let servedByArchive = 0;
  const pruned = digests.filter((d) => !found.has(d));
  if (pruned.length > 0 && getNetworkConfig().archive !== null) {
    const before = found.size;
    for (let i = 0; i < pruned.length; i += BATCH * BATCH_CONCURRENCY) {
      const batches = Array.from({ length: Math.min(BATCH_CONCURRENCY, Math.ceil((pruned.length - i) / BATCH)) },
        (_, n) => pruned.slice(i + n * BATCH, i + (n + 1) * BATCH));
      await Promise.all(batches.map((batch) => batchRead(archive, batch, found)));
    }
    servedByArchive = found.size - before;
  }

  const txs: AttackTx[] = [];
  const eventsUndecoded: string[] = [];
  for (const d of digests) {
    const t = found.get(d);
    if (!t) continue;
    const tx = fromGrpcTransaction(t);
    // Fullnodes and the archive fill `Event.json`. Should one not, GraphQL
    // decodes the same events, joined by position only when the counts agree.
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
