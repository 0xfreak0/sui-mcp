import { setTimeout as sleep } from "node:timers/promises";
import { gqlQuery } from "../clients/graphql.js";
import { sui } from "../clients/grpc.js";

/** One page of the sender's history. The first page starts at the oldest transaction. */
const PAGE_SIZE = 20;
const COMMAND_PAGE = 50;
const OBJECT_PAGE = 50;
const MAX_NESTED_PAGES = 24;

const HISTORY_QUERY = `query($address: SuiAddress!, $after: String) {
  transactions(filter: { sentAddress: $address }, first: ${PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      digest
      effects { timestamp }
      kind { __typename ... on ProgrammableTransaction {
        commands(first: ${COMMAND_PAGE}) {
          nodes { __typename }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }
  }
}`;

const COMMANDS_QUERY = `query($digest: String!, $after: String!) {
  transaction(digest: $digest) {
    kind { ... on ProgrammableTransaction {
      commands(first: ${COMMAND_PAGE}, after: $after) {
        nodes { __typename }
        pageInfo { hasNextPage endCursor }
      }
    } }
  }
}`;

const PACKAGES_QUERY = `query($digest: String!, $after: String) {
  transaction(digest: $digest) {
    effects {
      status
      objectChanges(first: ${OBJECT_PAGE}, after: $after) {
        nodes { idCreated outputState { asMovePackage { address } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type Commands = { nodes: Array<{ __typename: string }>; pageInfo: PageInfo };
type HistoryRow = {
  digest: string;
  effects: { timestamp?: string | null } | null;
  kind: { __typename: string; commands?: Commands | null } | null;
};
type PackageChange = { idCreated: boolean; outputState?: { asMovePackage?: { address: string } | null } | null };
type Changes = { nodes: PackageChange[]; pageInfo: PageInfo };

export interface WalletPackageVersion {
  package_id: string;
  root_package_id: string | null;
  version: number | null;
  action: "published" | "upgraded" | "unknown";
  transaction_digest: string;
  timestamp: string | null;
  detail_unavailable?: string;
}

export interface WalletPackageActivity {
  packages: WalletPackageVersion[];
  scan: {
    transactions_scanned: number;
    complete: boolean;
    /** Unread transactions in earlier pages; their digests were listed on those pages. */
    prior_incomplete_transactions?: number;
    incomplete_transactions?: string[];
    next_call?: { tool: "get_wallet_packages"; args: { address: string; cursor: string } };
    note: string;
  };
}

/** The external cursor also carries whether previous pages could not be fully read. */
function parseCursor(cursor?: string): { after: string | null; priorIncomplete: number } {
  if (cursor === undefined) return { after: null, priorIncomplete: 0 };
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      decoded && typeof decoded === "object" &&
      "after" in decoded && typeof decoded.after === "string" && decoded.after.length > 0 &&
      "priorIncomplete" in decoded && typeof decoded.priorIncomplete === "number" &&
      Number.isSafeInteger(decoded.priorIncomplete) && decoded.priorIncomplete >= 0
    ) return { after: decoded.after, priorIncomplete: decoded.priorIncomplete };
  } catch {
    // A stale or malformed cursor must not restart a scan at its first page.
  }
  throw new Error("Invalid wallet package cursor; start a new scan without cursor.");
}

function nextCursor(after: string, priorIncomplete: number): string {
  return Buffer.from(JSON.stringify({ after, priorIncomplete })).toString("base64url");
}

/** Pages a single connection completely; a missing cursor or a bound is explicitly incomplete. */
async function commandTypes(row: HistoryRow, signal?: AbortSignal): Promise<string[] | null> {
  if (!row.kind) return null;
  if (row.kind.__typename !== "ProgrammableTransaction") return [];
  if (!row.kind.commands) return null;
  const types = row.kind.commands.nodes.map((n) => n.__typename);
  let page = row.kind.commands.pageInfo;
  for (let i = 1; page.hasNextPage && i < MAX_NESTED_PAGES; i++) {
    if (!page.endCursor) return null;
    signal?.throwIfAborted();
    const next = await gqlQuery<{ transaction: { kind: { commands: Commands | null } | null } | null }>(COMMANDS_QUERY, {
      digest: row.digest,
      after: page.endCursor,
    }, { signal });
    const commands = next.transaction?.kind?.commands;
    if (!commands) return null;
    types.push(...commands.nodes.map((n) => n.__typename));
    page = commands.pageInfo;
  }
  return page.hasNextPage ? null : types;
}

async function packagesIn(digest: string, signal?: AbortSignal): Promise<string[] | null> {
  const ids: string[] = [];
  let after: string | null = null;
  for (let i = 0; i < MAX_NESTED_PAGES; i++) {
    signal?.throwIfAborted();
    const result: { transaction: { effects: { status: string; objectChanges: Changes | null } | null } | null } =
      await gqlQuery(PACKAGES_QUERY, { digest, after }, { signal });
    const effects = result.transaction?.effects;
    if (!effects) return null;
    if (effects.status !== "SUCCESS") return [];
    const changes = effects.objectChanges;
    if (!changes) return null;
    for (const change of changes.nodes) {
      if (change.idCreated && change.outputState?.asMovePackage?.address) ids.push(change.outputState.asMovePackage.address);
    }
    if (!changes.pageInfo.hasNextPage) return ids.length ? ids : null;
    if (!changes.pageInfo.endCursor) return null;
    after = changes.pageInfo.endCursor;
  }
  return null;
}

/** Publish and Upgrade commands create distinct package IDs. A sender is not necessarily today's cap holder. */
export async function readWalletPackageActivity(address: string, cursor?: string, signal?: AbortSignal): Promise<WalletPackageActivity> {
  const { after, priorIncomplete } = parseCursor(cursor);
  signal?.throwIfAborted();
  const history = await gqlQuery<{ transactions: { nodes: HistoryRow[]; pageInfo: PageInfo } }>(HISTORY_QUERY, {
    address,
    after,
  }, { signal });
  if (!history.transactions) throw new Error("The sender transaction list could not be read");
  const incomplete: string[] = [];
  const packages: WalletPackageVersion[] = [];
  for (const row of history.transactions.nodes) {
    signal?.throwIfAborted();
    let types: string[] | null;
    try {
      types = await commandTypes(row, signal);
    } catch {
      signal?.throwIfAborted();
      types = null;
    }
    if (types === null) {
      incomplete.push(row.digest);
      continue;
    }
    if (!types.includes("PublishCommand") && !types.includes("UpgradeCommand")) continue;
    let ids: string[] | null;
    try {
      ids = await packagesIn(row.digest, signal);
    } catch {
      signal?.throwIfAborted();
      ids = null;
    }
    if (ids === null || ids.length === 0) {
      // A successful Publish/Upgrade must create a package. A failed transaction
      // creates none; the effects read above returns [] for that case.
      if (ids === null) incomplete.push(row.digest);
      continue;
    }
    const resolved = await Promise.all(ids.map(async (packageId): Promise<WalletPackageVersion> => {
      try {
        signal?.throwIfAborted();
        const { response } = await sui.movePackageService.getPackage({ packageId }, { abort: signal });
        const pkg = response.package;
        if (!pkg?.originalId || pkg.version == null) throw new Error("Package lineage unavailable");
        const version = Number(pkg.version);
        return {
          package_id: packageId,
          root_package_id: pkg.originalId,
          version,
          action: version === 1 ? "published" : "upgraded",
          transaction_digest: row.digest,
          timestamp: row.effects?.timestamp ?? null,
        };
      } catch (err) {
        signal?.throwIfAborted();
        return {
          package_id: packageId,
          root_package_id: null,
          version: null,
          action: "unknown",
          transaction_digest: row.digest,
          timestamp: row.effects?.timestamp ?? null,
          detail_unavailable: err instanceof Error ? err.message : String(err),
        };
      }
    }));
    packages.push(...resolved);
  }
  const page = history.transactions.pageInfo;
  const previousUnread = priorIncomplete + incomplete.length;
  const next = page.hasNextPage && page.endCursor
    ? { tool: "get_wallet_packages" as const, args: { address, cursor: nextCursor(page.endCursor, previousUnread) } }
    : undefined;
  const complete = !page.hasNextPage && previousUnread === 0;
  return {
    packages,
    scan: {
      transactions_scanned: history.transactions.nodes.length,
      complete,
      ...(priorIncomplete ? { prior_incomplete_transactions: priorIncomplete } : {}),
      ...(incomplete.length ? { incomplete_transactions: incomplete } : {}),
      ...(next ? { next_call: next } : {}),
      note: complete
        ? "All transactions sent from this address on this network were checked. An alias or another signer may have authorized the sender; publication does not establish who holds the UpgradeCap now."
        : `This page checked ${history.transactions.nodes.length} transactions sent from this address, starting at the oldest${cursor ? " after the supplied cursor" : ""}. ${priorIncomplete ? `${priorIncomplete} earlier transaction(s) could not be checked; their digests are on earlier pages. ` : ""}More history or unread transaction details may hide packages; follow next_call when provided. An alias may have authorized the sender, and publishing does not establish who holds the UpgradeCap now.`,
    },
  };
}

/** An overview must not wait for a long historical scan; the full paging tool has no such limit. */
export async function readWalletPackageActivityBounded(address: string, timeoutMs = 3_000): Promise<WalletPackageActivity> {
  const controller = new AbortController();
  const timerController = new AbortController();
  const timeout = sleep(timeoutMs, undefined, { signal: timerController.signal }).then(() => {
    const error = new Error(`Package publication scan exceeded ${timeoutMs}ms`);
    controller.abort(error);
    throw error;
  });
  try {
    return await Promise.race([readWalletPackageActivity(address, undefined, controller.signal), timeout]);
  } finally {
    timerController.abort();
  }
}
