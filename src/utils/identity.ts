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

import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getLabel } from "./labels.js";
import { batchResolveNames } from "./names.js";
import { lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import {
  authenticationNote as describeAuthentication,
  readAuthentication,
  type Authentication,
} from "./multisig.js";

/** GraphQL page cap, and the natural chunk size for a keyed multi-get. */
const CHUNK = 50;

/**
 * Addresses whose authentication is read per GraphQL request.
 *
 * There is no multi-get for `transactions`, so this batches with aliases and
 * hits the same two service limits as package lineage: at most 20 queries that
 * need a backing store, and 5000 bytes of query text. Twenty aliased
 * `transactions` calls land at roughly 2.4KB, inside both. Kept separate from
 * `ROOT_BATCH_SIZE` because the payload per alias is different, not because
 * the limits are.
 */
const AUTH_BATCH_SIZE = 20;

/** Padded, so it matches the form the chain reports. */
const ALIAS_TYPE = `${normalizeSuiAddress("0x2")}::address_alias::AddressAliases`;

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
   * How the address authenticates, read from a transaction it sent.
   *
   * Absent means we could not tell, and that is not the same as "ordinary
   * wallet": an address that has never sent anything has produced no
   * signature, so a receive-only treasury multisig is indistinguishable from a
   * fresh personal wallet. `authentication_note` says so in words.
   */
  authentication?: Authentication;
  /**
   * Addresses this wallet has authorized to act for it, via `0x2::address_alias`.
   *
   * Chain-derived control, read from the `AddressAliases` object the wallet
   * owns: each of these may authorize a transaction for it. That is NOT a claim
   * of shared ownership — a custodian holds authority for a client, the same
   * distinction `co_signer` draws.
   *
   * The owner's own address is excluded, because a set begins holding only
   * itself and that is the absence of delegation rather than an instance of it.
   * Absent means no `AddressAliases` object exists, which is the common case for
   * a feature enabled on 63 mainnet wallets as of 2026-09-15.
   *
   * **Mutable**, unlike `authentication`: `remove` and `replace_all` exist, so
   * this is true as of the read and must not be cached the way a committee is.
   */
  aliases?: string[];
  /**
   * The identity of each multisig committee member, in committee order.
   *
   * A committee names addresses; this says who they are. Present only when the
   * caller asked to expand members, and only for a multisig.
   *
   * Exactly one level deep, and that is a property of the chain rather than a
   * budget: `PublicKey` in `sui-types` has no `MultiSig` variant, so a
   * committee cannot contain another committee and there is nothing to
   * recurse into.
   */
  committee_members?: AddressIdentity[];
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
 * How each address authenticates. Batched with aliases; never throws.
 *
 * One sent transaction is enough and the oldest is as good as the newest,
 * because an address commits to its authenticator in its own hash and can
 * never rotate it. That is also why nothing here is cached with a TTL — the
 * answer is fixed for the life of the address.
 *
 * An address with no sent transaction is simply absent from the result. It has
 * signed nothing, so there is nothing to read, and saying "single-key wallet"
 * would be a guess dressed as a finding.
 */
/**
 * Which addresses each wallet has authorized to act for it.
 *
 * `0x2::address_alias` lets an address name up to eight others that may
 * authorize for it. The `AddressAliases` object is owned by the address it
 * describes, so this is a filtered object read per address, batched with
 * aliases like the authentication query and bounded by the same service caps.
 *
 * The owner's own address is dropped: a set begins holding only itself, and
 * reporting that as a delegation would turn "has enabled the feature" into
 * "has given someone else authority".
 *
 * Addresses are validated before being interpolated, for the reason the
 * authentication query above states — one unparseable address answers the
 * WHOLE aliased batch with `data: null`.
 */
async function fetchAliases(addresses: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const usable: Array<{ query: string; original: string }> = [];
  for (const original of addresses) {
    const query = normalizeSuiAddress(original);
    if (isValidSuiAddress(query)) usable.push({ query, original });
  }

  for (let i = 0; i < usable.length; i += AUTH_BATCH_SIZE) {
    const chunk = usable.slice(i, i + AUTH_BATCH_SIZE);
    const query =
      "query {\n" +
      chunk
        .map(
          (_, j) =>
            `  a${j}: objects(filter: { type: "${ALIAS_TYPE}", owner: $a${j} }, first: 1) { nodes { asMoveObject { contents { json } } } }`,
        )
        .join("\n") +
      "\n}";
    const inlined = chunk.reduce((q, a, j) => q.replace(`$a${j}`, JSON.stringify(a.query)), query);
    try {
      const r = await gqlQuery<
        Record<string, { nodes: Array<{ asMoveObject?: { contents?: { json?: unknown } } }> }>
      >(inlined);
      chunk.forEach((a, j) => {
        const json = r[`a${j}`]?.nodes?.[0]?.asMoveObject?.contents?.json as
          | { aliases?: { contents?: unknown } }
          | undefined;
        const contents = json?.aliases?.contents;
        if (!Array.isArray(contents)) return;
        const self = normalizeSuiAddress(a.query);
        const others = contents
          .filter((x): x is string => typeof x === "string" && x.length > 0)
          .map((x) => normalizeSuiAddress(x))
          .filter((x) => x !== self);
        if (others.length) out.set(a.original, others);
      });
    } catch {
      // Enrichment. A trace the chain already answered must not fail here.
    }
  }
  return out;
}

async function fetchAuthentication(addresses: string[]): Promise<Map<string, Authentication>> {
  const out = new Map<string, Authentication>();
  // One unparseable address answers the WHOLE aliased batch with data: null,
  // not a null for its own alias. The catch below treats that as "no
  // authentication found" for all 20, so a single bad address in a seed list
  // silently removes multisig and zkLogin detection from the other nineteen —
  // downgrading a real finding to an absent one, which this project treats as
  // worse than reporting "unknown". Same rule as watched addresses and as
  // digests in get_transactions.
  // The NORMALIZED form is what gets batched, because normalizeSuiAddress ADDS
  // the 0x prefix: "2" passes a validity check applied to the normalized value
  // and is then rejected by the service, which is the same whole-batch failure
  // this filter exists to prevent.
  //
  // The result is keyed by the address the CALLER passed. Keying it canonically
  // would silently drop authentication for any caller holding a short form —
  // the identical mismatch that stopped a watch cursor advancing, one module
  // over.
  const usable: Array<{ query: string; original: string }> = [];
  for (const original of addresses) {
    const query = normalizeSuiAddress(original);
    if (isValidSuiAddress(query)) usable.push({ query, original });
  }
  for (let i = 0; i < usable.length; i += AUTH_BATCH_SIZE) {
    const chunk = usable.slice(i, i + AUTH_BATCH_SIZE);
    const query =
      "query {\n" +
      chunk
        .map(
          (_, j) =>
            `  a${j}: transactions(filter: { sentAddress: $a${j} }, first: 1) { nodes { signatures { signatureBytes } } }`,
        )
        .join("\n") +
      "\n}";
    // Variables would need declaring in the operation signature, so the address
    // is inlined. That is only safe because the chunk was validated above.
    const inlined = chunk.reduce((q, a, j) => q.replace(`$a${j}`, JSON.stringify(a.query)), query);
    try {
      const r = await gqlQuery<Record<string, { nodes: { signatures: { signatureBytes: string }[] }[] }>>(
        inlined,
      );
      chunk.forEach((a, j) => {
        const sigs = r[`a${j}`]?.nodes?.[0]?.signatures?.map((s) => s.signatureBytes);
        if (!sigs?.length) return;
        // Derived against the canonical form — an address IS the hash of its
        // authenticator, so the re-derivation only matches the padded value.
        const auth = readAuthentication(a.query, sigs);
        if (auth) out.set(a.original, auth);
      });
    } catch {
      // Enrichment only. A trace the chain already answered must not fail here.
    }
  }
  return out;
}

export interface DescribeOptions {
  /**
   * Also read how each address authenticates.
   *
   * Costs one extra GraphQL call per twenty addresses — `transactions` has no
   * multi-get, so this batches with aliases and the service caps those at
   * twenty. Every investigation flow turns it on: a trace whose hop set is
   * under twenty addresses, which is the common case, pays exactly one call
   * for it.
   */
  authentication?: boolean;
  /**
   * Also resolve each multisig committee member's own identity. Implies
   * `authentication`.
   *
   * This is the fan-out that makes a multisig worth detecting. The committee
   * names member addresses; without this the reader has a list of hex strings
   * and no idea that one of them is a labelled exchange deposit or carries an
   * expired SuiNS name that appears elsewhere in the case.
   *
   * One extra round over the member set, never more: committees cannot nest.
   */
  expandMembers?: boolean;
  /**
   * Also read each address's alias set.
   *
   * Off by default and separate from `authentication`, because it is a
   * different question — who may spend, rather than what the address is — and
   * it costs its own batched request.
   */
  aliases?: boolean;
}

/**
 * Name, label, kind and protocol for every address in one pass, and
 * optionally how each one authenticates.
 */
export async function describeAddresses(
  addresses: string[],
  options: DescribeOptions = {},
): Promise<Map<string, AddressIdentity>> {
  const unique = [...new Set(addresses.filter(Boolean))];
  const out = new Map<string, AddressIdentity>();
  if (unique.length === 0) return out;

  const wantAuth = options.authentication || options.expandMembers;
  const [names, kinds, held, auth, aliases] = await Promise.all([
    batchResolveNames(unique).catch(() => new Map<string, string>()),
    fetchKinds(unique),
    fetchHeldNames(unique),
    wantAuth ? fetchAuthentication(unique) : new Map<string, Authentication>(),
    options.aliases ? fetchAliases(unique) : new Map<string, string[]>(),
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
      ...(auth.get(address) ? { authentication: auth.get(address) } : {}),
      ...(aliases.get(address)?.length ? { aliases: aliases.get(address) } : {}),
      ...(held.get(address)?.length ? { names_held: held.get(address) } : {}),
    });
  }

  if (options.expandMembers) await expandCommitteeMembers(out);
  return out;
}

/**
 * Resolve the identity of every multisig member across a result set, in one
 * batch, and attach each committee's members to it.
 *
 * One round for the whole set rather than one per multisig — three 7-member
 * committees are 21 addresses, which is two calls here and six if each were
 * expanded on its own. The recursion terminates because committees cannot
 * nest, so the inner call deliberately does not expand again.
 *
 * A member we cannot resolve keeps its address and nothing else. Dropping it
 * would misreport the committee's size, which is the one number a reader uses
 * to judge how much control any single key represents.
 */
async function expandCommitteeMembers(identities: Map<string, AddressIdentity>): Promise<void> {
  const memberAddresses = new Set<string>();
  for (const id of identities.values()) {
    for (const m of id.authentication?.multisig?.members ?? []) {
      if (m.address) memberAddresses.add(m.address);
    }
  }
  if (memberAddresses.size === 0) return;

  const resolved = await describeAddresses([...memberAddresses], { authentication: true });

  for (const id of identities.values()) {
    const members = id.authentication?.multisig?.members;
    if (!members) continue;
    id.committee_members = members.map((m) => {
      const known = m.address ? resolved.get(m.address) : undefined;
      if (known) return known;
      return {
        address: m.address ?? `(${m.scheme} member #${m.index}, no derivable address)`,
        kind: "wallet" as const,
      };
    });
  }
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
  // Said after the kind checks because those describe what is AT the address,
  // and this describes who can spend from it. A multisig is still a wallet;
  // the point is that it is not one person's key.
  if (!id.authentication) return undefined;
  const base = describeAuthentication(id.authentication);
  if (!base) return undefined;
  // Naming the members that are already attributable is the difference between
  // "this is a 4-of-7" and a lead worth following.
  const known = (id.committee_members ?? []).filter((m) => m.name || m.label);
  if (known.length === 0) return base;
  const who = known.map((m) => `${m.address.slice(0, 10)}… (${m.label ?? m.name})`).join(", ");
  return `${base} Already attributable among its members: ${who}.`;
}
