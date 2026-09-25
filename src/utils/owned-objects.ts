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
 * Every object of one type an address owns, with its JSON, up to `max`.
 *
 * A single page is a sample: a wallet holding 139 StakedSui objects reported
 * the principal of the first 50 as its total stake. `complete` is false only
 * when `max` stopped the walk with objects left, so a caller can refuse to sum
 * a partial set.
 */
export async function listOwnedWithJson(
  owner: string,
  type: string,
  max: number,
): Promise<{ objects: OwnedObjectJson[]; complete: boolean }> {
  const objects: OwnedObjectJson[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: SuiClientTypes.ListOwnedObjectsResponse<{ json: true }> = await sui.listOwnedObjects({
      owner,
      type,
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
