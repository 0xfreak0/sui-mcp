/**
 * Reading the chain for a fund trace: one hop in full (GraphQL, then the
 * archive), candidate pages of an address's later or earlier transactions,
 * and the searches that pick which of them continue the funds.
 *
 * Shared by `trace_funds`, which follows one branch, and `trace_flow_graph` /
 * `find_flow_path`, which follow every branch. The decisions about which
 * party is next are pure and live in `trace-hop.ts`.
 */

import { gqlQuery } from "../clients/graphql.js";
import { lookupProtocol, lookupProtocolDisplay } from "../protocols/registry.js";
import { getLabel } from "./labels.js";
import type { FanoutResult } from "./fanout.js";
import {
  allSpends,
  passesClaim,
  inflowsNewestFirst,
  payerOf,
  type CandidateTx,
  type RemainingEntry,
  type UnfollowedRecipient,
} from "./trace-hop.js";
import { fetchEventJson } from "./event-json.js";
import {
  BALANCE_CHANGES_SELECTION,
  COMMANDS_SELECTION,
  completeTxConnections,
  readAllBalanceChanges,
  readAllCommands,
  type GqlConnection,
} from "./tx-connections.js";
import {
  readGrpcObjectChanges,
  readObjectMovements,
  type GqlObjectChange,
  writtenObjects,
  type GrpcChangedObject,
  type ObjectMovement,
  type WrittenObjects,
} from "./object-flow.js";
import { coinScale, displayCoin } from "./valuation.js";
import { adaptCommands, adaptBalanceChanges } from "./gql-adapters.js";
import { withArchiveFallback } from "./archive-fallback.js";
import { timestampToIso } from "./formatting.js";
import { isNotFound } from "./errors.js";
import { getCachedTransaction, saveTransaction } from "./store.js";
import { getNetwork } from "../config.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "./gql-adapters.js";

export interface BalanceChangeInfo {
  address: string;
  coin_type: string;
  amount: string;
}

// Kept compact: the service rejects a query document over 5,000 bytes.
const OWNER_SELECTION = `owner {
                __typename
                ... on AddressOwner { address { address } }
                ... on ObjectOwner { address { address } }
                ... on ConsensusAddressOwner { address { address } }
              }`;

/**
 * One hop. Signatures and the gas payer say who authorized the transaction
 * and whose SUI change carries gas. Event types feed bridge detection: a
 * bridge reached through a wrapper package has no marker call in the PTB, and
 * its event is the only signal present.
 */
const TX_QUERY = `
  query($digest: String!) {
    transaction(digest: $digest) {
      digest
      sender { address }
      gasInput { gasSponsor { address } }
      signatures { signatureBytes }
      effects {
        status
        timestamp
        checkpoint { sequenceNumber }
        gasEffects { gasSummary { computationCost storageCost storageRebate } }
        ${BALANCE_CHANGES_SELECTION}
        events(first: 50) { pageInfo { hasNextPage } nodes { contents { type { repr } } } }
        objectChanges(first: 50) {
          pageInfo { hasNextPage endCursor }
          nodes {
            address
            idCreated
            idDeleted
            inputState {
              asMoveObject { contents { type { repr } } }
              ${OWNER_SELECTION}
            }
            outputState {
              asMoveObject { contents { type { repr } } }
              ${OWNER_SELECTION}
            }
          }
        }
      }
      kind { ... on ProgrammableTransaction { ${COMMANDS_SELECTION} } }
    }
  }
`;

export interface GqlGasSummary {
  computationCost?: number | string | bigint | null;
  storageCost?: number | string | bigint | null;
  storageRebate?: number | string | bigint | null;
}

export interface GqlTxResult {
  transaction: {
    digest: string;
    sender?: { address: string };
    gasInput?: { gasSponsor?: { address?: string } | null } | null;
    signatures?: Array<{ signatureBytes?: string }> | null;
    effects?: {
      status: string;
      timestamp?: string;
      checkpoint?: { sequenceNumber: number };
      gasEffects?: { gasSummary?: GqlGasSummary | null } | null;
      balanceChanges?: GqlConnection<GqlBalanceChangeNode>;
      events?: {
        pageInfo?: { hasNextPage?: boolean };
        nodes: Array<{ contents?: { type?: { repr?: string } } | null }>;
      };
      objectChanges?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        nodes: GqlObjectChange[];
      };
    };
    kind?: {
      commands?: GqlConnection<GqlCommandNode>;
    };
  } | null;
}

/** Net gas charged to the payer, computation + storage − rebate, as a decimal string. */
export function netGas(s: GqlGasSummary | null | undefined): string | null {
  if (!s || s.computationCost == null || s.storageCost == null || s.storageRebate == null) return null;
  return (BigInt(s.computationCost) + BigInt(s.storageCost) - BigInt(s.storageRebate)).toString();
}

/**
 * A fetched hop, in a shape that does not depend on which transport answered.
 *
 * GraphQL and gRPC return different structures, and the adapters exist to
 * convert the former into the latter for the decoder. Doing that conversion
 * inside the fetch keeps one shape downstream, which is what makes an archive
 * fallback possible without a second set of consumers.
 */
export interface FetchedTx {
  sender: string | null;
  balanceChanges: BalanceChangeInfo[];
  /** Decoder input, already in gRPC form whichever transport was used. */
  grpcBalanceChanges: ReturnType<typeof adaptBalanceChanges>;
  commands: ReturnType<typeof adaptCommands>;
  /** Move calls reduced for bridge detection. */
  callSites: Array<{ packageId: string; module: string; function: string }>;
  /** Event types, for bridge detection through wrapper packages. */
  eventTypes: string[];
  eventsIncomplete?: boolean;
  /** Who paid gas and the net charge, as a decimal string (the cache is JSON). */
  gasPayer: string | null;
  netGas: string | null;
  /** Serialized user signatures, base64, for signer-versus-sender checks. */
  signatures: string[];
  balanceChangesTruncated?: boolean;
  commandsTruncated?: boolean;
  /**
   * Non-coin objects that moved. Both transports can report these — the
   * archive's gRPC `changedObjects` carries type and both owners — so this is
   * undefined only for a row cached before object flow existed.
   */
  objectMovements?: ObjectMovement[];
  /** The transaction reported more object changes than were read. */
  objectChangesTruncated?: boolean;
  /** What the object changes say about where unpaid value sits. Undefined for a row cached before it was recorded. */
  written?: WrittenObjects;
  timestamp: string | null;
  checkpoint: number | null;
  /**
   * Which transport answered. An archive hop is older than the fullnode keeps;
   * a cache hop was fetched in an earlier session and is safe because a
   * finalized transaction is immutable.
   */
  source: "fullnode" | "archive" | "cache";
}

/** Pull Move calls out of decoder-shaped commands, for bridge detection. */
/**
 * Registry-backed protocol lookup for object types.
 *
 * Only a package the registry already vouches for can promote an object to a
 * DeFi position. A type named `Position` proves nothing on its own; a type
 * named `Position` defined by a curated DEX does. Synchronous and cache-only,
 * per the registry contract, so it adds no requests.
 */
/**
 * Read the remaining object changes of a transaction that exceeded one page.
 *
 * The connection is ordered by object id, not by importance, so which 50
 * arrive first is arbitrary with respect to whether the interesting transfer
 * is among them, and truncating silently could drop a capability transfer.
 *
 * Bounded rather than exhaustive: the caller states the cap it hit, which is
 * the one thing a truncated read must never leave unsaid.
 */
export const OBJECT_CHANGE_PAGES = 5;

const MORE_OBJECT_CHANGES = `
  query($digest: String!, $after: String) {
    transaction(digest: $digest) {
      effects {
        objectChanges(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            address
            idCreated
            idDeleted
            inputState {
              asMoveObject { contents { type { repr } } }
              owner {
                __typename
                ... on AddressOwner { address { address } }
                ... on ObjectOwner { address { address } }
                ... on ConsensusAddressOwner { address { address } }
              }
            }
            outputState {
              asMoveObject { contents { type { repr } } }
              owner {
                __typename
                ... on AddressOwner { address { address } }
                ... on ObjectOwner { address { address } }
                ... on ConsensusAddressOwner { address { address } }
              }
            }
          }
        }
      }
    }
  }
`;

async function readAllObjectChanges(
  digest: string,
  first: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes: GqlObjectChange[] } | undefined,
): Promise<{ nodes: GqlObjectChange[]; truncated: boolean }> {
  const nodes = [...(first?.nodes ?? [])];
  // `more` and `cursor` are tracked apart on purpose. A connection can claim
  // another page and hand back a NULL cursor, and collapsing the two would
  // report a complete read of a list we know is incomplete — the cursor trap
  // CLAUDE.md documents, in the field that says whether to trust the answer.
  let more = first?.pageInfo?.hasNextPage === true;
  let cursor = more ? first?.pageInfo?.endCursor : undefined;
  let pages = 1;

  while (more && cursor && pages < OBJECT_CHANGE_PAGES) {
    const next = await gqlQuery<GqlTxResult>(MORE_OBJECT_CHANGES, { digest, after: cursor }).catch(
      () => null,
    );
    const conn = next?.transaction?.effects?.objectChanges;
    // A failed follow-up is not an empty one: leave `more` set so the caller
    // says the list is incomplete rather than asserting it is whole.
    if (!conn) break;
    nodes.push(...conn.nodes);
    pages++;
    more = conn.pageInfo?.hasNextPage === true;
    cursor = conn.pageInfo?.endCursor;
  }

  return { nodes, truncated: more };
}

export function protocolForPackage(packageId: string): { name: string; type?: string } | null {
  const p = lookupProtocol(packageId);
  return p ? { name: p.name, type: (p as { type?: string }).type } : null;
}

export function callSitesOf(commands: ReturnType<typeof adaptCommands>) {
  const out: Array<{ packageId: string; module: string; function: string }> = [];
  for (const cmd of commands) {
    const c = (cmd as { command?: { oneofKind?: string; moveCall?: { package?: string; module?: string; function?: string } } }).command;
    if (c?.oneofKind !== "moveCall" || !c.moveCall) continue;
    out.push({
      packageId: c.moveCall.package ?? "",
      module: c.moveCall.module ?? "",
      function: c.moveCall.function ?? "",
    });
  }
  return out;
}

export async function fetchTx(digest: string): Promise<FetchedTx | null> {
  // A finalized transaction never changes, so a hit here is always correct and
  // needs no TTL. This is deliberately the only thing about a trace that is
  // cached: the *conclusion* is derived from labels and from how far the chain
  // has grown, both of which move, and a stale conclusion looks identical to a
  // current one. Re-running a trace after adding a label costs nothing but
  // the recomputation.
  const network = getNetwork();
  const cached = getCachedTransaction<FetchedTx>(network, digest);
  if (cached) return { ...cached, source: "cache" };

  const data = await gqlQuery<GqlTxResult>(TX_QUERY, { digest }).catch(() => null);
  const tx = data?.transaction;

  // GraphQL answers a pruned digest with a hollow record rather than null: the
  // digest, timestamp and checkpoint are present while sender is null and both
  // balance changes and commands are empty. That is far more dangerous than a
  // miss — it renders as a real hop that simply moved nothing, so a trace ends
  // early looking complete. Treat it as absent and let the archive answer.
  const hollow =
    !!tx &&
    !tx.sender?.address &&
    (tx.effects?.balanceChanges?.nodes?.length ?? 0) === 0 &&
    (tx.kind?.commands?.nodes?.length ?? 0) === 0;

  if (tx && !hollow) {
    // Each costs a request only when its first page claimed more.
    const [bc, cmd, objectChanges] = await Promise.all([
      readAllBalanceChanges(digest, tx.effects?.balanceChanges),
      readAllCommands(digest, tx.kind?.commands),
      readAllObjectChanges(digest, tx.effects?.objectChanges),
    ]);
    const bcNodes = bc.nodes;
    const commands = adaptCommands(cmd.nodes);
    let eventTypes = (tx.effects?.events?.nodes ?? [])
      .map((e) => e?.contents?.type?.repr)
      .filter((t): t is string => typeof t === "string");
    let eventsIncomplete = false;
    if (tx.effects?.events?.pageInfo?.hasNextPage) {
      const all = await fetchEventJson(digest);
      if (all) eventTypes = all.map((e) => e.type).filter((t): t is string => typeof t === "string");
      else eventsIncomplete = true;
    }
    const fetched: FetchedTx = {
      sender: tx.sender?.address ?? null,
      balanceChanges: bcNodes.map((n) => ({
        address: n.owner?.address ?? "",
        coin_type: n.coinType?.repr ?? "",
        amount: n.amount ?? "0",
      })),
      grpcBalanceChanges: adaptBalanceChanges(bcNodes),
      commands,
      callSites: callSitesOf(commands),
      eventTypes,
      ...(eventsIncomplete ? { eventsIncomplete } : {}),
      gasPayer: tx.gasInput?.gasSponsor?.address ?? tx.sender?.address ?? null,
      netGas: netGas(tx.effects?.gasEffects?.gasSummary),
      signatures: (tx.signatures ?? [])
        .map((s) => s.signatureBytes)
        .filter((s): s is string => typeof s === "string" && s.length > 0),
      ...(bc.truncated ? { balanceChangesTruncated: true } : {}),
      ...(cmd.truncated ? { commandsTruncated: true } : {}),
      objectMovements: readObjectMovements(objectChanges.nodes, protocolForPackage),
      objectChangesTruncated: objectChanges.truncated,
      written: writtenObjects({ gql: objectChanges.nodes }),
      timestamp: tx.effects?.timestamp ?? null,
      checkpoint: tx.effects?.checkpoint?.sequenceNumber ?? null,
      source: "fullnode",
    };
    saveTransaction(network, digest, fetched);
    return fetched;
  }

  // The fullnode prunes. A digest it no longer holds is exactly what the
  // archives exist for, and a trace that stops there is the case an
  // investigator most needs to follow.
  //
  // The archive returns the same sender, balance changes, commands,
  // timestamp and checkpoint the fullnode does.
  let res;
  try {
    res = await withArchiveFallback(
      (client) => client.ledgerService.getTransaction({
        digest,
        readMask: {
          paths: [
            "digest", "transaction", "effects", "balance_changes", "timestamp", "checkpoint",
            "events", "signatures",
          ],
        },
      }),
      (r) => !r.transaction,
    );
  } catch (err) {
    // NOT_FOUND means the digest genuinely is not held anywhere, which the
    // caller renders as "could not fetch". Anything else — a malformed digest,
    // an outage — is a different problem and should say what it was rather
    // than be flattened into absence.
    if (isNotFound(err)) return null;
    throw new Error(
      `Could not read transaction ${digest} from the fullnode or the archive: ${(err as Error).message}`,
    );
  }

  const g = res.transaction;
  if (!g) return null;

  const grpcBc = g.balanceChanges ?? [];
  const kind = g.transaction?.kind;
  const commands =
    kind?.data.oneofKind === "programmableTransaction"
      ? kind.data.programmableTransaction.commands
      : [];

  const archived: FetchedTx = {
    sender: g.transaction?.sender ?? null,
    balanceChanges: grpcBc.map((bc) => ({
      address: bc.address ?? "",
      coin_type: bc.coinType ?? "",
      amount: bc.amount ?? "0",
    })),
    grpcBalanceChanges: grpcBc as ReturnType<typeof adaptBalanceChanges>,
    commands: commands as ReturnType<typeof adaptCommands>,
    callSites: callSitesOf(commands as ReturnType<typeof adaptCommands>),
    eventTypes: (g.events?.events ?? [])
      .map((e) => e.eventType)
      .filter((t): t is string => typeof t === "string"),
    gasPayer: g.transaction?.gasPayment?.owner ?? g.transaction?.sender ?? null,
    netGas: netGas(g.effects?.gasUsed),
    signatures: (g.signatures ?? [])
      .map((s) => (s.bcs?.value ? Buffer.from(s.bcs.value).toString("base64") : ""))
      .filter(Boolean),
    // The archive reports object changes: a digest the fullnode has pruned
    // comes back with changedObjects carrying objectType and both owners.
    // This transport is also the only one that can resolve the pre-2024
    // ambiguity, because it states inputState as EXISTS / DOES_NOT_EXIST
    // rather than a null.
    objectMovements: readGrpcObjectChanges(
      (g.effects?.changedObjects ?? []) as GrpcChangedObject[],
      protocolForPackage,
    ),
    written: writtenObjects({ grpc: (g.effects?.changedObjects ?? []) as GrpcChangedObject[] }),
    // gRPC returns a protobuf Timestamp ({seconds, nanos}), not a unix number.
    timestamp: timestampToIso(g.timestamp) ?? null,
    checkpoint: g.checkpoint != null ? Number(g.checkpoint) : null,
    source: "archive",
  };
  // Worth caching most of all: an archive hop is one the fullnode has pruned,
  // so it is both the slowest to fetch and the least likely to become
  // available again.
  saveTransaction(network, digest, archived);
  return archived;
}

/**
 * Candidate transactions for the next or previous hop, with what hop
 * selection needs: who sent it, who paid gas, and every balance change.
 */
const CANDIDATE_NODE = `digest sender { address } gasInput { gasSponsor { address } }
      effects { gasEffects { gasSummary { computationCost storageCost storageRebate } } ${BALANCE_CHANGES_SELECTION} }`;

const SENT_AFTER = `query($address: SuiAddress!, $first: Int!, $after: String, $afterCheckpoint: Int, $beforeCheckpoint: Int) {
  transactions(filter: { sentAddress: $address, afterCheckpoint: $afterCheckpoint, beforeCheckpoint: $beforeCheckpoint }, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ${CANDIDATE_NODE} }
  }
}`;

const AFFECTED_AFTER = `query($address: SuiAddress!, $first: Int!, $after: String, $afterCheckpoint: Int, $beforeCheckpoint: Int) {
  transactions(filter: { affectedAddress: $address, afterCheckpoint: $afterCheckpoint, beforeCheckpoint: $beforeCheckpoint }, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ${CANDIDATE_NODE} }
  }
}`;

const AFFECTED_BEFORE = `query($address: SuiAddress!, $last: Int!, $before: String, $beforeCheckpoint: Int, $afterCheckpoint: Int) {
  transactions(filter: { affectedAddress: $address, beforeCheckpoint: $beforeCheckpoint, afterCheckpoint: $afterCheckpoint }, last: $last, before: $before) {
    pageInfo { hasPreviousPage startCursor }
    nodes { ${CANDIDATE_NODE} }
  }
}`;

/**
 * Candidates per page, and pages per search.
 *
 * The sent-transaction search reaches 500 transactions because an attacker
 * can send hundreds of transactions before moving the proceeds. The object
 * and backward searches read inflows, which a busy address has many more of,
 * so they stop sooner.
 */
export const CANDIDATE_PAGE = 50;
export const SENT_PAGES = 10;
export const AFFECTED_PAGES = 4;

export interface CandidateNode {
  digest: string;
  sender?: { address?: string } | null;
  gasInput?: { gasSponsor?: { address?: string } | null } | null;
  effects?: {
    gasEffects?: { gasSummary?: GqlGasSummary | null } | null;
    balanceChanges?: GqlConnection<GqlBalanceChangeNode> | null;
  } | null;
}

export interface CandidatePage {
  transactions: {
    nodes: CandidateNode[];
    pageInfo: {
      hasNextPage?: boolean;
      endCursor?: string | null;
      hasPreviousPage?: boolean;
      startCursor?: string | null;
    };
  };
}

/** One page of candidates, in the ascending order GraphQL returns. */
export async function candidatePage(
  query: string,
  variables: Record<string, unknown>,
  paging: "forward" | "backward",
): Promise<{ txs: CandidateTx[]; cursor: string | null; more: boolean }> {
  const data = await gqlQuery<CandidatePage>(query, variables);
  const conn = data.transactions;
  const nodes = conn?.nodes ?? [];
  const completed = await completeTxConnections(
    nodes.map((n) => ({ digest: n.digest, balanceChanges: n.effects?.balanceChanges })),
  );
  const txs = nodes.map((n, i): CandidateTx => {
    const sender = n.sender?.address ?? null;
    const net = netGas(n.effects?.gasEffects?.gasSummary);
    return {
      digest: n.digest,
      sender,
      gas: { payer: n.gasInput?.gasSponsor?.address ?? sender, net: net === null ? null : BigInt(net) },
      changes: completed[i].balanceChanges.map((b) => ({
        address: b.owner?.address ?? "",
        coin_type: b.coinType?.repr ?? "",
        amount: b.amount ?? "0",
      })),
      ...(completed[i].balanceChangesTruncated ? { changesTruncated: true } : {}),
    };
  });
  const forward = paging === "forward";
  return {
    txs,
    cursor: (forward ? conn?.pageInfo?.endCursor : conn?.pageInfo?.startCursor) ?? null,
    more: (forward ? conn?.pageInfo?.hasNextPage : conn?.pageInfo?.hasPreviousPage) === true,
  };
}

export type ForwardStep =
  | {
      digest: string;
      via: "sent" | "released-from-object";
      spent: bigint;
      /** The other spends read before the delivered amount was covered, in order. */
      others: Array<{ digest: string; spent: bigint }>;
      /** Earlier transactions in which the address kept a claim on the coin it put in and still held (see claimCoinsKept). */
      keptClaims: Array<{ digest: string; spent: bigint }>;
    }
  | { digest: null; reason: string; keptClaims: Array<{ digest: string; spent: bigint }> };

/**
 * Spends read to choose a forward trace's next hop, and a flow graph's per-node
 * budget. Bounds how far past the first spend a hop looks for the rest of what
 * it delivered.
 */
export const MOVES_PER_NODE = 20;

/**
 * Checkpoint bounds a caller adds on top of the hop's own, both exclusive as
 * the filter takes them. A flow graph confines its whole search to a window.
 */
export interface SearchWindow {
  afterCheckpoint?: number;
  beforeCheckpoint?: number;
}

/** One transaction in which the followed address spent the tracked coin. */
export interface ForwardSpend {
  tx: CandidateTx;
  via: "sent" | "released-from-object";
  spent: bigint;
}
export interface ForwardScan {
  /** Spends in the order they happened. */
  spends: ForwardSpend[];
  /** The filter that found them, or the last one read when none was found. */
  phase: "sent" | "affected";
  /** Transactions read in that phase, the current one and the caller's `hardSkip` excluded. */
  seen: number;
  /** The phase reached the end of the address's history (or of the window). */
  exhausted: boolean;
  /** Stopped early because `need` was covered or `maxSpends` was reached. */
  satisfied: boolean;
  /**
   * Candidates that did spend the tracked coin but whose value the
   * address-start root of the same graph already claimed. Nonzero here means
   * the value did move, just not through a transaction this scan may count
   * again.
   */
  alreadyAllocated: number;
  /**
   * Candidates that spent the tracked coin but were drained to zero by this
   * same node's earlier arrivals: those spends are already counted against
   * them, and this arrival's share is still held.
   */
  drainedBySelf: number;
  /** Candidates `passOver` set aside: spends of the coin that did not move it on. */
  passedOver: ForwardSpend[];
}

/**
 * The transactions that move the tracked coin out of `address`, in order.
 *
 * Forward tracing filters on **sentAddress**, not `affectedAddress`. "The next
 * transaction affecting R" includes someone paying R, and following that
 * would attribute a third party's transaction to the subject. Within R's own
 * transactions, only one that SPENDS the tracked coin (gas removed) continues
 * the funds; the first one of any kind does not, and following it would
 * report an unrelated token transfer as the traced SUI.
 *
 * An object cannot send. When R has sent nothing since the hop, the funds may
 * be held by an object (a `Receiving<T>` transfer to an object's id, an
 * object's address balance), and the transaction that takes them out is sent
 * by someone else. That case is found through `affectedAddress`, as the later
 * transactions in which R's balance of the coin goes down.
 *
 * `afterCheckpoint` is **exclusive**: passing a transaction's own checkpoint
 * excludes it, passing `cp - 1` includes it. Same-checkpoint forwarding is
 * what a script does, so the window starts at `cp - 1` and the current digest
 * and anything before it in the page are dropped.
 *
 * Stops at `maxSpends` spends or once they add up to `need`, whichever comes
 * first; with neither it reads every page it is allowed.
 */
export async function scanForwardSpends(
  address: string,
  atCheckpoint: number | undefined,
  coin: string | null,
  remaining: ReadonlyMap<string, RemainingEntry>,
  current: string | undefined,
  opts: {
    need?: bigint;
    maxSpends?: number;
    window?: SearchWindow;
    hardSkip?: ReadonlySet<string>;
    /**
     * The claim coins a spend left the holder, which keep the value its own:
     * such a spend is set aside rather than counted while the holder keeps
     * the claim, and counted from where a later transaction passes the claim
     * to another address (see passesClaim).
     */
    passOver?: (tx: CandidateTx) => string[];
  } = {},
): Promise<ForwardScan> {
  const w = opts.window ?? {};
  const fromHop = atCheckpoint === undefined ? undefined : atCheckpoint - 1;
  const afterCheckpoint =
    fromHop === undefined ? w.afterCheckpoint : w.afterCheckpoint === undefined ? fromHop : Math.max(fromHop, w.afterCheckpoint);
  const done = (spends: ForwardSpend[], covered: bigint) =>
    (opts.maxSpends !== undefined && spends.length >= opts.maxSpends) ||
    (opts.need !== undefined && covered >= opts.need);

  const read = async (
    query: string,
    via: ForwardSpend["via"],
    pages: number,
  ): Promise<Omit<ForwardScan, "phase">> => {
    const spends: ForwardSpend[] = [];
    const passedOver: Array<ForwardSpend & { claims: string[] }> = [];
    /** Order each spend was seen in, so released claims keep their place. */
    const order = new Map<ForwardSpend, number>();
    let seq = 0;
    let covered = 0n;
    const inOrder = () => spends.sort((a, b) => order.get(a)! - order.get(b)!);
    const result = (exhausted: boolean, satisfied: boolean) => ({
      spends: inOrder(),
      seen,
      exhausted,
      satisfied,
      alreadyAllocated,
      drainedBySelf,
      passedOver: passedOver.map(({ claims: _, ...p }) => p),
    });
    let seen = 0;
    let alreadyAllocated = 0;
    let drainedBySelf = 0;
    let after: string | null = null;
    for (let page = 0; page < pages; page++) {
      const { txs, cursor, more } = await candidatePage(query, {
        address,
        first: CANDIDATE_PAGE,
        after,
        afterCheckpoint,
        ...(w.beforeCheckpoint !== undefined ? { beforeCheckpoint: w.beforeCheckpoint } : {}),
      }, "forward");
      // A hard-skipped digest is the caller's own earlier step, which predates
      // this receipt, so it is not a transaction sent since.
      seen += txs.filter((t) => t.digest !== current && !opts.hardSkip?.has(t.digest)).length;
      const found = allSpends(txs, address, coin, remaining, opts.hardSkip, current);
      alreadyAllocated += found.alreadyAllocated;
      drainedBySelf += found.drainedBySelf;
      const hitOf = new Map(found.hits.map((h) => [h.tx, h]));
      const lastHit = found.hits.at(-1)?.tx;
      for (const tx of txs) {
        // A claim set aside earlier counts as a spend once it is passed on.
        for (let i = passedOver.length - 1; i >= 0; i--) {
          const held = passedOver[i];
          if (held.tx === tx || !passesClaim(tx, address, held.claims)) continue;
          passedOver.splice(i, 1);
          const spend = { tx: held.tx, via: held.via, spent: held.spent };
          order.set(spend, order.get(held)!);
          spends.push(spend);
          covered += held.spent;
        }
        const hit = hitOf.get(tx);
        if (hit) {
          const claims = opts.passOver?.(hit.tx) ?? [];
          const spend = { tx: hit.tx, via, spent: hit.spent };
          if (claims.length) {
            const held = { ...spend, claims };
            order.set(held, seq++);
            passedOver.push(held);
          } else {
            order.set(spend, seq++);
            spends.push(spend);
            covered += hit.spent;
          }
        }
        // The last spend of the last page leaves nothing unread.
        if (done(spends, covered)) return result(tx === lastHit && (!more || !cursor), true);
      }
      if (!more || !cursor) return result(true, false);
      after = cursor;
    }
    return result(false, false);
  };

  const sent = await read(SENT_AFTER, "sent", SENT_PAGES);
  if (sent.spends.length > 0 || sent.seen > 0) return { ...sent, phase: "sent" };
  return { ...(await read(AFFECTED_AFTER, "released-from-object", AFFECTED_PAGES)), phase: "affected" };
}

/**
 * Why a forward search found nothing to follow. The wording is the one
 * `trace_funds` reports as its `stop_reason`.
 *
 * A scan that hit its page limit is reported as budget-limited first, even
 * when it also saw a wildcard-blocked candidate along the way: a truncated
 * scan has not actually ruled out an unblocked spend sitting in the pages it
 * never reached, and telling the reader "it did move, see the other arrival"
 * when the search may simply have stopped too soon is worse than saying
 * nothing was found yet.
 */
export function noSpendReason(address: string, coin: string | null, scan: ForwardScan): string {
  const coinName = coin ? displayCoin(coin).symbol : "the funds";
  const { seen, exhausted, satisfied, alreadyAllocated, drainedBySelf } = scan;
  const budgetLimited = !exhausted && !satisfied;
  if (!budgetLimited && alreadyAllocated > 0) {
    return (
      `${address} spent ${coinName} in ${alreadyAllocated} transaction(s) whose value was already counted from ` +
      `this address's start node elsewhere in this graph, so this branch's share is not counted a second time. ` +
      `It did move; see the start node's edges for where.`
    );
  }
  if (!budgetLimited && drainedBySelf > 0) {
    return (
      `${address}'s ${drainedBySelf} later spend(s) of ${coinName} are already counted against its earlier ` +
      `arrival(s) in this graph, so this arrival's share is still held.`
    );
  }
  // Spends of the coin the scan saw but could not count again: saying that
  // none of the transactions moved it would be false.
  const counted = alreadyAllocated + drainedBySelf;
  if (budgetLimited && counted > 0) {
    return (
      `${address} ${scan.phase === "sent" ? "sent" : "was touched by"} ${seen} transactions after receiving the funds, ` +
      `and the ${counted} of them that moved ${coinName} are already counted elsewhere in this graph. The search ` +
      `stopped at that limit, so this arrival's share may have moved in a later transaction: restart from ` +
      `${address}'s later activity.`
    );
  }
  if (scan.phase === "sent") {
    return exhausted
      ? `${address} has sent ${seen} transaction(s) since receiving the funds and none of them moved ${coinName}, so it has not spent them yet.`
      : `${address} sent ${seen} transactions after receiving the funds and none of them moved ${coinName}. The search stopped at that limit, so the funds may have moved in a later transaction: restart from ${address}'s later activity.`;
  }
  return exhausted
    ? `${address} has not sent a transaction since receiving the funds, and ${seen === 0 ? "no later transaction has touched it" : `none of the ${seen} later transaction(s) touching it took ${coinName} out`}. The funds are still there: a wallet that has not spent yet, or an object still holding them.`
    : `${address} has not sent a transaction since receiving the funds, and none of the first ${seen} later transactions touching it took ${coinName} out. The search stopped at that limit, so the funds may have left later.`;
}

/**
 * The transaction that moves the tracked coin out of `address` next. See
 * {@link scanForwardSpends}.
 *
 * With `need` (what the previous hop delivered), the spends are read in order
 * until they cover 99% of it (the tolerance `residual` uses, so a sweep that
 * paid its own gas counts as covering), at most {@link MOVES_PER_NODE}. `need`
 * is allocated to them first in, first out, and the spend that drew the most
 * of it is followed: a sliver sent first (a gas top-up, a test transfer) is
 * not where most of the funds went, and a larger later spend of other funds
 * draws only what remained. The rest come back as `others`. Without `need`,
 * the first spend.
 */
export async function findNextForward(
  address: string,
  atCheckpoint: number | undefined,
  coin: string | null,
  remaining: ReadonlyMap<string, RemainingEntry>,
  current: string,
  hardSkip?: ReadonlySet<string>,
  opts: { need?: bigint; passOver?: (tx: CandidateTx) => string[] } = {},
): Promise<ForwardStep> {
  const need = opts.need !== undefined && opts.need > 0n ? opts.need : null;
  const scan = await scanForwardSpends(address, atCheckpoint, coin, remaining, current, {
    ...(need !== null ? { need: (need * 99n + 99n) / 100n, maxSpends: MOVES_PER_NODE } : { maxSpends: 1 }),
    hardSkip,
    ...(opts.passOver ? { passOver: opts.passOver } : {}),
  });
  const keptClaims = scan.passedOver.map((p) => ({ digest: p.tx.digest, spent: p.spent }));
  let left = need ?? 0n;
  let hit: ForwardSpend | undefined;
  let drawn = -1n;
  for (const s of scan.spends) {
    const take = need === null ? s.spent : s.spent < left ? s.spent : left;
    left -= need === null ? 0n : take;
    if (take > drawn) {
      hit = s;
      drawn = take;
    }
  }
  if (!hit) return { digest: null, reason: noSpendReason(address, coin, scan), keptClaims };
  return {
    digest: hit.tx.digest,
    via: hit.via,
    spent: hit.spent,
    others: scan.spends.filter((s) => s !== hit).map((s) => ({ digest: s.tx.digest, spent: s.spent })),
    keptClaims,
  };
}

export type BackwardStep =
  | {
      digest: string;
      received: bigint;
      /** Earlier inflows needed to cover the outflow, not followed. */
      others: UnfollowedRecipient[];
      /** The inflows found cover less than the outflow being explained. */
      shortfall: boolean;
    }
  | { digest: null; reason: string };

export interface BackwardScan {
  /** Inflows newest first. */
  found: Array<{ tx: CandidateTx; received: bigint }>;
  covered: bigint;
  scanned: number;
  /** Reached the start of the address's history (or of the window). */
  exhausted: boolean;
  /**
   * Candidates that did pay the tracked coin in but whose value the
   * address-start root of the same graph already claimed.
   */
  alreadyAllocated: number;
  /** Inflows drained to zero by this same node's earlier arrivals. See {@link ForwardScan.drainedBySelf}. */
  drainedBySelf: number;
}

/**
 * The inflows of the tracked coin to `address` before the hop, newest first.
 *
 * Walks `affectedAddress` newest to oldest and takes the transactions in which
 * `address` gained the coin (gas removed), until they cover `need` (what
 * `address` paid out) or `maxInflows` are found.
 */
export async function scanPriorInflows(
  address: string,
  atCheckpoint: number | undefined,
  coin: string | null,
  remaining: ReadonlyMap<string, RemainingEntry>,
  current: string | undefined,
  need: bigint,
  opts: { maxInflows?: number; window?: SearchWindow; hardSkip?: ReadonlySet<string> } = {},
): Promise<BackwardScan> {
  const w = opts.window ?? {};
  const fromHop = atCheckpoint === undefined ? undefined : atCheckpoint + 1;
  const beforeCheckpoint =
    fromHop === undefined ? w.beforeCheckpoint : w.beforeCheckpoint === undefined ? fromHop : Math.min(fromHop, w.beforeCheckpoint);
  const found: Array<{ tx: CandidateTx; received: bigint }> = [];
  let covered = 0n;
  let before: string | null = null;
  let scanned = 0;
  let exhausted = false;
  let alreadyAllocated = 0;
  let drainedBySelf = 0;
  const full = () => covered >= need || (opts.maxInflows !== undefined && found.length >= opts.maxInflows);

  for (let page = 0; page < AFFECTED_PAGES && !full(); page++) {
    const { txs, cursor, more } = await candidatePage(AFFECTED_BEFORE, {
      address,
      last: CANDIDATE_PAGE,
      before,
      beforeCheckpoint,
      ...(w.afterCheckpoint !== undefined ? { afterCheckpoint: w.afterCheckpoint } : {}),
    }, "backward");
    scanned += txs.length;
    const inflows = inflowsNewestFirst(txs, address, coin, remaining, opts.hardSkip, page === 0 ? current : undefined);
    alreadyAllocated += inflows.alreadyAllocated;
    drainedBySelf += inflows.drainedBySelf;
    // Stopping before the page's last inflow leaves older inflows unread, even on the oldest page.
    let cut = false;
    for (const [k, inflow] of inflows.hits.entries()) {
      found.push(inflow);
      covered += inflow.received;
      if (full()) {
        cut = k < inflows.hits.length - 1;
        break;
      }
    }
    if (!more || !cursor) {
      exhausted = !cut;
      break;
    }
    before = cursor;
  }
  return { found, covered, scanned, exhausted, alreadyAllocated, drainedBySelf };
}

/**
 * Why a backward search found no inflow. The wording is `trace_funds`'s.
 *
 * Same ordering as {@link noSpendReason}: a page-limited scan is reported as
 * budget-limited first, even if it also saw a wildcard-blocked candidate.
 */
export function noInflowReason(address: string, coin: string | null, scan: BackwardScan): string {
  const coinName = coin ? displayCoin(coin).symbol : "value";
  if (scan.exhausted && scan.alreadyAllocated > 0) {
    return (
      `${address} was paid ${coinName} in ${scan.alreadyAllocated} transaction(s) whose value was already counted ` +
      `into this address's start node elsewhere in this graph, so this branch's share is not counted a second time.`
    );
  }
  if (scan.exhausted && scan.drainedBySelf > 0) {
    return (
      `${address}'s ${scan.drainedBySelf} earlier inflow(s) of ${coinName} already explain its other arrival(s) ` +
      `in this graph, and no other inflow explains this one: a mint, a withdrawal from a protocol it sent itself, ` +
      `or a transfer older than the history this server can read.`
    );
  }
  const counted = scan.alreadyAllocated + scan.drainedBySelf;
  if (!scan.exhausted && counted > 0) {
    return (
      `Of the ${scan.scanned} transactions before this one that touch ${address}, the ${counted} that paid ` +
      `${coinName} into it are already counted elsewhere in this graph. The search stopped at that limit; the ` +
      `funding is older.`
    );
  }
  return scan.exhausted
    ? `No earlier transaction paid ${coinName} into ${address}. Where it got these funds is not visible as an inflow: a mint, a withdrawal from a protocol it sent itself, or a transfer older than the history this server can read.`
    : `None of the ${scan.scanned} transactions before this one that touch ${address} paid ${coinName} into it. The search stopped at that limit; the funding is older.`;
}

/**
 * The most recent inflow of the tracked coin to `address` before the hop.
 *
 * When that inflow is smaller than what `address` paid out, older inflows are
 * collected until they cover it, and reported as unfollowed sources: the
 * outflow was funded by several of them, and the trace follows only the latest.
 */
export async function findPriorInflow(
  address: string,
  atCheckpoint: number | undefined,
  coin: string | null,
  remaining: ReadonlyMap<string, RemainingEntry>,
  current: string,
  need: bigint,
  hardSkip?: ReadonlySet<string>,
): Promise<BackwardStep> {
  const scan = await scanPriorInflows(address, atCheckpoint, coin, remaining, current, need, { hardSkip });
  if (scan.found.length === 0) return { digest: null, reason: noInflowReason(address, coin, scan) };
  const [followed, ...rest] = scan.found;
  return {
    digest: followed.tx.digest,
    received: followed.received,
    others: rest.map((r) => ({
      address: payerOf(r.tx, address, coin) ?? "",
      amount: r.received.toString(),
      coin_type: coin ?? "",
      usd_value: null,
      digest: r.tx.digest,
    })),
    shortfall: scan.covered < need,
  };
}

/**
 * Transactions sampled to decide whether a backward source is a hub.
 *
 * A hub's earlier inflows are other parties' deposits, so walking past one
 * names strangers as the source. `measureFanout` classifies at 100 distinct
 * counterparties, and 200 recent transactions is four requests.
 */
export const HUB_SCAN_TRANSACTIONS = 200;

/**
 * Whether a trace should stop at `address` because it pools other parties'
 * money, given its measured fan-out.
 *
 * Backward, any wide address stops: which of its many counterparties paid
 * these funds in is not recoverable. Forward, only a wide inflow side pools:
 * an address paid by few senders and paying many passes on what those few
 * sent, so its outflows continue the traced funds (the trace flags any
 * mixing hop by hop). A sender side of unknown width counts as wide. A
 * wallet labelled malicious is the subject whose money is being followed,
 * so it never stops a forward trace.
 */
export function stopsAsHub(
  address: string,
  fanout: Pick<FanoutResult, "classification" | "sender_classification"> | null,
  direction: "forward" | "backward",
): boolean {
  if (!fanout || fanout.classification === "narrow") return false;
  if (direction === "backward") return true;
  if (getLabel(address)?.category === "malicious") return false;
  return fanout.sender_classification !== "narrow";
}

/** Calls that put value into a protocol object and leave the caller a claim. */
export const DEPOSIT_CALL = /^(entry_|public_|request_add_)?(deposit|supply|stake|lock|add_liquidity|lend|provide|mint|open_position|place_order)/;

/**
 * A pool or protocol address is a pass-through, not a real destination: funds
 * routed through a DEX belong to the actor, not the pool.
 *
 * Curated lookup only, deliberately. Treating an address as a pass-through
 * makes a trace walk through it, so widening this with runtime-resolved MVR
 * names would let anyone who registers a name change where a fund trace stops.
 */
export function isPassThroughAddress(addr: string): boolean {
  if (lookupProtocol(addr)) return true;
  const cat = getLabel(addr)?.category;
  return cat === "protocol" || cat === "defi";
}

/** A package's protocol name, or a short `0x…::module` when nothing names it. */
export function callTarget(c: { packageId: string; module: string }): string {
  return lookupProtocolDisplay(c.packageId)?.name ?? `${c.packageId.slice(0, 10)}…::${c.module}`;
}

/**
 * Why a forward hop has nothing to follow.
 *
 * A deposit into a protocol produces no recipient balance change: the pool
 * holds a `Balance<T>` inside a shared object. Naming the protocol and the
 * depositor turns "the trace ended" into "the funds are in NAVI and this
 * wallet holds the claim", which is where an investigator goes next.
 */
export function forwardDeadEnd(
  tx: FetchedTx,
  holder: string | null,
  coin: string | null,
  consumed: boolean,
  note: string | undefined,
): string {
  if (!holder) return note ?? "No sender on this transaction, so there is no actor whose outflow could be followed.";
  const coinName = coin ? displayCoin(coin).symbol : "value";
  if (!consumed) {
    return `Nothing but gas left ${holder} on this hop and nobody else received anything, so there is no outflow to follow.`;
  }
  const into = tx.callSites.filter((c) => DEPOSIT_CALL.test(c.function));
  if (into.length > 0) {
    const protocols = [...new Set(into.map(callTarget))].join(", ");
    const calls = [...new Set(into.map((c) => `${c.module}::${c.function}`))].join(", ");
    return (
      `The ${coinName} went into ${protocols} (${calls}) and no address received it. It is held in the protocol's ` +
      `objects, and ${holder} holds the claim on it (a receipt, share or position). Follow ${holder}'s later withdrawal to continue.`
    );
  }
  const called = [...new Set(tx.callSites.map(callTarget))];
  return (
    `The ${coinName} left ${holder} and no address received it: it was burned, or locked in an object` +
    `${called.length ? ` by ${called.join(", ")}` : ""}. The balance changes do not say where it went; check the hop's object_transfers and events.`
  );
}

/** Why a backward hop has no earlier party to follow. */
export function backwardDeadEnd(tx: FetchedTx, recipient: string | null, coin: string | null): string {
  const coinName = coin ? displayCoin(coin).symbol : "value";
  const called = [...new Set(tx.callSites.map(callTarget))];
  return (
    `No address paid the ${coinName} in on this hop${recipient ? ` to ${recipient}` : ""}: it came out of ` +
    `${called.length ? called.join(", ") : "no identifiable call"} (a withdrawal, claim, mint, unstake, or an exploit of a pool). ` +
    "A protocol's shared objects hold many parties' funds, so there is no single earlier source to follow."
  );
}

/**
 * Signed human amount with its symbol, marked when nothing vouches for the coin.
 *
 * Scale comes from {@link coinScale}, which resolves by coin type, so a coin
 * whose struct name is `SUI` is rendered at real SUI's 9 decimals only when it
 * is real SUI. An imitator can declare a different scale.
 */
export function formatAmount(amount: string, coinType: string): string {
  const val = BigInt(amount);
  const abs = val < 0n ? -val : val;
  const sign = val < 0n ? "-" : "+";
  const { decimals, source } = coinScale(coinType);
  const { symbol, verified } = displayCoin(coinType);

  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const formatted = fracStr ? `${whole}.${fracStr}` : whole.toString();
  // Two different warnings. "unverified" is about WHICH coin this is; "assumed
  // scale" is about whether the number is right at all.
  const marks = [
    verified === false ? "unverified" : null,
    source === "assumed" ? "assumed scale" : null,
  ].filter(Boolean);
  return `${sign}${formatted} ${symbol}${marks.length ? ` (${marks.join(", ")})` : ""}`;
}

