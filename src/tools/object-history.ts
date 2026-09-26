import { z } from "zod";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { numArg, addressArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import { batchResolveNames } from "../utils/names.js";
import { getLabel } from "../utils/labels.js";
import {
  computeOwnerChanges,
  findOwnerTransitions,
  ownerDesc,
  type CheckpointState,
  type OwnerChange,
  type OwnerDesc,
  type TransitionBudget,
  type VersionEntry,
} from "../utils/object-history.js";
import { findEnclosingKiosk, resolveKioskCapHolder, unresolvedCapHolderNote, type KioskCapHolder } from "../utils/kiosk.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface OwnerGql { __typename?: string; address?: { address: string } }
interface TxPointGql {
  digest: string;
  effects?: { timestamp?: string; checkpoint?: { sequenceNumber: number } };
}
interface VersionNodeGql {
  version: number;
  owner?: OwnerGql;
  asMoveObject?: { contents?: { type?: { repr?: string } } };
  previousTransaction?: TxPointGql;
}
interface ObjectHistoryResult {
  current: VersionNodeGql | null;
  objectVersions: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: VersionNodeGql[];
  } | null;
}

const OWNER_FIELDS = `owner {
      __typename
      ... on AddressOwner { address { address } }
      ... on ObjectOwner { address { address } }
      ... on ConsensusAddressOwner { address { address } }
    }`;

const TX_POINT = `previousTransaction { digest effects { timestamp checkpoint { sequenceNumber } } }`;

/**
 * `objectVersions` walks forward from the object's earliest retained version,
 * which makes two things possible in one query shape:
 *
 * - Reaching genesis costs one page regardless of how busy the object later
 *   became: `first: N` from the start is always the oldest N versions, where
 *   `last: N` counting back from now is only the newest N.
 * - `objectVersions` returns rows for an object that no longer exists, where
 *   the point lookup `object(address:)` returns null, so a deleted object's
 *   provenance is readable without the object itself.
 *
 * `current` is read separately because forward paging cannot cheaply reach
 * "now" for a busy object. The two together, plus checkpoint bisection for
 * what falls between them, is what the rest of this file does.
 */
const OBJECT_HISTORY_QUERY = `query ($id: SuiAddress!, $first: Int!) {
  current: object(address: $id) {
    version
    ${OWNER_FIELDS}
    asMoveObject { contents { type { repr } } }
    ${TX_POINT}
  }
  objectVersions(address: $id, first: $first) {
    pageInfo { hasNextPage endCursor }
    nodes {
      version
      ${OWNER_FIELDS}
      asMoveObject { contents { type { repr } } }
      ${TX_POINT}
    }
  }
}`;

/** One checkpoint's owner, read for the bisection search; it selects only the owner. */
const OWNER_AT_CHECKPOINT_QUERY = `query ($id: SuiAddress!, $cp: UInt53!) {
  object(address: $id, atCheckpoint: $cp) {
    ${OWNER_FIELDS}
  }
}`;

/** The transaction that wrote a transition checkpoint, once bisection has pinned it. */
const TX_AT_CHECKPOINT_QUERY = `query ($id: SuiAddress!, $cp: UInt53!) {
  object(address: $id, atCheckpoint: $cp) {
    version
    ${TX_POINT}
  }
}`;

/** The last transaction to touch an object, found even after it stops existing. */
const LAST_TOUCH_QUERY = `query ($id: SuiAddress!) {
  transactions(filter: { affectedObject: $id }, last: 1) {
    nodes { digest effects { timestamp checkpoint { sequenceNumber } } }
  }
}`;

interface LastTouchResult {
  transactions: { nodes: Array<{ digest: string; effects?: { timestamp?: string; checkpoint?: { sequenceNumber: number } } }> };
}

function toEntry(n: VersionNodeGql): VersionEntry {
  return {
    version: n.version.toString(),
    tx: n.previousTransaction?.digest ?? null,
    timestamp: n.previousTransaction?.effects?.timestamp ?? null,
    checkpoint: n.previousTransaction?.effects?.checkpoint?.sequenceNumber?.toString() ?? null,
    owner: ownerDesc(n.owner),
  };
}

/** `sui.rpc.v2.ChangedObject.IdOperation` */
const ID_CREATED = 2;
const ID_DELETED = 3;

/**
 * Did `digest` create `objectId`? True, false, or null when the transaction
 * could not be read.
 *
 * Asked only when claiming a creation from the first row `objectVersions`
 * returns. Forward paging from an object's earliest retained version usually
 * starts at genesis, and this confirms it before a creation is claimed. It
 * asks gRPC, which returns every changed object in one read, where GraphQL
 * would page them 50 at a time.
 */
async function createdIn(digest: string, objectId: string): Promise<boolean | null> {
  try {
    const res = await withArchiveFallback<GrpcTypes.GetTransactionResponse>(
      (client) => client.ledgerService.getTransaction({ digest, readMask: { paths: ["effects"] } }),
      (r) => !r.transaction?.effects,
    );
    const want = normalizeSuiAddress(objectId);
    const change = res.transaction?.effects?.changedObjects?.find(
      (c) => c.objectId !== undefined && normalizeSuiAddress(c.objectId) === want,
    );
    return change?.idOperation === ID_CREATED;
  } catch {
    return null;
  }
}

interface ObjectEnd {
  kind: "deleted" | "wrapped";
  tx: string;
  timestamp: string | null;
  checkpoint: number | null;
}

/**
 * How an object that no longer exists stopped existing. The last transaction
 * to touch it either deleted it or wrapped it inside another object; gRPC's
 * `changedObjects` states which via `idOperation`, where GraphQL's
 * `objectChanges` would need paging to find the same row.
 */
async function findObjectEnd(objectId: string): Promise<ObjectEnd | null> {
  const r = await gqlQuery<LastTouchResult>(LAST_TOUCH_QUERY, { id: objectId });
  const last = r.transactions.nodes[0];
  if (!last) return null;
  const res = await withArchiveFallback<GrpcTypes.GetTransactionResponse>(
    (client) => client.ledgerService.getTransaction({ digest: last.digest, readMask: { paths: ["effects"] } }),
    (x) => !x.transaction?.effects,
  );
  const want = normalizeSuiAddress(objectId);
  const change = res.transaction?.effects?.changedObjects?.find(
    (c) => c.objectId !== undefined && normalizeSuiAddress(c.objectId) === want,
  );
  return {
    kind: change?.idOperation === ID_DELETED ? "deleted" : "wrapped",
    tx: last.digest,
    timestamp: last.effects?.timestamp ?? null,
    checkpoint: last.effects?.checkpoint?.sequenceNumber ?? null,
  };
}

/** Bisection's query budget, shared across every transition found in one call.
 *  Each step halves a checkpoint range, so this comfortably covers a handful
 *  of real ownership changes across the chain's whole checkpoint range (on
 *  the order of 2^28) even though the object between them may carry
 *  thousands of mutation-only versions bisection never has to read. */
const TRANSITION_BUDGET = 80;

/** Wall-clock ceiling on the same search. These are sequential GraphQL
 *  calls with no per-call deadline of their own, and on a throttled
 *  endpoint the full query budget can outlast a client's own timeout,
 *  losing the whole trace instead of returning it truncated. Checked beside
 *  `remaining` in `findOwnerTransitions`, which reports running out of
 *  either the same way: `truncated: true`. */
const TRANSITION_TIME_BUDGET_MS = 20_000;

/** Convert bisection's `{checkpoint, owner}` transitions into the same
 *  `OwnerChange` shape `computeOwnerChanges` produces, by reading the exact
 *  transaction at each pinned checkpoint. Transitions are few even when the
 *  object is not, so one extra request per transition is cheap. */
async function enrichTransitions(
  objectId: string,
  startOwner: OwnerDesc,
  points: { checkpoint: number; owner: OwnerDesc }[],
): Promise<OwnerChange[]> {
  const out: OwnerChange[] = [];
  let from = startOwner;
  for (const p of points) {
    const r = await gqlQuery<{ object: VersionNodeGql | null }>(TX_AT_CHECKPOINT_QUERY, {
      id: objectId,
      cp: p.checkpoint,
    });
    out.push({
      from,
      to: p.owner,
      at_version: r.object?.version?.toString() ?? "",
      tx: r.object?.previousTransaction?.digest ?? null,
      timestamp: r.object?.previousTransaction?.effects?.timestamp ?? null,
    });
    from = p.owner;
  }
  return out;
}

export function registerObjectHistoryTools(server: McpServer) {
  server.tool(
    "trace_object_history",
    "(Incident investigation) Trace the provenance of a Sui object: its version history — each version, the transaction that produced it, when — and every ownership transition (transfers, sharing, freezing, party transfers) found. Use it to see the lifecycle of an exploited pool/vault/cap: who created it and who held it when. A party object reports owner kind `consensus` with its single owner's address; a kiosk-held item reports owner kind `object` with the kiosk's own id (or the dynamic-field wrapper just below it) on its CURRENT row only, plus a `kiosk_cap_holder` naming who controls that kiosk today — never attached to a historical row, which would misname a past holder as the controller at that time. Works on a deleted or wrapped object: `current` is null and `end` names the transaction and kind. For a capability mutated on every privileged call, reaching a transition from long ago is a checkpoint search, not a page walk, so it stays cheap however hot the object has been since — but that search can only find a checkpoint where the owner disagrees with the one before it, so an ownership round trip (out to another owner and back) landing inside one probed span is invisible to it. `owner_change_count` beyond the shown page is therefore always a lower bound, never asserted complete; `owner_change_note` and `more_versions_note` say why.",
    {
      object_id: addressArg().describe("Object ID (0x...)"),
      limit: numArg().int().positive().max(50).optional().describe("Max versions to show, oldest first (default 25)"),
    },
    async ({ object_id, limit }) => {
      try {
        const first = limit ?? 25;
        const data = await gqlQuery<ObjectHistoryResult>(OBJECT_HISTORY_QUERY, { id: object_id, first });
        const conn = data.objectVersions;
        const forwardNodes = conn?.nodes ?? [];
        const current = data.current;

        if (forwardNodes.length === 0 && !current) {
          return errorResult(`Object not found (it may be deleted/wrapped, or the id is wrong): ${object_id}`);
        }

        const history: VersionEntry[] = forwardNodes.map(toEntry);
        const moreForward = conn?.pageInfo.hasNextPage ?? false;

        // Only claim a creation when the transaction at the front of the walk
        // actually created this object. Forward paging from the earliest
        // retained version usually starts at genesis, and `createdIn` checks
        // that it does.
        let createdConfirmed = false;
        if (history.length > 0 && history[0].tx) {
          createdConfirmed = (await createdIn(history[0].tx, object_id)) === true;
        }
        const historyUnavailable = history.length > 0 && !createdConfirmed;
        const truncated = moreForward || historyUnavailable;

        const type =
          current?.asMoveObject?.contents?.type?.repr ??
          forwardNodes[forwardNodes.length - 1]?.asMoveObject?.contents?.type?.repr ??
          null;

        // The object no longer exists: find what ended it, even though we
        // cannot ask it directly. Old effects never recorded this any other
        // way than walking every transaction that ever touched the id.
        const end = !current ? await findObjectEnd(object_id) : null;

        // Owner changes: exact from the page when the whole life fits in it.
        // Otherwise, exact for the page's own rows (`computeOwnerChanges`
        // walks every entry `history` already holds, so it sees a round trip
        // the page itself shows) plus a checkpoint search for whatever lies
        // between the last shown row and `current`, never further back than
        // that, since the page already answered for everything before it.
        // That search can still only find a checkpoint where the owner
        // disagrees with its neighbor; an ownership round trip landing
        // entirely inside one probed span (both ends the same owner) is
        // invisible to it regardless of whether the search finishes. So a
        // bisected span is never reported complete, only "no disagreement
        // found here" (see `findOwnerTransitions`).
        let ownerChanges: OwnerChange[];
        let ownerChangesComplete: boolean;
        let searchRan = false;
        let searchTruncated = false;
        let searchFound = 0;
        if (!moreForward) {
          // The forward page already reached the end of retained history:
          // either `current` (object still exists, `objectVersions` includes
          // it as the last row) or the last version before deletion/wrap.
          // No bisection is involved, so this is exact and can be complete.
          ownerChanges = computeOwnerChanges(history);
          ownerChangesComplete = createdConfirmed || history.length === 0;
        } else if (current && history.length > 0) {
          const pageChanges = computeOwnerChanges(history);
          const lastRow = history[history.length - 1];
          const lo: CheckpointState = {
            checkpoint: Number(lastRow.checkpoint ?? 0),
            owner: lastRow.owner,
          };
          const hiCheckpoint = current.previousTransaction?.effects?.checkpoint?.sequenceNumber;
          if (hiCheckpoint === undefined) {
            ownerChanges = pageChanges;
            ownerChangesComplete = false;
          } else {
            const hi: CheckpointState = { checkpoint: hiCheckpoint, owner: ownerDesc(current.owner) };
            const budget: TransitionBudget = {
              remaining: TRANSITION_BUDGET,
              deadlineMs: Date.now() + TRANSITION_TIME_BUDGET_MS,
            };
            searchRan = true;
            const search = await findOwnerTransitions(
              lo,
              hi,
              async (cp) => {
                const r = await gqlQuery<{ object: { owner?: OwnerGql } | null }>(OWNER_AT_CHECKPOINT_QUERY, {
                  id: object_id,
                  cp,
                });
                return ownerDesc(r.object?.owner);
              },
              budget,
            );
            searchTruncated = search.truncated;
            const bisected = await enrichTransitions(object_id, lo.owner, search.transitions);
            ownerChanges = [...pageChanges, ...bisected];
            searchFound = bisected.length;
            ownerChangesComplete = false;
          }
        } else {
          // Busy and deleted/wrapped: rare, and not worth a bisection whose
          // upper end would need the deleting transaction's INPUT owner
          // rather than a checkpoint read. Reported as an incomplete sample.
          ownerChanges = computeOwnerChanges(history);
          ownerChangesComplete = false;
        }

        // Resolve names/labels for every address-like owner, including the
        // single owner of a party object. Object-held owners are containers,
        // not wallets, so they are not looked up here.
        const addrs = new Set<string>();
        for (const e of history) {
          if (e.owner.kind === "address" || e.owner.kind === "consensus") addrs.add(e.owner.address);
        }
        if (current) {
          const co = ownerDesc(current.owner);
          if (co.kind === "address" || co.kind === "consensus") addrs.add(co.address);
        }
        for (const c of ownerChanges) {
          for (const o of [c.from, c.to]) {
            if (o.kind === "address" || o.kind === "consensus") addrs.add(o.address);
          }
        }
        const nameMap = await batchResolveNames([...addrs]);

        // A kiosk-held item's owner is a container, not a wallet. Naming who
        // actually controls it needs one more lookup, run only for `current`:
        // the cap's current holder is not who controlled the kiosk at a past
        // version, so on a historical row it would name the wrong controller,
        // and a lookup per row would multiply the cost. `describeOwner`'s
        // `isCurrent` flag is the only gate; every other call site passes it
        // as `false`. `Kiosk.owner` is a self-declared field the framework
        // does not keep in sync with the cap transfer that actually controls
        // it; `kiosk_cap_holder` is read from the cap's own current owner
        // instead.
        let kioskId: string | null = null;
        let kioskCap: KioskCapHolder | null = null;
        let kioskCapLookupFailed: string | null = null;
        let kioskCheckFailed: string | null = null;
        const currentOwnerDesc = current ? ownerDesc(current.owner) : null;
        const currentObjectOwnerAddress = currentOwnerDesc?.kind === "object" ? currentOwnerDesc.address : null;
        if (currentObjectOwnerAddress) {
          // Both kiosk reads are enrichment behind an object answer that
          // already succeeded, so a GraphQL failure in either degrades to a
          // note on `current.owner` rather than failing this whole call.
          // `resolveKioskCapHolder` wraps its own reads; the walk up to the
          // kiosk is caught here.
          try {
            kioskId = await findEnclosingKiosk(currentObjectOwnerAddress);
          } catch (err) {
            kioskCheckFailed = err instanceof Error ? err.message : String(err);
          }
          if (kioskId) {
            const capLookup = await resolveKioskCapHolder(kioskId);
            if (capLookup.status === "resolved") {
              kioskCap = capLookup.result;
            } else if (capLookup.status === "lookup_failed") {
              kioskCapLookupFailed = capLookup.message;
            }
          }
        }

        const describeOwner = (o: OwnerDesc, isCurrent = false) => {
          if (o.kind === "address" || o.kind === "consensus") {
            const label = getLabel(o.address);
            return {
              kind: o.kind,
              address: o.address,
              ...(nameMap.get(o.address) ? { name: nameMap.get(o.address) } : {}),
              ...(label ? { label: label.label, category: label.category } : {}),
            };
          }
          if (o.kind === "object") {
            // Only the current row gets the cap-holder enrichment: it names
            // who controls the kiosk now, which is only true of the present.
            // A historical row (or an owner_changes endpoint) with the
            // identical container address does not get it (see the comment
            // above `kioskId`).
            const enriched = isCurrent && kioskId !== null;
            return {
              kind: o.kind,
              address: o.address,
              ...(enriched
                ? {
                    kiosk_id: kioskId,
                    ...(kioskCap?.holder
                      ? {
                          kiosk_cap_holder: describeOwnerPlain(kioskCap.holder),
                          kiosk_cap_id: kioskCap.cap_id,
                          ...(kioskCap.wrapped_in ? { kiosk_cap_wrapped_in: kioskCap.wrapped_in } : {}),
                        }
                      : {
                          ...(kioskCap ? { kiosk_cap_id: kioskCap.cap_id } : {}),
                          ...(kioskCap?.wrapped_in ? { kiosk_cap_wrapped_in: kioskCap.wrapped_in } : {}),
                          kiosk_cap_holder_note: kioskCapLookupFailed
                            ? `The KioskOwnerCap lookup failed and was skipped: ${kioskCapLookupFailed}`
                            : kioskCap
                              ? unresolvedCapHolderNote(kioskCap)
                              : "The KioskOwnerCap for this kiosk could not be resolved (its creation transaction, or the matching cap within it, was not found).",
                        }),
                    kiosk_owner_field_caveat:
                      "The kiosk's own `owner` field (visible via get_object) is self-declared: it is set when the kiosk is created or by `set_owner`, and does not follow the KioskOwnerCap when the cap is transferred, so it can name a former owner. kiosk_cap_holder is read from the cap's own current owner instead.",
                  }
                : isCurrent && kioskCheckFailed
                  ? {
                      kiosk_cap_holder_note: `Whether this container belongs to a kiosk could not be checked, so no kiosk or KioskOwnerCap holder was looked up: ${kioskCheckFailed}`,
                    }
                  : {}),
            };
          }
          return { kind: o.kind };
        };
        // A plain describer for the resolved cap holder, without re-entering
        // the kiosk enrichment above. The holder is a wallet, or the owner of
        // the outermost object wrapping the cap (`kiosk_cap_wrapped_in`); an
        // object-owned wrapper is reported as read, not walked further.
        function describeOwnerPlain(o: OwnerDesc) {
          if (o.kind === "address" || o.kind === "consensus" || o.kind === "object") {
            const label = o.kind !== "object" ? getLabel(o.address) : null;
            return {
              kind: o.kind,
              address: o.address,
              ...(o.kind !== "object" && nameMap.get(o.address) ? { name: nameMap.get(o.address) } : {}),
              ...(label ? { label: label.label, category: label.category } : {}),
            };
          }
          return { kind: o.kind };
        }

        const creation = createdConfirmed && history.length > 0 ? history[0] : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  object_id,
                  type,
                  current: current
                    ? { version: current.version.toString(), owner: describeOwner(ownerDesc(current.owner), true) }
                    : null,
                  ...(end
                    ? {
                        end: {
                          kind: end.kind,
                          tx: end.tx,
                          timestamp: end.timestamp,
                          note:
                            end.kind === "deleted"
                              ? "This object was deleted in this transaction; it no longer exists as an object and holds nothing."
                              : "This object was wrapped inside another object in this transaction; it no longer exists as a top-level object, but its value was not destroyed.",
                        },
                      }
                    : !current
                      ? {
                          end_unknown:
                            "No transaction touching this object id could be found, so whether it was deleted or wrapped, and by what, is unknown.",
                        }
                      : {}),
                  created: creation
                    ? { tx: creation.tx, timestamp: creation.timestamp, owner: describeOwner(creation.owner) }
                    : null,
                  history_truncated: truncated,
                  ...(historyUnavailable
                    ? {
                        history_unavailable:
                          "The transaction at the front of this walk did not create this object, which for a long-lived object means its earlier history is beyond retention rather than absent. `created` is therefore null and `owner_change_count` counts only what was found — NOT that this object was never transferred before this window.",
                      }
                    : {}),
                  ...(moreForward
                    ? {
                        more_versions_note: searchRan
                          ? "More versions exist beyond this page (this object is busier than `limit`). `history` below is the OLDEST versions only. owner_changes adds a checkpoint search from the last shown version to current, but that search can only find a checkpoint where the owner disagrees with the one before it — an ownership round trip (out to another owner and back to this one) landing inside one probed span is invisible to it. owner_change_count is a lower bound on this object's full life, not a certified total; see owner_change_note."
                          : "More versions exist beyond this page (this object is busier than `limit`). `history` below is the OLDEST versions only, and owner_changes/owner_change_count count only the transitions among those shown versions: no checkpoint search ran for the rest of this object's life. See owner_change_note.",
                      }
                    : {}),
                  version_count_shown: history.length,
                  owner_change_count: ownerChanges.length,
                  ...(!ownerChangesComplete
                    ? {
                        owner_change_note: !moreForward
                          ? "Counts transitions among the versions shown only. An earlier transfer outside this window would not appear."
                          : searchRan
                            ? searchTruncated
                              ? `The checkpoint search that extends this list past the last shown version did not finish (its query budget or time budget ran out)${searchFound > 0 ? ` after finding ${searchFound} transition(s), listed in owner_changes after the page's own` : ""}, so a transition beyond where it stopped may be missing, in addition to any reversed transfer the search's design cannot see (see more_versions_note).`
                              : searchFound > 0
                                ? `The checkpoint search that extends this list past the last shown version finished and found ${searchFound} transition(s) there, listed in owner_changes after the page's own. It can only find a checkpoint where the owner disagrees with the one before it, so a reversed transfer (out to another owner and back to this one) inside one probed span would not appear (see more_versions_note).`
                                : "The checkpoint search that extends this list past the last shown version finished without finding further disagreement, but it can only find a checkpoint where the owner disagrees with the one before it: a reversed transfer (out to another owner and back to this one) inside one probed span would not appear (see more_versions_note)."
                            : "Counts only the transitions among the versions shown; no checkpoint search ran for the rest of this object's life, so an earlier or later transition would not appear.",
                      }
                    : {}),
                  owner_changes: ownerChanges.map((c) => ({
                    from: describeOwner(c.from),
                    to: describeOwner(c.to),
                    at_version: c.at_version,
                    tx: c.tx,
                    timestamp: c.timestamp,
                  })),
                  history: history.map((e) => ({
                    version: e.version,
                    tx: e.tx,
                    timestamp: e.timestamp,
                    checkpoint: e.checkpoint,
                    owner: describeOwner(e.owner),
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
