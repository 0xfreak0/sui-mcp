import { createRequire } from "node:module";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";

/**
 * Who published a called package version, and which newer versions of its
 * lineage existed.
 *
 * A version's publisher is the sender of the transaction that published or
 * upgraded it, so only the holder of that key can make it match. The current
 * UpgradeCap holder is not used: an UpgradeCap has `store`, so anyone can send
 * one to a curated protocol's cap holder without that holder's consent, and a
 * match on it would name any contract after that protocol.
 *
 * A package whose own publisher also signed a version of a curated lineage
 * was deployed by that protocol's key. That is the custody tier: the
 * protocol's name for display, and a publisher-verified basis for trust, but
 * no category. The curated side is `custody.signers` in
 * `src/data/protocol-roots.json` (`npm run sync:protocol-roots`). A key that
 * signed two curated protocols' lineages (Pyth and Wormhole share a deployer)
 * names neither, and still counts as publisher-verified.
 *
 * The same read lists the lineage's newest versions with the checkpoint each
 * was published at, which tells whether a call used a superseded version.
 *
 * Same constraints as ./package-roots.ts: lookups are synchronous and read the
 * cache a prefetch filled; a failed read leaves the package uncached.
 */

const require = createRequire(import.meta.url);
const rootsData = require("../data/protocol-roots.json") as {
  roots: Record<string, { name: string }>;
  custody?: Record<string, { signers: string[] }>;
};

export interface CustodyMatch {
  /** The one curated protocol whose lineage the same key signed. */
  protocol: string;
  via: "publisher";
  /** The address that published this package version. */
  address: string;
  /** A curated lineage root that address also published or upgraded. */
  shared_with: string;
}

/** One version of a lineage, with the checkpoint its publish or upgrade landed in. */
export interface LineageVersion {
  address: string;
  version: number;
  checkpoint: number | null;
}

export interface PackageOrigin {
  /** This package's version number in its lineage. */
  version: number | null;
  /** Sender of the transaction that published or upgraded this version. */
  publisher: string | null;
  /** Curated protocols whose lineages the publisher also signed, each with one root. */
  signed_for: Array<{ protocol: string; root: string }>;
  /** The lineage's newest versions, up to {@link LINEAGE_VERSIONS_READ}, oldest first. */
  versions: LineageVersion[];
}

/** Signer → curated protocol → one root of that protocol it signed a version of. */
const BY_SIGNER = (() => {
  const out = new Map<string, Map<string, string>>();
  for (const [root, c] of Object.entries(rootsData.custody ?? {})) {
    const protocol = rootsData.roots[root]?.name;
    if (!protocol) continue;
    for (const signer of c.signers) {
      const byProtocol = out.get(signer) ?? new Map<string, string>();
      if (!byProtocol.has(protocol)) byProtocol.set(protocol, root);
      out.set(signer, byProtocol);
    }
  }
  return out;
})();

/** Called packages resolved per tool call. Twenty share one GraphQL request. */
export const MAX_CUSTODY_LOOKUPS = 40;

/** Packages per request, under the service's 5000-byte payload cap. */
const ORIGIN_BATCH = 20;

/** Newest versions read per lineage. Older ones are superseded by these. */
export const LINEAGE_VERSIONS_READ = 50;

// Keyed `${network}:${normalized package id}`; null means "read, not a package".
const cache = new Map<string, PackageOrigin | null>();
const key = (packageId: string) => `${getNetwork()}:${normalizeSuiAddress(packageId)}`;

const VERSION_FIELDS = "address version previousTransaction { sender { address } effects { checkpoint { sequenceNumber } } }";

interface VersionNode {
  address: string;
  version: number;
  previousTransaction: { sender: { address: string } | null; effects: { checkpoint: { sequenceNumber: number } | null } | null } | null;
}

function batchQuery(count: number): string {
  const decls = Array.from({ length: count }, (_, i) => `$a${i}: SuiAddress!`).join(", ");
  const fields = Array.from({ length: count }, (_, i) => `p${i}: packageVersions(address: $a${i}, last: ${LINEAGE_VERSIONS_READ}) { ...V }`).join(" ");
  return `query (${decls}) { ${fields} } fragment V on MovePackageConnection { nodes { ${VERSION_FIELDS} } }`;
}

/** A version older than every one {@link batchQuery} returned is read on its own. */
const SELF_QUERY = `query ($a: SuiAddress!) { object(address: $a) { asMovePackage { ${VERSION_FIELDS} } } }`;

function signedFor(publisher: string | null): PackageOrigin["signed_for"] {
  const byProtocol = publisher ? BY_SIGNER.get(publisher) : undefined;
  return byProtocol ? [...byProtocol].map(([protocol, root]) => ({ protocol, root })) : [];
}

/**
 * Curated protocols whose lineage `address` published or upgraded, from the
 * shipped data alone. Mainnet only, like that data. A match says the address
 * holds a key that signed that protocol's code, so coins it receives went to
 * that team's key; it does not say what the address is used for.
 */
export function protocolsSignedBy(address: string): string[] {
  if (getNetwork() !== "mainnet") return [];
  return signedFor(normalizeSuiAddress(address)).map((s) => s.protocol);
}

async function resolveOrigin(id: string, nodes: VersionNode[]): Promise<PackageOrigin | null> {
  const versions = nodes.map((n) => ({
    address: normalizeSuiAddress(n.address),
    version: n.version,
    checkpoint: n.previousTransaction?.effects?.checkpoint?.sequenceNumber ?? null,
  }));
  let self = nodes.find((n) => normalizeSuiAddress(n.address) === id) ?? null;
  if (!self && nodes.length > 0) {
    const r = await gqlQuery<{ object: { asMovePackage: VersionNode | null } | null }>(SELF_QUERY, { a: id });
    self = r.object?.asMovePackage ?? null;
  }
  if (!self) return null;
  const sender = self.previousTransaction?.sender?.address;
  const publisher = sender ? normalizeSuiAddress(sender) : null;
  return { version: self.version, publisher, signed_for: signedFor(publisher), versions };
}

/** The origin of a package if a prefetch read it, else null. Never blocks. */
export function getPackageOrigin(packageId: string): PackageOrigin | null {
  return cache.get(key(packageId)) ?? null;
}

/** The custody match for a package: its publisher signed exactly one curated protocol's lineage. Never blocks. */
export function getPackageCustody(packageId: string): CustodyMatch | null {
  const origin = getPackageOrigin(packageId);
  if (!origin?.publisher || origin.signed_for.length !== 1) return null;
  const [only] = origin.signed_for;
  return { protocol: only.protocol, via: "publisher", address: origin.publisher, shared_with: only.root };
}

/**
 * Versions of the package's lineage newer than it, published at or before
 * `checkpoint` (any time when null). Empty when the package was its lineage's
 * newest then, or when no prefetch read it.
 */
export function newerVersions(packageId: string, checkpoint: number | null): LineageVersion[] {
  const origin = getPackageOrigin(packageId);
  if (!origin || origin.version === null) return [];
  return origin.versions.filter((v) => v.version > origin.version! && (checkpoint === null || (v.checkpoint !== null && v.checkpoint <= checkpoint)));
}

/**
 * Read the origin of up to {@link MAX_CUSTODY_LOOKUPS} packages not yet
 * cached, {@link ORIGIN_BATCH} per request. Mainnet only, like the curated
 * data it compares against. Returns the packages left unread because the
 * bound was reached (`skipped`) and those whose read failed (`failed`,
 * retried on the next call). Neither has a publisher basis or a superseded
 * state, so a caller must say they went unchecked.
 */
export async function prefetchPackageCustody(packageIds: Iterable<string>): Promise<{ skipped: string[]; failed: string[] }> {
  if (getNetwork() !== "mainnet") return { skipped: [], failed: [] };
  const uncached = [...new Set([...packageIds].filter(Boolean).map((id) => normalizeSuiAddress(id)))].filter((id) => !cache.has(key(id)));
  const read = uncached.slice(0, MAX_CUSTODY_LOOKUPS);
  const failed: string[] = [];
  for (let i = 0; i < read.length; i += ORIGIN_BATCH) {
    const chunk = read.slice(i, i + ORIGIN_BATCH);
    let data: Record<string, { nodes: VersionNode[] } | null>;
    try {
      data = await gqlQuery<Record<string, { nodes: VersionNode[] } | null>>(
        batchQuery(chunk.length),
        Object.fromEntries(chunk.map((id, j) => [`a${j}`, id])),
      );
    } catch {
      // Uncached, so a transient failure is retried on the next call.
      failed.push(...chunk);
      continue;
    }
    for (const [j, id] of chunk.entries()) {
      try {
        cache.set(key(id), await resolveOrigin(id, data[`p${j}`]?.nodes ?? []));
      } catch {
        failed.push(id);
      }
    }
  }
  return { skipped: uncached.slice(MAX_CUSTODY_LOOKUPS), failed };
}

/** Called packages whose origin was not read, and what that leaves unchecked; null when every one was read. */
export function originIncomplete(read: { skipped: string[]; failed: string[] }) {
  if (read.skipped.length === 0 && read.failed.length === 0) return null;
  return {
    ...(read.skipped.length ? { past_bound: read.skipped.slice(0, 10), past_bound_count: read.skipped.length } : {}),
    ...(read.failed.length ? { read_failed: read.failed.slice(0, 10), read_failed_count: read.failed.length } : {}),
    note: `These called packages were not checked for their publisher and newer versions: past_bound are beyond the first ${MAX_CUSTODY_LOOKUPS} per call, read_failed are ones whose read failed and is retried on the next call. They read as unrecognized even if a curated protocol's key published them, and a superseded version of them is not flagged.`,
  };
}

/** Test seam: drops every cached entry across all networks. */
export function clearPackageCustodyCache(): void {
  cache.clear();
}
