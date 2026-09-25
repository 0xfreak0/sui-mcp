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
import { getLabel, labelProvenance, type LabelProvenance } from "./labels.js";
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
 * Aliases per alias-lookup request. NOT `AUTH_BATCH_SIZE`.
 *
 * That constant was measured against the `transactions` query, whose line is
 * short. This one repeats the 97-character type string and a 66-character owner
 * per alias, about 270 bytes each, so it crosses the service's 5,000-byte query
 * cap far sooner. Measured: 18 aliases is 4,859 bytes and accepted, 19 is 5,129
 * and rejected outright.
 *
 * Reusing 20 made every full batch fail, and the catch below turned that into
 * "this wallet has delegated to nobody" for all twenty. Fifteen leaves room for
 * the type string to grow without anyone re-deriving this.
 */
const ALIAS_BATCH_SIZE = 15;

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

/**
 * Addresses per held-names request. NOT `CHUNK`.
 *
 * The service's 5,000-byte cap counts the variables as well as the query text,
 * and each full-length address key costs about 80 bytes. Measured with this
 * query: 40 addresses accepted, 44 rejected at 5,127 bytes, and 50 rejected at
 * 5,694. The catch below would turn that rejection into "holds no names" for
 * the whole chunk, so this stays well under the line.
 */
const HELD_NAMES_BATCH_SIZE = 35;

/**
 * `previousTransaction` is the transaction that last wrote the registration,
 * read in the same request as the names. An owned object can only be written
 * by a transaction its owner sent, so a sender other than the holder means that
 * transaction delivered it and the holder has not transacted with it since.
 */
const HELD_NAMES_QUERY = `query ($keys: [AddressKey!]!, $type: String!, $first: Int!) {
  multiGetAddresses(keys: $keys) {
    address
    objects(first: $first, filter: { type: $type }) {
      nodes {
        address
        contents { json }
        previousTransaction { digest sender { address } effects { timestamp } }
      }
    }
  }
}`;

interface HeldNamesResult {
  multiGetAddresses: Array<{
    address?: string;
    objects?: {
      nodes: Array<{
        address?: string;
        contents?: { json?: unknown };
        previousTransaction?: {
          digest?: string;
          sender?: { address?: string } | null;
          effects?: { timestamp?: string | null } | null;
        } | null;
      }>;
    };
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

/**
 * How a held registration reached the address, read from the transaction that
 * last wrote it.
 *
 * - `registered_or_used`: the holder sent that transaction, so it registered,
 *   bought, renewed or otherwise used the name itself.
 * - `received_from_third_party`: another address sent it, which means that
 *   transaction delivered the NFT and the holder has not transacted with it
 *   since. Anyone can send a name to any address.
 * - `unknown`: the transaction could not be read.
 */
export type NameProvenance = "registered_or_used" | "received_from_third_party" | "unknown";

/** A SuiNS name an address holds the registration for, live or expired. */
export interface HeldName {
  name: string;
  expired: boolean;
  expires_at?: string;
  /** Object id of the `SuinsRegistration` NFT. */
  registration_id?: string;
  provenance: NameProvenance;
  /** The transaction that last wrote the registration. */
  last_tx?: string;
  last_tx_at?: string;
  /** Sender of `last_tx`, when that is not the holder. */
  received_from?: string;
}

/**
 * Who may authorize for an address.
 *
 * Three shapes, and they are different findings:
 *
 * - `authorized` is the owner alone. The feature is enabled and nobody else can
 *   act for the wallet. `enable` seeds the set this way, so this is the absence
 *   of delegation rather than an instance of it.
 * - The owner plus others. Both the wallet and the others can act.
 * - The owner is ABSENT. The set replaces the signer, so the wallet's own key
 *   can no longer act for it and only the others can.
 */
export interface AliasSet {
  /** Every address that may authorize, exactly as the chain states it. */
  authorized: string[];
  /** Whether the wallet's own address is among them. */
  owner_can_authorize: boolean;
  /** `authorized` without the owner. Empty means nobody else was authorized. */
  delegated_to: string[];
}

export interface AddressIdentity {
  address: string;
  kind: AddressKind;
  /** Move type, when the address holds an object. */
  object_type?: string;
  name?: string;
  label?: string;
  label_category?: string;
  /** Where the label comes from: entity, evidence kind, source_url, retrieved_at. */
  label_provenance?: LabelProvenance;
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
   * Who may authorize for this wallet, via `0x2::address_alias`.
   *
   * The alias set REPLACES the signer, it does not extend it: the verifier
   * accepts a signature from any member of the set in place of the address
   * itself. So the set is the authoritative list of who controls the wallet,
   * and the owner's own presence in it is a fact that has to be reported rather
   * than assumed.
   *
   * Measured on mainnet 2026-09-15 across all 63 sets: **50 owners are absent
   * from their own set**, so their own key can no longer authorize for them; 4
   * of those name exactly one other address, which is a total handover. Only 2
   * sets hold the owner alone.
   *
   * Chain-derived control, and not a claim of shared ownership: a custodian
   * holds authority for a client, the same distinction `co_signer` draws.
   *
   * **Mutable**, unlike `authentication`: `remove` and `replace_all` exist, so
   * this is true as of the read and must not be cached the way a committee is.
   */
  aliases?: AliasSet;
  /** The alias lookup failed. Not the same as the wallet having no aliases. */
  aliases_unavailable?: boolean;
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
   * Reverse lookup answers a narrower question, the current default name, and
   * returns nothing once a name lapses. The registration object outlives
   * expiry, so this is where a wallet's historical aliases survive.
   *
   * Holding the NFT is not by itself attribution: it is transferable, and
   * anyone can send one to any address. `provenance` says whether the holder
   * registered or used the name, or only received it; only the first is a name
   * the address was known by.
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
  for (let i = 0; i < addresses.length; i += HELD_NAMES_BATCH_SIZE) {
    const chunk = addresses.slice(i, i + HELD_NAMES_BATCH_SIZE);
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
          const prev = n.previousTransaction;
          const sender = prev?.sender?.address;
          const self = sender !== undefined && normalizeSuiAddress(sender) === normalizeSuiAddress(chunk[j]);
          held.push({
            name: json.domain_name,
            expired: exp > 0 && exp < now,
            ...(exp > 0 ? { expires_at: new Date(exp).toISOString() } : {}),
            ...(n.address ? { registration_id: n.address } : {}),
            // Without the writing transaction there is nothing to tell a name
            // the holder chose from one it was sent, so neither is assumed.
            provenance: !prev?.digest || !sender ? "unknown" : self ? "registered_or_used" : "received_from_third_party",
            ...(prev?.digest ? { last_tx: prev.digest } : {}),
            ...(prev?.effects?.timestamp ? { last_tx_at: prev.effects.timestamp } : {}),
            ...(sender && !self ? { received_from: sender } : {}),
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
 * Who may authorize for each wallet, via `0x2::address_alias`.
 *
 * The `AddressAliases` object is owned by the address it describes, at an
 * address derived from `(0xa, AliasKey(owner))`, and the type carries `key`
 * without `store` so it can never be transferred away. One owner therefore has
 * at most one such object, which is what makes `first: 1` sound.
 *
 * **The set replaces the signer rather than extending it.** The verifier
 * accepts a signature from any member in place of the address itself, so an
 * owner absent from its own set can no longer authorize for itself. That is
 * reported, never assumed: measured across all 63 mainnet sets, 50 owners are
 * absent from their own.
 *
 * Batched at `ALIAS_BATCH_SIZE`. That is deliberately not the authentication
 * batch size; see the constant. Addresses are validated before being
 * interpolated, since one unparseable address answers the WHOLE aliased batch
 * with `data: null`.
 *
 * A chunk whose request failed is returned in `failed`, so the caller can say
 * "could not check" instead of reporting silence as an absence of delegation.
 */
async function fetchAliases(
  addresses: string[],
): Promise<{ found: Map<string, AliasSet>; failed: Set<string> }> {
  const out = new Map<string, AliasSet>();
  const failed = new Set<string>();
  const usable: Array<{ query: string; original: string }> = [];
  for (const original of addresses) {
    const query = normalizeSuiAddress(original);
    if (isValidSuiAddress(query)) usable.push({ query, original });
  }

  for (let i = 0; i < usable.length; i += ALIAS_BATCH_SIZE) {
    const chunk = usable.slice(i, i + ALIAS_BATCH_SIZE);
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
        const authorized = contents
          .filter((x): x is string => typeof x === "string" && x.length > 0)
          .map((x) => normalizeSuiAddress(x));
        if (!authorized.length) return;
        // The owner stays in the list. Whether it is there is the finding:
        // the set replaces the signer rather than extending it, so an owner
        // missing from its own set can no longer authorize for itself.
        out.set(a.original, {
          authorized,
          owner_can_authorize: authorized.includes(self),
          delegated_to: authorized.filter((x) => x !== self),
        });
      });
    } catch (err) {
      // A failed lookup is not an absence of delegation. Recorded so the caller
      // can say "could not check" rather than reporting silence as a finding,
      // and reported to stderr so a query the service rejected is separable
      // from a transport blip. Never stdout: that is the MCP transport.
      for (const a of chunk) failed.add(a.original);
      console.error(`[identity] alias lookup failed for ${chunk.length} addresses: ${(err as Error).message}`);
    }
  }
  return { found: out, failed };
}

/**
 * How each address authenticates. Batched with aliases; never throws.
 *
 * One sent transaction is enough and the oldest is as good as the newest,
 * because an address commits to its authenticator in its own hash and can never
 * rotate it. That is also why nothing here is cached with a TTL: the answer is
 * fixed for the life of the address. Note this is a fact about DERIVATION, not
 * about who may spend — see `fetchAliases`.
 *
 * An address with no sent transaction is simply absent from the result. It has
 * signed nothing, so there is nothing to read, and saying "single-key wallet"
 * would be a guess dressed as a finding.
 */
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
    options.aliases
      ? fetchAliases(unique)
      : { found: new Map<string, AliasSet>(), failed: new Set<string>() },
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
      ...(label
        ? {
            label: label.label,
            label_category: label.category,
            ...(labelProvenance(label) ? { label_provenance: labelProvenance(label) } : {}),
          }
        : {}),
      ...(protocol ? { protocol } : {}),
      ...(auth.get(address) ? { authentication: auth.get(address) } : {}),
      ...(aliases.found.get(address) ? { aliases: aliases.found.get(address) } : {}),
      ...(aliases.failed.has(address) ? { aliases_unavailable: true } : {}),
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
 * Held names sorted by what they say about the holder.
 *
 * A name is the holder's own when it sent the transaction that last wrote the
 * registration, or when the name is its current reverse record: only the
 * address itself can set that. Everything else it was sent by another address
 * and has not touched since, which is not attribution.
 */
export function classifyHeldNames(id: AddressIdentity): {
  /** Expired names the holder registered or used. */
  expired_own: HeldName[];
  /** Expired names whose writing transaction could not be read. */
  expired_unread: HeldName[];
  /** Names, live or expired, delivered by another address and unused since. */
  received: HeldName[];
} {
  const held = id.names_held ?? [];
  const own = (h: HeldName) => h.provenance === "registered_or_used" || h.name === id.name;
  return {
    expired_own: held.filter((h) => h.expired && own(h)),
    expired_unread: held.filter((h) => h.expired && !own(h) && h.provenance === "unknown"),
    received: held.filter((h) => !own(h) && h.provenance === "received_from_third_party"),
  };
}

/** What the held registrations say about the holder, or nothing to say. */
export function heldNamesNote(id: AddressIdentity): string | undefined {
  const { expired_own, expired_unread, received } = classifyHeldNames(id);
  const parts: string[] = [];
  if (expired_own.length > 0 && !id.name) {
    const one = expired_own.length === 1;
    parts.push(
      `No current SuiNS name, but this address holds ${expired_own.length} EXPIRED registration(s) it registered or used itself: ${expired_own.map((h) => h.name).join(", ")}. Reverse lookup no longer returns ${one ? "it" : "them"}, so older records may refer to the address by ${one ? "that name" : "those names"}.`,
    );
  }
  if (expired_unread.length > 0) {
    parts.push(
      `This address holds ${expired_unread.length} EXPIRED registration(s) whose last transaction could not be read: ${expired_unread.map((h) => h.name).join(", ")}. Whether it registered them or was sent them is unknown.`,
    );
  }
  if (received.length > 0) {
    const list = received
      .map((h) => `${h.name}${h.expired ? " (expired)" : ""} from ${h.received_from}${h.last_tx ? ` in ${h.last_tx}` : ""}`)
      .join("; ");
    parts.push(
      `This address holds ${received.length} SuiNS registration(s) sent to it by another address, and it has not transacted with ${received.length === 1 ? "that registration" : "those registrations"} since: ${list}. Anyone can send a name to any address, so ${received.length === 1 ? "this name is" : "these names are"} not attribution.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * A one-line reading for a reader scanning a chain of hops.
 *
 * Anything that is not a plain wallet is called out, because that is the case
 * where "funds went to X" would otherwise be read as a person.
 */
export function identityNote(id: AddressIdentity): string | undefined {
  // Said before the kind, because a lapsed alias is the finding a reader is
  // most likely to be missing entirely: reverse lookup simply stops
  // mentioning it. A received name is said here too, since it is the name a
  // reader is most likely to mistake for the holder's own.
  const names = heldNamesNote(id);
  if (names) return names;
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
