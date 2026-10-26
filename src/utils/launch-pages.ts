export const LAUNCH_PARENT_LISTS = ["discovered_buyers", "clusters", "destinations"] as const;

/** A parent's scalar fields must survive full-view paging even when child lists are paged separately. */
export function launchListRows(result: Record<string, unknown>, path: string, childPaths: ReadonlySet<string>): unknown[] | null {
  const rows = path.split(".").reduce<unknown>((node, part) =>
    node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined, result);
  if (!Array.isArray(rows)) return null;
  if (!(LAUNCH_PARENT_LISTS as readonly string[]).includes(path)) return rows;
  return rows.map((row, index) => {
    if (!row || typeof row !== "object") return row;
    return Object.fromEntries(Object.entries(row).filter(([field]) => !childPaths.has(`${path}.${index}.${field}`)));
  });
}

/** Every parent and nested list has a retrievable path, including empty parents. */
export function launchCatalogLists(result: Record<string, unknown>, paths: Iterable<string>, childPaths: ReadonlySet<string>): Array<{ path: string; count: number }> {
  return [...paths].flatMap(path => {
    const rows = launchListRows(result, path, childPaths);
    return rows === null ? [] : [{ path, count: rows.length }];
  });
}

/** A failed read has no advancing continuation; the hard cap cannot be repeated. */
export function nextLaunchPageBudget(pages: number, boundedRead: boolean): number | null {
  return boundedRead && pages < 1000 ? Math.min(1000, pages * 2) : null;
}
