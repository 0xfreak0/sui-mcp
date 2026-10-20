/**
 * Where a Hashi withdrawal request stands, read from the transactions that
 * touched its `WithdrawalRequest` object and, once committed, its withdrawal
 * record. Requesting, cancelling and committing each write the request
 * object; the committee's `confirm_withdrawal` writes only the record.
 */

import { gqlQuery } from "../../clients/graphql.js";
import { getNetwork, type SuiNetwork } from "../../config.js";
import { HASHI_PACKAGES, readHashiCancellation, readHashiCommitment, readHashiRequest } from "./hashi.js";
import type { EvidenceTier, SuiEventNode } from "./wormhole.js";

export type HashiRequestStatus = "requested" | "cancelled" | "committed" | "confirmed";

export interface HashiRequestState {
  request_id: string;
  /** Null when the lifecycle could not be read. */
  status: HashiRequestStatus | null;
  requester?: string;
  request_digest?: string;
  /** hBTC handed to Hashi, in satoshis. */
  amount_sats?: string;
  bitcoin_address?: string;
  cancel_digest?: string;
  commit_digest?: string;
  withdrawal_txn_id?: string;
  /** Explorer byte order. */
  bitcoin_txid?: string | null;
  /** The committed output for this request, after the Bitcoin miner fee. */
  output_sats?: string;
  confirm_digest?: string;
  /** What the chain shows about BTC reaching the destination. */
  bitcoin_delivery: { evidence: EvidenceTier | null; note: string };
  /** More transactions or events touched the request than were read. */
  lifecycle_incomplete?: true;
}

export interface LifecycleTx {
  digest: string;
  events: SuiEventNode[];
  /** The transaction's events ran past the page read. */
  eventsTruncated: boolean;
}

export interface Lifecycle {
  txs: LifecycleTx[];
  /** More transactions touched the object than were read. */
  more: boolean;
}

/** Requests whose status one call reads, at most. */
export const MAX_TRACKED_REQUESTS = 20;
/** Aliased connections per document: the service answers at most 21 store lookups a request, and each alias pages events too. */
const ALIASES_PER_REQUEST = 8;
const REQUEST_TXS = 10;
const RECORD_TXS = 20;
const EVENTS_PER_TX = 50;

const DELIVERY_NOTES: Record<HashiRequestStatus, string> = {
  requested: "No Bitcoin transaction is committed for this request. The destination is the one the requester asked for, and the requester can still cancel.",
  cancelled: "The requester cancelled on Sui (cancel_digest) and the hBTC went back to them; nothing was paid on Bitcoin.",
  committed: "Hashi burned the hBTC and committed Bitcoin transaction bitcoin_txid with this output on Sui (commit_digest). Signing, broadcast and confirmation are not shown by the commitment; check the txid on Bitcoin.",
  confirmed: "Hashi's committee certified on Sui (confirm_digest) that Bitcoin transaction bitcoin_txid reached its confirmation threshold. This server did not read Bitcoin.",
};

/**
 * The state of one request from its own lifecycle and, when committed, its
 * withdrawal record's. Pure: the reads are {@link readHashiRequestStates}.
 */
export function hashiRequestState(
  requestId: string,
  request: Lifecycle | null,
  record: Lifecycle | null,
  network: SuiNetwork = getNetwork(),
): HashiRequestState {
  const pkg = HASHI_PACKAGES[network];
  if (!request || !pkg) {
    return { request_id: requestId, status: null, bitcoin_delivery: { evidence: null, note: "The request's transactions could not be read, so its status is unknown." } };
  }
  const state: HashiRequestState = { request_id: requestId, status: "requested", bitcoin_delivery: { evidence: "heuristic", note: DELIVERY_NOTES.requested } };
  let truncated = request.more;
  for (const tx of request.txs) {
    truncated ||= tx.eventsTruncated;
    for (const e of tx.events) {
      const type = e.contents?.type?.repr;
      const json = e.contents?.json;
      if (type === `${pkg}::withdrawal_queue::WithdrawalRequested`) {
        const r = readHashiRequest(json, network);
        if (r?.request_id !== requestId) continue;
        Object.assign(state, { requester: r.requester, request_digest: tx.digest, amount_sats: r.amount_sats, bitcoin_address: r.bitcoin_address });
      } else if (type === `${pkg}::withdrawal_queue::WithdrawalCancelled`) {
        if (readHashiCancellation(json)?.request_id !== requestId) continue;
        state.status = "cancelled";
        state.cancel_digest = tx.digest;
      } else if (type === `${pkg}::withdrawal_queue::WithdrawalPickedForProcessing`) {
        const c = readHashiCommitment(json, network);
        const output = c?.outputs.find((o) => o.request_id === requestId);
        if (!c || !output) continue;
        Object.assign(state, {
          status: "committed", commit_digest: tx.digest, withdrawal_txn_id: c.withdrawal_txn_id,
          bitcoin_txid: c.bitcoin_txid, output_sats: output.amount_sats,
        });
      }
    }
  }
  if (state.status === "committed" && !record) truncated = true;
  if (state.status === "committed" && record) {
    for (const tx of record.txs) {
      for (const e of tx.events) {
        if (e.contents?.type?.repr !== `${pkg}::withdrawal_queue::WithdrawalConfirmed`) continue;
        const json = e.contents.json as { withdrawal_txn_id?: unknown } | undefined;
        if (json?.withdrawal_txn_id !== state.withdrawal_txn_id) continue;
        state.status = "confirmed";
        state.confirm_digest = tx.digest;
      }
    }
    if (state.status === "committed" && (record.more || record.txs.some((t) => t.eventsTruncated))) truncated = true;
  }
  const status = state.status!;
  state.bitcoin_delivery = { evidence: status === "requested" ? "heuristic" : "chain-derived", note: DELIVERY_NOTES[status] };
  // A cancellation or commitment may sit past what was read.
  if (truncated && (status === "requested" || status === "committed")) state.lifecycle_incomplete = true;
  return state;
}

interface TxConnection {
  pageInfo?: { hasNextPage?: boolean };
  nodes?: Array<{
    digest: string;
    effects?: { events?: { pageInfo?: { hasNextPage?: boolean }; nodes?: SuiEventNode[] } | null } | null;
  }>;
}

/** Transactions that touched each object, oldest first, with their events. Null for an object whose read failed. */
async function readLifecycles(ids: string[], first: number): Promise<Map<string, Lifecycle | null>> {
  const out = new Map<string, Lifecycle | null>();
  for (let i = 0; i < ids.length; i += ALIASES_PER_REQUEST) {
    const chunk = ids.slice(i, i + ALIASES_PER_REQUEST);
    const query = `query { ${chunk
      .map(
        (id, j) =>
          `o${j}: transactions(filter: { affectedObject: ${JSON.stringify(id)} }, first: ${first}) { pageInfo { hasNextPage } ` +
          `nodes { digest effects { events(first: ${EVENTS_PER_TX}) { pageInfo { hasNextPage } nodes { contents { type { repr } json } } } } } }`,
      )
      .join(" ")} }`;
    try {
      const data = await gqlQuery<Record<string, TxConnection | null>>(query);
      chunk.forEach((id, j) => {
        const conn = data[`o${j}`];
        out.set(id, conn ? {
          more: conn.pageInfo?.hasNextPage === true,
          txs: (conn.nodes ?? []).map((n) => ({
            digest: n.digest,
            events: n.effects?.events?.nodes ?? [],
            eventsTruncated: n.effects?.events?.pageInfo?.hasNextPage === true,
          })),
        } : null);
      });
    } catch {
      for (const id of chunk) out.set(id, null);
    }
  }
  return out;
}

/**
 * The status of each request, for at most {@link MAX_TRACKED_REQUESTS}
 * of them; the rest are left out of the map. Two reads at most per eight
 * requests: their lifecycles, then the records of those committed.
 */
export async function readHashiRequestStates(requestIds: string[]): Promise<Map<string, HashiRequestState>> {
  const ids = [...new Set(requestIds.map((id) => id.toLowerCase()))].slice(0, MAX_TRACKED_REQUESTS);
  const requests = await readLifecycles(ids, REQUEST_TXS);
  const firstPass = ids.map((id) => hashiRequestState(id, requests.get(id) ?? null, null));
  const records = [...new Set(firstPass.flatMap((s) => (s.status === "committed" && s.withdrawal_txn_id ? [s.withdrawal_txn_id] : [])))];
  const recordLives = records.length ? await readLifecycles(records, RECORD_TXS) : new Map<string, Lifecycle | null>();
  return new Map(
    firstPass.map((s) => [
      s.request_id,
      s.status === "committed" && s.withdrawal_txn_id
        ? hashiRequestState(s.request_id, requests.get(s.request_id) ?? null, recordLives.get(s.withdrawal_txn_id) ?? null)
        : s,
    ]),
  );
}
