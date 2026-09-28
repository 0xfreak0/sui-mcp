import type { SuiClientTypes } from "@mysten/sui/client";
import { sui } from "../clients/grpc.js";

/** Objects asked for per gRPC page. The fullnode returned 139 in one page at 1,000. */
const PAGE_SIZE = 1000;

export interface OwnedObjectJson {
  objectId: string;
  version: string;
  type: string;
  json: Record<string, unknown> | null;
}

/**
 * Every object of one type an address owns, with its JSON, up to `max`;
 * every object it owns of any type when `type` is null.
 *
 * A single page is a sample: a wallet holding 139 StakedSui objects reported
 * the principal of the first 50 as its total stake. `complete` is false only
 * when `max` stopped the walk with objects left, so a caller can refuse to sum
 * a partial set.
 */
export async function listOwnedWithJson(
  owner: string,
  type: string | null,
  max: number,
): Promise<{ objects: OwnedObjectJson[]; complete: boolean }> {
  const objects: OwnedObjectJson[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: SuiClientTypes.ListOwnedObjectsResponse<{ json: true }> = await sui.listOwnedObjects({
      owner,
      ...(type === null ? {} : { type }),
      limit: Math.min(PAGE_SIZE, max - objects.length),
      cursor,
      include: { json: true },
    });
    for (const o of page.objects) {
      objects.push({ objectId: o.objectId, version: o.version, type: o.type, json: o.json ?? null });
    }
    if (!page.hasNextPage) return { objects, complete: true };
    // More claimed with no cursor to reach it, or the budget spent: either
    // way the set is not whole.
    if (!page.cursor || objects.length >= max) return { objects, complete: false };
    cursor = page.cursor;
  }
}

/**
 * How many objects of one type an address owns, counted over every page up
 * to `max`. `complete` is false when `max` stopped the count with objects
 * left, so the count is a floor.
 */
export async function countOwned(owner: string, type: string, max: number): Promise<{ count: number; complete: boolean }> {
  let count = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: SuiClientTypes.ListOwnedObjectsResponse = await sui.listOwnedObjects({ owner, type, limit: Math.min(PAGE_SIZE, max - count), cursor });
    count += page.objects.length;
    if (!page.hasNextPage) return { count, complete: true };
    if (!page.cursor || count >= max) return { count, complete: false };
    cursor = page.cursor;
  }
}

/** Owned objects one call reads, coins included: five pages of the largest size. */
export const OWNED_WALK_MAX = 5 * PAGE_SIZE;

/**
 * Every object an address owns, with its JSON, up to {@link OWNED_WALK_MAX},
 * read once per call: with `memo` (a call's valuation memo) the readers and
 * the coverage count that follows them share one walk.
 */
export function ownedObjectsWalk(
  owner: string,
  memo?: Map<string, Promise<unknown>>,
): Promise<{ objects: OwnedObjectJson[]; complete: boolean }> {
  if (!memo) return listOwnedWithJson(owner, null, OWNED_WALK_MAX);
  const key = `owned-walk:${owner}`;
  let hit = memo.get(key) as Promise<{ objects: OwnedObjectJson[]; complete: boolean }> | undefined;
  if (!hit) {
    hit = listOwnedWithJson(owner, null, OWNED_WALK_MAX);
    memo.set(key, hit);
    hit.catch(() => memo.delete(key));
  }
  return hit;
}
