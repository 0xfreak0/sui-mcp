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
import { getNetwork, type SuiNetwork } from "../config.js";
import { getLabel, labelProvenance, type LabelProvenance } from "./labels.js";
import { batchResolveNames } from "./names.js";
import { lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import {
  assignSignerRoles,
  authenticationNote as describeAuthentication,
  readAuthentication,
  type Authentication,
} from "./multisig.js";
import { BALANCE_CHANGES_SELECTION, readAllBalanceChanges, type GqlConnection } from "./tx-connections.js";
import type { GqlBalanceChangeNode } from "./gql-adapters.js";
import type { FrameworkClaim } from "./framework-claims.js";

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
 * Framework facts the alias reading rests on: an `AddressAliases` object has
 * `key` without `store`, so it never leaves its owner and one owner has at
 * most one; its set is the `aliases` field; and the set can change.
 */
export const ALIAS_CLAIMS: FrameworkClaim[] = [
  { struct: "address_alias::AddressAliases", abilities: ["key"], fields: ["id", "aliases"], why: "one owner has at most one alias set, read from its aliases field" },
  { struct: "address_alias::AliasKey", fields: ["0"], why: "an alias set sits at an id derived from (0xa, AliasKey(owner))" },
  { fn: "address_alias::remove", entry: true, takes: { "address_alias::AddressAliases": "&mut" }, why: "an alias set is mutable, so it is true only as of the read" },
  { fn: "address_alias::replace_all", entry: true, takes: { "address_alias::AddressAliases": "&mut" }, why: "an alias set is mutable, so it is true only as of the read" },
];

/**
 * Aliases per alias-lookup request. NOT `AUTH_BATCH_SIZE`.
 *
 * This query repeats the 97-character type string and a 66-character owner
 * per alias, about 270 bytes each, so it reaches the service's 5,000-byte
 * query cap far sooner than the short `transactions` query that constant is
 * sized for. A rejected batch reaches the catch below and reads as "this
 * wallet has delegated to nobody" for every alias in it. Fifteen leaves room
 * for the type string to grow.
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
 * and each full-length address key costs about 80 bytes on top of the query
 * text. The catch below would turn a rejection into "holds no names" for the
 * whole chunk, so this stays well under the line.
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
 * Addresses per kind lookup. The service caps a request at 5,000 bytes
 * including variables, and each key costs about 81 bytes. A rejected chunk
 * classifies as nothing, and the caller's default then reads every address in
 * it as a wallet.
 */
const KINDS_BATCH_SIZE = 40;

/**
 * `wallet` is the *absence* of an object at that address, which is what an
 * ordinary account looks like on Sui. It is therefore a default, not a
 * positive finding — an address nobody has ever transacted with classifies the
 * same way.
 *
 * `wrapped_or_deleted_object` is an address with no live object and no
 * signature that some transaction nevertheless recorded as an OBJECT id: the
 * UID of an object that was wrapped inside another or deleted, such as a
 * zkSend link's bag. Value sent to it moves only through the owning module.
 */
export type AddressKind = "wallet" | "package" | "object" | "wrapped_or_deleted_object";

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
  /** The authentication lookup failed. Not the same as the address never having sent. */
  authentication_unavailable?: boolean;
  /**
   * The address has sent transactions, but none of those examined carries its
   * own signature: another address authorized them in its place, through an
   * address alias or a protocol-level substitution. How the address itself
   * authenticates is then unknown, and "never sent" would be false.
   */
  foreign_authorization?: {
    authorized_by: string[];
    digest: string;
    transactions_examined: number;
  };
  /**
   * This address's own authentication, recovered from a transaction it
   * signed as an address alias for another wallet, because none of its own
   * sent transactions carry its signature (`authentication` and
   * `foreign_authorization` are both absent). `sentAddress` and
   * `affectedAddress` both key on the transaction's sender, which an alias
   * signature never is, so this is read the other way: from the owners whose
   * alias set names this address, through their own sent transactions.
   */
  signed_as_alias_for?: {
    owner: string;
    digest: string;
  };
  /**
   * Every owner whose `0x2::address_alias` set names this address as a
   * delegate, from the reverse scan, whether or not a signature match was
   * found among that owner's sampled sent transactions. Present even when
   * `signed_as_alias_for` is absent: a real delegation whose key has simply
   * never signed within the sample must not read the same as "not a
   * delegate at all".
   */
  alias_delegate_for?: string[];
  /**
   * The reverse alias-signature scan (the on-chain delegate discovery, or
   * one of the owner-transaction batches checked against it) failed or hit
   * its cap. `signed_as_alias_for` and `alias_delegate_for` may understate
   * reality: a delegation or a signature can exist beyond what this reached.
   */
  alias_scan_unavailable?: boolean;
  /**
   * When the reverse scan behind `signed_as_alias_for`, `alias_delegate_for`
   * and `alias_scan_unavailable` read which alias sets name this address
   * (ISO). The scan is cached per network, so this can trail a recent
   * `add` or `remove`; see `aliasScanAsOfClause`. Set whenever that scan ran
   * for this address.
   */
  alias_scan_as_of?: string;
  /**
   * For `wrapped_or_deleted_object`: a transaction that recorded this id as
   * an object, which is the evidence for the kind.
   */
  object_seen_in?: string;
  /**
   * Who may authorize for this wallet, via `0x2::address_alias`.
   *
   * The alias set REPLACES the signer, it does not extend it: the verifier
   * accepts a signature from any member of the set in place of the address
   * itself. So the set is the authoritative list of who controls the wallet,
   * and the owner's own presence in it is a fact that has to be reported rather
   * than assumed.
   *
   * An owner absent from its own set can no longer authorize for itself, and a
   * set without the owner that names exactly one other address is a total
   * handover.
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

/** Classify addresses by what lives at them. Batched; never throws; an address left out could not be read. */
export async function fetchKinds(addresses: string[]): Promise<Map<string, { kind: AddressKind; type?: string }>> {
  const out = new Map<string, { kind: AddressKind; type?: string }>();
  for (let i = 0; i < addresses.length; i += KINDS_BATCH_SIZE) {
    const chunk = addresses.slice(i, i + KINDS_BATCH_SIZE);
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
 * reported, never assumed.
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

/** Sent transactions read per address when looking for its own signature. */
const AUTH_SAMPLE = 5;

interface AuthenticationLookup {
  found: Map<string, Authentication>;
  /** Addresses whose sent transactions carry none of their own signatures. */
  foreign: Map<string, NonNullable<AddressIdentity["foreign_authorization"]>>;
  /** Addresses whose lookup failed, so nothing may be concluded about them. */
  failed: Set<string>;
}

/**
 * How each address authenticates. Batched with aliases; never throws.
 *
 * One of its own signatures is enough and the oldest is as good as the newest,
 * because an address commits to its authenticator in its own hash and can never
 * rotate it. That is also why nothing here is cached with a TTL: the answer is
 * fixed for the life of the address. Note this is a fact about DERIVATION, not
 * about who may spend — see `fetchAliases`.
 *
 * A sent transaction does not always carry the sender's own signature: an
 * address alias, or a protocol-level substitution, authorizes in its place.
 * Such a transaction says who acted, and the address counts as having sent.
 * Up to `AUTH_SAMPLE` transactions are read; when none is self-signed the
 * address lands in `foreign` with the signers that did authorize.
 *
 * An address with no sent transaction is absent from all three results. It
 * has signed nothing, so there is nothing to read, and saying "single-key
 * wallet" would be a guess dressed as a finding.
 */
async function fetchAuthentication(addresses: string[]): Promise<AuthenticationLookup> {
  const out: AuthenticationLookup = { found: new Map(), foreign: new Map(), failed: new Set() };
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
            `  a${j}: transactions(filter: { sentAddress: $a${j} }, first: ${AUTH_SAMPLE}) { nodes { digest gasInput { gasSponsor { address } } signatures { signatureBytes } } }`,
        )
        .join("\n") +
      "\n}";
    // Variables would need declaring in the operation signature, so the address
    // is inlined. That is only safe because the chunk was validated above.
    const inlined = chunk.reduce((q, a, j) => q.replace(`$a${j}`, JSON.stringify(a.query)), query);
    try {
      const r = await gqlQuery<
        Record<
          string,
          {
            nodes: Array<{
              digest: string;
              gasInput?: { gasSponsor?: { address?: string } | null } | null;
              signatures: { signatureBytes: string }[];
            }>;
          }
        >
      >(inlined);
      chunk.forEach((a, j) => {
        const nodes = r[`a${j}`]?.nodes ?? [];
        let firstForeign: { digest: string; authorized_by: string[] } | null = null;
        for (const n of nodes) {
          const sigs = n.signatures?.map((s) => s.signatureBytes) ?? [];
          if (!sigs.length) continue;
          // Derived against the canonical form — an address IS the hash of its
          // authenticator, so the re-derivation only matches the padded value.
          const auth = readAuthentication(a.query, sigs);
          if (auth) {
            out.found.set(a.original, auth);
            return;
          }
          const signers = assignSignerRoles(a.query, n.gasInput?.gasSponsor?.address, sigs);
          if (!firstForeign && signers.signer_is_sender === false) {
            firstForeign = { digest: n.digest, authorized_by: signers.authorized_by };
          }
        }
        if (firstForeign) {
          out.foreign.set(a.original, { ...firstForeign, transactions_examined: nodes.length });
        }
      });
    } catch {
      // Enrichment only. A trace the chain already answered must not fail
      // here, but "could not read" is recorded so no caller says "never sent".
      for (const a of chunk) out.failed.add(a.original);
    }
  }
  return out;
}

/**
 * Which of `addresses` were ever recorded as an OBJECT id. Batched; never
 * throws.
 *
 * An address with no live object and no signature reads as a wallet by
 * default. When a transaction's object changes name it, it is the UID of an
 * object that has since been wrapped or deleted (a zkSend bag, a consumed
 * receipt), and value sent to it is released only by that object's module.
 * `affectedObject` never matches an account address, since an object id is
 * derived from a transaction digest and an account address from a key.
 */
async function fetchFormerObjects(addresses: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const usable = addresses
    .map((original) => ({ original, query: normalizeSuiAddress(original) }))
    .filter((a) => isValidSuiAddress(a.query));
  for (let i = 0; i < usable.length; i += AUTH_BATCH_SIZE) {
    const chunk = usable.slice(i, i + AUTH_BATCH_SIZE);
    const query =
      "query {\n" +
      chunk
        .map((a, j) => `  a${j}: transactions(filter: { affectedObject: ${JSON.stringify(a.query)} }, first: 1) { nodes { digest } }`)
        .join("\n") +
      "\n}";
    try {
      const r = await gqlQuery<Record<string, { nodes: Array<{ digest: string }> }>>(query);
      chunk.forEach((a, j) => {
        const digest = r[`a${j}`]?.nodes?.[0]?.digest;
        if (digest) out.set(a.original, digest);
      });
    } catch {
      // Enrichment only; the address keeps its default kind.
    }
  }
  return out;
}

/** Objects of `0x2::address_alias::AddressAliases` read per full-scan page. */
const ALIAS_SCAN_PAGE = 50;

/**
 * Full-scan cap. The owner population is small, so this is headroom rather
 * than a limit expected to bind; it exists so a future surge in `enable`
 * calls cannot turn a single `identify_address` lookup into an unbounded
 * crawl. Hitting it reports `status: "truncated"` rather than silently
 * under-reporting delegators.
 */
const ALIAS_SCAN_CAP = 2000;

const ALIAS_SCAN_QUERY = `query ($first: Int!, $after: String) {
  objects(filter: { type: "${ALIAS_TYPE}" }, first: $first, after: $after) {
    nodes {
      owner { ... on AddressOwner { address { address } } ... on ConsensusAddressOwner { address { address } } }
      asMoveObject { contents { json } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface AliasScanResult {
  objects: {
    nodes: Array<{
      owner?: { address?: { address?: string } } | null;
      asMoveObject?: { contents?: { json?: { aliases?: { contents?: unknown } } } } | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/**
 * "complete": every page was read. "truncated": stopped at `ALIAS_SCAN_CAP`
 * with more pages remaining. "failed": a request threw; `byDelegate` holds
 * whatever had already been read.
 */
export type AliasScanStatus = "complete" | "truncated" | "failed";

interface AliasDelegateScan {
  byDelegate: Map<string, string[]>;
  status: AliasScanStatus;
  /** When the scan read chain state (epoch ms); a cached scan keeps its own. */
  readAt: number;
}

/**
 * `scanAliasDelegators` costs ceil(owner_objects/50) sequential requests, and
 * `get_transaction_history` and `identify_address` both call it. The owner
 * population changes only on an `enable`/`disable` call, so a short cache
 * absorbs repeated calls within one session; the TTL bounds how long a change
 * can go unseen. Every answer resting on it states when it was read
 * (`aliasScanAsOfClause`), since the forward direction (`fetchAliases`) is
 * read live and the two can disagree inside one TTL.
 */
const ALIAS_DELEGATE_CACHE_TTL_MS = 5 * 60 * 1000;
const aliasDelegateCache = new Map<SuiNetwork, AliasDelegateScan>();

/** Test-only: a scan cached by an earlier case must not leak into the next one. */
export function resetAliasDelegateCache(): void {
  aliasDelegateCache.clear();
}

/**
 * The sentence said beside any answer that rests on the reverse delegate
 * scan (`alias_delegate_for`, `signed_as_alias`, a never-sent caveat), so a
 * cached scan is never presented as a live read.
 */
export function aliasScanAsOfClause(asOf: string): string {
  return `Which alias sets name this address was read at ${asOf} and is reused for up to ${ALIAS_DELEGATE_CACHE_TTL_MS / 60_000} minutes, so a delegation added or removed after that is not reflected.`;
}

/**
 * Every `AddressAliases` object that exists, decoded to delegate -> owners.
 *
 * This is the reverse of `fetchAliases`: that reads one owner's set from the
 * object derived at its own address, and there is no filter that goes the
 * other way, from a delegate key back to the owners who named it. The owner
 * population is tiny enough that a full scan answers it directly.
 *
 * Cached per network (see `ALIAS_DELEGATE_CACHE_TTL_MS`). A failed scan is
 * never cached, so the next call retries instead of being pinned to an
 * empty result for the whole TTL window.
 */
async function scanAliasDelegators(): Promise<AliasDelegateScan> {
  const network = getNetwork();
  const cached = aliasDelegateCache.get(network);
  if (cached && Date.now() - cached.readAt < ALIAS_DELEGATE_CACHE_TTL_MS) return cached;

  // Stamped before the first page, so the reported time never postdates what was read.
  const readAt = Date.now();
  const byDelegate = new Map<string, string[]>();
  let after: string | null = null;
  let scanned = 0;
  let status: AliasScanStatus = "complete";
  try {
    for (;;) {
      const r: AliasScanResult = await gqlQuery<AliasScanResult>(ALIAS_SCAN_QUERY, { first: ALIAS_SCAN_PAGE, after });
      const nodes = r.objects.nodes;
      scanned += nodes.length;
      for (const n of nodes) {
        const owner = n.owner?.address?.address;
        const contents = n.asMoveObject?.contents?.json?.aliases?.contents;
        if (!owner || !Array.isArray(contents)) continue;
        const ownerNorm = normalizeSuiAddress(owner);
        for (const raw of contents) {
          if (typeof raw !== "string" || !raw) continue;
          const delegate = normalizeSuiAddress(raw);
          if (delegate === ownerNorm) continue; // the owner's own membership, not a delegation
          const list = byDelegate.get(delegate) ?? [];
          list.push(ownerNorm);
          byDelegate.set(delegate, list);
        }
      }
      if (!r.objects.pageInfo.hasNextPage) break;
      if (scanned >= ALIAS_SCAN_CAP) {
        status = "truncated";
        break;
      }
      after = r.objects.pageInfo.endCursor;
    }
  } catch {
    status = "failed";
  }
  const scan: AliasDelegateScan = { byDelegate, status, readAt };
  if (status !== "failed") aliasDelegateCache.set(network, scan);
  return scan;
}

/**
 * Owners' sent transactions read per GraphQL request. Chunked, not capped:
 * a custodian key can be named by far more owners than one request's
 * 21-aliased-connection limit allows in a single round trip, and every
 * delegating owner is checked rather than only the first few.
 */
const ALIAS_AUTH_OWNER_BATCH = 20;

/** Each candidate owner's sent transactions read, newest first. */
export const ALIAS_AUTH_SAMPLE = 10;

/** One transaction a target address signed as an address alias for `owner`. */
export interface AliasSignedTransaction {
  owner: string;
  digest: string;
  timestamp?: string;
  authentication: Authentication;
}

export interface AliasSignedLookup {
  /** Every alias-signed transaction found per target. */
  matches: Map<string, AliasSignedTransaction[]>;
  /**
   * Every owner whose alias set names the target, whether or not a
   * signature match was found among that owner's sampled sent transactions.
   */
  delegateFor: Map<string, string[]>;
  /** Worst status across the delegate scan and every owner-transaction batch read. */
  status: AliasScanStatus;
  /** When the delegate scan behind `delegateFor` read chain state (epoch ms). Absent when no scan ran. */
  scanReadAt?: number;
}

/**
 * Every transaction `targets` signed as an address alias for someone else,
 * rather than one they sent themselves.
 *
 * `sentAddress` and `affectedAddress` both key on the transaction's sender,
 * which an alias signature never is: the sender is the address being acted
 * for. An address that only ever signs as an alias is therefore invisible to
 * both filters: `get_transaction_history` on it shows only what it received,
 * and `fetchAuthentication` reports it as having never sent anything. This
 * walks the relationship the other way: which owners named `target` in their
 * alias set (`scanAliasDelegators`), then which of those owners' own
 * signatures derive to `target` (`readAuthentication`, which matches by
 * re-deriving the key, never by position or role).
 *
 * Every delegating owner is checked, chunked at `ALIAS_AUTH_OWNER_BATCH` per
 * request, and only each owner's `ALIAS_AUTH_SAMPLE` most recent sent
 * transactions are read, so an owner who delegated long ago and has sent
 * more than that since may have an earlier alias signature this does not
 * reach. `status` says whether the scan itself completed, and `delegateFor`
 * is populated even where no signature was found, so a real delegation is
 * never silently dropped.
 */
export async function findAliasSignedTransactions(targets: string[]): Promise<AliasSignedLookup> {
  const matches = new Map<string, AliasSignedTransaction[]>();
  const delegateFor = new Map<string, string[]>();
  if (targets.length === 0) return { matches, delegateFor, status: "complete" };
  const scan = await scanAliasDelegators();
  const wanted = targets
    .map((original) => ({ original, norm: normalizeSuiAddress(original) }))
    .filter((t) => scan.byDelegate.has(t.norm));
  for (const t of wanted) delegateFor.set(t.original, scan.byDelegate.get(t.norm)!);
  if (wanted.length === 0) return { matches, delegateFor, status: scan.status, scanReadAt: scan.readAt };

  const owners = [...new Set(wanted.flatMap((t) => scan.byDelegate.get(t.norm)!))];
  const byOwner: Record<
    string,
    { nodes: Array<{ digest: string; effects?: { timestamp?: string } | null; signatures: { signatureBytes: string }[] }> }
  > = {};
  let ownerReadFailed = false;
  for (let i = 0; i < owners.length; i += ALIAS_AUTH_OWNER_BATCH) {
    const chunk = owners.slice(i, i + ALIAS_AUTH_OWNER_BATCH);
    const query =
      "query {\n" +
      chunk
        .map(
          (_, j) =>
            `  o${j}: transactions(filter: { sentAddress: $o${j} }, last: ${ALIAS_AUTH_SAMPLE}) { nodes { digest effects { timestamp } signatures { signatureBytes } } }`,
        )
        .join("\n") +
      "\n}";
    const inlined = chunk.reduce((q, addr, j) => q.replace(`$o${j}`, JSON.stringify(addr)), query);
    try {
      const page = await gqlQuery<
        Record<string, { nodes: Array<{ digest: string; effects?: { timestamp?: string } | null; signatures: { signatureBytes: string }[] }> }>
      >(inlined);
      chunk.forEach((addr, j) => {
        byOwner[addr] = page[`o${j}`] ?? { nodes: [] };
      });
    } catch {
      ownerReadFailed = true; // This chunk's owners are simply unchecked; other chunks still stand.
    }
  }

  for (const t of wanted) {
    const found: AliasSignedTransaction[] = [];
    for (const owner of scan.byDelegate.get(t.norm)!) {
      for (const tx of byOwner[owner]?.nodes ?? []) {
        const sigs = tx.signatures?.map((s) => s.signatureBytes) ?? [];
        const auth = readAuthentication(t.original, sigs);
        if (auth) found.push({ owner, digest: tx.digest, timestamp: tx.effects?.timestamp ?? undefined, authentication: auth });
      }
    }
    if (found.length > 0) matches.set(t.original, found);
  }

  const status: AliasScanStatus = ownerReadFailed ? "failed" : scan.status;
  return { matches, delegateFor, status, scanReadAt: scan.readAt };
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
  /**
   * For an address `fetchAuthentication` found nothing for, also check
   * whether it authenticates by signing as an address alias for someone
   * else, which a plain `sentAddress`/`affectedAddress` read cannot see. Adds
   * a full scan of every `AddressAliases` object plus, only when that scan
   * names a candidate, one batched read of the candidate owners' own sent
   * transactions, too costly to default on for a per-hop batch, which is
   * why `identify_address` is the one caller that sets it.
   */
  checkAliasSignatures?: boolean;
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
  const noAuth: AuthenticationLookup = { found: new Map(), foreign: new Map(), failed: new Set() };
  const [names, kinds, held, auth, aliases] = await Promise.all([
    batchResolveNames(unique).catch(() => new Map<string, string>()),
    fetchKinds(unique),
    fetchHeldNames(unique),
    wantAuth ? fetchAuthentication(unique) : noAuth,
    options.aliases
      ? fetchAliases(unique)
      : { found: new Map<string, AliasSet>(), failed: new Set<string>() },
  ]);

  // Only packages are worth a protocol lookup, and the registry is cached, so
  // this adds no requests beyond the prefetch.
  const packages = unique.filter((a) => kinds.get(a)?.kind === "package");
  if (packages.length > 0) await prefetchProtocolNames(packages).catch(() => {});

  // An address with no live object that has never signed may be an object id
  // rather than an account. Only asked when authentication was read, since
  // "never signed" is what narrows the candidates.
  const unsigned = wantAuth
    ? unique.filter(
        (a) =>
          kinds.get(a)?.kind === "wallet" &&
          !auth.found.has(a) &&
          !auth.foreign.has(a) &&
          !auth.failed.has(a),
      )
    : [];
  const [formerObjects, aliasLookup] = await Promise.all([
    unsigned.length > 0 ? fetchFormerObjects(unsigned) : Promise.resolve(new Map<string, string>()),
    options.checkAliasSignatures && unsigned.length > 0
      ? findAliasSignedTransactions(unsigned)
      : Promise.resolve<AliasSignedLookup>({ matches: new Map(), delegateFor: new Map(), status: "complete" }),
  ]);

  for (const address of unique) {
    const k = kinds.get(address);
    const label = getLabel(address);
    const protocol = k?.kind === "package" ? lookupProtocolDisplay(address)?.name : undefined;
    const seenAsObject = formerObjects.get(address);
    out.set(address, {
      address,
      kind: seenAsObject ? "wrapped_or_deleted_object" : (k?.kind ?? "wallet"),
      ...(k?.type ? { object_type: k.type } : {}),
      ...(seenAsObject ? { object_seen_in: seenAsObject } : {}),
      ...(names.get(address) ? { name: names.get(address) } : {}),
      ...(label
        ? {
            label: label.label,
            label_category: label.category,
            ...(labelProvenance(label) ? { label_provenance: labelProvenance(label) } : {}),
          }
        : {}),
      ...(protocol ? { protocol } : {}),
      ...(auth.found.get(address)
        ? { authentication: auth.found.get(address) }
        : aliasLookup.matches.get(address)?.[0]
          ? { authentication: aliasLookup.matches.get(address)![0].authentication }
          : {}),
      ...(auth.foreign.get(address) ? { foreign_authorization: auth.foreign.get(address) } : {}),
      ...(aliasLookup.matches.get(address)?.[0]
        ? {
            signed_as_alias_for: {
              owner: aliasLookup.matches.get(address)![0].owner,
              digest: aliasLookup.matches.get(address)![0].digest,
            },
          }
        : {}),
      ...(aliasLookup.delegateFor.get(address)?.length ? { alias_delegate_for: aliasLookup.delegateFor.get(address) } : {}),
      ...(options.checkAliasSignatures && unsigned.includes(address) && aliasLookup.status !== "complete"
        ? { alias_scan_unavailable: true }
        : {}),
      ...(options.checkAliasSignatures && unsigned.includes(address) && aliasLookup.scanReadAt !== undefined
        ? { alias_scan_as_of: new Date(aliasLookup.scanReadAt).toISOString() }
        : {}),
      ...(auth.failed.has(address) ? { authentication_unavailable: true } : {}),
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
  if (id.kind === "wrapped_or_deleted_object") {
    return `This is the id of an OBJECT that is no longer live at top level (wrapped inside another object, or deleted), recorded in ${id.object_seen_in}. It is not a wallet: nothing signs for it, and value sent to it moves only through the module that owns the object.`;
  }
  if (!id.authentication && id.foreign_authorization) {
    const f = id.foreign_authorization;
    return `This address has sent transactions, but none of the ${f.transactions_examined} examined carries its own signature: ${f.digest} was authorized by ${f.authorized_by.join(", ")} acting for it (an address alias or a protocol-level substitution).`;
  }
  if (id.signed_as_alias_for) {
    const s = id.signed_as_alias_for;
    return `This address has never sent a transaction of its own, but its key signed ${s.digest} as an address alias for ${s.owner}. That signature is where its authentication above is read from.`;
  }
  if (!id.authentication && id.alias_scan_unavailable) {
    return "This address has never sent a transaction of its own, and the reverse scan that checks whether it signed as an address alias for someone else could not fully complete (a request failed, or the on-chain scan was capped). Whether it authenticates that way is unknown, not ruled out.";
  }
  if (!id.authentication && id.alias_delegate_for?.length) {
    const owners = id.alias_delegate_for;
    return `This address has never sent a transaction of its own, but its key is named as a delegate in ${owners.length === 1 ? "one owner's" : `${owners.length} owners'`} 0x2::address_alias set (${owners.join(", ")}); none of the sampled sent transactions of ${owners.length === 1 ? "that owner" : "those owners"} carried its signature.`;
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

const FIRST_SEEN_QUERY = `query ($addr: SuiAddress!) {
  transactions(filter: { affectedAddress: $addr }, first: 1) {
    nodes { digest sender { address } effects { timestamp checkpoint { sequenceNumber } ${BALANCE_CHANGES_SELECTION} } }
  }
}`;

interface FirstSeenResult {
  transactions: {
    nodes: Array<{
      digest: string;
      sender: { address: string } | null;
      effects: {
        timestamp: string | null;
        checkpoint: { sequenceNumber: number | string } | null;
        balanceChanges: GqlConnection<GqlBalanceChangeNode> | null;
      } | null;
    }>;
  };
}

/** An address's oldest transaction, as `identify_address` reports it. */
export interface FirstSeen {
  digest: string;
  timestamp: string | null;
  checkpoint: string | null;
  sender: string | null;
  /** Coins the address gained in it, from the balance changes read. */
  received: Array<{ coin_type: string; amount: string }>;
  /**
   * Another address sent it and this address gained coins in it, so it is
   * the address's first inflow. The genesis transaction has no sender and
   * counts as an inflow. Null when the rest of the balance changes could not
   * be read, so a gain may be unread.
   */
  first_inflow: boolean | null;
}

/**
 * The oldest transaction affecting `address`: null when none does. Throws
 * when the first read fails, so a caller can say the age is unknown instead
 * of omitting it.
 *
 * The balance changes are read to the end: genesis credits every initial
 * holder in one transaction, so a holder's gain can sort past the first page.
 */
export async function readFirstSeen(address: string): Promise<FirstSeen | null> {
  const data = await gqlQuery<FirstSeenResult>(FIRST_SEEN_QUERY, { addr: address });
  const node = data.transactions.nodes[0];
  if (!node) return null;
  const self = normalizeSuiAddress(address);
  const changes = await readAllBalanceChanges(node.digest, node.effects?.balanceChanges);
  const received = changes.nodes
    .filter((c) => c.owner?.address && normalizeSuiAddress(c.owner.address) === self && c.amount && BigInt(c.amount) > 0n)
    .map((c) => ({ coin_type: c.coinType?.repr ?? "", amount: c.amount! }));
  const sender = node.sender?.address ? normalizeSuiAddress(node.sender.address) : null;
  return {
    digest: node.digest,
    timestamp: node.effects?.timestamp ?? null,
    checkpoint: node.effects?.checkpoint?.sequenceNumber != null ? String(node.effects.checkpoint.sequenceNumber) : null,
    sender,
    received,
    first_inflow: received.length > 0 ? sender !== self : changes.truncated ? null : false,
  };
}
