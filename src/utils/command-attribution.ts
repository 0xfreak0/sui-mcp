/**
 * Which PTB command emitted each event and touched each changed object, as
 * far as the executed transaction itself says. `get_transaction` with
 * `commands` narrows its events and object changes with these, and names
 * each event's command in its full view.
 */
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

type Command = Record<string, unknown>;

/** An event as `get_transaction` lists it: the package and module of the Move call that emitted it. */
export interface Emitter {
  package_id?: string | null;
  module?: string | null;
}

/** The commands one event can have come from, in index order. One entry is exact. */
export type EventCommands = number[];

/** A MoveCall command's package (normalized) and module; null for any other command. */
function calledModule(c: Command): { pkg: string; module: string } | null {
  if (c.type !== "MoveCall" || typeof c.target !== "string") return null;
  const [pkg, module] = c.target.split("::");
  return pkg && module ? { pkg: normalizeSuiAddress(pkg), module } : null;
}

/**
 * The commands each event can have come from. An event carries the package
 * and module of the top-level Move call that emitted it, and commands run in
 * order, so emission order never returns to an earlier command: an event's
 * earliest command is the first matching one at or after the previous
 * event's earliest, and its latest the last matching one at or before the
 * next event's latest. Consecutive calls into one module share their events
 * between them, and those events list every command they can belong to.
 * Events match on package and module, or on module alone when that fits no
 * order (an event emitted before the relocate_event_module cutover names the
 * package's original id). Null when neither fits.
 */
export function eventCommands(events: Emitter[], commands: Command[]): EventCommands[] | null {
  const calls = commands.map(calledModule);
  const attempt = (samePackage: boolean): EventCommands[] | null => {
    const candidates = events.map((e) => {
      const pkg = e.package_id ? normalizeSuiAddress(e.package_id) : null;
      return calls.flatMap((c, i) => (c && c.module === e.module && (!samePackage || c.pkg === pkg) ? [i] : []));
    });
    const lo: number[] = [];
    let floor = 0;
    for (const found of candidates) {
      const first = found.find((c) => c >= floor);
      if (first === undefined) return null;
      lo.push(first);
      floor = first;
    }
    const out: EventCommands[] = new Array(events.length);
    let ceiling = Number.POSITIVE_INFINITY;
    for (let i = events.length - 1; i >= 0; i--) {
      const inRange = candidates[i].filter((c) => c >= lo[i] && c <= ceiling);
      if (inRange.length === 0) return null;
      out[i] = inRange;
      ceiling = inRange[inRange.length - 1];
    }
    return out;
  };
  return attempt(true) ?? attempt(false);
}

/** Every object id a resolved command takes as an argument, at any depth of its arguments. */
export function commandObjectIds(c: Command): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "object_id" && typeof x === "string") out.add(normalizeSuiAddress(x));
        else walk(x);
      }
    }
  };
  walk(c);
  return [...out];
}

/** The PTB input indices a resolved command takes, at any depth of its arguments. */
export function commandInputIndices(c: Command): number[] {
  const out = new Set<number>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "Input" && typeof o.index === "number") out.add(o.index);
      Object.values(o).forEach(walk);
    }
  };
  walk(c);
  return [...out].sort((a, b) => a - b);
}

/** Canonical struct tag, or the input when it does not parse. */
function typeKey(t: string): string {
  try {
    return normalizeStructTag(t);
  } catch {
    return t;
  }
}

/**
 * Whether a changed object belongs to the chosen commands: one of them takes
 * it as an argument, or it was created with a type one of them returns.
 */
export function objectMatcher(chosen: Command[]): (row: { object_id: string; type: string | null }, kind: string) => boolean {
  const ids = new Set(chosen.flatMap(commandObjectIds));
  const returned = new Set(
    chosen.flatMap((c) => (Array.isArray(c.returns) ? c.returns.filter((r): r is string => typeof r === "string").map(typeKey) : [])),
  );
  return (row, kind) => ids.has(normalizeSuiAddress(row.object_id)) || (kind === "created" && row.type !== null && returned.has(typeKey(row.type)));
}
