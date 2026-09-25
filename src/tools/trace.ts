import { z } from "zod";
import { numArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { describeAddresses, identityNote } from "../utils/identity.js";
import { lookupProtocol, lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import { getLabel, isSink, labelProvenance, type LabelProvenance } from "../utils/labels.js";
import { detectBridges, resolvableHit, type BridgeHit } from "../utils/bridge/detect.js";
import {
  chooseNextHop,
  coinKey,
  firstSpend,
  inflowsNewestFirst,
  nonGasAmount,
  payerOf,
  sameCoin,
  type CandidateTx,
  type GasCharge,
  type HopBasis,
  type UnfollowedRecipient,
} from "../utils/trace-hop.js";
import { assignSignerRoles } from "../utils/multisig.js";
import { measureFanout } from "../utils/fanout.js";
import { fetchEventJson } from "../utils/event-json.js";
import {
  BALANCE_CHANGES_SELECTION,
  COMMANDS_SELECTION,
  completeTxConnections,
  readAllBalanceChanges,
  readAllCommands,
  type GqlConnection,
} from "../utils/tx-connections.js";
import {
  custodyChanges,
  objectCounterparties,
  readGrpcObjectChanges,
  readObjectMovements,
  summarizeObjectFlow,
  type GqlObjectChange,
  type GrpcChangedObject,
  type ObjectMovement,
} from "../utils/object-flow.js";
import { ActivityLedger, lookalikeReport } from "../utils/address-lookalike.js";
import type { Appearance } from "../utils/address-lookalike.js";
import { pricesForRanking } from "../utils/price-providers.js";
import {
  coinScale,
  decimalsForCoinType,
  displayCoin,
  dominantInflowUsd,
  formatUsd,
  PRICE_STALE_THRESHOLD_SEC,
  priceUsdAtTime,
  pricingScale,
  usdValue,
  type PricePoint,
} from "../utils/valuation.js";
import { collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { adaptCommands, adaptBalanceChanges } from "../utils/gql-adapters.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import { timestampToIso } from "../utils/formatting.js";
import { errorResult, isNotFound } from "../utils/errors.js";
import { getCachedTransaction, saveTransaction } from "../utils/store.js";
import { getNetwork } from "../config.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "../utils/gql-adapters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface BalanceChangeInfo {
  address: string;
  coin_type: string;
  amount: string;
}

interface HopResult {
  hop: number;
  digest: string;
  sender: string | null;
  balance_changes: BalanceChangeInfo[];
  timestamp: string | null;
  checkpoint: string | null;
  protocols: string[];
  /** How the next hop was chosen. See `HopBasis`. */
  basis?: HopBasis;
  /** Forward: recipients on this hop that the trace did not follow. */
  unfollowed_recipients?: UnfollowedRecipient[];
  /**
   * Backward: other parties that paid the tracked coin in on this hop, and
   * earlier inflows to the followed source that were not followed.
   */
  unfollowed_sources?: UnfollowedRecipient[];
  /**
   * Set when this hop was not sent by the address the trace was following:
   * the value was held by an object (a `Receiving<T>` transfer, an object's
   * address balance) and this transaction took it out.
   */
  reached_via?: "released-from-object";
  /**
   * False when the sender's own key did not sign: another address authorized
   * it through an address alias or a protocol-level substitution.
   */
  signer_is_sender?: false;
  authorized_by?: string[];
  /** The holder spent more of the tracked coin than the trace delivered to it. */
  commingled?: { received: string; spent: string; coin_type: string; note: string };
  actions: string[];
  token_flow: { coin: string; amount: string; raw_type: string }[];
  /**
   * Non-coin objects that changed hands on this hop. Absent when none did.
   * An NFT, a Kiosk or a capability moves without producing a balance change,
   * so these do not appear in `balance_changes` and never will.
   */
  object_transfers?: ObjectMovement[];
  /** Set when more object changes existed than the page returned. */
  object_changes_truncated?: string;
  /** More balance changes or commands existed than could be read. */
  balance_changes_truncated?: true;
  commands_truncated?: true;
  /** More events existed than could be read, so bridge detection may be incomplete. */
  events_incomplete?: true;
  /**
   * Set when the transport that answered this hop cannot report object
   * changes at all — the archive path. "No objects moved" and "could not
   * read what moved" are opposite claims, and only one of them is knowable
   * here.
   */
  object_flow_unavailable?: string;
  /** Note about how the next hop was chosen (swap follow-through, pool skip). */
  note?: string;
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

interface GqlGasSummary {
  computationCost?: number | string | bigint | null;
  storageCost?: number | string | bigint | null;
  storageRebate?: number | string | bigint | null;
}

interface GqlTxResult {
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
function netGas(s: GqlGasSummary | null | undefined): string | null {
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
interface FetchedTx {
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
 * Measured: about 1 transaction in 400 carries more than 50 object changes,
 * and a real three-hop trace hit one with 101. The connection is ordered by
 * object id, not by importance, so which 50 arrive first is arbitrary with
 * respect to whether the interesting transfer is among them — truncating
 * silently would drop a capability transfer on a coin flip.
 *
 * Bounded rather than exhaustive: the caller states the cap it hit, which is
 * the one thing a truncated read must never leave unsaid.
 */
const OBJECT_CHANGE_PAGES = 5;

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

function protocolForPackage(packageId: string): { name: string; type?: string } | null {
  const p = lookupProtocol(packageId);
  return p ? { name: p.name, type: (p as { type?: string }).type } : null;
}

function callSitesOf(commands: ReturnType<typeof adaptCommands>) {
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

async function fetchTx(digest: string): Promise<FetchedTx | null> {
  // A finalized transaction never changes, so a hit here is always correct and
  // needs no TTL. This is deliberately the only thing about a trace that is
  // cached: the *conclusion* is derived from labels and from how far the chain
  // has grown, both of which move, and a stale conclusion looks identical to a
  // current one. Re-running a trace after adding a label now costs nothing but
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
      timestamp: tx.effects?.timestamp ?? null,
      checkpoint: tx.effects?.checkpoint?.sequenceNumber ?? null,
      source: "fullnode",
    };
    saveTransaction(network, digest, fetched);
    return fetched;
  }

  // The fullnode prunes. A digest it no longer holds is exactly what the
  // archives exist for, and a trace that stops there is the case an
  // investigator most needs to follow — old money is the money worth tracing.
  //
  // The commit that removed this fallback justified it on the archive not
  // returning balance_changes. Measured against mainnet, it returns the same
  // sender, balance changes, commands, timestamp and checkpoint the fullnode
  // does, so that reason no longer holds.
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
    // The archive DOES report object changes. An earlier version claimed it
    // could not and disclaimed object flow on every archive hop; verified
    // false against mainnet, where a digest the fullnode has pruned comes back
    // with changedObjects carrying objectType and both owners. This transport
    // is also the only one that can resolve the pre-2024 ambiguity, because it
    // states inputState as EXISTS / DOES_NOT_EXIST rather than a null.
    objectMovements: readGrpcObjectChanges(
      (g.effects?.changedObjects ?? []) as GrpcChangedObject[],
      protocolForPackage,
    ),
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

const SENT_AFTER = `query($address: SuiAddress!, $first: Int!, $after: String, $afterCheckpoint: Int) {
  transactions(filter: { sentAddress: $address, afterCheckpoint: $afterCheckpoint }, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ${CANDIDATE_NODE} }
  }
}`;

const AFFECTED_AFTER = `query($address: SuiAddress!, $first: Int!, $after: String, $afterCheckpoint: Int) {
  transactions(filter: { affectedAddress: $address, afterCheckpoint: $afterCheckpoint }, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ${CANDIDATE_NODE} }
  }
}`;

const AFFECTED_BEFORE = `query($address: SuiAddress!, $last: Int!, $before: String, $beforeCheckpoint: Int) {
  transactions(filter: { affectedAddress: $address, beforeCheckpoint: $beforeCheckpoint }, last: $last, before: $before) {
    pageInfo { hasPreviousPage startCursor }
    nodes { ${CANDIDATE_NODE} }
  }
}`;

/**
 * Candidates per page, and pages per search.
 *
 * The sent-transaction search reaches 500 transactions because an attacker
 * keeps working before moving the proceeds: the Cetus exploiter sent 385
 * transactions (the rest of the drain) before its first haSUI outflow. Each
 * page is one request of about 0.2s. The object and backward searches read
 * inflows, which a busy address has many more of, so they stop sooner.
 */
const CANDIDATE_PAGE = 50;
const SENT_PAGES = 10;
const AFFECTED_PAGES = 4;

interface CandidateNode {
  digest: string;
  sender?: { address?: string } | null;
  gasInput?: { gasSponsor?: { address?: string } | null } | null;
  effects?: {
    gasEffects?: { gasSummary?: GqlGasSummary | null } | null;
    balanceChanges?: GqlConnection<GqlBalanceChangeNode> | null;
  } | null;
}

interface CandidatePage {
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
async function candidatePage(
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
    };
  });
  const forward = paging === "forward";
  return {
    txs,
    cursor: (forward ? conn?.pageInfo?.endCursor : conn?.pageInfo?.startCursor) ?? null,
    more: (forward ? conn?.pageInfo?.hasNextPage : conn?.pageInfo?.hasPreviousPage) === true,
  };
}

type ForwardStep =
  | { digest: string; via: "sent" | "released-from-object"; spent: bigint }
  | { digest: null; reason: string };

/**
 * The next transaction that moves the tracked coin out of `address`.
 *
 * Forward tracing filters on **sentAddress**, not `affectedAddress`. "The next
 * transaction affecting R" includes someone paying R, and following that
 * attributed a third party's transaction to the subject. Within R's own
 * transactions, the first one that SPENDS the tracked coin (gas removed) is
 * the continuation; the first one of any kind is not, and following it
 * reported an unrelated token transfer as the traced SUI.
 *
 * An object cannot send. When R has sent nothing since the hop, the funds may
 * be held by an object (a `Receiving<T>` transfer to an object's id, an
 * object's address balance), and the transaction that takes them out is sent
 * by someone else. That case is found through `affectedAddress`, as the first
 * later transaction in which R's balance of the coin goes down.
 *
 * `afterCheckpoint` is **exclusive** — verified against mainnet: passing a
 * transaction's own checkpoint excludes it, passing `cp - 1` includes it.
 * Same-checkpoint forwarding is what a script does, so the window starts at
 * `cp - 1` and the current digest and anything before it in the page are
 * dropped.
 */
async function findNextForward(
  address: string,
  atCheckpoint: number | undefined,
  coin: string | null,
  visited: ReadonlySet<string>,
  current: string,
): Promise<ForwardStep> {
  const afterCheckpoint = atCheckpoint === undefined ? undefined : atCheckpoint - 1;
  const coinName = coin ? displayCoin(coin).symbol : "the funds";

  let sent = 0;
  let after: string | null = null;
  let exhausted = false;
  for (let page = 0; page < SENT_PAGES; page++) {
    const { txs, cursor, more } = await candidatePage(SENT_AFTER, {
      address,
      first: CANDIDATE_PAGE,
      after,
      afterCheckpoint,
    }, "forward");
    sent += txs.filter((t) => t.digest !== current).length;
    const hit = firstSpend(txs, address, coin, visited, current);
    if (hit) return { digest: hit.tx.digest, via: "sent", spent: hit.spent };
    if (!more || !cursor) {
      exhausted = true;
      break;
    }
    after = cursor;
  }
  if (sent > 0) {
    return {
      digest: null,
      reason: exhausted
        ? `${address} has sent ${sent} transaction(s) since receiving the funds and none of them moved ${coinName}, so it has not spent them yet.`
        : `${address} sent ${sent} transactions after receiving the funds and none of them moved ${coinName}. The search stopped at that limit, so the funds may have moved in a later transaction: restart from ${address}'s later activity.`,
    };
  }

  let seen = 0;
  after = null;
  exhausted = false;
  for (let page = 0; page < AFFECTED_PAGES; page++) {
    const { txs, cursor, more } = await candidatePage(AFFECTED_AFTER, {
      address,
      first: CANDIDATE_PAGE,
      after,
      afterCheckpoint,
    }, "forward");
    seen += txs.filter((t) => t.digest !== current).length;
    const hit = firstSpend(txs, address, coin, visited, current);
    if (hit) return { digest: hit.tx.digest, via: "released-from-object", spent: hit.spent };
    if (!more || !cursor) {
      exhausted = true;
      break;
    }
    after = cursor;
  }
  return {
    digest: null,
    reason: exhausted
      ? `${address} has not sent a transaction since receiving the funds, and ${seen === 0 ? "no later transaction has touched it" : `none of the ${seen} later transaction(s) touching it took ${coinName} out`}. The funds are still there: a wallet that has not spent yet, or an object still holding them.`
      : `${address} has not sent a transaction since receiving the funds, and none of the first ${seen} later transactions touching it took ${coinName} out. The search stopped at that limit, so the funds may have left later.`,
  };
}

type BackwardStep =
  | {
      digest: string;
      received: bigint;
      /** Earlier inflows needed to cover the outflow, not followed. */
      others: UnfollowedRecipient[];
      /** The inflows found cover less than the outflow being explained. */
      shortfall: boolean;
    }
  | { digest: null; reason: string };

/**
 * The most recent inflow of the tracked coin to `address` before the hop.
 *
 * Walks `affectedAddress` newest to oldest and takes the first transaction in
 * which `address` gained the coin (gas removed). When that inflow is smaller
 * than what `address` paid out, older inflows are collected until they cover
 * it, and reported as unfollowed sources: the outflow was funded by several
 * of them, and the trace follows only the latest.
 */
async function findPriorInflow(
  address: string,
  atCheckpoint: number | undefined,
  coin: string | null,
  visited: ReadonlySet<string>,
  current: string,
  need: bigint,
): Promise<BackwardStep> {
  const beforeCheckpoint = atCheckpoint === undefined ? undefined : atCheckpoint + 1;
  const coinName = coin ? displayCoin(coin).symbol : "value";
  const found: Array<{ tx: CandidateTx; received: bigint }> = [];
  let covered = 0n;
  let before: string | null = null;
  let scanned = 0;
  let exhausted = false;

  for (let page = 0; page < AFFECTED_PAGES && covered < need; page++) {
    const { txs, cursor, more } = await candidatePage(AFFECTED_BEFORE, {
      address,
      last: CANDIDATE_PAGE,
      before,
      beforeCheckpoint,
    }, "backward");
    scanned += txs.length;
    for (const inflow of inflowsNewestFirst(txs, address, coin, visited, page === 0 ? current : undefined)) {
      found.push(inflow);
      covered += inflow.received;
      if (covered >= need) break;
    }
    if (!more || !cursor) {
      exhausted = true;
      break;
    }
    before = cursor;
  }

  if (found.length === 0) {
    return {
      digest: null,
      reason: exhausted
        ? `No earlier transaction paid ${coinName} into ${address}. Where it got these funds is not visible as an inflow: a mint, a withdrawal from a protocol it sent itself, or a transfer older than the history this server can read.`
        : `None of the ${scanned} transactions before this one that touch ${address} paid ${coinName} into it. The search stopped at that limit; the funding is older.`,
    };
  }
  const [followed, ...rest] = found;
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
    shortfall: covered < need,
  };
}

/**
 * Transactions sampled to decide whether a backward source is a hub.
 *
 * A hub's earlier inflows are other parties' deposits: walking past an
 * exchange-scale wallet named mainnet-launch-era strangers as the source of a
 * 2025 payment. `measureFanout` classifies at 100 distinct counterparties, and
 * 200 recent transactions is four requests.
 */
const HUB_SCAN_TRANSACTIONS = 200;

/** Calls that put value into a protocol object and leave the caller a claim. */
const DEPOSIT_CALL = /^(entry_|public_|request_add_)?(deposit|supply|stake|lock|add_liquidity|lend|provide|mint|open_position|place_order)/;

/** A package's protocol name, or a short `0x…::module` when nothing names it. */
function callTarget(c: { packageId: string; module: string }): string {
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
function forwardDeadEnd(
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
function backwardDeadEnd(tx: FetchedTx, recipient: string | null, coin: string | null): string {
  const coinName = coin ? displayCoin(coin).symbol : "value";
  const called = [...new Set(tx.callSites.map(callTarget))];
  return (
    `No address paid the ${coinName} in on this hop${recipient ? ` to ${recipient}` : ""}: it came out of ` +
    `${called.length ? called.join(", ") : "no identifiable call"} (a withdrawal, claim, mint, unstake, or an exploit of a pool). ` +
    "A protocol's shared objects hold many parties' funds, so there is no single earlier source to follow."
  );
}

function shortCoinType(coinType: string): string {
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
}

/**
 * Signed human amount with its symbol, marked when nothing vouches for the coin.
 *
 * Scale comes from {@link coinScale}, which resolves by coin TYPE. This used to
 * carry its own symbol-keyed decimals map — a third copy of the same table —
 * which meant any coin whose struct name was `SUI` was rendered with real SUI's
 * 9 decimals. Measured on mainnet, 47 of 289 imitators declare a different
 * scale, one of them 10^9 out.
 */
function formatAmount(amount: string, coinType: string): string {
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

function addrLabel(addr: string, nameMap: Map<string, string>): string {
  return nameMap.get(addr) ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * At least 0.001 of a whole unit of the coin, on the coin's own scale.
 *
 * A raw threshold of 1e6 hid every USDC flow under 1 USDC as "gas only",
 * because USDC has 6 decimals where SUI has 9.
 */
function isSignificant(amount: string, coinType: string): boolean {
  const v = BigInt(amount);
  const abs = v < 0n ? -v : v;
  return abs * 1000n >= 10n ** BigInt(coinScale(coinType).decimals);
}

function formatTimeSpan(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "< 1 minute";
  if (min < 60) return `${min} minute${min !== 1 ? "s" : ""}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr !== 1 ? "s" : ""}`;
  const days = Math.round(hr / 24);
  return `${days} day${days !== 1 ? "s" : ""}`;
}

function buildSummary(
  hops: HopResult[],
  direction: string,
  nameMap: Map<string, string>,
): string {
  if (hops.length === 0) return "No hops traced.";

  const lines: string[] = [];
  const first = hops[0];
  const last = hops[hops.length - 1];

  // Header
  lines.push(`FUND TRACE — ${direction.toUpperCase()}`);
  lines.push(`Starting tx: ${first.digest}`);

  // Time range
  if (first.timestamp && last.timestamp && hops.length > 1) {
    const diffMs = Math.abs(new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime());
    lines.push(`Time span: ${formatTimeSpan(diffMs)} across ${hops.length} hops`);
  } else {
    lines.push(`Hops: ${hops.length}`);
  }

  // Protocols
  const allProtocols = new Set<string>();
  for (const hop of hops) for (const p of hop.protocols) allProtocols.add(p);
  if (allProtocols.size > 0) {
    lines.push(`Protocols: ${[...allProtocols].join(", ")}`);
  }

  lines.push("");

  // Per-hop breakdown
  for (const hop of hops) {
    const sender = hop.sender ? addrLabel(hop.sender, nameMap) : "unknown";
    const ts = hop.timestamp ? new Date(hop.timestamp).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "";

    lines.push(`--- Hop ${hop.hop} ${ts ? `(${ts})` : ""} ---`);
    lines.push(`Tx:     ${hop.digest}`);
    lines.push(`Sender: ${sender}`);

    if (hop.actions.length > 0) {
      lines.push(`Action: ${hop.actions.join(", ")}`);
    }

    // Balance changes — separate significant from gas
    const significant: typeof hop.balance_changes = [];
    const gasOnly: typeof hop.balance_changes = [];
    for (const bc of hop.balance_changes) {
      if (isSignificant(bc.amount, bc.coin_type)) {
        significant.push(bc);
      } else {
        gasOnly.push(bc);
      }
    }

    if (significant.length > 0) {
      lines.push("Flows:");
      for (const bc of significant) {
        const who = addrLabel(bc.address, nameMap);
        lines.push(`  ${who}: ${formatAmount(bc.amount, bc.coin_type)}`);
      }
    }

    // "gas only" has meant two different things: no value moved, and value
    // moved as an object where a balance change cannot see it. On a hop that
    // handed over a capability, the second reading is the finding and the
    // first is false.
    const objectsHere = hop.object_transfers ?? [];
    if (gasOnly.length > 0 && significant.length === 0 && objectsHere.length === 0) {
      lines.push(hop.object_flow_unavailable ? "Flows:  no coin moved" : "Flows:  gas only");
    }

    if (objectsHere.length > 0) {
      lines.push("Objects:");
      for (const m of objectsHere) {
        const mark = m.high_consequence && !m.renounced ? " ⚠" : "";
        const who = (ref: typeof m.from) => {
          if (!ref) return "?";
          if (ref.kind === "address") return addrLabel(ref.address ?? "?", nameMap);
          if (ref.kind === "object") return `kiosk/object ${String(ref.address ?? "?").slice(0, 10)}…`;
          return ref.kind;
        };
        const label = m.protocol ? `${m.type_short} (${m.protocol})` : (m.type_short ?? "unknown type");
        const arrow = m.kind === "appeared" ? "(previous holder not recorded) ->" : "->";
        lines.push(`  ${label}${mark}  ${m.kind === "appeared" ? "" : who(m.from) + " "}${arrow} ${who(m.to)}`);
        if (m.note) lines.push(`    ${m.note}`);
      }
    }

    if (hop.object_changes_truncated) lines.push(`  ⚠ ${hop.object_changes_truncated}`);
    if (hop.object_flow_unavailable) lines.push(`  (${hop.object_flow_unavailable})`);
    if (hop.balance_changes_truncated) lines.push("  ⚠ More balance changes exist than could be read; the flows above are incomplete.");
    if (hop.signer_is_sender === false) {
      lines.push(`  ⚠ Not signed by the sender: authorized by ${hop.authorized_by?.join(", ")}.`);
    }
    if (hop.commingled) lines.push(`  ⚠ ${hop.commingled.note}`);
    if (hop.note) lines.push(`Note:   ${hop.note}`);

    lines.push("");
  }

  // End-state summary
  const lastHop = hops[hops.length - 1];
  const allCoinsTraced = new Set<string>();
  for (const hop of hops) {
    for (const bc of hop.balance_changes) {
      if (isSignificant(bc.amount, bc.coin_type)) allCoinsTraced.add(shortCoinType(bc.coin_type));
    }
  }
  if (allCoinsTraced.size > 0) {
    lines.push(`Coins involved: ${[...allCoinsTraced].join(", ")}`);
  }
  if (lastHop.actions.length > 0) {
    lines.push(`Final action: ${lastHop.actions.join(", ")}`);
  }

  return lines.join("\n");
}

export function registerTraceTools(server: McpServer) {
  server.tool(
    "trace_funds",
    "(Advanced — multi-hop) Trace fund flow from a transaction. Forward follows the tracked coin to whoever received it and then to that address's next transaction that moves it; backward follows whoever paid the coin in, then that address's most recent earlier inflow of it. Swap-aware (follows value across DEX swaps instead of losing it in the pool), follows the actor through an exploit or withdrawal that credits only itself, follows value out of objects that received it, stops at known sinks (exchanges, bridges, mixers, malicious wallets — see manage_labels), at bridge exits, and backward at high-fanout hubs, and always says why it stopped in `stop_reason`. Values each hop in USD at block time (see `usd` for the price source). Returns protocol-decoded actions and a human-readable summary. Makes sequential API calls per hop (up to 10).",
    {
      digest: z.string().describe("Starting transaction digest (Base58)"),
      direction: z
        .enum(["forward", "backward"])
        .describe("Direction to trace: 'forward' follows recipients, 'backward' follows sender"),
      hops: numArg()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Max hops to follow (default 3, max 10)"),
      coin_type: z
        .string()
        .optional()
        .describe("Start by following this coin type, and restrict the DISPLAYED balance changes to it (e.g. 0x2::sui::SUI; the short and padded forms match). The trace still follows value across swaps regardless. If omitted, all of each hop's balance changes are shown and the first hop picks the largest flow."),
    },
    async ({ digest, direction, hops, coin_type }) => {
      const maxHops = Math.min(hops ?? 3, 10);
      // Compared and echoed in canonical form. GraphQL reports the padded type,
      // so `0x2::sui::SUI` compared as a raw string matched nothing and every
      // hop rendered empty.
      const coinFilter = coin_type ? coinKey(coin_type) : null;
      const traceHops: HopResult[] = [];
      /** Full movement lists per hop — internal, never serialised. */
      const movementsByHop = new Map<number, ObjectMovement[]>();
      let currentDigest: string | null = digest;
      // Why the trace ended. Every exit from the loop sets it: a trace that
      // just ends reads as "the money stopped here", which is the wrong
      // conclusion for most of the ways a trace can end.
      let terminationReason: string | null = null;
      // Bridge exits seen anywhere in the trace, keyed by digest.
      //
      // Detected from the hop's Move calls and events rather than from a sink
      // label. A bridge does not transfer value to an identifiable wallet — it
      // burns or locks the coin and emits a message — so there is usually no
      // recipient address to label, and `isSink` never fires.
      const bridgeExits: Array<{ digest: string; hits: BridgeHit[] }> = [];
      // Who the next hop's transaction must have been sent by, for the chain to
      // still be about the same funds. Null on the first hop, which has no
      // predecessor to disagree with, and on a hop that released funds from an
      // object, which someone else necessarily sent.
      let expectedSender: string | null = null;
      // Forward: whose funds the current hop moves. The sender, except on a
      // hop that took value out of an object.
      let holder: string | null = null;
      let reachedVia: HopResult["reached_via"];
      // Backward: the address whose inflow the current hop explains.
      let recipient: string | null = null;
      // Forward: what the followed address received on the previous hop, so a
      // larger outflow can be flagged as mixed with other funds.
      let delivered: { address: string; coin: string; amount: bigint } | null = null;
      // Hops the fullnode had pruned. Worth reporting: it tells a reader the
      // trace reached back past the fullnode's retention, which is usually the
      // interesting part of an old case.
      let archiveHops = 0;
      // Hops served from the local transaction cache. Reported so a fast trace
      // is legible as reuse rather than as a different chain read.
      let cacheHops = 0;
      // Addresses already followed. A↔B ping-pong is a common obfuscation
      // pattern, and it passes the custody check on every hop — without this
      // the trace fills maxHops with a two-wallet loop and presents it as a
      // ten-hop chain.
      const visitedAddresses = new Set<string>();
      // Digests already read, so a same-checkpoint window cannot hand one back.
      const visitedDigests = new Set<string>();
      let custodyBreak: Record<string, unknown> | null = null;
      // The coin we're following. May change mid-trace after a swap (A→B).
      let trackedCoin: string | null = coinFilter;

      // A pool/protocol address is a pass-through, not a real destination —
      // funds routed through a DEX belong to the actor, not the pool.
      const isPassThrough = (addr: string): boolean => {
        // Curated lookup only, deliberately. Treating an address as a
        // pass-through makes the trace walk through it, so widening this with
        // runtime-resolved MVR names would let anyone who registers a name
        // change where a fund trace stops.
        if (lookupProtocol(addr)) return true;
        const cat = getLabel(addr)?.category;
        return cat === "protocol" || cat === "defi";
      };

      for (let hop = 0; hop < maxHops && currentDigest; hop++) {
        let tx: FetchedTx | null;
        try {
          tx = await fetchTx(currentDigest);
        } catch (err) {
          // A transport failure is not an empty trace. On the first hop there
          // is nothing to report, so say why; later, keep what was found and
          // mark it incomplete.
          if (hop === 0) return errorResult((err as Error).message);
          terminationReason = `${(err as Error).message} The trace is incomplete rather than finished.`;
          break;
        }
        if (!tx) {
          // Not found on the fullnode *or* the archive. Breaking silently here
          // produced `hop_count: 0, hops: []` with no error, which a reader
          // takes as "there is nothing to follow" rather than "this could not
          // be fetched" — and on hop 0 those are opposite conclusions.
          if (hop === 0) {
            return errorResult(
              `Could not fetch the starting transaction ${currentDigest} from the fullnode or the archive. ` +
                "Check the digest and the network. This is not evidence that no funds moved.",
            );
          }
          terminationReason =
            `Could not fetch the next transaction (${currentDigest}) from the fullnode or the archive. ` +
            "The trace is incomplete rather than finished — value may have moved beyond this point.";
          break;
        }
        if (tx.source === "archive") archiveHops++;
        if (tx.source === "cache") cacheHops++;
        visitedDigests.add(currentDigest);

        const sender = tx.sender;
        const allChanges = tx.balanceChanges;
        // What we DISPLAY for the hop. Filter only by the caller's explicit
        // coin_type (a constant), NOT the mutable `trackedCoin`: when the trace
        // auto-switches assets across a swap, the hop's real flows must still be
        // shown. Next-hop selection still sees allChanges.
        const displayChanges = coinFilter
          ? allChanges.filter((c) => sameCoin(c.coin_type, coinFilter))
          : allChanges;

        const checkpointNum = tx.checkpoint ?? undefined;
        const gas: GasCharge = { payer: tx.gasPayer ?? null, net: tx.netGas == null ? null : BigInt(tx.netGas) };

        // Decode protocol actions
        const commands = tx.commands;
        const grpcBc = tx.grpcBalanceChanges;
        // Per-hop rather than batched: hops are discovered one at a time, so
        // there is no earlier point at which the package set is known.
        await prefetchProtocolNames(collectPackageIds(commands));
        const decoded = decodeTransaction(commands, grpcBc, sender ?? undefined);

        // Detect a bridge exit from this hop's Move calls and events. Runs
        // after the prefetch so the registry tier can see lineage-resolved
        // packages — an upgraded bridge still identifies. Events catch a
        // bridge reached through a wrapper package, whose own call carries no
        // marker.
        const hits = detectBridges(tx.callSites, tx.eventTypes ?? []);
        if (hits.length) bridgeExits.push({ digest: currentDigest, hits });

        // Chain of custody. The next transaction was found among those the
        // followed address SENT, so a different sender means the search
        // returned something it should not have, and the trace would
        // attribute a stranger's flows to the subject.
        // Forward only. Backward tracing deliberately walks to the transaction
        // that FUNDED the address, which by definition someone else sent — so
        // requiring the sender to match would fire on every backward hop.
        if (direction === "forward" && expectedSender && sender && sender !== expectedSender) {
          custodyBreak = {
            at_hop: hop + 1,
            digest: currentDigest,
            expected_sender: expectedSender,
            actual_sender: sender,
            meaning:
              "The next transaction on this address was not sent by it. That happens when the trace " +
              "followed a shared contract (a pool or protocol), whose subsequent activity belongs to " +
              "other users. Stopping here rather than attributing their flows to the subject.",
          };
          terminationReason =
            "Chain of custody broken — the following transaction was sent by a different address. " +
            "Stopping trace.";
          break;
        }

        // `?? []`: a row cached by an earlier build lacks the field.
        const signers = assignSignerRoles(sender, tx.gasPayer, tx.signatures ?? []);

        const hopResult: HopResult = {
          hop: hop + 1,
          digest: currentDigest,
          sender,
          balance_changes: displayChanges,
          timestamp: tx.timestamp,
          checkpoint: tx.checkpoint?.toString() ?? null,
          protocols: decoded.protocols,
          actions: decoded.actions,
          token_flow: decoded.token_flow,
          ...(reachedVia ? { reached_via: reachedVia } : {}),
          ...(signers.signer_is_sender === false
            ? { signer_is_sender: false as const, authorized_by: signers.authorized_by }
            : {}),
          ...(tx.balanceChangesTruncated ? { balance_changes_truncated: true as const } : {}),
          ...(tx.commandsTruncated ? { commands_truncated: true as const } : {}),
          ...(tx.eventsIncomplete ? { events_incomplete: true as const } : {}),
        };

        // Spending more than the trace delivered means other funds are mixed
        // in, so amounts from here on are not all the traced funds.
        if (direction === "forward" && delivered && holder === delivered.address) {
          const spent = -allChanges
            .filter((c) => c.address === holder && sameCoin(c.coin_type, delivered!.coin))
            .reduce((sum, c) => sum + nonGasAmount(c, gas), 0n);
          // More than 1% over, so a gas rebate or rounding dust is not flagged.
          if (spent * 100n > delivered.amount * 101n) {
            hopResult.commingled = {
              received: delivered.amount.toString(),
              spent: spent.toString(),
              coin_type: delivered.coin,
              note:
                // formatAmount signs its output; these are magnitudes.
                `${holder} spent ${formatAmount(spent.toString(), delivered.coin).slice(1)} here, more than the ` +
                `${formatAmount(delivered.amount.toString(), delivered.coin).slice(1)} the previous hop delivered, so funds it ` +
                "already held or received elsewhere are mixed in. Amounts from here on are not all the traced funds.",
            };
          }
        }

        // Object flow. Both live transports report it, so `undefined` now means
        // exactly one thing: a row cached before this field existed. Saying
        // "the archive cannot see objects" for a cache hit was wrong twice
        // over — the source is known two lines above, and the archive can.
        if (tx.objectMovements === undefined) {
          hopResult.object_flow_unavailable =
            tx.source === "cache"
              ? "This hop came from the local store, cached before object flow was recorded. " +
                "Re-run with the store disabled (unset SUI_STORE_PATH) to read it — this is not a statement that no objects moved."
              : "Object changes were not reported for this hop. That is not a statement that none happened.";
        } else {
          // Kept out of the hop payload on purpose: creations, deletions and
          // wraps are needed to COUNT movements and to collect counterparties,
          // but serialising them costs tokens for output nobody reads. A
          // 13-movement kiosk hop carries one transfer.
          movementsByHop.set(hopResult.hop, tx.objectMovements);
          const moved = custodyChanges(tx.objectMovements);
          if (moved.length > 0) hopResult.object_transfers = moved;
          if (tx.objectChangesTruncated) {
            hopResult.object_changes_truncated =
              `This transaction has more object changes than were read (${OBJECT_CHANGE_PAGES} pages of 50), ` +
              "so the list above is incomplete. Changes are ordered by object id, not by importance.";
          }
        }

        traceHops.push(hopResult);

        // A bridge exit ends the on-chain trace. The coin was burned or locked,
        // so there is no recipient to follow, and the value's next move is on
        // another chain: resolve_bridge_transfer is how it is followed.
        // Forward only. A bridge exit means value left the chain going forward;
        // a backward trace is asking where the money in this transaction came
        // FROM, which the exit says nothing about. Terminating there cut a
        // four-hop funding walk to one.
        const exitHere =
          direction === "forward"
            ? bridgeExits.find((e) => e.digest === currentDigest)
            : undefined;
        if (exitHere) {
          const protocols = exitHere.hits.map((h) => h.protocol).join(", ");
          terminationReason =
            `Value left Sui via ${protocols}. Stopping: the coin was burned or locked, so nothing ` +
            "on this chain continues it. Run resolve_bridge_transfer on this transaction to pick " +
            "the transfer up on the destination chain.";
          break;
        }

        // Forward only: what happens after a transaction signed by someone
        // else is that party's decision. Following on would attribute a
        // protocol recovery or an alias's actions to the address it acted for.
        if (direction === "forward" && signers.signer_is_sender === false) {
          terminationReason =
            `Hop ${hop + 1} was sent as ${sender} but signed by ${signers.authorized_by.join(", ")}, acting for it ` +
            "through an address alias or a protocol-level substitution. Its movements are not the sender's own, " +
            "so the trace stops rather than attributing them to the sender. Follow the signer separately if its actions belong to the case.";
          break;
        }

        // Price this hop's coins before choosing, so the next-hop ranking
        // compares value rather than raw units — 1 USDC is 1e6 units and 1 SUI
        // is 1e9, so a raw comparison ranks by decimal places and can follow
        // dust over the real transfer.
        //
        // Current prices, deliberately. Ranking needs *relative* value, and
        // which of five recipients got the most does not become more correct
        // with block-time precision, while a historical lookup per hop costs
        // a request per ranking decision. Coins with no quote fall back to raw
        // magnitude, which is at least consistent within one coin.
        const hopCoins = [...new Set(allChanges.map((c) => c.coin_type))];
        const decisionPrices = await pricesForRanking(hopCoins).catch(
          () => new Map<string, { price: number }>(),
        );
        const valueUsd = (c: { amount: string; coin_type: string }) => {
          const price = decisionPrices.get(c.coin_type)?.price;
          if (price == null) return null;
          return usdValue(c.amount, decimalsForCoinType(c.coin_type), price);
        };

        // Swap-aware, pool-skipping next-hop selection.
        const actor: string | null = direction === "forward" ? (holder ?? sender) : (recipient ?? sender);
        const decision = chooseNextHop({
          sender,
          changes: allChanges,
          actions: decoded.actions,
          direction,
          trackedCoin,
          isPassThrough,
          valueUsd,
          gas,
          ...(direction === "forward" ? { holder: holder ?? sender } : { recipient }),
        });
        const coinBefore = trackedCoin;
        trackedCoin = decision.nextCoinType;
        if (decision.note) hopResult.note = decision.note;
        hopResult.basis = decision.basis;
        // Branches the trace set aside. Reported per hop so "the money went
        // here" is never read off a split that had five other recipients.
        if (decision.unfollowed.length) {
          if (direction === "forward") hopResult.unfollowed_recipients = decision.unfollowed;
          else hopResult.unfollowed_sources = decision.unfollowed;
        }
        const nextAddress = decision.nextAddress;
        if (!nextAddress) {
          terminationReason =
            direction === "forward"
              ? forwardDeadEnd(tx, actor, coinBefore, decision.consumed === true, decision.note)
              : backwardDeadEnd(tx, actor, coinBefore);
          break;
        }
        // Following the same actor across a swap or a self-credit is not a
        // cycle; value coming back to an earlier party is.
        if (nextAddress !== actor && visitedAddresses.has(nextAddress)) {
          terminationReason =
            `Cycle detected — value returned to ${nextAddress}, an address already in this trace. ` +
            "Stopping rather than reporting the same wallets again as further hops.";
          break;
        }
        visitedAddresses.add(nextAddress);

        // Stop at known sinks: once funds reach an exchange, bridge, mixer,
        // malicious wallet, or burn address, further hops are noise.
        if (isSink(nextAddress)) {
          const label = getLabel(nextAddress);
          terminationReason = `Funds reached ${label?.label ?? nextAddress} (${label?.category}) — a known sink. Stopping trace.`;
          // A bridge is the one sink that is not terminal, and a labeled one
          // may carry no curated Move-call marker at all — a relayer forward,
          // an unlisted bridge, or a plain transfer into a deposit address.
          // Detection from calls alone therefore misses exactly the case an
          // investigator created the label for, and the trace reads as "the
          // money stopped here" when it left the chain.
          if (label?.category === "bridge") {
            bridgeExits.push({
              digest: currentDigest,
              hits: [
                {
                  protocol: label.label,
                  resolution: "detect-only",
                  matched: "address-label",
                  note:
                    "Labeled as a bridge. No curated marker fired on this transaction, so the " +
                    "protocol is whatever the label says — try resolve_bridge_transfer on this " +
                    "digest, and follow the value on the destination chain if it cannot resolve it.",
                },
              ],
            });
          }
          break;
        }

        if (hop === maxHops - 1) {
          terminationReason =
            `Reached the hop limit (${maxHops}) while following ${nextAddress}. The funds may have moved ` +
            `further: raise hops, or trace again from ${direction === "forward" ? "that address's next transaction" : "this hop"}.`;
          break;
        }

        // A hub pools many parties' money. Backward, its earlier inflows are
        // strangers' deposits, so walking past it names one of them as the
        // source. Forward, its next outflow is someone's withdrawal: an
        // exchange hot wallet's next SUI payment is not the traced SUI. Not
        // asked when the trace keeps following the same actor, who is the
        // subject rather than a new party.
        if (direction === "backward" || nextAddress !== actor) {
          const fanout = await measureFanout(nextAddress, HUB_SCAN_TRANSACTIONS).catch(() => null);
          if (fanout && fanout.classification !== "narrow") {
            terminationReason =
              `${nextAddress} is a ${fanout.classification}: ${fanout.counterparty_count}${fanout.truncated ? "+" : ""} ` +
              `counterparties in its last ${fanout.scanned_transactions} transactions. ` +
              (direction === "backward"
                ? "Its earlier inflows are other parties' money, so the transaction before this one does not say where these funds came from. "
                : "Funds it receives are pooled with other parties' money, so its next outflow is not a continuation of these funds. ") +
              "Stopping here: attribute this address (manage_labels, get_address_fanout) rather than walking past it.";
            break;
          }
        }

        // How much of the tracked coin the chosen address moved on this hop.
        const movedHere: bigint = trackedCoin
          ? allChanges
              .filter((c) => c.address === nextAddress && sameCoin(c.coin_type, trackedCoin!))
              .reduce((sum, c) => sum + nonGasAmount(c, gas), 0n)
          : 0n;

        if (direction === "forward") {
          delivered = trackedCoin && movedHere > 0n ? { address: nextAddress, coin: trackedCoin, amount: movedHere } : null;
          const step = await findNextForward(nextAddress, checkpointNum, trackedCoin, visitedDigests, currentDigest);
          if (step.digest === null) {
            terminationReason = step.reason;
            break;
          }
          holder = nextAddress;
          reachedVia = step.via === "released-from-object" ? step.via : undefined;
          // Only meaningful for a transaction the followed address sent. An
          // object's funds leave in a transaction someone else sends.
          expectedSender = step.via === "sent" ? nextAddress : null;
          currentDigest = step.digest;
        } else {
          const need = movedHere < 0n ? -movedHere : 1n;
          const step = await findPriorInflow(nextAddress, checkpointNum, trackedCoin, visitedDigests, currentDigest, need);
          if (step.digest === null) {
            terminationReason = step.reason;
            break;
          }
          if (step.others.length) {
            hopResult.unfollowed_sources = [...(hopResult.unfollowed_sources ?? []), ...step.others];
          }
          if (step.shortfall || step.others.length) {
            const coin = trackedCoin ? displayCoin(trackedCoin).symbol : "value";
            const cover = step.shortfall
              ? "The inflows found before it do not cover the whole outflow either, so part of it came from further back."
              : "The older inflows that make up the rest are listed in unfollowed_sources.";
            hopResult.note = [
              hopResult.note,
              `${nextAddress}'s latest ${coin} inflow before this hop is smaller than what it paid out here. ${cover}`,
            ]
              .filter(Boolean)
              .join(" ");
          }
          recipient = nextAddress;
          currentDigest = step.digest;
        }
      }

      // Collect all unique addresses from hops
      const allAddresses = new Set<string>();
      for (const hop of traceHops) {
        if (hop.sender) allAddresses.add(hop.sender);
        for (const bc of hop.balance_changes) {
          if (bc.address) allAddresses.add(bc.address);
        }
        // Object counterparties belong here too. Whoever receives a capability
        // is as much a party to the trace as whoever receives a coin, and
        // without this they get no name, no label, no sink check and no
        // lookalike comparison — while the prose truncates their address,
        // which is precisely the attack address_poisoning exists to catch.
        for (const a of objectCounterparties(movementsByHop.get(hop.hop) ?? [])) allAddresses.add(a);
        for (const s of hop.unfollowed_sources ?? []) if (s.address) allAddresses.add(s.address);
        for (const a of hop.authorized_by ?? []) allAddresses.add(a);
      }

      // Name, label and WHAT EACH ADDRESS IS, in two batched calls. A hop that
      // is a package or a shared object is not "someone the funds went to",
      // and nothing else in a trace says so.
      const identities = await describeAddresses([...allAddresses], { expandMembers: true });
      const nameMap = new Map(
        [...identities].filter(([, v]) => v.name).map(([k, v]) => [k, v.name!]),
      );

      // Build labels from SuiNS names, protocol package IDs, and the
      // attribution registry (exchanges, bridges, malicious wallets, ...).
      const addressLabels: Record<
        string,
        {
          name?: string;
          protocol?: string;
          label?: string;
          category?: string;
          confidence?: string;
          source?: string;
          provenance?: LabelProvenance;
          is_sink?: boolean;
          kind?: string;
          object_type?: string;
          names_held?: Array<{ name: string; expired: boolean; expires_at?: string }>;
          note?: string;
        }
      > = {};
      for (const addr of allAddresses) {
        const label: (typeof addressLabels)[string] = {};
        const name = nameMap.get(addr);
        if (name) label.name = name;
        // Display-only enrichment of the address label, so an MVR name is fine.
        const proto = lookupProtocolDisplay(addr);
        if (proto) label.protocol = proto.name;
        const id = identities.get(addr);
        if (id?.names_held?.length) label.names_held = id.names_held;
        if (id && id.kind !== "wallet") {
          label.kind = id.kind;
          if (id.object_type) label.object_type = id.object_type;
          const note = identityNote(id);
          if (note) label.note = note;
        }
        const known = getLabel(addr);
        if (known) {
          label.label = known.label;
          label.category = known.category;
          label.confidence = known.confidence;
          label.source = known.source;
          const provenance = labelProvenance(known);
          if (provenance) label.provenance = provenance;
          label.is_sink = isSink(addr);
          // Prefer explicit attribution over the short-hex fallback in the
          // human summary — "Binance deposit" beats "0x1234…abcd".
          if (!name) nameMap.set(addr, known.label);
        }
        // The kind alone is worth a label: an unnamed object read as a wallet
        // is the misreading this field exists to prevent.
        if (label.name || label.protocol || label.label || label.kind) {
          addressLabels[addr] = label;
        }
      }

      // Value each hop's flows in USD at that hop's block time: Pyth for
      // verified coins when a key is set, DefiLlama otherwise. Best-effort:
      // a coin with no price gets a null usd_value and is listed in
      // `usd.unpriced` with the reason, and pricing failures never break the
      // trace.
      const hopPrices: Array<Map<string, PricePoint>> = [];
      const hopUnix: Array<number | null> = [];
      const unpricedCoins = new Map<string, string>();
      for (const hop of traceHops) {
        const coinTypes = hop.balance_changes.map((bc) => bc.coin_type);
        const unixTs = hop.timestamp ? Math.floor(new Date(hop.timestamp).getTime() / 1000) : null;
        hopUnix.push(unixTs);
        const priced = await priceUsdAtTime(coinTypes, unixTs ?? undefined);
        hopPrices.push(priced.points);
        for (const u of priced.unpriced) if (!unpricedCoins.has(u.coin_type)) unpricedCoins.set(u.coin_type, u.reason);
      }

      let anyStalePrice = false;

      // Enrich hops with names, protocol labels, formatted amounts, and USD value
      const enrichedHops = traceHops.map((hop, i) => {
        const prices = hopPrices[i];
        const blockUnix = hopUnix[i];
        const inflows: Array<{ address: string; usd: number }> = [];
        const balance_changes = hop.balance_changes.map((bc) => {
          const pp = prices.get(bc.coin_type) ?? null;
          const price = pp?.price ?? null;
          const usd = usdValue(bc.amount, pricingScale(bc.coin_type, pp).decimals, price);
          if (price != null && BigInt(bc.amount) > 0n) inflows.push({ address: bc.address, usd });
          // How far is the price we used from the actual block time?
          const ageSec = pp && blockUnix != null ? Math.abs(pp.publishTime - blockUnix) : null;
          const stale = ageSec != null && ageSec > PRICE_STALE_THRESHOLD_SEC;
          if (stale) anyStalePrice = true;
          const coin = displayCoin(bc.coin_type);
          return {
            ...bc,
            formatted: formatAmount(bc.amount, bc.coin_type),
            // Structural, not just in the formatted string: a report generated
            // from this must be able to see that the asset is unidentified
            // without parsing prose. 8,008 mainnet coins share a symbol with
            // another, so "moved 10,000 USDC" is not a claim about which USDC.
            coin_verified: coin.verified,
            ...(coin.verified ? {} : { coin_scale: coinScale(bc.coin_type).source }),
            name: nameMap.get(bc.address) ?? null,
            protocol: lookupProtocolDisplay(bc.address)?.name ?? null,
            usd_value: price != null ? Number(usd.toFixed(2)) : null,
            // Unit price actually used, where it came from and when it was
            // sampled, so the valuation is auditable.
            price_usd: price != null ? Number(price.toFixed(price < 1 ? 6 : 4)) : null,
            price_source: pp?.source ?? null,
            ...(pp?.confidence !== undefined ? { price_confidence: pp.confidence } : {}),
            priced_at: pp ? new Date(pp.publishTime * 1000).toISOString() : null,
            price_age_sec: ageSec,
            price_stale: stale || undefined,
          };
        });
        const hopUsd = dominantInflowUsd(inflows);
        return {
          ...hop,
          sender_name: hop.sender ? nameMap.get(hop.sender) ?? null : null,
          usd_total: hopUsd > 0 ? Number(hopUsd.toFixed(2)) : null,
          balance_changes,
        };
      });

      // USD headline. We do NOT sum across hops — that's the same money moving,
      // so a sum overstates impact. Report the origin and the largest hop.
      const usdTotals = enrichedHops.map((h) => h.usd_total ?? 0);
      const originUsd = usdTotals[0] ?? 0;
      const peakUsd = usdTotals.length ? Math.max(...usdTotals) : 0;

      const baseSummary = buildSummary(traceHops, direction, nameMap);
      const parts = [baseSummary];
      if (peakUsd > 0) {
        const usedSources = [
          ...new Set(enrichedHops.flatMap((h) => h.balance_changes.map((bc) => bc.price_source)).filter(Boolean)),
        ];
        const usd = [`Value (USD, at transaction time — ${usedSources.join(" + ")}):`];
        if (originUsd > 0) usd.push(`  Origin (hop 1): ${formatUsd(originUsd)}`);
        usd.push(`  Largest single-hop flow: ${formatUsd(peakUsd)}`);
        // Show the unit prices and their exact sample times, so it's visible
        // these are transaction-second prices — not a daily average.
        const shown = new Set<string>();
        for (const bc of enrichedHops[0].balance_changes) {
          if (bc.price_usd == null || shown.has(bc.coin_type)) continue;
          shown.add(bc.coin_type);
          const at = bc.priced_at ? ` (${bc.priced_at.replace("T", " ").slice(0, 19)} UTC)` : "";
          usd.push(`  ${shortCoinType(bc.coin_type)} @ $${bc.price_usd}${at}${bc.price_stale ? " ⚠stale" : ""}`);
        }
        usd.push("  (Later hops are largely the same funds moving; values are not summed.)");
        if (anyStalePrice) {
          usd.push("  ⚠ Some prices are >1h from block time (illiquid coin or a gap in the provider's history), so treat them as approximate.");
        }
        parts.push(usd.join("\n"));
      }
      if (terminationReason) parts.push(`⚠ Stopped: ${terminationReason}`);
      if (custodyBreak) {
        parts.push(
          `⚠ Chain of custody broke at hop ${custodyBreak.at_hop}: expected a transaction from ` +
            `${custodyBreak.expected_sender}, found one sent by ${custodyBreak.actual_sender}. ` +
            `Hops beyond this point were not followed.`,
        );
      }
      if (bridgeExits.length) {
        // Said in the summary as well as the structured payload: a trace that
        // just ends reads as "the money stopped here", which is the wrong
        // conclusion when it actually left the chain.
        const lines = ["🌉 Value left Sui in this trace:"];
        for (const exit of bridgeExits) {
          for (const hit of exit.hits) {
            lines.push(`  ${exit.digest} — ${hit.protocol}: ${hit.note}`);
          }
        }
        parts.push(lines.join("\n"));
      }
      // Address poisoning across the whole trace, not per hop.
      //
      // A trace is where this matters most and where a per-page check cannot
      // reach: the lookalike and the address it imitates are usually several
      // hops apart, so only the accumulated set of everyone the trace touched
      // puts them side by side. The comparison covers senders, everyone who
      // took a balance change, and the recipients the trace chose NOT to
      // follow — an unfollowed branch that imitates a followed one is exactly
      // the branch an investigator would otherwise pick by eye.
      const ledger = new ActivityLedger();
      for (const hop of enrichedHops) {
        const appearances: Appearance[] = hop.sender ? [{ address: hop.sender }] : [];
        for (const bc of hop.balance_changes) {
          let amount = 0n;
          try {
            amount = BigInt(bc.amount);
          } catch {
            // A non-numeric amount only costs this address its received total,
            // never its presence in the comparison.
          }
          appearances.push({ address: bc.address, amount });
        }
        for (const r of hop.unfollowed_recipients ?? []) appearances.push({ address: r.address });
        for (const r of hop.unfollowed_sources ?? []) appearances.push({ address: r.address });
        for (const a of objectCounterparties(movementsByHop.get(hop.hop) ?? [])) {
          appearances.push({ address: a });
        }
        ledger.observe(appearances);
      }
      const poisoning = lookalikeReport(ledger.addresses(), ledger.activity);

      // Object flow across the whole trace. Gathered here rather than per hop
      // because a capability handed over on hop 1 and exercised on hop 4 is
      // one story, and the hop-level lists cannot say that.
      const allMovements = [...movementsByHop.values()].flat();
      const objectFlow = summarizeObjectFlow(allMovements, {
        truncated: enrichedHops.some((h) => h.object_changes_truncated),
      });
      if (objectFlow && objectFlow.capability_transfers.length > 0) {
        // In the prose as well as the payload, for the same reason bridge
        // exits are: a trace whose coin amounts are all zero reads as "nothing
        // happened", which is the wrong conclusion when authority moved.
        const lines = ["⚠ Control of something changed hands in this trace:"];
        for (const m of objectFlow.capability_transfers) {
          lines.push(
            `  ${m.type_short} — ${addrLabel(m.from?.address ?? "?", nameMap)} -> ${addrLabel(m.to?.address ?? "?", nameMap)}`,
          );
          lines.push(`    object ${m.object_id}`);
          if (m.note) lines.push(`    ${m.note}`);
        }
        lines.push(
          "  This produces no balance change, so fund tracing alone would report that nothing moved.",
        );
        parts.push(lines.join("\n"));
      }
      // Renunciation is the opposite finding and must not borrow the warning.
      // Measured in upgrade-cap.ts: 27 of 30 UpgradeCap departures go to an
      // unspendable address, so treating those as handovers would make the
      // loudest output wrong most of the time.
      if (objectFlow && objectFlow.renounced_capabilities.length > 0) {
        const lines = ["Capability rights renounced in this trace:"];
        for (const m of objectFlow.renounced_capabilities) {
          lines.push(
            `  ${m.type_short} — ${addrLabel(m.from?.address ?? "?", nameMap)} -> ${m.to?.address} (unspendable)`,
          );
        }
        lines.push("  A reduction in risk, not a warning: nobody can exercise these rights again.");
        parts.push(lines.join("\n"));
      }
      if (poisoning) {
        // In the summary as well as the payload, for the same reason the bridge
        // exits are: the prose is what gets read, and a lookalike that only
        // appears in JSON is a warning nobody sees before they copy an address.
        const lines = ["⚠ Addresses in this trace close enough to be mistaken for one another:"];
        for (const pair of poisoning.pairs) {
          lines.push(`  ${pair.rendered.established}  vs  ${pair.rendered.suspect}`);
          lines.push(`    ${pair.note}`);
        }
        parts.push(lines.join("\n"));
      }

      const summary = parts.join("\n\n");

      const fullData = {
        starting_digest: digest,
        direction,
        coin_type: coinFilter ?? "all",
        hop_count: enrichedHops.length,
        // Same field name as find_funding_source. Always set: a sink, a bridge
        // exit, a dead end, a hub, a cycle, the hop limit or a read failure.
        stop_reason: terminationReason,
        ...(archiveHops ? { hops_served_by_archive: archiveHops } : {}),
        ...(cacheHops ? { hops_from_cache: cacheHops } : {}),
        ...(custodyBreak ? { custody_break: custodyBreak } : {}),
        // Structured, not just prose in the summary, so a caller can chain
        // straight into resolve_bridge_transfer without re-parsing the text.
        ...(bridgeExits.length
          ? {
              bridge_exits: bridgeExits.map((e) => ({
                digest: e.digest,
                protocols: e.hits.map((h) => ({
                  protocol: h.protocol,
                  resolution: h.resolution,
                  matched: h.matched,
                  note: h.note,
                })),
                ...(resolvableHit(e.hits)
                  ? { next_tool: "resolve_bridge_transfer" }
                  : {}),
              })),
            }
          : {}),
        usd: {
          origin: originUsd > 0 ? Number(originUsd.toFixed(2)) : null,
          peak_hop: peakUsd > 0 ? Number(peakUsd.toFixed(2)) : null,
          note: "Per-hop USD at each hop's block time, from Pyth for verified coins when PYTH_API_KEY is set and DefiLlama otherwise; not summed across hops (same funds moving). Each balance change carries price_usd, price_source, priced_at and price_age_sec.",
          ...(unpricedCoins.size
            ? { unpriced: [...unpricedCoins].map(([coin_type, reason]) => ({ coin_type, reason })) }
            : {}),
        },
        ...(poisoning ? { address_poisoning: poisoning } : {}),
        // The hop already carries these records in `object_transfers`; the
        // trace-level block repeats the digest-level view, so it names them by
        // id rather than serialising each one a second time.
        ...(objectFlow
          ? {
              object_flow: {
                movements: objectFlow.movements,
                transfer_count: objectFlow.transfers.length,
                capability_transfers: objectFlow.capability_transfers,
                renounced_capabilities: objectFlow.renounced_capabilities,
                ...(objectFlow.truncated ? { truncated: true } : {}),
                note: objectFlow.note,
              },
            }
          : {}),
        hops: enrichedHops,
        address_labels: addressLabels,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: summary,
          },
          {
            type: "text" as const,
            text: JSON.stringify(fullData, null, 2),
          },
        ],
      };
    }
  );
}
