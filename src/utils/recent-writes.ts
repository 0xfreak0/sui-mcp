/**
 * Shared objects another address rewrote in the seconds before a transaction
 * read them, where the rewrite changed what decides where the transaction's
 * value goes.
 *
 * A signed transaction binds a shared object by id, not by its contents. An
 * object whose fields route or size transfers (recipients, amounts, an
 * enabled flag) can be changed by whoever may write it after the signer
 * approved the transaction and before it runs, and whoever submits the
 * transaction (a gas sponsor holding the signed bytes) chooses that moment.
 * A dry run against the earlier state shows nothing leaving.
 *
 * No rule here reads a field name. A write counts when it flips a boolean,
 * sets an address that gains value in this transaction, or sets a number
 * equal to an amount this transaction moved.
 */

import type { GrpcTypes } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { archive, sui } from "../clients/grpc.js";
import { getNetworkConfig } from "../config.js";
import type { AttackTx } from "./attack-analysis.js";
import { protoValueToJson } from "./proto.js";
import type { CheckRun, PtbAnomaly } from "./ptb-anomalies.js";
import { formatUsd } from "./valuation.js";

/** How long before the transaction a write is looked at: one minute. */
export const RECENT_WRITE_WINDOW_MS = 60_000;
/** A write this recent, with value leaving the signer to other addresses, reads high. */
const HIGH_WITHIN_MS = 10_000;
/** USD the signer must lose to other addresses for the flag to read medium or high: a gas-sized loss says nothing. */
export const MOVED_MIN_USD = 1;
/** Shared objects followed per transaction. */
const MAX_OBJECTS = 8;
/** Writes followed back per object. */
const MAX_WRITES = 3;

/** Framework singletons below 0x10000 (the system state, the clock, randomness). */
const isSystemObject = (id: string) => /^0x0{60}/.test(normalizeSuiAddress(id));
const ADDRESS = /^0x[0-9a-fA-F]{64}$/;

/** Scalars of a JSON value by path, lists included (one write's before and after share their indices). */
function leaves(json: unknown, path = "", out = new Map<string, unknown>(), depth = 0): Map<string, unknown> {
  if (depth > 8) return out;
  if (Array.isArray(json)) json.forEach((v, i) => leaves(v, `${path}[${i}]`, out, depth + 1));
  else if (json && typeof json === "object") for (const [k, v] of Object.entries(json)) leaves(v, path ? `${path}.${k}` : k, out, depth + 1);
  else out.set(path, json);
  return out;
}

export interface ChangedField {
  path: string;
  /** `gate`: a boolean that flipped. `recipient`: an address set to one that gains here. `amount`: a number set to an amount this transaction moved. */
  kind: "gate" | "recipient" | "amount";
  before: string;
  after: string;
}

/** What in this transaction a write can have decided: the addresses that gained value, and every amount that moved. */
export interface Consequences {
  sender: string;
  recipients: ReadonlySet<string>;
  amounts: ReadonlySet<string>;
}

export function consequencesOf(tx: Pick<AttackTx, "sender" | "balanceChanges" | "movements">): Consequences {
  const sender = tx.sender ? normalizeSuiAddress(tx.sender) : "";
  const recipients = new Set<string>();
  const amounts = new Set<string>();
  for (const b of tx.balanceChanges) {
    if (!/^-?\d+$/.test(b.amount) || b.amount === "0") continue;
    amounts.add(b.amount.replace(/^-/, ""));
    const a = normalizeSuiAddress(b.address);
    if (!b.amount.startsWith("-") && a !== sender) recipients.add(a);
  }
  for (const m of tx.movements) {
    const to = m.to?.kind === "address" && m.to.address ? normalizeSuiAddress(m.to.address) : null;
    if (to && to !== sender) recipients.add(to);
  }
  return { sender, recipients, amounts };
}

/** The fields one write changed that can decide where this transaction's value goes. */
export function decisiveChanges(before: unknown, after: unknown, c: Consequences): ChangedField[] {
  const b = leaves(before);
  const out: ChangedField[] = [];
  for (const [path, a] of leaves(after)) {
    const was = b.get(path);
    if (was === a || !b.has(path)) continue;
    if (typeof a === "boolean" && typeof was === "boolean") out.push({ path, kind: "gate", before: String(was), after: String(a) });
    else if (typeof a === "string" && ADDRESS.test(a) && c.recipients.has(normalizeSuiAddress(a)))
      out.push({ path, kind: "recipient", before: String(was), after: a });
    else if ((typeof a === "string" || typeof a === "number") && /^\d+$/.test(String(a)) && String(a) !== "0" && c.amounts.has(String(a)))
      out.push({ path, kind: "amount", before: String(was), after: String(a) });
  }
  return out;
}

export interface ForeignWrite {
  object: string;
  object_type: string | null;
  writer: string;
  digest: string;
  ms_before: number;
  changed: ChangedField[];
}

const OBJECT_MASK = { paths: ["object_id", "version", "previous_transaction", "json", "object_type"] };
const TX_MASK = { paths: ["digest", "transaction.sender", "effects.changed_objects", "timestamp"] };

async function readObject(objectId: string, version: bigint): Promise<GrpcTypes.Object | null> {
  for (const client of getNetworkConfig().archive !== null ? [sui, archive] : [sui]) {
    try {
      const { response } = await client.ledgerService.getObject({ objectId, version, readMask: OBJECT_MASK });
      if (response.object) return response.object;
    } catch {
      // Pruned on the fullnode: the archive is asked next.
    }
  }
  return null;
}

async function readWriter(digest: string): Promise<GrpcTypes.ExecutedTransaction | null> {
  for (const client of getNetworkConfig().archive !== null ? [sui, archive] : [sui]) {
    try {
      const { response } = await client.ledgerService.getTransaction({ digest, readMask: TX_MASK });
      if (response.transaction) return response.transaction;
    } catch {
      // As above.
    }
  }
  return null;
}

export interface RecentWritesRead {
  writes: ForeignWrite[];
  /** Objects whose history could not be read. */
  unread: string[];
}

/**
 * Follow each shared object the transaction took (changed, or read only)
 * back through the writes that made the version it read, while each write
 * is another sender's and within {@link RECENT_WRITE_WINDOW_MS}, keeping the
 * writes that changed a field this transaction's transfers depend on.
 */
export async function recentForeignWrites(
  tx: Pick<AttackTx, "sender" | "timestampMs" | "objects" | "balanceChanges" | "movements" | "readShared">,
): Promise<RecentWritesRead> {
  const out: RecentWritesRead = { writes: [], unread: [] };
  if (!tx.sender || tx.timestampMs === null) return out;
  const c = consequencesOf(tx);
  if (c.recipients.size === 0) return out;
  const candidates = [
    ...tx.objects.filter((o) => o.shared && o.inputVersion).map((o) => ({ id: o.objectId, version: o.inputVersion!, type: o.objectType })),
    ...(tx.readShared ?? []).map((o) => ({ id: o.objectId, version: o.version, type: o.objectType })),
  ]
    .filter((o) => !isSystemObject(o.id))
    .slice(0, MAX_OBJECTS);
  await Promise.all(
    candidates.map(async (cand) => {
      let version = BigInt(cand.version);
      for (let step = 0; step < MAX_WRITES; step++) {
        const obj = await readObject(cand.id, version);
        const writerDigest = obj?.previousTransaction;
        const writer = writerDigest ? await readWriter(writerDigest) : null;
        if (!obj || !writer) {
          out.unread.push(cand.id);
          return;
        }
        const ts = writer.timestamp ? Number(writer.timestamp.seconds) * 1000 + Math.floor(writer.timestamp.nanos / 1_000_000) : null;
        const from = writer.transaction?.sender ? normalizeSuiAddress(writer.transaction.sender) : null;
        if (ts === null || !from || from === c.sender || tx.timestampMs! - ts > RECENT_WRITE_WINDOW_MS) return;
        const change = writer.effects?.changedObjects?.find((x) => x.objectId && normalizeSuiAddress(x.objectId) === normalizeSuiAddress(cand.id));
        // A write that created the object has no earlier state to compare.
        if (change?.inputVersion === undefined) return;
        const prior = await readObject(cand.id, change.inputVersion);
        if (!prior) {
          out.unread.push(cand.id);
          return;
        }
        const changed = decisiveChanges(protoValueToJson(prior.json), protoValueToJson(obj.json), c);
        if (changed.length) {
          out.writes.push({ object: cand.id, object_type: cand.type ?? obj.objectType ?? null, writer: from, digest: writerDigest!, ms_before: tx.timestampMs! - ts, changed });
        }
        version = change.inputVersion;
      }
    }),
  );
  out.writes.sort((a, b) => a.ms_before - b.ms_before);
  return out;
}

export const RECENT_WRITE_CHECK: CheckRun = {
  code: "switched-before-execution",
  rule: `another sender wrote a shared input within ${RECENT_WRITE_WINDOW_MS / 1000} s, flipping a boolean or setting a gaining address or a moved amount; high within ${HIGH_WITHIN_MS / 1000} s when the signer lost ${formatUsd(MOVED_MIN_USD)}+ to others`,
};

/**
 * The `switched-before-execution` anomaly. `movedUsd` is what the signer
 * lost that other addresses gained in this transaction, coins and valued
 * objects.
 */
export function recentWriteAnomaly(writes: ForeignWrite[], movedUsd: number): PtbAnomaly | null {
  if (!writes.length) return null;
  const latest = writes[0].ms_before;
  const moved = movedUsd >= MOVED_MIN_USD;
  return {
    severity: moved && latest <= HIGH_WITHIN_MS ? "high" : moved ? "medium" : "info",
    code: "switched-before-execution",
    title: `Reads a shared object another address rewrote ${(latest / 1000).toFixed(3)} s before, changing where or how much value goes${moved ? `; the signer lost ${formatUsd(movedUsd)} to other addresses` : ""}`,
    detail: `Another sender wrote a shared object this transaction took, within ${RECENT_WRITE_WINDOW_MS / 1000} s before it ran, and the write flipped a boolean (a gate), set an address that gains value in this transaction (a recipient), or set a number equal to an amount this transaction moved. A signature binds a shared object by id, not by its contents, so whoever may write the object, and whoever submits the signed transaction (a gas sponsor holds the bytes), can change where the signer's value goes after the signer approved it; a dry run against the earlier state shows nothing leaving. High within ${HIGH_WITHIN_MS / 1000} s when the signer lost ${formatUsd(MOVED_MIN_USD)} or more to other addresses, medium within the window, info when the signer lost nothing. A keeper or oracle writing the same object in ordinary use reads the same; check the writer and the object's history with trace_object_history.`,
    evidence: writes.slice(0, 6).map(
      (w) =>
        `${w.object} (${w.object_type ? w.object_type.split("<")[0].split("::").slice(1).join("::") : "unknown type"}) written by ${w.writer} in ${w.digest} ${(w.ms_before / 1000).toFixed(3)} s before: ${w.changed
          .slice(0, 3)
          .map((f) => `${f.kind} ${f.path} ${f.before.slice(0, 20)} -> ${f.after.slice(0, 20)}`)
          .join("; ")}${w.changed.length > 3 ? ` and ${w.changed.length - 3} more` : ""}`,
    ),
  };
}
