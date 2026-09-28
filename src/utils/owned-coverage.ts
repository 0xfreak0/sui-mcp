/**
 * What a wallet valuation covers of the objects the wallet owns. Every
 * object it owns directly, coins aside (those are its balances), is one of:
 *
 * - read by the reader that owns its type (a cap is often valued under the
 *   obligation or account it opens, not under its own id);
 * - valued by the balances held inside it, or by a position it wraps;
 * - unread: a reader tried and could not read it;
 * - a kiosk key, whose items are NFTs counted through the kiosk;
 * - an NFT estimate, when NFTs were valued;
 * - not recognised: no reader values its type and nothing inside it that
 *   was read held a coin.
 *
 * Not-recognised objects are listed by type and count, so a total never
 * reads as the wallet's worth while it leaves them out.
 */

import { canonicalType } from "./nft-sales.js";
import { isKioskKey } from "./nft-holdings.js";
import { readerFor, type ValuedPosition, type ValuerResult } from "./position-value.js";
import { HELD_BALANCES, type HeldWalk } from "./valuers/held-balances.js";

const COIN = /^0x0*2::coin::Coin</;

export interface NotRecognisedType {
  type: string;
  count: number;
  /** Up to three of its objects. */
  object_ids: string[];
}

export interface OwnedCoverage {
  /** Objects the address owns besides coins, as far as the walk read. */
  owned_objects: number;
  /** False when the walk stopped at its bound with objects left, or failed. */
  complete: boolean;
  /** Objects read by a reader, by reader: the positions they back are in the totals unless unpriced. */
  read_by: Record<string, number>;
  unread: number;
  kiosk_keys: number;
  nft_estimates?: number;
  not_recognised: number;
  not_recognised_types: NotRecognisedType[];
  /** Not-recognised objects whose own dynamic fields were not read, past the probe bound. */
  dynamic_fields_unread?: number;
  note: string;
}

/**
 * Sort every object the walk read into what covered it. `nfts` says whether
 * NFTs were valued in this call; when not, NFTs count as not recognised and
 * the note says how to value them.
 */
export function ownedCoverage(
  walk: HeldWalk,
  positions: ValuedPosition[],
  unread: ValuerResult["unread"],
  nfts: boolean,
): OwnedCoverage {
  const unreadIds = new Set(unread.map((u) => u.what));
  // A reader that failed as a whole, or could not list one of its types,
  // names itself (`suilend`, `suilend: <type>`) rather than an object: none
  // of its objects was read.
  const failedReaders = new Set(unread.map((u) => u.what.split(":")[0].trim()));
  const heldIds = new Set<string>();
  const nftTypes = new Set<string>();
  for (const p of positions) {
    if (p.kind === "nft") {
      if (typeof p.detail?.collection === "string") nftTypes.add(canonicalType(p.detail.collection));
      continue;
    }
    if (p.object_id) heldIds.add(p.object_id);
    const inside = p.detail?.held_in as { object_id?: unknown } | undefined;
    if (typeof inside?.object_id === "string") heldIds.add(inside.object_id);
  }

  const readBy: Record<string, number> = {};
  const groups = new Map<string, NotRecognisedType>();
  let owned = 0;
  let unreadCount = 0;
  let kioskKeys = 0;
  let nftCount = 0;
  let notRecognised = 0;
  let fieldsUnread = 0;
  const fieldsRead = new Set(walk.fields_read);
  for (const o of walk.objects) {
    if (COIN.test(o.type)) continue;
    owned++;
    const specific = readerFor(o.type, true);
    if (unreadIds.has(o.objectId) || (specific !== null && failedReaders.has(specific))) unreadCount++;
    else if (specific) readBy[specific] = (readBy[specific] ?? 0) + 1;
    else if (heldIds.has(o.objectId)) readBy[HELD_BALANCES] = (readBy[HELD_BALANCES] ?? 0) + 1;
    else if (isKioskKey(o.type)) kioskKeys++;
    else if (nfts && nftTypes.has(canonicalType(o.type))) nftCount++;
    else {
      notRecognised++;
      if (!fieldsRead.has(o.objectId)) fieldsUnread++;
      const g = groups.get(o.type) ?? { type: o.type, count: 0, object_ids: [] };
      g.count++;
      if (g.object_ids.length < 3) g.object_ids.push(o.objectId);
      groups.set(o.type, g);
    }
  }

  const types = [...groups.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const readCount = Object.values(readBy).reduce((s, n) => s + n, 0);
  const parts = [
    `Of the ${owned} objects this address owns besides coins${walk.complete ? "" : " (as far as the walk read; it stopped with objects left)"}, ${readCount} were read by a reader and back the positions valued`,
    ...(unreadCount ? [`${unreadCount} could not be read (see unread)`] : []),
    ...(kioskKeys ? [`${kioskKeys} open kiosks, whose items are NFTs`] : []),
    ...(nfts && nftCount ? [`${nftCount} are NFTs, estimated apart from the total`] : []),
  ];
  const note =
    `${parts.join(", ")}. ` +
    (notRecognised
      ? `${notRecognised} object(s) of ${types.length} type(s) no reader recognises are not in the total: they are listed in not_recognised_types by type and count, and nothing inside them that was read held a coin${fieldsUnread ? `, though the dynamic fields of ${fieldsUnread} of them were not read` : ""}. A receipt of a protocol no reader knows looks the same, so the total is a floor.` +
        (nfts ? "" : " NFTs are among them; list_nft_collections, or get_wallet_overview with include_nfts, estimates those.")
      : "Every one is accounted for above.");
  return {
    owned_objects: owned,
    complete: walk.complete,
    read_by: readBy,
    unread: unreadCount,
    kiosk_keys: kioskKeys,
    ...(nfts ? { nft_estimates: nftCount } : {}),
    not_recognised: notRecognised,
    not_recognised_types: types,
    ...(fieldsUnread ? { dynamic_fields_unread: fieldsUnread } : {}),
    note,
  };
}
