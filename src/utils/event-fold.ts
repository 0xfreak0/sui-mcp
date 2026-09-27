/**
 * Events that differ only in their amounts fold into one row: same type,
 * emitting package, module and sender, and the same decoded fields once every
 * digit string is set aside. Sui renders u64 and wider as digit strings and
 * u8 to u32 as JSON numbers; the small ones are indices, chain ids and kinds,
 * so a JSON number stays part of the key and events that differ in one never
 * fold together. The row keeps every emission index,
 * the fields all of them share under `parsed`, and each field that varies
 * under `varying` by its dotted path, with its total, minimum and maximum.
 * A boolean such as a signed amount's `positive` is a field, not an amount,
 * so events of opposite sign never fold together.
 */
/** Characters of compact JSON a transaction's events may take before they fold, and the cap on the folded rows. */
export const EVENT_FOLD_BUDGET = 20_000;

export interface EventRow {
  package_id?: string;
  module?: string;
  event_type?: string;
  sender?: string;
  parsed?: unknown;
}

export type FoldedEvent =
  | (EventRow & { index: number })
  | (EventRow & { index: number; indices: number[]; count: number; varying: Record<string, { total: string; min: string; max: string }> });

const isAmount = (v: unknown): v is string => typeof v === "string" && /^-?\d+$/.test(v);

/** The value with every amount replaced by one placeholder: the fold key. */
function shape(v: unknown): unknown {
  if (isAmount(v)) return "#";
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return v;
}

/** Every amount leaf by dotted path. */
function amounts(v: unknown, path: string, out: Map<string, string>) {
  if (isAmount(v)) out.set(path, v);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) amounts(x, path ? `${path}.${k}` : k, out);
}

/** The value without the leaves at `drop`. */
function without(v: unknown, drop: Set<string>, path = ""): unknown {
  if (drop.has(path)) return undefined;
  if (Array.isArray(v)) return v.map((x, i) => without(x, drop, path ? `${path}.${i}` : String(i)));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .map(([k, x]) => [k, without(x, drop, path ? `${path}.${k}` : k)] as const)
        .filter(([, x]) => x !== undefined),
    );
  }
  return v;
}

export function foldEvents(events: EventRow[]): { rows: FoldedEvent[]; folded: number } {
  const groups = new Map<string, number[]>();
  events.forEach((e, i) => {
    const key = JSON.stringify([e.event_type, e.package_id, e.module, e.sender, shape(e.parsed ?? null)]);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  let folded = 0;
  const rows = [...groups.values()].map((indices): FoldedEvent => {
    const first = events[indices[0]];
    if (indices.length === 1) return { index: indices[0], ...first };
    folded += indices.length;
    const perEvent = indices.map((i) => {
      const m = new Map<string, string>();
      amounts(events[i].parsed, "", m);
      return m;
    });
    const varying: Record<string, { total: string; min: string; max: string }> = {};
    for (const path of perEvent[0].keys()) {
      const values = perEvent.map((m) => m.get(path)!);
      if (values.every((x) => x === values[0])) continue;
      const big = values.map((x) => BigInt(x));
      varying[path] = {
        total: big.reduce((s, x) => s + x, 0n).toString(),
        min: big.reduce((a, b) => (b < a ? b : a)).toString(),
        max: big.reduce((a, b) => (b > a ? b : a)).toString(),
      };
    }
    const { parsed, ...base } = first;
    return {
      index: indices[0],
      indices,
      count: indices.length,
      ...base,
      ...(parsed !== undefined ? { parsed: without(parsed, new Set(Object.keys(varying))) } : {}),
      varying,
    };
  });
  return { rows: rows.sort((a, b) => a.index - b.index), folded };
}
