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
  findOwnerTransitionsFromEnd,
  ownerDesc,
  type CheckpointState,
  type OwnerChange,
  type OwnerDesc,
  type TransitionBudget,
  type VersionEntry,
} from "../utils/object-history.js";
import { readObjectEnd } from "../utils/object-end.js";
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
  /** The earliest retained version, read by every page except the first oldest-first one, which starts there. */
  genesis?: { nodes: VersionNodeGql[] } | null;
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

const VERSION_FIELDS = `version
      ${OWNER_FIELDS}
      asMoveObject { contents { type { repr } } }
      ${TX_POINT}`;

/**
 * A later page, oldest first: the versions from `$after + 1` on. The cursor
 * is the last version the previous page showed, so the first row returned is
 * that version again, read only as the owner the next row changed from.
 */
const OBJECT_HISTORY_AFTER_QUERY = `query ($id: SuiAddress!, $first: Int!, $after: UInt53!) {
  current: object(address: $id) { ${VERSION_FIELDS} }
  objectVersions(address: $id, first: $first, filter: { afterVersion: $after }) {
    pageInfo { hasNextPage endCursor }
    nodes { ${VERSION_FIELDS} }
  }
  genesis: objectVersions(address: $id, first: 1) { nodes { ${VERSION_FIELDS} } }
}`;

/**
 * A page newest first: the `$last` versions before `$filter`'s
 * `beforeVersion`, or the newest ones with no filter. Rows come back oldest
 * first; one more than the page is asked for, and that oldest extra row is
 * read only as the owner the page's oldest row changed from.
 */
const OBJECT_HISTORY_NEWEST_QUERY = `query ($id: SuiAddress!, $last: Int!, $filter: VersionFilter) {
  current: object(address: $id) { ${VERSION_FIELDS} }
  objectVersions(address: $id, last: $last, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { ${VERSION_FIELDS} }
  }
  genesis: objectVersions(address: $id, first: 1) { nodes { ${VERSION_FIELDS} } }
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

function toEntry(n: VersionNodeGql): VersionEntry {
  return {
    version: n.version.toString(),
    tx: n.previousTransaction?.digest ?? null,
    timestamp: n.previousTransaction?.effects?.timestamp ?? null,
    checkpoint: n.previousTransaction?.effects?.checkpoint?.sequenceNumber?.toString() ?? null,
    owner: ownerDesc(n.owner),
  };
}

/** `sui.rpc.v2.ChangedObject.IdOperation.CREATED` */
const ID_CREATED = 2;

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

/** Most rows one GraphQL connection request may ask for. */
const GQL_PAGE_MAX = 50;

/** Bisection's query budget, shared across every transition found in one call.
 *  Pinning one change costs about log2 of the checkpoint range (27 reads over
 *  a year of checkpoints), less the reads changes share near the top of the
 *  search, and a change made by the span's last write costs one read. */
const TRANSITION_BUDGET = 80;

/** Wall-clock ceiling on the same search. These are GraphQL calls with no
 *  per-call deadline of their own, and on a throttled endpoint the full
 *  query budget can outlast a client's own timeout, losing the whole trace
 *  instead of returning it truncated. Both halves of a range are read at
 *  once, so the time spent grows with the search's depth. Checked beside
 *  `remaining` in `findOwnerTransitions`, which reports running out of
 *  either the same way: `truncated: true`, with the ranges it stopped in. */
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
    "(Incident investigation) Trace the provenance of a Sui object: its version history — each version, the transaction that produced it, when — and every ownership transition (transfers, sharing, freezing, party transfers) found. Use it to see the lifecycle of an exploited pool/vault/cap: who created it and who held it when. A party object reports owner kind `consensus` with its single owner's address; a kiosk-held item reports owner kind `object` with the kiosk's own id (or the dynamic-field wrapper just below it) on its CURRENT row only, plus a `kiosk_cap_holder` naming who controls that kiosk today — never attached to a historical row, which would misname a past holder as the controller at that time. Works on a deleted or wrapped object: `current` is null and `end` names the transaction and kind. For a capability mutated on every privileged call, reaching a transition from long ago is a checkpoint search, not a page walk, so it stays cheap however hot the object has been since — but that search can only find a checkpoint where the owner disagrees with the one before it, so an ownership round trip (out to another owner and back) landing inside one probed span is invisible to it. `owner_change_count` beyond the shown page is therefore always a lower bound, never asserted complete; `owner_change_note` and `more_versions_note` say why. A search that runs out of its read or time budget lists in `owner_change_unpinned` each checkpoint range it stopped inside, with the owners at both ends: each holds an owner change it did not pin. Versions list oldest first from the earliest retained one; `order: 'newest'` starts at the current version and pages back, which reaches how a busy shared object changed just before an incident. Each page states its `order`; pass `next_cursor` back as `cursor` with the same `order` (`next_call` is that call). Owner changes relate each listed version to the one before it, whichever order the page runs.",
    {
      object_id: addressArg().describe("Object ID (0x...)"),
      limit: numArg().int().positive().max(50).optional().describe("Max versions to show per page (default 25). A newest-first page, or a page after a cursor, lists at most 49: it reads one more version for the owner change into its oldest row."),
      order: z
        .enum(["oldest", "newest"])
        .optional()
        .describe("'oldest' (default) starts at the object's first retained version and pages forward; 'newest' starts at the current version and pages back in time."),
      cursor: z
        .string()
        .optional()
        .describe("`next_cursor` from the previous page. Continues in the same direction; pass the same `order`."),
    },
    async ({ object_id, limit, order, cursor }) => {
      try {
        const limitRows = limit ?? 25;
        const newest = order === "newest";
        // A newest-first or cursor page reads one version past its older
        // edge for the owner change into its oldest row, and GraphQL serves
        // at most 50 rows a request, so such a page lists at most 49. The
        // next page starts from its last row, so nothing is skipped.
        const readsContext = newest || cursor !== undefined;
        const n = readsContext ? Math.min(limitRows, GQL_PAGE_MAX - 1) : limitRows;
        if (cursor !== undefined && !/^\d+$/.test(cursor)) {
          return errorResult(`cursor must be the next_cursor of a previous page, a version number; got ${JSON.stringify(cursor)}.`);
        }
        const data =
          cursor === undefined && !newest
            ? await gqlQuery<ObjectHistoryResult>(OBJECT_HISTORY_QUERY, { id: object_id, first: n })
            : newest
              ? await gqlQuery<ObjectHistoryResult>(OBJECT_HISTORY_NEWEST_QUERY, {
                  id: object_id,
                  last: n + 1,
                  filter: cursor === undefined ? null : { beforeVersion: Number(cursor) },
                })
              : await gqlQuery<ObjectHistoryResult>(OBJECT_HISTORY_AFTER_QUERY, {
                  id: object_id,
                  first: n + 1,
                  after: Number(cursor) - 1,
                });
        const conn = data.objectVersions;
        const pageNodes = conn?.nodes ?? [];
        const current = data.current;

        // `history` is the page's versions, oldest first. `context` is the
        // version just before its oldest row, read only so the owner change
        // into that row is exact; it is never listed.
        const history: VersionEntry[] = pageNodes.map(toEntry);
        let context: VersionEntry | null = null;
        let moreOlder: boolean;
        let moreNewer: boolean;
        if (newest) {
          moreOlder = history.length > n;
          if (moreOlder) context = history.shift()!;
          moreNewer = cursor !== undefined;
        } else {
          if (cursor !== undefined && history[0]?.version === cursor) context = history.shift()!;
          moreOlder = cursor !== undefined;
          moreNewer = history.length > n || (conn?.pageInfo.hasNextPage ?? false);
          history.splice(n);
        }

        if (history.length === 0 && !current && cursor === undefined) {
          return errorResult(`Object not found (it may be deleted/wrapped, or the id is wrong): ${object_id}`);
        }

        // Only claim a creation when the transaction that wrote the earliest
        // retained version actually created this object. That version usually
        // is genesis, and `createdIn` checks that it is. The first oldest-first
        // page starts there; every other page reads it separately.
        const genesisNode = cursor === undefined && !newest ? pageNodes[0] : data.genesis?.nodes[0];
        const genesis = genesisNode ? toEntry(genesisNode) : null;
        let createdConfirmed = false;
        if (genesis?.tx) {
          createdConfirmed = (await createdIn(genesis.tx, object_id)) === true;
        }
        const historyUnavailable = genesis !== null && !createdConfirmed;
        const truncated = moreOlder || moreNewer || historyUnavailable;

        const type =
          current?.asMoveObject?.contents?.type?.repr ??
          pageNodes[pageNodes.length - 1]?.asMoveObject?.contents?.type?.repr ??
          null;

        // The object no longer exists: find what ended it, even though we
        // cannot ask it directly. Old effects never recorded this any other
        // way than walking every transaction that ever touched the id.
        const end = !current ? await readObjectEnd(object_id) : null;

        // Owner changes: exact from the page when the whole life fits in it.
        // Otherwise, exact for the page's own rows (`computeOwnerChanges`
        // walks every entry `history` already holds, so it sees a round trip
        // the page itself shows) plus a checkpoint search over the span
        // beyond the page in its paging direction: oldest first, from the
        // last shown row to `current`; newest first, from the earliest
        // retained version to the row before the page. Never the other side,
        // which this page or an earlier one already answered for. That search
        // can still only find a checkpoint where the owner disagrees with its
        // neighbor; an ownership round trip landing entirely inside one
        // probed span (both ends the same owner) is invisible to it
        // regardless of whether the search finishes. So a bisected span is
        // never reported complete, only "no disagreement found here" (see
        // `findOwnerTransitions`).
        const pageChanges = computeOwnerChanges(context ? [context, ...history] : history);
        let span: { lo: CheckpointState; hi: CheckpointState } | null = null;
        const hiCheckpoint = current?.previousTransaction?.effects?.checkpoint?.sequenceNumber;
        // Oldest first, a busy object that is deleted or wrapped is not
        // searched: the upper end would need the deleting transaction's INPUT
        // owner rather than a checkpoint read.
        if (!newest && moreNewer && current && history.length > 0 && hiCheckpoint !== undefined) {
          const lastRow = history[history.length - 1];
          span = {
            lo: { checkpoint: Number(lastRow.checkpoint ?? 0), owner: lastRow.owner },
            hi: { checkpoint: hiCheckpoint, owner: ownerDesc(current.owner) },
          };
        } else if (newest && moreOlder && genesis?.checkpoint && context?.checkpoint) {
          span = {
            lo: { checkpoint: Number(genesis.checkpoint), owner: genesis.owner },
            hi: { checkpoint: Number(context.checkpoint), owner: context.owner },
          };
        }
        let ownerChanges = pageChanges;
        const ownerChangesComplete = !moreOlder && !moreNewer && (createdConfirmed || history.length === 0);
        const searchRan = span !== null;
        let searchTruncated = false;
        let searchFound = 0;
        let unresolved: { lo: CheckpointState; hi: CheckpointState }[] = [];
        if (span) {
          const budget: TransitionBudget = {
            remaining: TRANSITION_BUDGET,
            deadlineMs: Date.now() + TRANSITION_TIME_BUDGET_MS,
          };
          const search = await findOwnerTransitionsFromEnd(
            span.lo,
            span.hi,
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
          unresolved = search.unresolved;
          const bisected = await enrichTransitions(object_id, span.lo.owner, search.transitions);
          ownerChanges = newest ? [...bisected, ...pageChanges] : [...pageChanges, ...bisected];
          searchFound = bisected.length;
        }
        // Newest first lists both lists from the latest version back; each
        // change still reads from the owner before `at_version` to the owner at it.
        const listedHistory = newest ? [...history].reverse() : history;
        const listedChanges = newest ? [...ownerChanges].reverse() : ownerChanges;
        const more = newest ? moreOlder : moreNewer;
        const nextCursor = more && history.length > 0 ? (newest ? history[0] : history[history.length - 1]).version : null;
        const shownVersions = cursor !== undefined ? "this page's versions only" : newest ? "the NEWEST versions only" : "the OLDEST versions only";
        const searchSpan = newest ? "from the object's first retained version to the oldest shown one" : "from the last shown version to current";
        const pastPage = newest ? "before the oldest shown version" : "past the last shown version";
        const walked = cursor !== undefined ? " Versions on pages already walked are not listed or searched again." : "";

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

        const creation = createdConfirmed ? genesis : null;

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
                  order: newest ? "newest" : "oldest",
                  ...(newest
                    ? { order_note: "history and owner_changes run newest first; each owner change reads from the owner before at_version to the owner at it." }
                    : {}),
                  history_truncated: truncated,
                  ...(historyUnavailable
                    ? {
                        history_unavailable:
                          "The transaction at the front of this walk did not create this object, which for a long-lived object means its earlier history is beyond retention rather than absent. `created` is therefore null and `owner_change_count` counts only what was found — NOT that this object was never transferred before this window.",
                      }
                    : {}),
                  ...(moreOlder || moreNewer
                    ? {
                        more_versions_note: searchRan
                          ? `More versions exist beyond this page (this object is busier than \`limit\`). \`history\` below is ${shownVersions}.${walked} owner_changes adds a checkpoint search ${searchSpan}, but that search can only find a checkpoint where the owner disagrees with the one before it — an ownership round trip (out to another owner and back to this one) landing inside one probed span is invisible to it. owner_change_count is a lower bound on this object's full life, not a certified total; see owner_change_note.`
                          : `More versions exist beyond this page (this object is busier than \`limit\`). \`history\` below is ${shownVersions}, and owner_changes/owner_change_count count only the transitions among those shown versions: no checkpoint search ran for the rest of this object's life.${walked} See owner_change_note.`,
                      }
                    : {}),
                  version_count_shown: history.length,
                  ...(nextCursor
                    ? {
                        next_cursor: nextCursor,
                        next_call: {
                          tool: "trace_object_history",
                          repeat_with: { order: newest ? "newest" : "oldest", cursor: nextCursor },
                        },
                      }
                    : {}),
                  owner_change_count: ownerChanges.length,
                  ...(!ownerChangesComplete
                    ? {
                        owner_change_note: !(moreOlder || moreNewer)
                          ? "Counts transitions among the versions shown only. An earlier transfer outside this window would not appear."
                          : searchRan
                            ? searchTruncated
                              ? `The checkpoint search that extends this list ${pastPage} did not finish (its query budget or time budget ran out)${searchFound > 0 ? ` after finding ${searchFound} transition(s), listed in owner_changes after the page's own` : ""}. owner_change_unpinned lists the checkpoint ranges it stopped inside: each holds at least one more owner change, from the owner at its start to the owner at its end, not pinned to a transaction. A transition elsewhere may be missing too, as may any reversed transfer the search's design cannot see (see more_versions_note).`
                              : searchFound > 0
                                ? `The checkpoint search that extends this list ${pastPage} finished and found ${searchFound} transition(s) there, listed in owner_changes after the page's own. It can only find a checkpoint where the owner disagrees with the one before it, so a reversed transfer (out to another owner and back to this one) inside one probed span would not appear (see more_versions_note).`
                                : `The checkpoint search that extends this list ${pastPage} finished without finding further disagreement, but it can only find a checkpoint where the owner disagrees with the one before it: a reversed transfer (out to another owner and back to this one) inside one probed span would not appear (see more_versions_note).`
                            : "Counts only the transitions among the versions shown; no checkpoint search ran for the rest of this object's life, so an earlier or later transition would not appear.",
                      }
                    : {}),
                  ...(unresolved.length
                    ? {
                        owner_change_unpinned: unresolved.map((u) => ({
                          from_checkpoint: u.lo.checkpoint,
                          to_checkpoint: u.hi.checkpoint,
                          owner_before: describeOwner(u.lo.owner),
                          owner_after: describeOwner(u.hi.owner),
                        })),
                      }
                    : {}),
                  owner_changes: listedChanges.map((c) => ({
                    from: describeOwner(c.from),
                    to: describeOwner(c.to),
                    at_version: c.at_version,
                    tx: c.tx,
                    timestamp: c.timestamp,
                  })),
                  history: listedHistory.map((e) => ({
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
