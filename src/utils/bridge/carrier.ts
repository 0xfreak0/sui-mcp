/**
 * A package that sends a curated bridge's transfer from its own code: an
 * adapter, an aggregator, a wallet's router. The bridge's own markers name the
 * bridge and nothing else, so the package that made the call on the user's
 * behalf goes unnamed, and its own event (an order id, a fee) is the thread
 * that ties the transfer to a front end or a service.
 *
 * Two readings, both from chain data:
 *
 *   - In a transaction: every event records the module of the PTB command
 *     whose call emitted it. A bridge event emitted under a module outside the
 *     bridge's upgrade lineage was sent by that module's package.
 *   - In a package: its bytecode names every function it calls in another
 *     package. A call into a curated bridge's exit entry means the package can
 *     send that bridge's transfer.
 */

import { gqlQuery } from "../../clients/graphql.js";
import { lookupProtocol } from "../../protocols/registry.js";
import { prefetchPackageRoots } from "../../protocols/package-roots.js";
import { getLabel } from "../labels.js";
import { canonicalSuiAddress } from "../chain-id.js";
import { importedFunctions } from "../module-imports.js";
import { BRIDGE_PROTOCOLS, bridgeExitEntry, type CallSite } from "./detect.js";
import { matchesEvent } from "./event-type.js";
import type { SuiEventNode } from "./wormhole.js";

/** A package that emitted a curated bridge's event from its own PTB call. */
export interface BridgeCarrier {
  evidence: "chain-derived";
  package: string;
  module: string;
  /** The PTB's calls into that module, `module::function`. */
  functions: string[];
  /** The bridges whose events its call emitted. */
  carried: string[];
  bridge_events: string[];
  /** Events of the carrier's own lineage in the same transaction: its record of the transfer. */
  emitted: Array<{ type: string; fields: unknown }>;
}

/** Why a carrier is reported, stated once beside the list. */
export const CARRIER_MEANING =
  "Each carrier's call emitted a curated bridge's event: the event records the PTB command's module, and that module's " +
  "package is outside the bridge's upgrade lineage. The carrier sent the transfer on the sender's behalf; `emitted` is its " +
  "own record of it, such as an order id to match against the service that built the transaction.";

/** The package of a type or a `0xpkg::module` string, canonical. */
const packageOf = (s: string) => canonicalSuiAddress(s.split("::")[0]);

/** Curated bridge events of this transaction, with the package that defines each. */
function bridgeEventsOf(events: SuiEventNode[]) {
  return events.flatMap((e) => {
    const type = e?.contents?.type?.repr;
    const bridge = typeof type === "string" ? BRIDGE_PROTOCOLS.find((p) => p.eventMarkers.some((m) => matchesEvent(m, type))) : undefined;
    const definer = typeof type === "string" ? packageOf(type) : null;
    return bridge && definer && type ? [{ e, type, bridge: bridge.name, definer }] : [];
  });
}

/**
 * The packages whose lineage {@link bridgeCarriers} needs: the sending and
 * defining packages of every curated bridge event sent under another
 * package. Empty when every bridge event was sent by its own package, so a
 * direct transfer costs no lineage read.
 */
export function carrierPackages(events: SuiEventNode[]): string[] {
  const out = new Set<string>();
  for (const b of bridgeEventsOf(events)) {
    const fq = b.e.transactionModule?.fullyQualifiedName;
    const sender = fq ? packageOf(fq) : null;
    if (sender && sender !== b.definer) out.add(sender).add(b.definer);
  }
  return [...out];
}

/**
 * Carriers of this transaction's curated bridge events. `lineage` gives a
 * package's upgrade root, or null when it was not read; an event whose
 * sending package's root is unknown is not attributed, since a direct call
 * into an upgraded version of the bridge looks the same until the root is
 * known. A package that defines a curated bridge event in the same
 * transaction is that bridge (a Mayan order's package sending its Wormhole
 * leg) and is named by the bridge markers already, as is a package the
 * protocol registry types as a bridge.
 */
export function bridgeCarriers(
  events: SuiEventNode[],
  calls: CallSite[],
  lineage: (pkg: string) => string | null,
): BridgeCarrier[] {
  const root = (pkg: string) => lineage(pkg) ?? pkg;
  const bridgeEvents = bridgeEventsOf(events);
  const bridgeRoots = new Set(bridgeEvents.map((b) => root(b.definer)));

  const byModule = new Map<string, BridgeCarrier>();
  for (const b of bridgeEvents) {
    const fq = b.e.transactionModule?.fullyQualifiedName;
    const sender = fq ? packageOf(fq) : null;
    const module = fq?.split("::")[1];
    if (!sender || !module) continue;
    const senderRoot = lineage(sender);
    if (senderRoot === null || bridgeRoots.has(senderRoot) || lookupProtocol(sender)?.type === "bridge") continue;
    const key = `${sender}::${module}`;
    const c = byModule.get(key) ?? {
      evidence: "chain-derived" as const,
      package: sender,
      module,
      functions: [...new Set(calls.filter((call) => canonicalSuiAddress(call.packageId) === sender && call.module === module).map((call) => `${call.module}::${call.function}`))],
      carried: [],
      bridge_events: [],
      emitted: events.flatMap((e) => {
        const t = e?.contents?.type?.repr;
        const p = typeof t === "string" ? packageOf(t) : null;
        return t && p && root(p) === senderRoot ? [{ type: t, fields: e.contents?.json ?? null }] : [];
      }),
    };
    if (!c.carried.includes(b.bridge)) c.carried.push(b.bridge);
    if (!c.bridge_events.includes(b.type)) c.bridge_events.push(b.type);
    byModule.set(key, c);
  }
  return [...byModule.values()];
}

/** One call in a package's bytecode into a curated bridge's exit entry. */
export interface BridgeExitCall {
  /** The calling module in this package. */
  module: string;
  bridge: string;
  /** `0xpkg::module::function` called. */
  target: string;
  /** The protocol registry's name for the called package, when it has one. */
  target_protocol: string | null;
}

/**
 * Calls to curated bridge exit entries among each module's imported
 * functions. The entry is matched by `module::function`, and the called
 * package must be the bridge: a registry `bridge` (its lineage included) or a
 * package labelled `bridge`. A same-named function in any other package is
 * not a bridge call.
 */
export async function bridgeExitCalls(modules: Array<{ name: string; bytes: Uint8Array }>): Promise<{ calls: BridgeExitCall[]; unreadable: string[] }> {
  const matched: Array<{ module: string; bridge: string; address: string; target: string }> = [];
  const unreadable: string[] = [];
  for (const m of modules) {
    const imports = importedFunctions(m.bytes);
    if (!imports) {
      unreadable.push(m.name);
      continue;
    }
    for (const f of imports) {
      const bridge = bridgeExitEntry(f.module, f.function);
      if (bridge) matched.push({ module: m.name, bridge: bridge.name, address: f.address, target: `${f.address}::${f.module}::${f.function}` });
    }
  }
  // An upgraded bridge version is named through its lineage root.
  if (matched.length) await prefetchPackageRoots(new Set(matched.map((c) => c.address)));
  const calls = matched.flatMap((c): BridgeExitCall[] => {
    const protocol = lookupProtocol(c.address);
    if (protocol?.type !== "bridge" && getLabel(c.address)?.category !== "bridge") return [];
    return [{ module: c.module, bridge: c.bridge, target: c.target, target_protocol: protocol?.name ?? null }];
  });
  return { calls, unreadable };
}

/** Modules per page: module bytes run to tens of kilobytes. */
const MODULE_PAGE = 20;

const MODULE_BYTES_QUERY = `query ($p: SuiAddress!, $after: String) {
  object(address: $p) {
    asMovePackage {
      modules(first: ${MODULE_PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { name bytes }
      }
    }
  }
}`;

interface ModulesPage {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: Array<{ name?: string; bytes?: string | null }>;
}

interface ModuleBytesPage {
  object?: { asMovePackage?: { modules?: ModulesPage | null } | null } | null;
}

/** Every module's bytes in exactly this package version, or null when any page could not be read. */
export async function fetchModuleBytes(packageId: string): Promise<Array<{ name: string; bytes: Uint8Array }> | null> {
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  let after: string | null = null;
  for (;;) {
    let page: ModulesPage | null | undefined;
    try {
      page = (await gqlQuery<ModuleBytesPage>(MODULE_BYTES_QUERY, { p: packageId, after }))?.object?.asMovePackage?.modules;
    } catch {
      return null;
    }
    if (!page?.nodes) return null;
    for (const n of page.nodes) {
      if (typeof n.name !== "string" || typeof n.bytes !== "string") return null;
      out.push({ name: n.name, bytes: Buffer.from(n.bytes, "base64") });
    }
    if (!page.pageInfo?.hasNextPage) return out;
    after = page.pageInfo.endCursor ?? null;
    // A page claiming more with no cursor would restart the walk.
    if (!after) return null;
  }
}
