/**
 * Kiosk-specific object resolution shared by `get_object`, `identify_address`
 * and `trace_object_history`.
 *
 * `Kiosk.owner` is a self-declared, mutable field. The framework does not
 * update it when the `KioskOwnerCap` that controls the kiosk is transferred,
 * so it can name a former owner. The only way to name the real controller is
 * to find the cap object itself and read its current owner.
 *
 * There is no on-chain index from a kiosk to its cap. `kiosk::new()` creates
 * both together and hands the cap to the caller, so the cap's ID is
 * discoverable only by reading the kiosk's CREATION transaction (found via
 * `objectVersions(first: 1)`, which returns the earliest retained version
 * regardless of how many the kiosk has accumulated since, in one request)
 * and matching the created `KioskOwnerCap` whose `for` field names this
 * kiosk. A batch mint can create hundreds of kiosks and caps in one
 * transaction, so the match is not always on the first page of that
 * transaction's object changes.
 */
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { baseType } from "./object-flow.js";
import { ownerDesc, type OwnerDesc } from "./object-history.js";

const ADDR2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
export const KIOSK_TYPE = `${ADDR2}::kiosk::Kiosk`;
const KIOSK_OWNER_CAP_TYPE = `${ADDR2}::kiosk::KioskOwnerCap`;

const OWNER_FIELDS = `owner {
  __typename
  ... on AddressOwner { address { address } }
  ... on ObjectOwner { address { address } }
  ... on ConsensusAddressOwner { address { address } }
}`;

interface OwnerGql {
  __typename?: string;
  address?: { address: string };
}

const CONTAINER_QUERY = `query ($id: SuiAddress!) {
  object(address: $id) {
    asMoveObject { contents { type { repr } } }
    ${OWNER_FIELDS}
  }
}`;

interface ContainerResult {
  object: {
    asMoveObject?: { contents?: { type?: { repr?: string } } | null } | null;
    owner?: OwnerGql | null;
  } | null;
}

/**
 * Walk up to `maxHops` `ObjectOwner` links from `startId` looking for a
 * `0x2::kiosk::Kiosk`. `startId` is the immediate PARENT of the object in
 * question (an `ObjectOwner.address`, not the object itself), since a kiosk
 * item's own type is never the kiosk's. A kiosk-placed item sits one hop
 * below the kiosk's `kiosk::Item` dynamic-field wrapper, which is itself
 * owned by the kiosk, so `startId` reaches the kiosk within `maxHops = 2`.
 * Matched on the FULL type: a Bag or TableVec parent must not read as a
 * kiosk just because it too is an object owner.
 */
export async function findEnclosingKiosk(startId: string, maxHops = 2): Promise<string | null> {
  let id = startId;
  for (let hop = 0; hop < maxHops; hop++) {
    const r = await gqlQuery<ContainerResult>(CONTAINER_QUERY, { id });
    const type = r.object?.asMoveObject?.contents?.type?.repr;
    if (type && baseType(type) === KIOSK_TYPE) return id;
    const owner = r.object?.owner;
    if (owner?.__typename !== "ObjectOwner" || !owner.address?.address) return null;
    id = owner.address.address;
  }
  return null;
}

const CREATION_TX_QUERY = `query ($id: SuiAddress!) {
  objectVersions(address: $id, first: 1) {
    nodes { previousTransaction { digest } }
  }
}`;

interface CreationTxResult {
  objectVersions: { nodes: Array<{ previousTransaction?: { digest?: string } | null }> } | null;
}

const CAP_SCAN_QUERY = `query ($d: String!, $after: String) {
  transaction(digest: $d) {
    effects {
      objectChanges(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          address
          outputState {
            ${OWNER_FIELDS}
            asMoveObject { contents { type { repr } json } }
          }
        }
      }
    }
  }
}`;

interface CapScanResult {
  transaction: {
    effects: {
      objectChanges: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          address: string;
          outputState?: {
            owner?: OwnerGql | null;
            asMoveObject?: {
              contents?: { type?: { repr?: string }; json?: Record<string, unknown> | null } | null;
            } | null;
          } | null;
        }>;
      };
    } | null;
  } | null;
}

const CURRENT_OWNER_QUERY = `query ($id: SuiAddress!) {
  object(address: $id) { ${OWNER_FIELDS} }
}`;

interface CurrentOwnerResult {
  object: { owner?: OwnerGql | null } | null;
}

/** A wrapper's current owner AND contents: the contents show whether it still holds the cap. */
const CURRENT_STATE_QUERY = `query ($id: SuiAddress!) {
  object(address: $id) {
    ${OWNER_FIELDS}
    asMoveObject { contents { json } }
  }
}`;

interface CurrentStateResult {
  object: { owner?: OwnerGql | null; asMoveObject?: { contents?: { json?: unknown } | null } | null } | null;
}

/** The last transaction to touch an object, found even after it stops
 *  existing as a top-level object (deleted, or wrapped inside another). */
const LAST_TOUCH_QUERY = `query ($id: SuiAddress!) {
  transactions(filter: { affectedObject: $id }, last: 1) {
    nodes { digest }
  }
}`;

interface LastTouchResult {
  transactions: { nodes: Array<{ digest: string }> };
}

export interface KioskCapWrapper {
  object_id: string;
  type: string;
}

/**
 * A creation transaction big enough that the matching cap could sit past this
 * many pages is reported truncated rather than silently wrong. Object IDs are
 * effectively random 32-byte values and `objectChanges` is address-sorted, so
 * where the match falls in a large batch mint is unpredictable. An airdrop
 * to a few hundred recipients can create about 2,000 objects in one
 * transaction, so 40 pages (2,000 rows) covers that; the common case
 * resolves in one page.
 */
const MAX_SCAN_PAGES = 40;

/**
 * Containers visited from the cap outwards, counting each wrapping level and
 * each move of the cap into a new container. A personal kiosk needs one
 * (`PersonalKioskCap`, owned by the wallet); a cap created inside another
 * object and later moved into a `PersonalKioskCap` needs two. The bound keeps
 * a pathological chain from costing unbounded reads.
 */
const MAX_WRAP_STEPS = 4;

/**
 * The struct `target` accepts, embedded at any depth below the top of `json`
 * (a Move object's contents), or null. GraphQL renders a wrapped object
 * inline as its own fields, so a `PersonalKioskCap` reads
 * `{ id, cap: { id, for } }`: the cap is a nested OBJECT carrying its own
 * `id`, never a bare id string. Matching the nested struct rather than a
 * field name also covers wrappers that name the field differently or hold it
 * in an `Option`, rendered as the value.
 */
function embedded(json: unknown, target: (o: Record<string, unknown>) => boolean, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || json === null || typeof json !== "object") return null;
  if (Array.isArray(json)) {
    for (const v of json) {
      const hit = embedded(v, target, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const o = json as Record<string, unknown>;
  if (depth > 0 && target(o)) return o;
  for (const v of Object.values(o)) {
    const hit = embedded(v, target, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const sameId = (v: unknown, id: string): boolean => typeof v === "string" && normalizeSuiAddress(v) === id;

/** A `KioskOwnerCap` rendered inline: exactly `{ id, for }`, `for` naming `kioskId`. */
const isCapFor = (kioskId: string) => (o: Record<string, unknown>): boolean =>
  typeof o.id === "string" && sameId(o.for, kioskId) && Object.keys(o).length === 2;

/**
 * The object embedding what `isEmbedded` accepts, read from `objectId`'s own
 * LAST TOUCH: wrapping, unwrapping and moving a wrapped object out all write
 * the container they happen in, and nothing touches a wrapped object while it
 * stays wrapped. Matched on the embedded struct, not on the wrapper's type: a
 * `PersonalKioskCap` is published by a Mysten extension package, not `0x2`,
 * and pinning its id would drift on upgrade.
 */
async function findWrapper(
  objectId: string,
  isEmbedded: (o: Record<string, unknown>) => boolean,
): Promise<(KioskCapWrapper & { json: unknown }) | null> {
  const last = await gqlQuery<LastTouchResult>(LAST_TOUCH_QUERY, { id: objectId });
  const digest = last.transactions.nodes[0]?.digest;
  if (!digest) return null;

  let after: string | null = null;
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const r: CapScanResult = await gqlQuery<CapScanResult>(CAP_SCAN_QUERY, { d: digest, after });
    const changes = r.transaction?.effects?.objectChanges;
    if (!changes) return null;

    for (const n of changes.nodes) {
      if (normalizeSuiAddress(n.address) === objectId) continue;
      const contents = n.outputState?.asMoveObject?.contents;
      if (!contents || !embedded(contents.json, isEmbedded)) continue;
      return { object_id: n.address, type: contents.type?.repr ?? "unknown", json: contents.json };
    }

    if (!changes.pageInfo.hasNextPage) return null;
    after = changes.pageInfo.endCursor;
    if (!after) return null;
  }
  return null;
}

/**
 * When a `KioskOwnerCap` is no longer a top-level object, find the container
 * holding it now and that container's owner, who controls the kiosk.
 *
 * Each container found is re-read, and its owner is named only if its
 * CURRENT contents still embed the cap: moving a wrapped cap between
 * containers writes the containers but never the cap, so the container named
 * by the cap's last touch can be one it has since left. A container that is
 * no longer top-level, or no longer holds the cap, is followed through its
 * own last touch, which is where it was wrapped further (the next level
 * embeds it whole, its `id` beside other fields, so an `ID`-only key such as
 * `kiosk::Item { id }` never matches) or where the cap moved out (the next
 * container embeds the cap itself, and the chain restarts from it).
 *
 * `owner` is null when a step finds nothing or the walk passes
 * `MAX_WRAP_STEPS`. `left` is set when the last container found still exists
 * but no longer holds the cap and its last write names no new one; it is
 * then kept out of `chain`.
 */
async function followCapWrappers(
  capId: string,
  kioskId: string,
): Promise<{ chain: KioskCapWrapper[]; owner: OwnerDesc | null; left?: KioskCapWrapper }> {
  const cap = normalizeSuiAddress(capId);
  const holdsCap = (o: Record<string, unknown>) => sameId(o.id, cap) && sameId(o.for, kioskId);
  let chain: KioskCapWrapper[] = [];
  let from = cap;
  let target = holdsCap;
  let left: KioskCapWrapper | undefined;
  for (let step = 0; step < MAX_WRAP_STEPS; step++) {
    const found = await findWrapper(from, target);
    if (!found) return left ? { chain, owner: null, left } : { chain, owner: null };
    const wrapper = { object_id: found.object_id, type: found.type };
    const prev = chain[chain.length - 1];
    const wrapsPrev =
      prev !== undefined &&
      embedded(found.json, (o) => sameId(o.id, normalizeSuiAddress(prev.object_id)) && Object.keys(o).length > 1) !== null;
    chain = wrapsPrev ? [...chain, wrapper] : [wrapper];
    left = undefined;

    const id = normalizeSuiAddress(found.object_id);
    const cur = await gqlQuery<CurrentStateResult>(CURRENT_STATE_QUERY, { id });
    if (cur.object && embedded(cur.object.asMoveObject?.contents?.json, holdsCap)) {
      return { chain, owner: ownerDesc(cur.object.owner) };
    }
    from = id;
    if (cur.object) {
      left = chain.pop();
      target = holdsCap;
    } else {
      target = (o) => (sameId(o.id, id) && Object.keys(o).length > 1) || holdsCap(o);
    }
  }
  return left ? { chain, owner: null, left } : { chain, owner: null };
}

export interface KioskCapHolder {
  cap_id: string;
  creation_tx: string;
  /** The cap's owner at creation; for a cap created inside another object,
   *  that object's owner at creation. */
  original_holder: OwnerDesc;
  /** Null when the cap could not be resolved to a current owner, directly
   *  or through the objects wrapping it. */
  holder: OwnerDesc | null;
  /** Set when the cap is no longer a top-level object because something
   *  wraps it: the wrappers from the cap outwards, the last one being the
   *  top-level object whose owner `holder` is. When `holder` is null this
   *  lists how far the chain was followed before it could not continue. */
  wrapped_in?: KioskCapWrapper[];
  /** A container that still exists and once held the cap but holds it no
   *  longer, where the walk stopped because its last write named no new one. */
  cap_left?: KioskCapWrapper;
}

/**
 * The note a caller shows beside a null `holder`, so a null is never read as
 * "nobody controls this kiosk". Undefined when a holder was resolved.
 */
export function unresolvedCapHolderNote(r: KioskCapHolder): string | undefined {
  if (r.holder) return undefined;
  if (r.cap_left) {
    return `The KioskOwnerCap was held in ${r.cap_left.object_id} (${r.cap_left.type}), which still exists but no longer holds it, and that object's last transaction names no new holder, so who controls this kiosk is unresolved.`;
  }
  const chain = r.wrapped_in ?? [];
  if (chain.length === 0) {
    return "The KioskOwnerCap for this kiosk is no longer a top-level object, and the object wrapping it could not be found, so who controls it is unresolved.";
  }
  const last = chain[chain.length - 1];
  return `The KioskOwnerCap is wrapped (${chain.map((w) => w.type).join(" inside ")}), and the outermost wrapper found, ${last.object_id}, is not a top-level object either; nothing wrapping it could be found, so who controls this kiosk is unresolved.`;
}

export type KioskCapLookup =
  | { status: "resolved"; result: KioskCapHolder }
  | { status: "creation_unreachable" }
  | { status: "cap_not_found"; scanned_pages: number; truncated: boolean }
  | { status: "lookup_failed"; message: string };

/**
 * Find who currently holds the `KioskOwnerCap` that controls `kioskId`, the
 * only party who can list, delist or withdraw from it. There is no reverse
 * index for this on chain; it is reconstructed from the kiosk's own creation
 * transaction, which `kiosk::new()` always creates alongside the cap.
 *
 * Never throws: this is a supplementary enrichment behind an object read
 * that already succeeded (`get_object`, `identify_address`,
 * `trace_object_history`), and its sequential GraphQL reads (one
 * `objectVersions`, up to 40 `objectChanges` pages, the cap's own owner, and
 * for a wrapped cap a last-touch read, its pages and an owner read per
 * wrapping level) are a lot of surface for one of those to hit a 429 or a
 * timeout. A failure here degrades to `lookup_failed` with the error message
 * rather than discarding the object answer the caller already has.
 */
export async function resolveKioskCapHolder(kioskId: string): Promise<KioskCapLookup> {
  try {
    return await resolveKioskCapHolderInner(kioskId);
  } catch (err) {
    return { status: "lookup_failed", message: err instanceof Error ? err.message : String(err) };
  }
}

async function resolveKioskCapHolderInner(kioskId: string): Promise<KioskCapLookup> {
  const id = normalizeSuiAddress(kioskId);
  const creation = await gqlQuery<CreationTxResult>(CREATION_TX_QUERY, { id });
  const digest = creation.objectVersions?.nodes[0]?.previousTransaction?.digest;
  if (!digest) return { status: "creation_unreachable" };

  let after: string | null = null;
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const r: CapScanResult = await gqlQuery<CapScanResult>(CAP_SCAN_QUERY, { d: digest, after });
    const changes = r.transaction?.effects?.objectChanges;
    if (!changes) return { status: "creation_unreachable" };

    for (const n of changes.nodes) {
      const contents = n.outputState?.asMoveObject?.contents;
      const type = contents?.type?.repr;
      // The cap is either a top-level output of the creation transaction, or,
      // when the same transaction wrapped it (`personal_kiosk::new` in the
      // same PTB as `kiosk::new`, or a cap created inside another object),
      // embedded in an object that transaction wrote.
      let capId: string;
      if (type && baseType(type) === KIOSK_OWNER_CAP_TYPE && sameId(contents?.json?.for, id)) {
        capId = n.address;
      } else {
        const inner = contents ? embedded(contents.json, isCapFor(id)) : null;
        if (!inner) continue;
        capId = inner.id as string;
      }

      const originalHolder = ownerDesc(n.outputState?.owner);
      const cur = await gqlQuery<CurrentOwnerResult>(CURRENT_OWNER_QUERY, { id: capId });
      if (cur.object) {
        return {
          status: "resolved",
          result: { cap_id: capId, creation_tx: digest, original_holder: originalHolder, holder: ownerDesc(cur.object.owner) },
        };
      }
      // The cap is not a top-level object: the normal state of a personal
      // kiosk, whose controller is the owner of the object holding the cap.
      const { chain, owner, left } = await followCapWrappers(capId, id);
      return {
        status: "resolved",
        result: {
          cap_id: capId,
          creation_tx: digest,
          original_holder: originalHolder,
          holder: owner,
          ...(chain.length ? { wrapped_in: chain } : {}),
          ...(left ? { cap_left: left } : {}),
        },
      };
    }

    if (!changes.pageInfo.hasNextPage) return { status: "cap_not_found", scanned_pages: page + 1, truncated: false };
    after = changes.pageInfo.endCursor;
    if (!after) return { status: "cap_not_found", scanned_pages: page + 1, truncated: false };
  }
  return { status: "cap_not_found", scanned_pages: MAX_SCAN_PAGES, truncated: true };
}
