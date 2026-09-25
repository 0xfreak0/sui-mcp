import { classifyCapabilityRisk, type CapabilityInfo } from "./capabilities.js";

/**
 * The compact per-module view `analyze_package` and `get_package` return by
 * default. Full signatures and struct shapes run to 250k characters on a
 * framework package (0x2), past what a client keeps inline, so they are
 * returned for the modules asked for (`modules`) or with `detail: 'full'`.
 */

export interface ModuleFunction {
  name: string;
  /** "public" | "public(friend)" | "private" | "unknown", as `formatVisibility` renders it. */
  visibility: string;
  isEntry: boolean;
}

export interface ModuleShape {
  name: string;
  functions: ModuleFunction[];
  structs: Array<{ name: string }>;
}

export interface ModuleSummary {
  name: string;
  function_count: number;
  struct_count: number;
  /** Entry functions, whatever their visibility: what a transaction can call directly. */
  entry_functions: string[];
  /** Public functions that are not entry: callable from other packages and from a PTB's MoveCall. */
  public_functions: string[];
  friend_function_count: number;
  private_function_count: number;
}

export function summarizeModule(m: ModuleShape): ModuleSummary {
  const entry: string[] = [];
  const pub: string[] = [];
  let friend = 0;
  let priv = 0;
  for (const f of m.functions) {
    if (f.isEntry) entry.push(f.name);
    else if (f.visibility === "public") pub.push(f.name);
    else if (f.visibility === "public(friend)") friend++;
    else priv++;
  }
  return {
    name: m.name,
    function_count: m.functions.length,
    struct_count: m.structs.length,
    entry_functions: entry,
    public_functions: pub,
    friend_function_count: friend,
    private_function_count: priv,
  };
}

/**
 * The modules a caller named, in package order, and the names that matched
 * none. An empty or absent list selects nothing.
 */
export function selectModules<T extends { name?: string }>(
  modules: T[],
  wanted: string[] | undefined,
): { selected: T[]; missing: string[] } {
  if (!wanted?.length) return { selected: [], missing: [] };
  const names = new Set(wanted);
  const have = new Set(modules.map((m) => m.name));
  return {
    selected: modules.filter((m) => m.name !== undefined && names.has(m.name)),
    missing: [...names].filter((n) => !have.has(n)),
  };
}

/** Caps of one type in one ownership state, listed once with every holder. */
export interface CapabilityGroup {
  kind: CapabilityInfo["kind"];
  type: string;
  owner: CapabilityInfo["owner"];
  risk: CapabilityInfo["risk"];
  count: number;
  holders: Array<{ object_id: string; owner_address?: string }>;
  note: string;
}

/**
 * Fold capabilities that differ only in object id and holder into one entry.
 *
 * A publish can mint dozens of the same cap (Sui's genesis created one
 * validator cap per validator), and each entry repeats the type, the risk and
 * a note that differs only by the holder's address. Every object id and holder
 * is kept. An UpgradeCap is never folded: it carries its own policy and holder
 * assessment. Groups of one are returned as the original entry.
 */
export function groupCapabilities(caps: CapabilityInfo[]): Array<CapabilityInfo | CapabilityGroup> {
  const groups = new Map<string, CapabilityInfo[]>();
  const order: Array<CapabilityInfo | string> = [];
  for (const cap of caps) {
    if (cap.kind === "upgrade") {
      order.push(cap);
      continue;
    }
    const key = [cap.kind, cap.type, cap.owner, cap.risk].join("|");
    const members = groups.get(key);
    if (members) members.push(cap);
    else {
      groups.set(key, [cap]);
      order.push(key);
    }
  }
  return order.map((entry) => {
    if (typeof entry !== "string") return entry;
    const members = groups.get(entry)!;
    const [head] = members;
    if (members.length === 1) return head;
    return {
      kind: head.kind,
      type: head.type,
      owner: head.owner,
      risk: head.risk,
      count: members.length,
      holders: members.map((c) => ({
        object_id: c.object_id,
        ...(c.owner_address ? { owner_address: c.owner_address } : {}),
      })),
      note: classifyCapabilityRisk({
        kind: head.kind,
        type: head.type,
        owner: head.owner,
        ownerAddress: head.owner_address ? "the holder of each object in holders" : undefined,
      }).note,
    };
  });
}
