/**
 * What kind of thing an address is, resolved for a whole result set at once.
 *
 * An investigation keeps turning up addresses, and "who is this" is asked of
 * every one of them. `identify_address` answers it thoroughly but costs about
 * five requests per address, which is unaffordable per hop. This is the cheap
 * half, and it batches: one `multiGetObjects` call classifies fifty addresses
 * in ~0.15s.
 *
 * The distinction earns its place because it changes what a result *means*. A
 * trace reporting "funded by 0xabc" reads as a person; if 0xabc is a package or
 * a shared object, that reading is wrong, and nothing else in the response says
 * so. Names and labels were already resolved in these flows — this adds the
 * kind, which was the missing half.
 *
 * Everything here is best-effort. Enrichment must never fail a trace that the
 * chain already answered.
 */

import { gqlQuery } from "../clients/graphql.js";
import { getLabel } from "./labels.js";
import { batchResolveNames } from "./names.js";
import { lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";

/** GraphQL page cap, and the natural chunk size for a keyed multi-get. */
const CHUNK = 50;

/**
 * SuiNS registrations, matched at module level.
 *
 * A Move type keeps the package that DEFINED it, so this does not drift when
 * SuiNS upgrades — the opposite of the call-target problem the protocol
 * registry solves with lineage roots. Module rather than full type so a rename
 * of the struct does not silently stop matching.
 */
const SUINS_REGISTRATION =
  "0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration";

/** Registrations read per address. Far beyond any observed holder. */
const NAMES_PER_ADDRESS = 25;

const HELD_NAMES_QUERY = `query ($keys: [AddressKey!]!, $type: String!, $first: Int!) {
  multiGetAddresses(keys: $keys) {
    address
    objects(first: $first, filter: { type: $type }) {
      nodes { contents { json } }
    }
  }
}`;

interface HeldNamesResult {
  multiGetAddresses: Array<{
    address?: string;
    objects?: { nodes: Array<{ contents?: { json?: unknown } }> };
  } | null>;
}

const MULTI_GET = `query ($keys: [ObjectKey!]!) {
  multiGetObjects(keys: $keys) {
    address
    asMovePackage { address }
    asMoveObject { contents { type { repr } } }
  }
}`;

interface MultiGetResult {
  multiGetObjects: Array<{
    address?: string;
    asMovePackage?: { address?: string } | null;
    asMoveObject?: { contents?: { type?: { repr?: string } } } | null;
  } | null>;
}

/**
 * `wallet` is the *absence* of an object at that address, which is what an
 * ordinary account looks like on Sui. It is therefore a default, not a
 * positive finding — an address nobody has ever transacted with classifies the
 * same way.
 */
export type AddressKind = "wallet" | "package" | "object";

/** A SuiNS name an address holds the registration for, live or expired. */
export interface HeldName {
  name: string;
  expired: boolean;
  expires_at?: string;
}

export interface AddressIdentity {
  address: string;
  kind: AddressKind;
  /** Move type, when the address holds an object. */
  object_type?: string;
  name?: string;
  label?: string;
  label_category?: string;
  /** Protocol name, when the address is a package the registry knows. */
  protocol?: string;
  /**
   * Every SuiNS registration this address holds, including expired ones.
   *
   * Reverse lookup answers a narrower question — what is the current *default*
   * name — and returns nothing once a name lapses. The registration object
   * outlives expiry, so this is where a wallet's historical aliases survive.
   * An expired name is still attribution: the address was known by it at the
   * time of the activity under investigation, which is exactly when it matters.
   */
  names_held?: HeldName[];
}

/** Classify addresses by what lives at them. Batched; never throws. */
async function fetchKinds(addresses: string[]): Promise<Map<string, { kind: AddressKind; type?: string }>> {
  const out = new Map<string, { kind: AddressKind; type?: string }>();
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    try {
      const r = await gqlQuery<MultiGetResult>(MULTI_GET, {
        keys: chunk.map((address) => ({ address })),
      });
      // Positional: the response mirrors the keys it was given, so a null entry
      // means "nothing at that address" rather than a dropped result.
      r.multiGetObjects.forEach((o, j) => {
        const addr = chunk[j];
        if (!o) {
          out.set(addr, { kind: "wallet" });
        } else if (o.asMovePackage) {
          out.set(addr, { kind: "package" });
        } else {
          out.set(addr, { kind: "object", type: o.asMoveObject?.contents?.type?.repr });
        }
      });
    } catch {
      // Leave this chunk unclassified rather than guessing. A missing kind is
      // honest; a wrong one changes how a hop reads.
    }
  }
  return out;
}

/** SuiNS registrations held per address. Batched; never throws. */
async function fetchHeldNames(addresses: string[]): Promise<Map<string, HeldName[]>> {
  const out = new Map<string, HeldName[]>();
  const now = Date.now();
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    try {
      const r = await gqlQuery<HeldNamesResult>(HELD_NAMES_QUERY, {
        keys: chunk.map((address) => ({ address })),
        type: SUINS_REGISTRATION,
        first: NAMES_PER_ADDRESS,
      });
      r.multiGetAddresses.forEach((a, j) => {
        const nodes = a?.objects?.nodes ?? [];
        const held: HeldName[] = [];
        for (const n of nodes) {
          const json = n.contents?.json as
            | { domain_name?: string; expiration_timestamp_ms?: string | number }
            | undefined;
          if (!json?.domain_name) continue;
          const exp = Number(json.expiration_timestamp_ms ?? 0);
          held.push({
            name: json.domain_name,
            expired: exp > 0 && exp < now,
            ...(exp > 0 ? { expires_at: new Date(exp).toISOString() } : {}),
          });
        }
        if (held.length > 0) out.set(chunk[j], held);
      });
    } catch {
      // Historical names are an enrichment; never fail the caller over them.
    }
  }
  return out;
}

/**
 * Name, label, kind and protocol for every address in one pass.
 *
 * Two network calls total regardless of set size: one batched name resolution
 * and one batched classification, both already chunked.
 */
export async function describeAddresses(addresses: string[]): Promise<Map<string, AddressIdentity>> {
  const unique = [...new Set(addresses.filter(Boolean))];
  const out = new Map<string, AddressIdentity>();
  if (unique.length === 0) return out;

  const [names, kinds, held] = await Promise.all([
    batchResolveNames(unique).catch(() => new Map<string, string>()),
    fetchKinds(unique),
    fetchHeldNames(unique),
  ]);

  // Only packages are worth a protocol lookup, and the registry is cached, so
  // this adds no requests beyond the prefetch.
  const packages = unique.filter((a) => kinds.get(a)?.kind === "package");
  if (packages.length > 0) await prefetchProtocolNames(packages).catch(() => {});

  for (const address of unique) {
    const k = kinds.get(address);
    const label = getLabel(address);
    const protocol = k?.kind === "package" ? lookupProtocolDisplay(address)?.name : undefined;
    out.set(address, {
      address,
      kind: k?.kind ?? "wallet",
      ...(k?.type ? { object_type: k.type } : {}),
      ...(names.get(address) ? { name: names.get(address) } : {}),
      ...(label ? { label: label.label, label_category: label.category } : {}),
      ...(protocol ? { protocol } : {}),
      ...(held.get(address)?.length ? { names_held: held.get(address) } : {}),
    });
  }
  return out;
}

/**
 * A one-line reading for a reader scanning a chain of hops.
 *
 * Anything that is not a plain wallet is called out, because that is the case
 * where "funds went to X" would otherwise be read as a person.
 */
export function identityNote(id: AddressIdentity): string | undefined {
  // Said before the kind, because a lapsed alias is the finding a reader is
  // most likely to be missing entirely — reverse lookup simply stops
  // mentioning it.
  const expired = (id.names_held ?? []).filter((n) => n.expired).map((n) => n.name);
  if (expired.length > 0 && !id.name) {
    return `No current SuiNS name, but this address holds ${expired.length} EXPIRED registration(s): ${expired.join(", ")}. It was known by ${expired.length === 1 ? "that name" : "those names"} previously, which is how it may appear in older records.`;
  }
  if (id.kind === "package") {
    return `This is a PACKAGE${id.protocol ? ` (${id.protocol})` : ""}, not a wallet — value associated with it is protocol activity, not a person holding funds.`;
  }
  if (id.kind === "object") {
    return `This is an OBJECT${id.object_type ? ` (${id.object_type.split("::").slice(-2).join("::")})` : ""}, not a wallet — it may be a shared pool or vault that many parties touch.`;
  }
  return undefined;
}
