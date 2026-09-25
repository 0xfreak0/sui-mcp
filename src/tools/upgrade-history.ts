import { z } from "zod";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { numArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import { resolvePackageId } from "../utils/move-package.js";
import { resolvePublisher } from "../utils/publisher.js";
import { describeAddresses, type AddressIdentity } from "../utils/identity.js";
import { describeSignatures, readAuthentication, type Authentication } from "../utils/multisig.js";
import { ownerDesc, type OwnerDesc } from "../utils/object-history.js";
import { diffLinkage, type LinkageEntry } from "../utils/package-diff.js";
import {
  capExcursions,
  capHolderAtPublish,
  custodyPeriods,
  parseAsOf,
  schemeLabel,
  stateAsOf,
  upgradeFlags,
  upgradePolicyName,
  usualHolder,
  type CapEnd,
  type CapVersion,
  type ChainPoint,
  type PublishedVersion,
} from "../utils/upgrade-history.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const UPGRADE_CAP_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::package::UpgradeCap";

/** Pages of 50. A lineage or a cap history past this is reported as incomplete. */
const MAX_PAGES = 20;

const TX_FIELDS = `digest sender { address } effects { timestamp checkpoint { sequenceNumber } } signatures { signatureBytes }`;

interface TxGql {
  digest: string;
  sender: { address: string } | null;
  effects: { timestamp: string | null; checkpoint: { sequenceNumber: number } | null } | null;
  signatures: { signatureBytes: string }[] | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

const VERSIONS_QUERY = `query ($addr: SuiAddress!, $after: String) {
  packageVersions(address: $addr, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      address
      version
      linkage { originalId upgradedId version }
      previousTransaction { ${TX_FIELDS} }
    }
  }
}`;

interface VersionsResult {
  packageVersions: {
    pageInfo: PageInfo;
    nodes: Array<{
      address: string;
      version: number;
      linkage: LinkageEntry[] | null;
      previousTransaction: TxGql | null;
    }>;
  } | null;
}

const CAP_SCAN_QUERY = `query ($d: String!, $after: String) {
  transaction(digest: $d) {
    effects {
      objectChanges(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { address outputState { asMoveObject { contents { type { repr } json } } } }
      }
    }
  }
}`;

interface CapScanResult {
  transaction: {
    effects: {
      objectChanges: {
        pageInfo: PageInfo;
        nodes: Array<{
          address: string;
          outputState: { asMoveObject: { contents: { type: { repr: string }; json: Record<string, unknown> | null } | null } | null } | null;
        }>;
      };
    } | null;
  } | null;
}

const CAP_VERSIONS_QUERY = `query ($id: SuiAddress!, $after: String) {
  object(address: $id) { version }
  objectVersions(address: $id, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      version
      owner {
        __typename
        ... on AddressOwner { address { address } }
        ... on ConsensusAddressOwner { address { address } }
      }
      asMoveObject { contents { json } }
      previousTransaction { ${TX_FIELDS} }
    }
  }
}`;

interface CapVersionsResult {
  object: { version: number } | null;
  objectVersions: {
    pageInfo: PageInfo;
    nodes: Array<{
      version: number;
      owner: { __typename?: string; address?: { address: string } } | null;
      asMoveObject: { contents: { json: Record<string, unknown> | null } | null } | null;
      previousTransaction: TxGql | null;
    }>;
  } | null;
}

const LAST_TOUCH_QUERY = `query ($id: SuiAddress!) {
  transactions(filter: { affectedObject: $id }, last: 1) {
    nodes { digest sender { address } effects { timestamp checkpoint { sequenceNumber } } }
  }
}`;

interface LastTouchResult {
  transactions: { nodes: Array<Omit<TxGql, "signatures">> };
}

/** `sui.rpc.v2.ChangedObject.IdOperation.DELETED` */
const ID_DELETED = 3;

const point = (tx: Omit<TxGql, "signatures"> | null): ChainPoint & { sender: string | null } => ({
  tx: tx?.digest ?? null,
  timestamp: tx?.effects?.timestamp ?? null,
  checkpoint: tx?.effects?.checkpoint?.sequenceNumber ?? null,
  sender: tx?.sender?.address ?? null,
});

function numberField(json: Record<string, unknown> | null | undefined, key: string): number | null {
  const v = json?.[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

interface LineageVersion extends PublishedVersion {
  linkage: LinkageEntry[];
  signatures: string[];
  /** Why the publishing transaction's details are missing, when they are. */
  unresolved?: string;
}

async function fetchLineage(packageId: string): Promise<{ versions: LineageVersion[]; complete: boolean }> {
  const versions: LineageVersion[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r: VersionsResult = await gqlQuery<VersionsResult>(VERSIONS_QUERY, { addr: packageId, after });
    const conn = r.packageVersions;
    if (!conn) break;
    for (const n of conn.nodes) {
      const tx = n.previousTransaction;
      versions.push({
        package_id: n.address,
        version: n.version,
        ...point(tx),
        linkage: n.linkage ?? [],
        signatures: tx?.signatures?.map((s) => s.signatureBytes) ?? [],
      });
    }
    if (!conn.pageInfo.hasNextPage) return { versions, complete: true };
    after = conn.pageInfo.endCursor;
    if (!after) break;
  }
  return { versions, complete: false };
}

/** The UpgradeCap a transaction wrote whose `package` field names `packageId`. */
async function findCapIn(digest: string, packageId: string): Promise<string | null> {
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r: CapScanResult = await gqlQuery<CapScanResult>(CAP_SCAN_QUERY, { d: digest, after });
    const changes = r.transaction?.effects?.objectChanges;
    if (!changes) return null;
    for (const n of changes.nodes) {
      const contents = n.outputState?.asMoveObject?.contents;
      if (contents?.type.repr !== UPGRADE_CAP_TYPE) continue;
      const pkg = contents.json?.package;
      if (typeof pkg === "string" && normalizeSuiAddress(pkg) === packageId) return n.address;
    }
    if (!changes.pageInfo.hasNextPage) return null;
    after = changes.pageInfo.endCursor;
    if (!after) return null;
  }
  return null;
}

export interface CapHistory {
  versions: CapVersion[];
  /** Signatures of the transaction that wrote each version, by digest. */
  signatures: Map<string, string[]>;
  /** The cap object still exists (neither destroyed nor wrapped). */
  exists: boolean;
  /** Every page was read. */
  complete: boolean;
}

/** Every version of an UpgradeCap, oldest first. */
export async function fetchCapHistory(capId: string): Promise<CapHistory> {
  const versions: CapVersion[] = [];
  const signatures = new Map<string, string[]>();
  let exists = true;
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r: CapVersionsResult = await gqlQuery<CapVersionsResult>(CAP_VERSIONS_QUERY, { id: capId, after });
    if (page === 0) exists = r.object !== null;
    const conn = r.objectVersions;
    if (!conn) break;
    for (const n of conn.nodes) {
      const tx = n.previousTransaction;
      const json = n.asMoveObject?.contents?.json;
      versions.push({
        object_version: n.version,
        ...point(tx),
        owner: ownerDesc(n.owner),
        package_version: numberField(json, "version"),
        policy: numberField(json, "policy"),
      });
      if (tx?.digest && tx.signatures?.length) signatures.set(tx.digest, tx.signatures.map((s) => s.signatureBytes));
    }
    if (!conn.pageInfo.hasNextPage) return { versions, signatures, exists, complete: true };
    after = conn.pageInfo.endCursor;
    if (!after) break;
  }
  return { versions, signatures, exists, complete: false };
}

/**
 * How a cap that no longer exists as an object stopped existing. The last
 * transaction to touch it either deleted it (only `package::make_immutable`
 * can) or wrapped it inside another object. gRPC reports every changed object
 * in one read, where GraphQL would page them.
 */
async function capEnd(capId: string): Promise<CapEnd | null> {
  const r = await gqlQuery<LastTouchResult>(LAST_TOUCH_QUERY, { id: capId });
  const last = r.transactions.nodes[0];
  if (!last) return null;
  const res = await withArchiveFallback<GrpcTypes.GetTransactionResponse>(
    (client) => client.ledgerService.getTransaction({ digest: last.digest, readMask: { paths: ["effects"] } }),
    (x) => !x.transaction?.effects,
  );
  const change = res.transaction?.effects?.changedObjects?.find(
    (c) => c.objectId !== undefined && normalizeSuiAddress(c.objectId) === capId,
  );
  return { kind: change?.idOperation === ID_DELETED ? "deleted" : "wrapped", ...point(last) };
}

function describeHolder(
  o: OwnerDesc | null,
  auth: Map<string, Authentication>,
  ids: Map<string, AddressIdentity>,
): Record<string, unknown> | null {
  if (!o) return null;
  if (o.kind !== "address" && o.kind !== "consensus") return { kind: o.kind };
  const id = ids.get(o.address);
  return {
    kind: o.kind,
    address: o.address,
    scheme: schemeLabel(auth.get(o.address)),
    ...(id?.name ? { name: id.name } : {}),
    ...(id?.label ? { label: id.label } : {}),
  };
}

/**
 * The authentication a version's sender signed its publish with. A signature
 * that does not decode still names its scheme by flag: older multisig
 * signatures use an encoding the SDK no longer parses, and reading those as
 * "unknown" would hide a committee.
 */
function publishSigner(sender: string | null, signatures: string[]): Authentication | null {
  if (!sender || signatures.length === 0) return null;
  const own = readAuthentication(sender, signatures);
  if (own) return own;
  const undecoded = describeSignatures(signatures).find((d) => !d.address && d.scheme !== "unknown");
  return undecoded ? { scheme: undecoded.scheme, verified: false } : null;
}

function signerView(signer: Authentication | null, senderAuth: Authentication | undefined) {
  if (!signer) return null;
  if (!signer.verified) {
    return {
      scheme: senderAuth?.scheme === signer.scheme ? schemeLabel(senderAuth) : signer.scheme,
      signers_unreadable: `The signature uses a ${signer.scheme} encoding that does not decode, so which members signed is unknown. The scheme is read from its flag byte.`,
    };
  }
  return {
    scheme: schemeLabel(signer),
    ...(signer.multisig
      ? {
          signed_by: signer.multisig.members
            .filter((m) => m.signed_source_tx)
            .map((m) => m.address ?? `(${m.scheme} member #${m.index})`),
        }
      : {}),
  };
}

export function registerUpgradeHistoryTools(server: McpServer) {
  server.tool(
    "get_upgrade_history",
    "(Incident investigation) Upgrade governance across a package's whole lineage. For every version: package id, publish/upgrade transaction, time, sender, the sender's signing scheme (single key, zkLogin, passkey, or multisig with its threshold and which members signed), and who held the UpgradeCap at that moment. Flags an UpgradeCap round trip (it leaves its usual holder, an upgrade ships, and it returns within `round_trip_hours`), an upgrade signed by a single key while the cap is usually multisig-held, an upgrade-policy change, and a cap that was destroyed (package made immutable), wrapped, frozen, shared or sent to an unspendable address. Pass `as_of` to ask who held upgrade authority at a moment and which version was the newest then. Also lists non-framework dependency relinks per version. Accepts any version's 0x id or an MVR name (@org/app).",
    {
      package: z.string().describe("Any version's package ID (0x...) or an MVR name (@org/app)"),
      as_of: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp, 'now', or checkpoint number: report the cap holder and newest version at that moment"),
      round_trip_hours: numArg()
        .positive()
        .max(720)
        .optional()
        .describe("A cap that leaves its usual holder and returns within this many hours around an upgrade is flagged (default 24)"),
    },
    async ({ package: ref, as_of, round_trip_hours }) => {
      try {
        const at = as_of !== undefined && as_of.trim() !== "" ? parseAsOf(as_of) : null;
        const windowHours = round_trip_hours ?? 24;
        const packageId = await resolvePackageId(ref);

        const lineage = await fetchLineage(packageId);
        const versions = lineage.versions;
        if (versions.length === 0) return errorResult(`No package lineage found for ${packageId}. Is it a package ID?`);

        const root = versions[0];
        // Framework packages upgrade in place: every version shares one ID, so
        // the package object names only the newest framework upgrade, and
        // their transactions are system-authored with no signature to read.
        const systemPackage = /^0x0{60}/.test(root.package_id);

        // A pruned publish transaction leaves the node without one. The
        // package object still names it, and the archive may have it.
        if (!systemPackage) {
          await Promise.all(
            versions
              .filter((v) => !v.tx || !v.sender)
              .map(async (v) => {
                const p = await resolvePublisher(v.package_id);
                v.tx = v.tx ?? p.publish_tx;
                v.sender = v.sender ?? p.publisher;
                v.timestamp = v.timestamp ?? p.published_at;
                if (p.unresolved) v.unresolved = p.unresolved;
              }),
          );
        }

        // The cap is minted by version 1's publish. When that transaction is
        // unreadable, the newest upgrade also wrote it.
        let capId: string | null = null;
        let capNote: string | undefined;
        if (systemPackage) {
          capNote = "This is a framework package. It upgrades in place at protocol version boundaries and has no UpgradeCap.";
        } else {
          if (root.tx) capId = await findCapIn(root.tx, root.package_id);
          const newest = versions[versions.length - 1];
          if (!capId && newest !== root && newest.tx) capId = await findCapIn(newest.tx, newest.package_id);
          if (!capId) {
            capNote =
              "No UpgradeCap was found in the publish transaction or the newest upgrade, so cap custody is unknown. This is not evidence the package is immutable.";
          }
        }

        const cap = capId ? await fetchCapHistory(capId) : null;
        const caps = cap?.versions ?? [];
        const end = capId && cap && !cap.exists && caps.length > 0 ? await capEnd(capId) : null;
        const capComplete = !!cap && cap.complete && caps[0]?.tx === root.tx;

        // How every sender authenticates, read from the transactions already
        // in hand. An address can never change its authenticator, so one
        // signed transaction answers for all of them.
        const auth = new Map<string, Authentication>();
        const signerByVersion = new Map<number, Authentication | null>();
        for (const v of versions) {
          const a = publishSigner(v.sender, v.signatures);
          signerByVersion.set(v.version, a);
          if (a?.verified && v.sender) auth.set(v.sender, a);
        }
        for (const c of caps) {
          const sigs = c.tx ? cap?.signatures.get(c.tx) : undefined;
          if (!c.sender || !sigs || auth.has(c.sender)) continue;
          const a = readAuthentication(c.sender, sigs);
          if (a) auth.set(c.sender, a);
        }

        const addresses = new Set<string>();
        for (const v of versions) if (v.sender) addresses.add(v.sender);
        for (const c of caps) {
          if (c.owner.kind === "address" || c.owner.kind === "consensus") addresses.add(c.owner.address);
        }
        const ids = await describeAddresses([...addresses], { authentication: true });
        for (const [addr, id] of ids) if (!auth.has(addr) && id.authentication) auth.set(addr, id.authentication);

        const periods = custodyPeriods(caps, end);
        const asOfState = at ? stateAsOf(at, versions, caps, end) : null;
        const asOf =
          at && asOfState
            ? {
                at: "checkpoint" in at ? { checkpoint: at.checkpoint } : { timestamp: at.iso },
                cap_state: asOfState.cap_state,
                holder: describeHolder(asOfState.holder, auth, ids),
                holder_since: asOfState.holder_since,
                policy: asOfState.cap_state === "held" ? upgradePolicyName(asOfState.policy) : null,
                newest_version: asOfState.latest_version
                  ? {
                      version: asOfState.latest_version.version,
                      package_id: asOfState.latest_version.package_id,
                      published_at: asOfState.latest_version.timestamp,
                      sender: asOfState.latest_version.sender,
                    }
                  : null,
                note: "Older versions stay callable after an upgrade unless the package itself checks a version number, so the newest version is not necessarily the only live code.",
                ...(asOfState.unordered
                  ? {
                      unordered: `${asOfState.unordered} event(s) lacked the ${"checkpoint" in at ? "checkpoint" : "timestamp"} needed to place them against as_of and were left out.`,
                    }
                  : {}),
              }
            : null;

        const nowMs = Date.now();
        const usual = usualHolder(periods, nowMs);
        const excursions = capExcursions(periods, versions, usual?.holder ?? null, windowHours);
        const flags = upgradeFlags({ versions, caps, end, periods, excursions, usual, signerByVersion, auth });

        const current = caps[caps.length - 1];
        const hoursOf = (from: ChainPoint, until: ChainPoint | null): number | null => {
          const a = from.timestamp ? Date.parse(from.timestamp) : NaN;
          const b = until ? (until.timestamp ? Date.parse(until.timestamp) : NaN) : nowMs;
          return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round(((b - a) / 3_600_000) * 1000) / 1000;
        };

        const result = {
          package: ref,
          root_package_id: root.package_id,
          version_count: versions.length,
          latest: { version: versions[versions.length - 1].version, package_id: versions[versions.length - 1].package_id },
          ...(lineage.complete ? {} : { lineage_truncated: `Only the first ${versions.length} versions were read.` }),
          upgrade_cap: capId
            ? {
                object_id: capId,
                state: end ? end.kind : current ? "exists" : "unknown",
                current_holder: end ? null : describeHolder(current?.owner ?? null, auth, ids),
                policy: upgradePolicyName(current?.policy),
                owner_change_count: Math.max(0, periods.length - 1),
                history_complete: capComplete,
                ...(capComplete
                  ? {}
                  : {
                      history_note:
                        "The cap's history does not reach back to its creation, so custody before the first version shown is unknown and holders at early versions may be missing.",
                    }),
              }
            : null,
          ...(capNote ? { upgrade_cap_note: capNote } : {}),
          usual_holder: usual
            ? { ...describeHolder(usual.holder, auth, ids), share_of_time: usual.share_of_time }
            : null,
          flag_count: flags.length,
          flags,
          ...(asOf ? { as_of: asOf } : {}),
          versions: versions.map((v, i) => {
            const holder = caps.length ? capHolderAtPublish(v, caps) : null;
            const relinks = i > 0 ? diffLinkage(versions[i - 1].linkage, v.linkage) : [];
            const own = relinks.filter((l) => !l.system);
            const framework = relinks.length - own.length;
            const signer = signerByVersion.get(v.version) ?? null;
            const senderId = v.sender ? ids.get(v.sender) : undefined;
            return {
              version: v.version,
              package_id: v.package_id,
              tx: v.tx,
              timestamp: v.timestamp,
              checkpoint: v.checkpoint,
              sender: v.sender,
              ...(senderId?.name ? { sender_name: senderId.name } : {}),
              ...(senderId?.label ? { sender_label: senderId.label } : {}),
              signer: signerView(signer, v.sender ? auth.get(v.sender) : undefined),
              ...(signer || !v.sender || systemPackage
                ? {}
                : {
                    signer_note: v.signatures.length
                      ? "No signature on the publish transaction derives to the sender, which is what an address alias signing on the sender's behalf looks like."
                      : "The publish transaction's signatures could not be read.",
                  }),
              cap_holder: describeHolder(holder, auth, ids),
              ...(v.version > 1 && holder && (holder.kind === "address" || holder.kind === "consensus")
                ? { sender_held_cap: holder.address === v.sender }
                : {}),
              ...(own.length ? { linkage_changes: own } : {}),
              ...(framework ? { framework_relinks: framework } : {}),
              ...(v.unresolved ? { unresolved: v.unresolved } : {}),
            };
          }),
          cap_custody: periods.map((p) => ({
            holder: describeHolder(p.holder, auth, ids),
            from: p.from,
            until: p.until,
            duration_hours: hoursOf(p.from, p.until),
          })),
          cap_excursions: excursions.map((x) => ({
            holders: x.holders.map((h) => describeHolder(h, auth, ids)),
            left: x.left,
            returned: x.returned,
            duration_hours: x.duration_hours,
            upgrades_during: x.upgrades_during,
            round_trip: x.round_trip,
          })),
          ...(end ? { cap_end: end } : {}),
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
