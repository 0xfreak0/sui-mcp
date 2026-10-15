/**
 * Fund-flow graph over (address, coin) nodes, on the hop machinery
 * `trace_funds` uses: the same transaction read, the same searches for an
 * address's next spend or earlier inflow, the same stops (sinks, bridges,
 * hubs, signer substitution). Where `trace_funds` picks one branch, this
 * follows every branch and allocates the traced value between them.
 *
 * Level by level while the node limit can cover every node queued, so the
 * branches that reconverge on a wallet all reach it before it is expanded.
 * Once the queued nodes outnumber what the limit has left, the node carrying
 * the largest share of the traced value goes next, whatever its depth, so the
 * limit is spent on the heaviest branches rather than on every light branch
 * of a shallower level. Arrivals at a node still queued merge into its job;
 * one arriving after the node was expanded queues a further expansion. `find_flow_path` interleaves
 * a forward and a backward engine one node at a time. The split and
 * accounting rules are pure, in `flow-graph.ts`.
 */

import { prefetchProtocolNames } from "../protocols/registry.js";
import { collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { getNetwork } from "../config.js";
import { detectBridges, type BridgeHit } from "./bridge/detect.js";
import { LookalikeIndex } from "./address-lookalike.js";
import { readBridgeEvents, sameForeignAddress } from "./bridge/exits.js";
import { crossChainLeads, type CrossChainLead } from "./bridge/cross-chain.js";
import { isPlumbingPackage } from "./system-packages.js";
import type { ObjectMovement, OwnerRef, SharedWrite } from "./object-flow.js";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { Beneficiary } from "./bridge/beneficiary.js";
import type { SuiEventNode } from "./bridge/wormhole.js";
import { fetchEventJson } from "./event-json.js";
import { readAttackTransactions } from "./attack-read.js";
import { measureFanout, type FanoutResult } from "./fanout.js";
import { readMovedObjects, valueMovedObjects, valueTransactionObjects, type MovedObjectValue } from "./moved-value.js";
import { getLabel, inferredLabelNote, isSink } from "./labels.js";
import { assignSignerRoles } from "./multisig.js";
import { prefetchCoinScale, priceUsdAtTime, pricingScale, usdValue, type PricePoint } from "./valuation.js";
import { availabilityKey, coinKey, type CandidateTx, type GasCharge, type HopChange, type RemainingEntry } from "./trace-hop.js";
import {
  backwardDeadEnd,
  callTarget,
  fetchTx,
  forwardDeadEnd,
  HUB_SCAN_TRANSACTIONS,
  isPassThroughAddress,
  MOVES_PER_NODE,
  noInflowReason,
  noSpendReason,
  scanForwardSpends,
 scanObjectTouches,
  scanPriorInflows,
  stopsAsHub,
  type FetchedTx,
  type SearchWindow,
} from "./trace-read.js";
import {
  allocateFifo,
  coinsMoved,
  movedOnChain,
 objectNodeId,
 objectOriginWeights,
  nodeId,
  shortestPath,
  ratio,
  scaleAmount,
  splitInflow,
  splitOrigin,
  splitOriginBackward,
  splitSpend,
  TerminalLedger,
  type Branch,
  type FlowBasis,
  type PathStep,
  type Split,
  type StopCode,
  type ValueUsd,
} from "./flow-graph.js";

/**
 * MOVES_PER_NODE for an address the caller started from. It has no traced amount to
 * cover, so every move in the window counts, and an attacker's wallet makes
 * hundreds of them.
 */
export const MOVES_PER_START_ADDRESS = 100;
/** Expansions of one node: a wallet that receives the traced coin several times is expanded once per arrival. */
const EXPANSIONS_PER_NODE = 4;

/**
 * Whether `holder` can have a claim on value it put into a transaction: it
 * was left owning a non-coin object the transaction created, transferred or
 * wrote in place (a receipt, or an existing position). False only when the
 * object changes were read in full, it owns none, and no dynamic field was
 * written, since a table keyed by address can hold its account unseen.
 * Undefined otherwise.
 */
function receivedClaim(tx: FetchedTx, holder: string): boolean | undefined {
  const w = tx.written;
  if (!w) return undefined;
  if (w.owners.includes(holder)) return true;
  return tx.objectChangesTruncated || w.ledger ? undefined : false;
}

/** Transactions per graph whose events are read for cross-chain leads when they consume traced value. */
const LEAD_READS = 20;

export interface EngineOptions {
  direction: "forward" | "backward";
  coin: string | null;
  maxDepth: number;
  maxNodes: number;
  minShare: number;
  minUsd: number | null;
  window: SearchWindow;
  /** Transactions read in full, across the whole graph. */
  maxTxReads: number;
  /** Stop at this Sui address, or at a bridge exit paying this foreign address. */
  target?: { sui?: string; foreign?: string };
}

export type NodeKind = "origin_tx" | "address" | "bridge_exit" | "consumed" | "retained" | "source";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  address: string | null;
  coin_type: string | null;
 /** Set on an object lineage instead of a coin lineage. */
 object_id?: string;
 object_type?: string;
 object_tier?: MovedObjectValue["tier"];
 object_estimate?: boolean;
  depth: number;
  /** Fraction of the traced value that reached this node. */
  share: number;
  /** Traced amount that reached it, in `coin_type`. Summed across arrivals. */
  traced: bigint;
  /** USD of `traced`, at each arrival's time. Null when unpriced. */
  usd: number | null;
  /** Checkpoint of the earliest arrival (forward) or payment (backward). */
  arrivedAt: number | null;
  expanded: boolean;
  /** Set when the node itself ends the walk (a sink, hub, protocol, target). */
  stop?: { code: StopCode; detail: string };
  /** Bridge exit or entry: the protocols that matched, and the far-side accounts. */
  protocols?: string[];
  beneficiaries?: Beneficiary[];
  beneficiaries_unavailable?: string;
  /** Consumed or source: the calls the value went into or came out of. */
  detail?: string;
  /**
   * Consumed or retained: events of the transactions that took the value shaped like
   * a cross-chain message from a bridge with no curated marker. Heuristic.
   */
  cross_chain_leads?: Array<CrossChainLead & { digest: string }>;
  /** Retained: the shared objects the transaction wrote, where the kept value sits. */
  shared_objects?: SharedWrite[];
  /** Held by the node when the walk ended, in `coin_type`. */
  unspent?: bigint;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
 /** One transferred object, rather than an amount of a coin. */
 object_id?: string;
 object_type?: string;
 object_tier?: MovedObjectValue["tier"];
 object_estimate?: boolean;
  coin_type: string;
  /** What moved on chain, summed over `digests`. */
  amount: bigint;
  /** The traced part of `amount`. Less than it when other funds were mixed in. */
  traced: bigint;
  share: number;
  usd: number | null;
  basis: FlowBasis;
  digests: string[];
  first_checkpoint: number | null;
  first_time: string | null;
}

interface Job {
  node: string;
  share: number;
 object_id?: string;
  /** Traced amount to account for; null means every move counts (an address start). */
  need: bigint | null;
  arrival: { digest?: string; checkpoint?: number };
  depth: number;
  /** The address the value came from (forward) or went to (backward). */
  from: string | null;
  /** The node that queued this job, for cycle checks. */
  via: string | null;
}

export interface PrunedBranch {
  address: string;
  coin_type: string;
 /** Set when the pruned branch is an object rather than a coin. */
 object_id?: string;
 object_type?: string;
  share: number;
  usd: number | null;
  digest: string;
  /** Raw amount that would have moved, in `coin_type`. */
  traced: bigint;
}

/** Price points per hour, so a burst of transactions costs one lookup per coin. */
const PRICE_BUCKET_MS = 3_600_000;

export class FlowEngine {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  readonly ledger = new TerminalLedger();
  /** The edge that first reached each node and the node it came from, for paths. */
  readonly parentOf = new Map<string, { edge: string; from: string }>();
  readonly pruned: PrunedBranch[] = [];
  readonly roots: string[] = [];
  readonly notes: string[] = [];
  /** Why the graph is partial where no terminal carries the missing share: a start node that did not read every move. */
  readonly partial: string[] = [];
  /** Shares left unexpanded because the node limit was reached, by node. */
  readonly nodeLimited: Array<{ node: string; share: number }> = [];
  txReads = 0;
  archiveReads = 0;
  expandedNodes = 0;
  depthReached = 0;
  /** Nodes left in the frontier or refused for a limit, so a caller can say the graph is partial. */
  truncated = false;
  readonly unpriced = new Map<string, string>();
  /** The address an address start began at, whose own moves the start node counts. */
  private startAddress: string | null = null;
  /** The coin-null start node's search read every move of its address in the window. */
  private startReadAll = false;
  /** The start node's search, of any coin, stopped before reading every move in the window. */
  private startCapped = false;

  /** Queued jobs by node id, in the order they were first queued. */
  private frontier = new Map<string, Job>();
  private readonly txCache = new Map<string, Promise<FetchedTx | null>>();
  private readonly decoded = new Map<string, string[]>();
 private readonly objects = new Map<string, Promise<ObjectRead>>();
 readonly unvaluedObjects: Array<{ digest: string; object_id: string; type: string | null; reason: string }> = [];
 private readonly unvaluedSeen = new Set<string>();
  /** Every address any branch has named, bucketed for the lookalike check. */
  private readonly seenAddresses = new LookalikeIndex();
  private readonly allocated = new Map<string, Map<string, RemainingEntry>>();
  private readonly expansions = new Map<string, number>();
  private readonly hubChecked = new Map<string, FanoutResult | Error>();
  private readonly prices = new Map<number, { at: number | undefined; points: Map<string, PricePoint> }>();
  /** Price requests in flight, by `${bucket}|${coin}`. */
  private readonly priceRequests = new Map<string, Promise<void>>();
  private readonly eventCache = new Map<string, Promise<SuiEventNode[] | null>>();
  /** Digests whose events were read for cross-chain leads; see {@link leadsOf}. */
  private readonly leadDigests = new Set<string>();
  /** `${exit node}|${digest}` pairs whose beneficiaries are already merged into the exit. */
  private readonly mergedExits = new Set<string>();
  private readonly qualify = getNetwork() === "mainnet";

  constructor(readonly opts: EngineOptions) {}

  /* ------------------------------------------------------------------ *
   * Starts
   * ------------------------------------------------------------------ */

  /** Start from a transaction. Throws when it cannot be read: "could not look" is not "nothing moved". */
  async startFromDigest(digest: string): Promise<void> {
    const tx = await this.read(digest);
    if (!tx) {
      throw new Error(
        `Could not fetch the starting transaction ${digest} from the fullnode or the archive. ` +
          "Check the digest and the network. This is not evidence that no funds moved.",
      );
    }
    const origin = this.node(`tx:${digest}`, "origin_tx", null, null, 0);
    origin.share = 1;
    origin.arrivedAt = tx.checkpoint;
    this.roots.push(origin.id);
    const valueUsd = await this.valuer(tx);
    const gas = gasOf(tx);
    const forward = this.opts.direction === "forward";
    const split = forward
      ? splitOrigin({ changes: tx.balanceChanges, trackedCoin: this.opts.coin, gas, valueUsd })
      : splitOriginBackward({ changes: tx.balanceChanges, trackedCoin: this.opts.coin, gas, valueUsd });
  const objectRead = this.opts.coin === null ? await this.objectValues(digest, tx, true) : NO_OBJECTS;
  if (objectRead.unread.some((u) => u.what === digest)) {
   this.truncated = true;
   this.partial.push(`The object changes in ${digest} could not be read.`);
  }
  const sender = tx.sender ? normalizeSuiAddress(tx.sender) : null;
  // Forward, what an address gained: an object transferred to it, or created
  // for an address other than the sender. Backward, what an address gave up.
  const candidate = (from: string | null, to: string | null) =>
   from !== to && (forward ? to !== null && (from !== null || to !== sender) : from !== null);
  const objects = objectRead.rows.filter((r) =>
   !r.changed_in_place && !r.custody && r.usd !== null && r.usd > 0 && candidate(r.from, r.to),
  );
  const unvalued = objectRead.unvalued.filter((u) => !u.custody && candidate(u.from, u.to));
  this.noteUnvalued(unvalued);
  const weights = objectOriginWeights(
   split.branches.map((b) => ({ amount: b.amount, coin_type: b.coin_type })),
   objects,
   valueUsd,
  );

  for (let i = 0; i < split.branches.length; i++) {
   const b = split.branches[i];
      const job: Job = {
        node: nodeId(b.address, b.coin_type),
    share: weights.coins[i],
        need: b.amount,
        arrival: { digest, checkpoint: tx.checkpoint ?? undefined },
        depth: 0,
        from: tx.sender,
        via: origin.id,
      };
   if (job.share <= 0) continue;
      const usd = valueUsd({ amount: b.amount.toString(), coin_type: b.coin_type });
      this.connect(job, b.address, b.coin_type, forward ? origin.id : job.node, forward ? job.node : origin.id, {
    amount: b.amount, traced: b.amount, usd, basis: b.basis, digest, tx,
      });
    }
  for (let i = 0; i < objects.length; i++) {
   const row = objects[i];
   const holder = forward ? row.to! : row.from!;
   this.connectObject({
    node: objectNodeId(holder, row.object_id),
    object_id: row.object_id,
    share: weights.objects[i],
    need: 1n,
    arrival: { digest, checkpoint: tx.checkpoint ?? undefined },
    depth: 0,
    from: tx.sender,
    via: origin.id,
   }, holder, forward ? origin.id : objectNodeId(holder, row.object_id),
    forward ? objectNodeId(holder, row.object_id) : origin.id, row, digest, tx);
  }
  if (split.branches.length === 0 && objects.length === 0 && unvalued.length > 0) {
   this.truncated = true;
   this.ledger.add("read_failed", {
    node: origin.id, share: 1, usd: null,
    detail: `No priced coin or valued object moved in ${digest}; ${unvalued.length} object movement(s) have no established value (see unvalued_objects).`,
   });
   return;
  }
  if (split.branches.length === 0 && objects.length === 0) {
      // Credited nobody (forward) or paid by nobody (backward): the start is
      // itself a bridge exit, a deposit or burn, a mint or a withdrawal.
      // Decoding prefetches the packages' protocol names, which the
      // registry tier of bridge detection reads.
      await this.actions(digest, tx);
      const hits = detectBridges(tx.callSites, tx.eventTypes ?? []);
      if (forward && tx.sender) {
        const spend = splitSpend({ sender: tx.sender, holder: tx.sender, changes: tx.balanceChanges, trackedCoin: this.opts.coin, gas, valueUsd, bridgeExit: hits.length > 0 });
        const coin = spend.coin_type ?? "";
        const usd = valueUsd({ amount: spend.total.toString(), coin_type: coin });
        if (spend.total > 0n) {
          await this.terminalOut(origin.id, tx.sender, tx, digest, hits, 1, spend.total, spend.total, coin, usd);
        } else {
          this.notes.push(forwardDeadEnd(tx, tx.sender, this.opts.coin, false, undefined));
        }
      } else if (!forward) {
        this.ledger.add(hits.length ? "bridge_entry" : "source", {
          node: origin.id,
          share: 1,
          usd: null,
          detail: backwardDeadEnd(tx, null, this.opts.coin),
        });
      }
    }
  }

  /** Start from an address: its moves after (forward) or before (backward) the window bound. */
  startFromAddress(address: string): void {
    this.startAddress = address;
    const id = nodeId(address, this.opts.coin);
    const n = this.node(id, "address", address, this.opts.coin, 0);
    this.roots.push(n.id);
    this.frontier.set(id, { node: id, share: 1, need: null, arrival: {}, depth: 0, from: null, via: null });
    n.share = 1;
  }

  /* ------------------------------------------------------------------ *
   * Frontier
   * ------------------------------------------------------------------ */

  /**
   * Expand the next queued job: the shallowest, then the largest share, while
   * the node limit left covers every queued node not yet expanded; past that,
   * the largest share, then the shallowest. Ties go to the first queued.
   * False when nothing was left to expand.
   */
  async expandNext(): Promise<boolean> {
    let unexpanded = 0;
    for (const j of this.frontier.values()) if (!this.nodes.get(j.node)?.expanded) unexpanded++;
    const heaviest = unexpanded > this.opts.maxNodes - this.expandedNodes;
    let job: Job | undefined;
    for (const j of this.frontier.values()) {
      const better = heaviest
        ? !job || j.share > job.share || (j.share === job.share && j.depth < job.depth)
        : !job || j.depth < job.depth || (j.depth === job.depth && j.share > job.share);
      if (better) job = j;
    }
    if (!job) return false;
    this.frontier.delete(job.node);
    this.depthReached = Math.max(this.depthReached, job.depth);
    try {
   if (job.object_id) await this.expandObject(job);
   else if (this.opts.direction === "forward") await this.expandForward(job);
      else await this.expandBackward(job);
    } catch (err) {
      this.ledger.add("read_failed", {
        node: job.node,
        share: job.share,
        usd: null,
        detail: (err as Error).message,
      });
      this.truncated = true;
    }
    return true;
  }

  async run(): Promise<void> {
    while (await this.expandNext()) {
      /* heaviest first until the frontier is empty or every node hits a limit */
    }
  }

  /** Jobs still queued. */
  get pending(): number {
    return this.frontier.size;
  }

  /** Depths expanded, counting the start as the first. */
  get levels(): number {
    return this.expandedNodes > 0 ? this.depthReached + 1 : 0;
  }

  /* ------------------------------------------------------------------ *
   * Node checks shared by both directions
   * ------------------------------------------------------------------ */

  /** Decide whether a job's node ends here. Returns the stop, or null to expand. */
  private async gate(job: Job, n: GraphNode): Promise<{ code: StopCode; detail: string; nodeLevel: boolean; nodeLimit?: true } | null> {
    if (n.stop) return { ...n.stop, nodeLevel: true };
    const address = n.address!;
    const target = this.opts.target?.sui;
    if (target && address === target) {
      return { code: "target", detail: "The address being searched for.", nodeLevel: true };
    }
    // The address the caller started from is the subject whatever its label:
    // asking where an exchange wallet's money went is a question, not a stop.
    const startAddress = job.depth === 0 && job.from === null;
    // A malicious label marks the subject, not a destination: an attacker's
    // wallets are what the graph is following. Exchanges, bridges, mixers and
    // burn addresses end it.
    const label = getLabel(address);
    if (!startAddress && isSink(address)) {
      if (label?.category === "bridge") {
        return { code: "bridge_exit", detail: `Labeled as a bridge (${label.label}). No curated marker was checked here; run resolve_bridge_transfer on the arriving transaction.`, nodeLevel: true };
      }
      const inferred = label ? inferredLabelNote(label) : undefined;
      return { code: "sink", detail: `${label?.label ?? address} (${label?.category ?? "sink"}).${inferred ? ` ${inferred}` : ""}`, nodeLevel: true };
    }
    if (!startAddress && isPassThroughAddress(address)) {
      return {
        code: "protocol",
        detail: "A curated protocol or pool address. Funds paid to a shared contract are pooled with its other users' funds.",
        nodeLevel: true,
      };
    }
    if (job.depth >= this.opts.maxDepth) {
      return { code: "budget", detail: `Depth limit (${this.opts.maxDepth}) reached before expanding it.`, nodeLevel: false };
    }
    const firstTime = !n.expanded;
    if (firstTime && this.expandedNodes >= this.opts.maxNodes) {
      return { code: "budget", detail: `Node limit (${this.opts.maxNodes}) reached before expanding it.`, nodeLevel: false, nodeLimit: true };
    }
    if ((this.expansions.get(n.id) ?? 0) >= EXPANSIONS_PER_NODE) {
      return { code: "budget", detail: `Expanded ${EXPANSIONS_PER_NODE} times already; later arrivals were not followed.`, nodeLevel: false };
    }
    if (this.txReads >= this.opts.maxTxReads) {
      return { code: "budget", detail: `Transaction read limit (${this.opts.maxTxReads}) reached before expanding it.`, nodeLevel: false };
    }
    // A new party is measured before its moves are attributed to these funds.
    // The same actor continuing (a swap, a self-credit) is the subject, not a
    // new party; neither is the address the caller started from. Forward, an
    // address paid by few senders passes on what they sent and is expanded;
    // see stopsAsHub.
  if (!job.object_id && job.from !== null && job.from !== address) {
      let fanout = this.hubChecked.get(address);
      if (fanout === undefined) {
        fanout = await measureFanout(address, HUB_SCAN_TRANSACTIONS).catch((err: unknown) =>
          new Error(`Hub check for ${address} is unread: ${err instanceof Error ? err.message : String(err)}`),
        );
        this.hubChecked.set(address, fanout);
      }
      if (fanout instanceof Error) return { code: "read_failed", detail: fanout.message, nodeLevel: true };
      if (stopsAsHub(address, fanout, this.opts.direction)) {
        const senders = this.opts.direction === "forward" && fanout.sender_count >= 0 ? `, ${fanout.sender_count}${fanout.truncated ? "+" : ""} of them paying in` : "";
        return {
          code: "hub",
          detail:
            `A ${fanout.classification}: ${fanout.counterparty_count}${fanout.truncated ? "+" : ""} counterparties in its last ` +
            `${fanout.scanned_transactions} transactions${senders}. Attribute it (manage_labels, classify_deposit_address) rather than walking past it.`,
          nodeLevel: true,
        };
      }
    }
    return null;
  }

  private async stopJob(job: Job, n: GraphNode): Promise<boolean> {
    const stop = await this.gate(job, n);
    if (!stop) return false;
    if (stop.nodeLevel) n.stop = { code: stop.code, detail: stop.detail };
    if (stop.code === "budget" || stop.code === "read_failed") this.truncated = true;
    if (stop.nodeLimit) this.nodeLimited.push({ node: n.id, share: job.share });
    this.ledger.add(stop.code, {
      node: n.id,
      share: job.share,
      usd: this.usdAt(job.need, n),
      detail: stop.detail,
    });
    return true;
  }

 /** Follow an object by identity through its subsequent transactions. */
 private async expandObject(job: Job): Promise<void> {
  const n = this.nodes.get(job.node)!;
  if (await this.stopJob(job, n)) return;
  const holder = n.address!;
  const objectId = job.object_id!;
  const forward = this.opts.direction === "forward";
  const scan = await scanObjectTouches(objectId, job.arrival.checkpoint, job.arrival.digest, this.opts.direction, this.opts.window);
  this.markExpanded(n);
  // The part of the share the object still carries: value drawn from it in
  // place (forward) or added to it in place (backward) passes to that
  // transaction's coins.
  let share = job.share;
  const usd = () => {
   const whole = this.usdAt(1n, n);
   return whole === null ? null : whole * (share / job.share);
  };
  const stop = (detail: string) => {
   this.truncated = true;
   this.ledger.add("read_failed", { node: n.id, share, usd: usd(), detail });
  };
  for (const digest of scan.digests) {
   if (this.txReads >= this.opts.maxTxReads) break;
   const tx = await this.read(digest);
   if (!tx) return stop(`Could not read object transaction ${digest}.`);
   const values = await this.objectValues(digest, tx, false, holder);
   const row = values.rows.find((r) => r.object_id === objectId && !r.changed_in_place);
   if (!row) {
    if (values.unread.some((u) => u.what === objectId || u.what === digest)) {
     return stop(`The custody or value of ${objectId} in ${digest} could not be read completely.`);
    }
    const kept = values.rows.find((r) => r.object_id === objectId && r.changed_in_place && (forward ? r.from : r.to) === holder);
    if (kept) {
     const delta = kept.usd === null ? null : forward ? -kept.usd : kept.usd;
     if (delta === null || kept.usd_after == null) return stop(`The change in value of ${objectId} in ${digest} is unavailable: ${kept.unpriced_reason ?? "an asset leg has no price"}.`);
     if (delta > 0) {
      const whole = forward ? delta + Math.max(0, kept.usd_after) : Math.max(kept.usd_after, delta);
      const part = Math.min(1, delta / whole);
      await this.convertObject(n, job.from, kept, digest, tx, share * part, delta, values);
      share *= 1 - part;
      if (share <= 0) return;
     }
     continue;
    }
    const moved = tx.objectMovements?.some((m) => m.object_id === objectId &&
     (m.from?.address !== m.to?.address || m.kind === "deleted" || m.kind === "wrapped"));
    if (moved || tx.objectChangesTruncated) return stop(`The custody or value of ${objectId} in ${digest} could not be read completely.`);
    continue;
   }
   const nextHolder = forward ? row.to : row.from;
   if ((forward ? row.from : row.to) !== holder) continue;
   // Into or out of another object (a wrapper, a kiosk), shared or frozen:
   // the object still exists, and no address is established as holding it.
   const movement = values.movements.find((m) => normalizeSuiAddress(m.object_id) === objectId);
   const other = forward ? movement?.to : movement?.from;
   if (row.custody || (!nextHolder && other && other.kind !== "address")) {
    const where = other?.kind === "object" && other.address ? `object ${other.address}` : other ? `a ${other.kind} owner` : "another object";
    return stop(`${objectId} moved ${forward ? "into" : "out of"} ${where} in ${digest}; the controlling address is not established.`);
   }
   if (row.usd === null) return stop(`The value of ${objectId} at ${digest} is unavailable: ${row.unpriced_reason ?? "an asset leg has no price"}.`);
   if (nextHolder && nextHolder !== holder) {
    const target = objectNodeId(nextHolder, objectId);
    this.connectObject({
     node: target, object_id: objectId, share,
     need: 1n, arrival: { digest, checkpoint: tx.checkpoint ?? undefined },
     depth: job.depth + 1, from: holder, via: n.id,
    }, nextHolder, forward ? n.id : target, forward ? target : n.id,
     row, digest, tx);
    return;
   }
   await this.convertObject(n, job.from, row, digest, tx, share, row.usd, values);
   return;
  }
  const stopped = !scan.exhausted || this.txReads >= this.opts.maxTxReads;
  if (stopped) this.truncated = true;
  if (!stopped && forward) n.unspent = (n.unspent ?? 0n) + 1n;
  this.ledger.add(stopped ? "budget" : forward ? "unspent" : "source", {
   node: n.id, share, usd: usd(),
   detail: stopped ? `The search for ${objectId} stopped before reaching the end of its history.`
    : forward ? `No later transaction in the window moved ${objectId} or drew value from it.` : `No earlier transfer of ${objectId} was found in the window.`,
  });
 }

 /**
  * Pass `share` of a redeemed object, or of the part drawn from it in place,
  * worth `value`, to the transaction's priced coin proceeds (forward) or to
  * its priced payers (backward). Several objects converted in one
  * transaction divide the coins by value. The holder's own coins arrive from
  * `prev`, the party the object came through: the object kept its identity
  * at the holder, but coins mix with the holder's own, so a holder that
  * pools others' funds is a hub for them.
  */
 private async convertObject(n: GraphNode, prev: string | null, row: MovedObjectValue, digest: string, tx: FetchedTx, share: number, value: number, values: ObjectRead): Promise<void> {
  const forward = this.opts.direction === "forward";
  const valueUsd = await this.valuer(tx);
  const split = forward
   ? splitOrigin({ changes: tx.balanceChanges, trackedCoin: null, gas: gasOf(tx), valueUsd })
   : splitOriginBackward({ changes: tx.balanceChanges, trackedCoin: null, gas: gasOf(tx), valueUsd });
  const unpriced = split.branches.some((b) => valueUsd({ amount: b.amount.toString(), coin_type: b.coin_type }) === null);
  const priced = split.branches.filter((b) => {
   const usd = valueUsd({ amount: b.amount.toString(), coin_type: b.coin_type });
   return usd !== null && usd > 0;
  });
  const contained = new Set(values.movements.filter((m) => {
   const other = forward ? m.to : m.from;
   return other !== null && other.kind !== "address";
  }).map((m) => normalizeSuiAddress(m.object_id)));
  // An object holding coins is valued here at the prices its proceeds are
  // valued at: a valuer's own quote for the same SUI differs slightly, and
  // would leave a redemption that paid out in full partly unexplained.
  const atTx = (r: MovedObjectValue): MovedObjectValue => {
   if (!r.coin_amounts?.length || r.usd === null) return r;
   let usd = 0;
   for (const c of r.coin_amounts) {
    const raw = BigInt(c.amount);
    const u = valueUsd({ amount: (raw < 0n ? -raw : raw).toString(), coin_type: c.coin_type });
    if (u === null) return r;
    usd += raw < 0n ? -u : u;
   }
   return { ...r, usd };
  };
  const own = atTx(row);
  if (own !== row) value = Math.max(0, own.changed_in_place ? (forward ? -own.usd! : own.usd!) : own.usd!);
  const converted = values.rows.reduce((sum, r) => sum + (contained.has(r.object_id) ? 0 : conversionValue(atTx(r), forward)), 0);
  const fraction = converted > 0 ? Math.min(1, value / converted) : 1;
  const usdTotal = priced.reduce((sum, b) => sum + (valueUsd({ amount: b.amount.toString(), coin_type: b.coin_type }) ?? 0), 0);
  const covered = value > 0 && usdTotal > 0 ? Math.min(1, (usdTotal * fraction) / value) : 0;
  for (const b of priced) {
   const usd = valueUsd({ amount: b.amount.toString(), coin_type: b.coin_type })!;
   const traced = scaleAmount(b.amount, Math.min(fraction, value / usdTotal));
   const target = nodeId(b.address, b.coin_type);
   this.connect({
    node: target, share: share * covered * usd / usdTotal, need: traced, arrival: { digest, checkpoint: tx.checkpoint ?? undefined },
    depth: n.depth + 1, from: b.address === n.address ? (prev ?? n.address) : n.address, via: n.id,
   }, b.address, b.coin_type, forward ? n.id : target, forward ? target : n.id,
    { amount: b.amount, traced, usd, basis: "conversion", digest, tx });
  }
  if (covered < 1) {
   if (unpriced) this.truncated = true;
   this.ledger.add(unpriced ? "read_failed" : forward ? "consumed" : "source", {
    node: n.id, share: share * (1 - covered), usd: value * (1 - covered),
    detail: unpriced
     ? `${row.object_id} was converted in ${digest}; some coin ${forward ? "proceeds" : "payments"} lack a price, so their share cannot be allocated.`
     : `${row.object_id} was converted in ${digest}; priced coin ${forward ? "proceeds" : "payments"} cover ${Math.round(covered * 100)}% of the $${value.toFixed(2)} converted.`,
   });
  }
 }

  /* ------------------------------------------------------------------ *
   * Forward
   * ------------------------------------------------------------------ */

 /** Read bounded object transfers for an address start, including transactions with no coin change. */
 private async addressObjects(address: string): Promise<Array<MovedObjectValue & { digest: string }>> {
  const forward = this.opts.direction === "forward";
  // An address-owned object leaves only in a transaction its owner sends.
  const scan = await scanObjectTouches(address, undefined, undefined, this.opts.direction, this.opts.window, MOVES_PER_START_ADDRESS, forward ? "sentAddress" : "affectedAddress");
  const read = await readMovedObjects(scan.digests);
  // Forward, an object leaving the address, or one a transaction it sent
  // created for another address (a stake or a position opened for someone).
  const candidate = (from: string | null, to: string | null) =>
   forward ? (from === address || from === null) && to !== null && to !== address : to === address && from !== null && from !== address;
  // A previous holder old effects did not record is read during valuation.
  const relevant = read.txs.filter((tx) => tx.moved.some((m) =>
   candidate(m.from, m.to) || (m.prior_version !== undefined && m.from === null && (forward ? m.to !== null && m.to !== address : m.to === address)),
  ));
  const values = await valueTransactionObjects(relevant, { maxTxs: MOVES_PER_START_ADDRESS, maxObjects: MOVES_PER_START_ADDRESS });
  const skipped = new Set([...read.unread, ...values.skipped]);
  for (const tx of read.txs) {
   if (skipped.has(tx.digest)) continue;
   const rows = values.rows.filter((r) => r.digest === tx.digest);
   const unread = new Map(values.unread.filter((u) => u.digest === tx.digest).map((u) => [u.what, u.reason]));
   this.noteUnvalued(unvaluedOf(tx.digest, tx.movements ?? [], rows, unread).filter((u) => !u.custody && candidate(u.from, u.to)));
   }
  for (const digest of skipped) {
   this.truncated = true;
   this.partial.push(`The object changes of ${digest} could not be read in the address history.`);
  }
  if (!scan.exhausted) {
   this.truncated = true;
   this.partial.push(`The object history of ${address} stopped after ${scan.digests.length} transactions; later object transfers may be missing.`);
  }
  return values.rows.filter((r) => !r.custody && !r.changed_in_place && r.usd !== null && r.usd > 0 && candidate(r.from, r.to));
 }

 /**
  * Divide the address-root share between its coin legs, each worth `coins`
  * (USD, null when unpriced), and its object handovers. `carved` is the part
  * of each object's value a coin leg already carries: an object the root
  * created from its own coins and then handed over is counted once, on the
  * object. Returns the part of the share left to the coin legs.
  */
 private async connectAddressObjects(
  job: Job, n: GraphNode, rows: Array<MovedObjectValue & { digest: string }>, coins: Array<number | null>, carved: number[] = [],
 ): Promise<number> {
  if (rows.length === 0) return 1;
  const coinTotal = coins.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const total = coinTotal + rows.reduce((sum, r, i) => sum + Math.max(0, r.usd! - (carved[i] ?? 0)), 0);
  if (total <= 0) return 1;
  for (let i = 0; i < rows.length; i++) {
   const row = rows[i];
   const share = (job.share * row.usd!) / total;
   const tx = await this.read(row.digest);
   if (!tx) {
    this.truncated = true;
    this.ledger.add("read_failed", { node: n.id, share, usd: row.usd, detail: `Could not read object transaction ${row.digest}.` });
    continue;
   }
   const holder = this.opts.direction === "forward" ? row.to! : row.from!;
   const target = objectNodeId(holder, row.object_id);
   this.connectObject({
    node: target, object_id: row.object_id, share,
    need: 1n, arrival: { digest: row.digest, checkpoint: tx.checkpoint ?? undefined },
    depth: job.depth + 1, from: n.address, via: n.id,
   }, holder, this.opts.direction === "forward" ? n.id : target,
    this.opts.direction === "forward" ? target : n.id, row, row.digest, tx);
  }
  return coinTotal / total;
 }

 /**
  * Value an address-start root's coin legs put into an object the root hands
  * over: forward, an object created for the address or written in place
  * while it held it in the leg's transaction (a deposit into a position),
  * or created in the leg's own transaction for another address; backward,
  * an object the root received and then gave up or drew from in place in the
  * leg's transaction (an unstake, a redemption, a withdrawal). The leg's
  * unpaid part and the handover are the same value, up to the object's value
  * at the handover. `carve` is the part of each leg's unpaid value the
  * objects take; `carved` the USD each object takes from legs.
  */
 private rootObjectLinks(address: string, legs: Leg[], txs: Array<FetchedTx | null>, digests: string[], rows: Array<MovedObjectValue & { digest: string }>): { carve: number[]; carved: number[] } {
  const forward = this.opts.direction === "forward";
  const carve = legs.map(() => 0);
  const carved = rows.map(() => 0);
  if (rows.length === 0) return { carve, carved };
  const bySpend = new Map<number, number[]>();
  legs.forEach((l, i) => bySpend.set(l.spend, [...(bySpend.get(l.spend) ?? []), i]));
  const unpaid = (i: number) => (forward ? legs[i].split.unallocated - legs[i].split.retained : legs[i].split.unallocated);
  for (const [spend, idx] of bySpend) {
   const tx = txs[spend];
   if (!tx) continue;
   const held = (tx.written?.held ?? []).filter((h) => h.owner === address).map((h) => h.object_id);
   const ids = new Set([...held, ...(tx.objectMovements ?? [])
    .filter((m) => forward ? m.kind === "created" && holderOf(m.to) === address : holderOf(m.from) === address && holderOf(m.to) !== address)
    .map((m) => normalizeSuiAddress(m.object_id))]);
   const linked = [...new Set([
    ...[...ids].map((id) => rows.findIndex((r) => r.object_id === id && r.digest !== digests[spend])),
    ...(forward ? rows.map((r, i) => (r.digest === digests[spend] && r.from === null ? i : -1)) : []),
   ].filter((r) => r >= 0))];
   const room = (r: number) => Math.max(0, rows[r].usd! - carved[r]);
   const objectUsd = linked.reduce((sum, r) => sum + room(r), 0);
   if (objectUsd <= 0) continue;
   const unpaidUsd = idx.reduce((sum, i) => sum + (legs[i].value === null ? 0 : legs[i].value! * unpaid(i)), 0);
   if (unpaidUsd <= 0) continue;
   // Several legs can feed one object (opened, then added to); together
   // they never take more than it was worth when handed over.
   const taken = Math.min(unpaidUsd, objectUsd);
   for (const i of idx) if (legs[i].value !== null && unpaid(i) > 0) carve[i] = taken / unpaidUsd;
   const rooms = linked.map(room);
   linked.forEach((r, k) => { carved[r] += (taken * rooms[k]) / objectUsd; });
  }
  return { carve, carved };
 }

  private async expandForward(job: Job): Promise<void> {
    const n = this.nodes.get(job.node)!;
    if (await this.stopJob(job, n)) return;
    const address = n.address!;
    const coin = n.coin_type;
    // Keyed by address, not node id: an address reached again under a
    // different coin (a swap-follow child of an address-start root, say)
    // must not re-discover a transaction another coin-node of the same
    // address already allocated. Every transaction is one real-world event;
    // crediting it to two lineages of the same address double-counts it.
    const done = this.allocatedFor(address);

    // A node carrying most of the traced value is the trunk, the start's
    // continuation, and reads as many moves as the start address. At most one
    // node per level can hold over half, so this cannot multiply the budget;
    // the per-node cap still bounds a fan-out's many small branches.
    const trunk = job.need === null || job.share > 0.5;
    const scan = await scanForwardSpends(address, job.arrival.checkpoint, coin, done, job.arrival.digest, {
      ...(job.need !== null ? { need: job.need } : {}),
      maxSpends: trunk ? MOVES_PER_START_ADDRESS : MOVES_PER_NODE,
      window: this.opts.window,
    });
    this.markExpanded(n);
    if (job.from === null && coin === null) this.startReadAll = scan.exhausted;
    if (job.from === null) this.startCapped = !scan.exhausted;
  const addressRoot = job.need === null && coin === null && job.from === null;
  let objectRows: Array<MovedObjectValue & { digest: string }> = [];
  if (addressRoot) {
   try {
    objectRows = await this.addressObjects(address);
   } catch (err) {
    this.truncated = true;
    this.partial.push(`The object history of ${address} could not be read: ${err instanceof Error ? err.message : String(err)}.`);
   }
  }

  if (scan.spends.length === 0 && objectRows.length > 0) {
   await this.connectAddressObjects(job, n, objectRows, []);
   return;
  }
    if (scan.spends.length === 0) {
      // A candidate this same (address, coin) node already drained to zero
      // is a non-hit (see allSpends): the funds this arrival brought were
      // never spent, and the detail says those spends are already counted.
      // A candidate the address-start root claimed is a cycle. A
      // page-limited scan is reported as budget-limited first
      // regardless; see noSpendReason.
      const code: StopCode = !scan.exhausted && !scan.satisfied ? "budget" : scan.alreadyAllocated > 0 ? "cycle" : "unspent";
      if (code === "budget") this.truncated = true;
      if (job.need !== null && code !== "cycle") n.unspent = (n.unspent ?? 0n) + job.need;
      this.ledger.add(code, {
        node: n.id,
        share: job.share,
        usd: this.usdAt(job.need, n),
        detail: noSpendReason(address, coin, scan),
      });
      return;
    }

    // A start node has no amount to cover, so a search that stopped at its
    // limit leaves no share uncovered, only moves unread.
    if (job.need === null && !scan.exhausted) {
      this.truncated = true;
      this.partial.push(`The search of ${address} stopped at its limit after ${scan.spends.length} spend(s); any later moves in the window were not read.`);
    }
    const txs = await Promise.all(scan.spends.map((s) => this.read(s.tx.digest)));
    const { legs, pools } = await this.legsOf(
      address,
      coin,
      -1,
      scan.spends.map((s) => ({ tx: s.tx, moved: s.spent })),
      txs,
      async (tx, digest) => {
        // Decoding prefetches the packages' protocol names, which the
        // registry tier of bridge detection reads.
        await this.actions(digest, tx);
        return { bridge: detectBridges(tx.callSites, tx.eventTypes ?? []).length > 0, claim: receivedClaim(tx, address) };
      },
      (p) =>
        splitSpend({
          sender: p.sender,
          holder: address,
          changes: p.changes,
          trackedCoin: p.trackedCoin,
          gas: p.gas,
          valueUsd: p.valueUsd,
          drawnUsd: p.drawnUsd,
          bridgeExit: p.bridge,
          capToProceeds: p.row,
          holderGotClaim: p.claim,
        }),
    );
    const moves = movesOf(legs);
    const alloc = allocateFifo(moves, job.need);
    const plan = pools ? rootPlan(legs, pools, alloc.fractions) : null;
  const links = addressRoot ? this.rootObjectLinks(address, legs, txs, scan.spends.map((s) => s.tx.digest), objectRows) : null;
  const coinScale = addressRoot
   ? await this.connectAddressObjects(job, n, objectRows, legs.map((l, i) => (l.value === null ? null : l.value * (plan ? plan.keep[i] : 1))), links!.carved)
   : 1;

    for (let l = 0; l < legs.length; l++) {
      const { spend, split } = legs[l];
      const digest = scan.spends[spend].tx.digest;
      // Keyed by the leg's coin, so a transaction that moves two coins
      // blocks each only for what was drawn on it. `byRoot` marks the
      // address-start root's claim, which a later coin-specific node of the
      // same address reads as a cycle rather than as its own lineage's
      // leftover capacity.
      done.set(availabilityKey(digest, legs[l].coin ?? coin), {
        avail: moves[l].amount - alloc.allocated[l],
        byRoot: coin === null,
      });
   const share = job.share * coinScale * (plan ? plan.fractions[l] : alloc.fractions[l]);
      const tx = txs[spend];
      // Checked before the share: an unreadable leg leaves the graph partial whatever it weighed.
      if (!tx || !legs[l].read) {
        this.truncated = true;
        this.ledger.add("read_failed", { node: n.id, share, usd: null, detail: `Could not read ${digest} from the fullnode or the archive.` });
        continue;
      }
      if (share <= 0) continue;
      const signers = assignSignerRoles(tx.sender, tx.gasPayer, tx.signatures ?? []);
      if (signers.signer_is_sender === false) {
        this.ledger.add("signer_not_sender", {
          node: n.id,
          share,
          usd: null,
          detail: `${digest} was sent as ${tx.sender} but signed by ${signers.authorized_by.join(", ")}.`,
        });
        continue;
      }
      const traced = alloc.allocated[l];
      const txFrac = split.total > 0n ? Math.min(1, Number((traced * 1_000_000n) / split.total) / 1e6) : 0;
      const valueUsd = legs[l].valuer!;
      const keep = plan ? plan.keep[l] : 1;
      for (const b of split.branches) {
        const kept = keptPart(b, plan, txFrac);
        if (kept.weight <= 0) continue;
        const target = nodeId(b.address, b.coin_type);
        const amount = movedOnChain(tx.balanceChanges, b.address, b.coin_type, gasOf(tx));
        this.connect(
          { node: target, share: (share * kept.weight) / keep, need: kept.traced, arrival: { digest, checkpoint: tx.checkpoint ?? undefined }, depth: job.depth + 1, from: address, via: n.id },
          b.address,
          b.coin_type,
          n.id,
          target,
          { amount, traced: kept.traced, usd: valueUsd({ amount: amount.toString(), coin_type: b.coin_type }), basis: b.basis, digest, tx },
          kept.held ? this.heldAtStart(address, scan.exhausted, scan.spends.length, kept.held === "unknown") : undefined,
        );
      }
      if (split.retained > 0) {
        const amount = scaleAmount(split.total, split.retained);
        const usd = valueUsd({ amount: amount.toString(), coin_type: split.coin_type ?? "" });
        await this.retainedOut(n.id, address, tx, digest, (share * split.retained) / keep, amount, scaleAmount(amount, txFrac), split.coin_type ?? "", usd);
      }
   const rest = (split.unallocated - split.retained) * (1 - (links?.carve[l] ?? 0));
      if (rest > 0) {
        const hits = detectBridges(tx.callSites, tx.eventTypes ?? []);
        const amount = scaleAmount(split.total, rest);
        const usd = valueUsd({ amount: amount.toString(), coin_type: split.coin_type ?? "" });
        await this.terminalOut(n.id, address, tx, digest, hits, (share * rest) / keep, amount, scaleAmount(amount, txFrac), split.coin_type ?? "", usd);
      }
    }

    if (alloc.remaining > 0) {
      const code: StopCode = scan.satisfied ? "budget" : scan.exhausted ? "unspent" : "budget";
      if (code === "budget") this.truncated = true;
      const left = job.need === null ? null : scaleAmount(job.need, alloc.remaining);
      if (left !== null && code === "unspent") n.unspent = (n.unspent ?? 0n) + left;
      this.ledger.add(code, {
        node: n.id,
    share: job.share * coinScale * alloc.remaining,
        usd: this.usdAt(left, n),
        detail:
          code === "unspent"
            ? `${address} has moved only part of the traced amount since receiving it; the rest is still there.`
            : `${address}'s first ${scan.spends.length} spend(s) did not account for the whole traced amount, and the search stopped at that limit.`,
      });
    }
  }

  /**
   * Where value an address-start root converted in place ends when no later
   * leg of the root moved it again: held at the start address in the coin it
   * became (forward) or in the coin it was paid in from (backward), or
   * `budget` when the root's scan stopped at a limit before reading every
   * move, or `read_failed` when a transaction it could not read in full may
   * have moved it.
   */
  private heldAtStart(address: string, exhausted: boolean, moves: number, unknown: boolean): { code: StopCode; detail: string } {
    const { window, direction } = this.opts;
    if (unknown) {
      return {
        code: "read_failed",
        detail: `${address} converted value in place that a transaction whose balance changes could not all be read may have moved, so where it ended is unknown.`,
      };
    }
    if (direction === "forward") {
      if (!exhausted) {
        return {
          code: "budget",
          detail: `${address} converted into this coin in place. The search read its first ${moves} moves, which did not spend all of it, and stopped at that limit.`,
        };
      }
      return {
        code: "unspent",
        detail:
          window.beforeCheckpoint === undefined
            ? `${address} converted into this coin in place, and no later move spent it, so it still holds it.`
            : `${address} converted into this coin in place, and no later move in the window spent it, so it held it when the window ended.`,
      };
    }
    if (!exhausted) {
      return {
        code: "budget",
        detail: `${address} paid this coin into a conversion in place. The search read its latest ${moves} inflows, which did not explain all of it, and stopped at that limit.`,
      };
    }
    return {
      code: "source",
      detail:
        window.afterCheckpoint === undefined
          ? `${address} paid this coin into a conversion in place, and no earlier inflow explains it: it held the coin before the history this server can read.`
          : `${address} paid this coin into a conversion in place, and no earlier inflow in the window explains it: it held the coin when the window began.`,
    };
  }

  /**
   * One leg per coin of each transaction a node drew on: every coin the
   * transaction moved in `sign`'s direction for the address-start root, the
   * node's own coin otherwise. An unreadable transaction is split from the
   * balance changes of its search row and priced as of the nearest readable
   * one. The root draws each transaction on its earlier conversions in place
   * (`RootPools`) before splitting it. A leg is valued at the market price of
   * what it moved, then at the priced side of its own split, then at the
   * rate its draws carried.
   */
  private async legsOf(
    address: string,
    coin: string | null,
    sign: 1 | -1,
    rows: Array<{ tx: CandidateTx; moved: bigint }>,
    txs: Array<FetchedTx | null>,
    contextOf: (tx: FetchedTx, digest: string) => Promise<{ bridge: boolean; claim?: boolean }>,
    splitOf: (p: { sender: string | null; changes: HopChange[]; gas: GasCharge; bridge: boolean; claim?: boolean; row: boolean; trackedCoin: string | null; valueUsd: ValueUsd; drawnUsd: ValueUsd }) => Split,
  ): Promise<{ legs: Leg[]; pools: RootPools | null }> {
    const valuers = await Promise.all(
      txs.map((tx, i) => (tx ? this.valuer(tx) : this.valuerAt(rows[i].tx.changes.map((c) => c.coin_type), nearestRead(txs, i)?.timestamp))),
    );
    const pools = coin === null ? new RootPools(address) : null;
    const legs: Leg[] = [];
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      const row = rows[i];
      const changes = tx ? tx.balanceChanges : row.tx.changes;
      const gas = tx ? gasOf(tx) : row.tx.gas;
      const context = tx ? await contextOf(tx, row.tx.digest) : { bridge: false };
      const tracked: Array<string | null> = coin === null ? coinsMoved(changes, address, sign, gas) : [coin];
      if (tracked.length === 0) tracked.push(null);
      const valueUsd = pools
        ? pools.draw(valuers[i], tracked.map((c) => ({ coin: c, amount: c ? movedOnChain(changes, address, c, gas) : 0n })))
        : valuers[i];
      // A row missing some balance changes may have moved any conversion still open.
      if (!tx && row.tx.changesTruncated) pools?.blind();
      const first = legs.length;
      for (const trackedCoin of tracked) {
        const split = splitOf({ sender: tx ? tx.sender : row.tx.sender, changes, gas, ...context, row: !tx, trackedCoin, valueUsd: valuers[i], drawnUsd: valueUsd });
        // The root draws every move in full; a coin-specific node draws at
        // most what the search found still available, which an earlier
        // arrival at the same address may have cut below the split's total.
        const amount = coin === null ? split.total : split.total > 0n && split.total < row.moved ? split.total : row.moved;
        const moved = { amount: amount.toString(), coin_type: split.coin_type ?? "" };
        const value = valuers[i](moved) ?? pricedSide(split, valueUsd) ?? valueUsd(moved);
        legs.push({ spend: i, split, read: tx !== null, valuer: valueUsd, coin: split.coin_type, amount, value });
      }
      pools?.open(legs.slice(first));
    }
    return { legs, pools };
  }

  /**
   * Value that no address received on a forward hop: a bridge exit when the
   * transaction carries a bridge marker, otherwise a deposit, lock or burn.
   * Returns false when there was nothing to record.
   */
  private async terminalOut(
    from: string,
    holder: string,
    tx: FetchedTx,
    digest: string,
    hits: BridgeHit[],
    share: number,
    amount: bigint,
    traced: bigint,
    coin: string,
    usd: number | null,
  ): Promise<boolean> {
    if (share <= 0) return false;
    const tracedUsd = usd === null || amount === 0n ? usd : usd * (Number((traced * 1_000_000n) / amount) / 1e6);
    const record = (n: GraphNode) => {
      n.share += share;
      if (tracedUsd !== null) n.usd = (n.usd ?? 0) + tracedUsd;
    };
    if (hits.length > 0) {
      const protocols = [...new Set(hits.map((h) => h.protocol))].sort();
      const { beneficiaries, unavailable } = await this.beneficiariesOf(digest);
      const accounts = [...new Set(beneficiaries.map((b) => b.account ?? b.address ?? b.address_raw))].sort();
      const id = `exit:${protocols.join("+")}:${accounts.join(",") || "unresolved"}`;
      const exit = this.node(id, "bridge_exit", null, null, 0);
      exit.protocols = protocols;
      // A transaction's beneficiaries join its exit once, however many of its coins reach it.
      if (!this.mergedExits.has(`${id}|${digest}`)) {
        this.mergedExits.add(`${id}|${digest}`);
        exit.beneficiaries = mergeBeneficiaries(exit.beneficiaries ?? [], beneficiaries);
      }
      if (unavailable) exit.beneficiaries_unavailable = unavailable;
      const target = this.opts.target?.foreign;
      const hitTarget = target ? beneficiaries.some((b) => sameForeignAddress(b.address, target) || b.account === target) : false;
      this.edge(from, id, { amount, traced, usd, basis: "consumed", digest, tx, coin, share });
      record(exit);
      this.ledger.add(hitTarget ? "target" : "bridge_exit", { node: id, share, usd: tracedUsd });
      if (hitTarget) exit.stop = { code: "target", detail: "A bridge exit paying the account being searched for." };
      return true;
    }
    const into = [...new Set(tx.callSites.map(callTarget))].slice(0, 3);
    const id = `consumed:${holder}:${into.join("+") || "none"}`;
    const c = this.node(id, "consumed", null, null, 0);
    c.detail = forwardDeadEnd(tx, holder, coin || null, true, undefined);
    this.addLeads(c, digest, await this.leadsOf(digest));
    this.edge(from, id, { amount, traced, usd, basis: "consumed", digest, tx, coin, share });
    record(c);
    this.ledger.add("consumed", { node: id, share, usd: tracedUsd });
    return true;
  }

  /** Attach a transaction's cross-chain leads to a terminal node, once each. */
  private addLeads(n: GraphNode, digest: string, leads: CrossChainLead[]): void {
    for (const lead of leads) {
      n.cross_chain_leads ??= [];
      if (!n.cross_chain_leads.some((l) => l.digest === digest && l.event_type === lead.event_type)) n.cross_chain_leads.push({ digest, ...lead });
    }
  }

  /**
   * Value a conversion's counterparty kept on a forward hop: the proceeds were
   * worth under a tenth of it and the holder received nothing to claim it
   * with. One node per set of shared objects the transaction wrote, which is
   * where that value sits, else per set of calls.
   */
  private async retainedOut(from: string, holder: string, tx: FetchedTx, digest: string, share: number, amount: bigint, traced: bigint, coin: string, usd: number | null): Promise<void> {
    if (share <= 0) return;
    const tracedUsd = usd === null || amount === 0n ? usd : usd * (Number((traced * 1_000_000n) / amount) / 1e6);
    const shared = (tx.written?.shared ?? []).slice(0, 3);
    const into = shared.length ? shared.map((o) => o.object_id) : [...new Set(tx.callSites.map(callTarget))].slice(0, 3);
    const id = `retained:${holder}:${into.join("+") || "none"}`;
    const r = this.node(id, "retained", null, null, 0);
    if (shared.length) r.shared_objects = shared;
    this.addLeads(r, digest, await this.leadsOf(digest));
    r.detail =
      `${holder} put this in (${digest}) and got back proceeds worth under a tenth of it at market prices, with no receipt or position ` +
      "to claim the rest. The counterparty kept it" +
      (shared.length ? `: the shared objects the transaction wrote are ${shared.map((o) => o.object_id).join(", ")}.` : `, through ${into.join(", ") || "no Move call"}.`) +
      " A sale into a pool whose liquidity the seller controls moves value this way; check who can withdraw from it.";
    this.edge(from, id, { amount, traced, usd, basis: "retained", digest, tx, coin, share });
    r.share += share;
    if (tracedUsd !== null) r.usd = (r.usd ?? 0) + tracedUsd;
    this.ledger.add("retained", { node: id, share, usd: tracedUsd });
  }

  /* ------------------------------------------------------------------ *
   * Backward
   * ------------------------------------------------------------------ */

  private async expandBackward(job: Job): Promise<void> {
    const n = this.nodes.get(job.node)!;
    if (await this.stopJob(job, n)) return;
    const address = n.address!;
    const coin = n.coin_type;
    // See the forward comment: shared per address, not per node id.
    const done = this.allocatedFor(address);

    // An address start explains every inflow up to the limit: no amount to cover.
    const need = job.need ?? (1n << 255n);
    const scan = await scanPriorInflows(address, job.arrival.checkpoint, coin, done, job.arrival.digest, need, {
      // The trunk rule of expandForward.
      maxInflows: job.need === null || job.share > 0.5 ? MOVES_PER_START_ADDRESS : MOVES_PER_NODE,
      window: this.opts.window,
    });
    this.markExpanded(n);
    if (job.from === null && coin === null) this.startReadAll = scan.exhausted;
    if (job.from === null) this.startCapped = !scan.exhausted;
  const addressRoot = job.need === null && coin === null && job.from === null;
  let objectRows: Array<MovedObjectValue & { digest: string }> = [];
  if (addressRoot) {
   try {
    objectRows = await this.addressObjects(address);
   } catch (err) {
    this.truncated = true;
    this.partial.push(`The object history of ${address} could not be read: ${err instanceof Error ? err.message : String(err)}.`);
   }
  }

  if (scan.found.length === 0 && objectRows.length > 0) {
   await this.connectAddressObjects(job, n, objectRows, []);
   return;
  }
    if (scan.found.length === 0) {
      // See the forward comment: a same-node drain is not a cycle, and a
      // page-limited scan is reported as budget-limited first regardless.
      const code: StopCode = !scan.exhausted ? "budget" : scan.alreadyAllocated > 0 ? "cycle" : "source";
      if (code === "budget") this.truncated = true;
      this.ledger.add(code, {
        node: n.id,
        share: job.share,
        usd: this.usdAt(job.need, n),
        detail: noInflowReason(address, coin, scan),
      });
      return;
    }

    // See the forward comment: a start node's capped search leaves moves unread.
    if (job.need === null && !scan.exhausted) {
      this.truncated = true;
      this.partial.push(`The search of ${address} stopped at its limit after ${scan.found.length} inflow(s); any earlier moves in the window were not read.`);
    }
    const txs = await Promise.all(scan.found.map((f) => this.read(f.tx.digest)));
    // See the forward comment: the root explains every coin that came in.
    const { legs, pools } = await this.legsOf(
      address,
      coin,
      1,
      scan.found.map((f) => ({ tx: f.tx, moved: f.received })),
      txs,
      async (tx, digest) => {
        // Decoding prefetches the packages' protocol names, which the
        // registry tier of bridge detection reads.
        await this.actions(digest, tx);
        return { bridge: false };
      },
      (p) =>
        splitInflow({
          sender: p.sender,
          recipient: address,
          changes: p.changes,
          trackedCoin: p.trackedCoin,
          isPassThrough: isPassThroughAddress,
          gas: p.gas,
          valueUsd: p.valueUsd,
          drawnUsd: p.drawnUsd,
        }),
    );
    const moves = movesOf(legs);
    const alloc = allocateFifo(moves, job.need);
    const plan = pools ? rootPlan(legs, pools, alloc.fractions) : null;
  const links = addressRoot ? this.rootObjectLinks(address, legs, txs, scan.found.map((f) => f.tx.digest), objectRows) : null;
  const coinScale = addressRoot
   ? await this.connectAddressObjects(job, n, objectRows, legs.map((l, i) => (l.value === null ? null : l.value * (plan ? plan.keep[i] : 1))), links!.carved)
   : 1;

    for (let l = 0; l < legs.length; l++) {
      const { spend, split } = legs[l];
      const digest = scan.found[spend].tx.digest;
      // See the forward comment: keyed by the leg's coin, and marked when
      // the root wrote it.
      done.set(availabilityKey(digest, legs[l].coin ?? coin), {
        avail: moves[l].amount - alloc.allocated[l],
        byRoot: coin === null,
      });
   const share = job.share * coinScale * (plan ? plan.fractions[l] : alloc.fractions[l]);
      const tx = txs[spend];
      // See the forward comment: checked before the share.
      if (!tx || !legs[l].read) {
        this.truncated = true;
        this.ledger.add("read_failed", { node: n.id, share, usd: null, detail: `Could not read ${digest} from the fullnode or the archive.` });
        continue;
      }
      if (share <= 0) continue;
      const txFrac = split.total > 0n ? Math.min(1, Number((alloc.allocated[l] * 1_000_000n) / split.total) / 1e6) : 0;
      const valueUsd = legs[l].valuer!;
      const keep = plan ? plan.keep[l] : 1;
      for (const b of split.branches) {
        const kept = keptPart(b, plan, txFrac);
        if (kept.weight <= 0) continue;
        const payer = nodeId(b.address, b.coin_type);
        const amount = movedOnChain(tx.balanceChanges, b.address, b.coin_type, gasOf(tx));
        this.connect(
          { node: payer, share: (share * kept.weight) / keep, need: kept.traced, arrival: { digest, checkpoint: tx.checkpoint ?? undefined }, depth: job.depth + 1, from: address, via: n.id },
          b.address,
          b.coin_type,
          payer,
          n.id,
          { amount, traced: kept.traced, usd: valueUsd({ amount: amount.toString(), coin_type: b.coin_type }), basis: b.basis, digest, tx },
          kept.held ? this.heldAtStart(address, scan.exhausted, scan.found.length, kept.held === "unknown") : undefined,
        );
      }
   const unpaid = split.unallocated * (1 - (links?.carve[l] ?? 0));
   if (unpaid > 0) {
        const hits = detectBridges(tx.callSites, tx.eventTypes ?? []);
        const code: StopCode = hits.length ? "bridge_entry" : "source";
        const from = hits.length
          ? `entry:${[...new Set(hits.map((h) => h.protocol))].sort().join("+")}`
          : `source:${[...new Set(tx.callSites.map(callTarget))].slice(0, 3).join("+") || "none"}`;
        const src = this.node(from, "source", null, null, 0);
        if (hits.length) src.protocols = [...new Set(hits.map((h) => h.protocol))].sort();
        src.detail = backwardDeadEnd(tx, address, split.coin_type);
    const amount = scaleAmount(split.total, unpaid);
        const usd = valueUsd({ amount: amount.toString(), coin_type: split.coin_type ?? "" });
    const srcShare = (share * unpaid) / keep;
        const srcUsd = usd === null ? null : usd * txFrac;
        this.edge(from, n.id, { amount, traced: scaleAmount(amount, txFrac), usd, basis: "consumed", digest, tx, coin: split.coin_type ?? "", share: srcShare });
        src.share += srcShare;
        if (srcUsd !== null) src.usd = (src.usd ?? 0) + srcUsd;
        this.ledger.add(code, { node: from, share: srcShare, usd: srcUsd });
      }
    }

    if (alloc.remaining > 0) {
      const code: StopCode = scan.exhausted ? "source" : "budget";
      if (code === "budget") this.truncated = true;
      this.ledger.add(code, {
        node: n.id,
    share: job.share * coinScale * alloc.remaining,
        usd: this.usdAt(job.need === null ? null : scaleAmount(job.need, alloc.remaining), n),
        detail:
          code === "source"
            ? `The inflows found before it do not cover what ${address} paid out, and there are no earlier ones.`
            : `${address}'s latest ${scan.found.length} inflow(s) did not cover what it paid out, and the search stopped at that limit.`,
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Graph bookkeeping
   * ------------------------------------------------------------------ */

  private node(id: string, kind: NodeKind, address: string | null, coin: string | null, depth: number): GraphNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, kind, address, coin_type: coin, depth, share: 0, traced: 0n, usd: null, arrivedAt: null, expanded: false };
      this.nodes.set(id, n);
    }
    return n;
  }

  private markExpanded(n: GraphNode): void {
    if (!n.expanded) this.expandedNodes++;
    n.expanded = true;
    this.expansions.set(n.id, (this.expansions.get(n.id) ?? 0) + 1);
  }

  /**
   * The remaining-capacity map for one address, shared by every coin-lineage
   * of it in this graph: keyed by `availabilityKey(digest, coin)`, absent
   * means untouched (full on-chain amount), present means at most that much
   * is still available to whichever node next draws on that transaction,
   * plus whether it was the address-start root's claim (see `RemainingEntry`).
   */
  private allocatedFor(address: string): Map<string, RemainingEntry> {
    let m = this.allocated.get(address);
    if (!m) {
      m = new Map();
      this.allocated.set(address, m);
    }
    return m;
  }

  /**
   * Record a branch: prune it below the threshold, otherwise add its edge and
   * queue its node. A node already expanded is expanded again for a later
   * arrival, unless the value came back to an address it already passed
   * through, which is a cycle (see {@link returnsTo}). Value another address
   * passes back to the start address of a coin-null address start that read
   * every move in the window is a cycle at any size: the start node already
   * counts every move of that address. When the start node stopped before
   * reading every move, a return to the start address is expanded again even
   * where it passed through. With `hold`, the node ends there with that stop
   * instead of being queued.
   */
 /** An object is one indivisible unit; each id has its own edge and node. */
 private connectObject(job: Job, holder: string, from: string, to: string, row: MovedObjectValue, digest: string, tx: FetchedTx): void {
  if (job.share <= 0 || row.usd === null) return;
  this.connect(job, holder, "", from, to, {
   amount: 1n, traced: 1n, usd: Math.max(0, row.usd), basis: "object", digest, tx,
   object_id: row.object_id, object_type: row.type, object_tier: row.tier, object_estimate: row.estimate,
  });
 }

  private connect(
    job: Job,
    address: string,
    coin: string,
    from: string,
    to: string,
  e: {
   amount: bigint; traced: bigint; usd: number | null; basis: FlowBasis; digest: string; tx: FetchedTx;
   object_id?: string; object_type?: string; object_tier?: MovedObjectValue["tier"]; object_estimate?: boolean
  },
    hold?: { code: StopCode; detail: string },
  ): void {
    const tracedUsd = e.usd === null || e.amount === 0n ? null : e.usd * (Number((e.traced * 1_000_000n) / e.amount) / 1e6);
    // An address a poisoner built to imitate one the graph has already
    // reached is never pruned as dust: the small amount is the finding, and
    // a min_share/min_usd floor tuned for noise would otherwise hide it.
    const flaggedLookalike = this.seenAddresses.addAndCheck(address);
    const returned = this.startReadAll && address === this.startAddress && job.from !== null && job.from !== address;
    const below =
      !flaggedLookalike &&
      !returned &&
      (this.opts.minUsd !== null && tracedUsd !== null ? tracedUsd < this.opts.minUsd : job.share < this.opts.minShare);
    if (below) {
   this.pruned.push({
    address, coin_type: coin, share: job.share, usd: tracedUsd, digest: e.digest, traced: e.traced,
    ...(e.object_id ? { object_id: e.object_id, object_type: e.object_type } : {}),
   });
      this.ledger.add("below_threshold", { node: job.node, share: job.share, usd: tracedUsd });
      return;
    }
    const n = this.node(job.node, "address", address, coin, job.depth);
  if (e.object_id) {
   n.object_id = e.object_id;
   n.object_type = e.object_type;
   n.object_tier = e.object_tier;
   n.object_estimate = e.object_estimate;
  }
    n.share += job.share;
    n.traced += e.traced;
    if (tracedUsd !== null) n.usd = (n.usd ?? 0) + tracedUsd;
    const cp = e.tx.checkpoint;
    if (cp !== null && (n.arrivedAt === null || cp < n.arrivedAt)) n.arrivedAt = cp;
    this.edge(from, to, { ...e, coin, share: job.share, usd: e.usd });

    if (hold) {
      if (hold.code === "unspent") n.unspent = (n.unspent ?? 0n) + e.traced;
      if (hold.code === "budget" || hold.code === "read_failed") this.truncated = true;
      this.ledger.add(hold.code, { node: n.id, share: job.share, usd: tracedUsd, detail: hold.detail });
      return;
    }
    // The start node did not read every move of its address, so a return there is expanded, not a cycle.
    const unread = this.startCapped && address === this.startAddress;
    if (returned || (n.expanded && job.via && !unread && this.returnsTo(job.via, address))) {
      this.ledger.add("cycle", {
        node: n.id,
        share: job.share,
        usd: tracedUsd,
        detail: returned
          ? `Value returned to ${address}, the start address, whose moves the start node already counts.`
          : `Value returned to ${address}, which it had already passed through.`,
      });
      return;
    }
    const queued = this.frontier.get(n.id);
    if (queued) {
      queued.share += job.share;
      queued.need = queued.need === null || job.need === null ? null : queued.need + job.need;
      if ((job.arrival.checkpoint ?? Infinity) < (queued.arrival.checkpoint ?? Infinity)) queued.arrival = job.arrival;
      return;
    }
    this.frontier.set(n.id, job);
  }

  private edge(
    from: string,
    to: string,
  e: {
   amount: bigint; traced: bigint; usd: number | null; basis: FlowBasis; digest: string; tx: FetchedTx; coin: string; share: number;
   object_id?: string; object_type?: string; object_tier?: MovedObjectValue["tier"]; object_estimate?: boolean
  },
  ): void {
  const id = `${from}>${to}>${e.object_id ? `object:${e.object_id}:${e.digest}` : coinKey(e.coin || "none")}`;
    let edge = this.edges.get(id);
    if (!edge) {
      edge = {
        id,
        from,
        to,
        coin_type: e.coin,
    ...(e.object_id ? { object_id: e.object_id, object_type: e.object_type, object_tier: e.object_tier, object_estimate: e.object_estimate } : {}),
        amount: 0n,
        traced: 0n,
        share: 0,
        usd: null,
        basis: e.basis,
        digests: [],
        first_checkpoint: e.tx.checkpoint,
        first_time: e.tx.timestamp,
      };
      this.edges.set(id, edge);
      // The node this edge discovered: its target going forward, its source
      // (the payer) going backward.
      const [found, by] = this.opts.direction === "forward" ? [to, from] : [from, to];
      if (!this.parentOf.has(found)) this.parentOf.set(found, { edge: id, from: by });
    }
    if (!edge.digests.includes(e.digest)) {
      edge.digests.push(e.digest);
      edge.amount += e.amount;
      if (e.usd !== null) edge.usd = (edge.usd ?? 0) + e.usd;
    }
    edge.traced += e.traced;
    edge.share += e.share;
    if (e.tx.checkpoint !== null && (edge.first_checkpoint === null || e.tx.checkpoint < edge.first_checkpoint)) {
      edge.first_checkpoint = e.tx.checkpoint;
      edge.first_time = e.tx.timestamp;
    }
  }

  /**
   * Whether value reaching `address` through `via` left that address and came
   * back, read along the first-arrival chain into `via`.
   *
   * A leading run of nodes at `address` itself is the value changing coin
   * where it sits: a swap-follow edge stays at the holder, so that run does
   * not count as leaving. A conversion into a coin-node the address has
   * already expanded is therefore no cycle: such an arrival is expanded again
   * and draws on whatever the node's spends have left (`RemainingEntry`).
   */
  private returnsTo(via: string, address: string): boolean {
    const direction = this.opts.direction;
    let left = false;
    let at: string | undefined = via;
    for (let i = 0; at && i < 64; i++) {
      const n = this.nodes.get(at);
      if (n?.address !== address) left = true;
      else if (left) return true;
      if (direction === "forward") at = this.parentOf.get(at)?.from;
      else {
        // Backward edges point payer -> recipient, so the node that queued a
        // payer is the edge's target.
        const p = this.parentOf.get(at);
        at = p ? this.edges.get(p.edge)?.to : undefined;
        if (at === via) break;
      }
    }
    return false;
  }

  /** The shortest explored route from a root to `node`, in the direction the money moved. */
  pathFromRoot(node: string): PathStep[] {
    return shortestPath(node, this.edges.values(), this.roots, this.opts.direction);
  }

  /* ------------------------------------------------------------------ *
   * Reads
   * ------------------------------------------------------------------ */

 /** Record unvalued object movements once per transaction and object. */
 private noteUnvalued(entries: UnvaluedEntry[]): void {
  for (const e of entries) {
   const key = `${e.digest}:${e.object_id}`;
   if (this.unvaluedSeen.has(key)) continue;
   this.unvaluedSeen.add(key);
   this.unvaluedObjects.push({ digest: e.digest, object_id: e.object_id, type: e.type, reason: e.reason });
  }
 }

 /**
  * Full effects supply object versions, which the graph's ordinary
  * transaction read does not need. With `ifMoved`, a transaction whose
  * object changes moved nothing into or out of an address is not read. With
  * `holder`, only objects that address held before or after are valued: a
  * followed object's later transactions can move many other parties' objects.
  */
 private objectValues(digest: string, tx: FetchedTx, ifMoved = false, holder?: string): Promise<ObjectRead> {
  if (ifMoved && !tx.objectMovements?.some((m) => m.type && m.category !== "coin" && (m.from?.kind === "address" || m.to?.kind === "address"))) {
   return Promise.resolve(NO_OBJECTS);
  }
  const key = holder ? `${digest}|${holder}` : digest;
  let p = this.objects.get(key);
  if (!p) {
   p = (async (): Promise<ObjectRead> => {
    const read = await readMovedObjects([digest]);
    const t = read.txs[0];
    if (!t) {
     const reason = "The object's changed versions could not be read.";
     return {
      rows: [], movements: tx.objectMovements ?? [], unread: [{ what: digest, reason }],
      unvalued: unvaluedOf(digest, tx.objectMovements ?? [], [], new Map(), reason),
     };
     }
    // An object whose previous holder old effects did not record is resolved during valuation.
    const scoped = holder ? t.moved.filter((m) => m.from === holder || m.to === holder || (m.from === null && m.prior_version !== undefined)) : t.moved;
    const valued = await valueMovedObjects(scoped, t.checkpoint);
    const movements = t.movements ?? [];
    const unread = new Map(valued.unread.map((u) => [u.what, u.reason]));
    return { ...valued, movements, unvalued: unvaluedOf(digest, movements, valued.rows, unread) };
   })().catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    return { rows: [], movements: tx.objectMovements ?? [], unread: [{ what: digest, reason }], unvalued: unvaluedOf(digest, tx.objectMovements ?? [], [], new Map(), reason) };
   });
   this.objects.set(key, p);
  }
  return p;
 }

  private read(digest: string): Promise<FetchedTx | null> {
    let p = this.txCache.get(digest);
    if (!p) {
      this.txReads++;
      p = fetchTx(digest).then(async (tx) => {
        if (tx?.source === "archive") this.archiveReads++;
        // A coin outside the curated list is valued at its own decimals only
        // once they are loaded. Every coin the graph values or labels arrives
        // through a read, so they are loaded here, before `valuer` prices the
        // transaction and before trace_flow_graph formats a node or edge.
        if (tx) await prefetchCoinScale(tx.balanceChanges.map((b) => b.coin_type));
        return tx;
      });
      // A failed read is reported where it is used, as read_failed.
      p = p.catch(() => null);
      this.txCache.set(digest, p);
    }
    return p;
  }

  private async actions(digest: string, tx: FetchedTx): Promise<string[]> {
    const cached = this.decoded.get(digest);
    if (cached) return cached;
    await prefetchProtocolNames(collectPackageIds(tx.commands));
    const actions = decodeTransaction(tx.commands, tx.grpcBalanceChanges, tx.sender ?? undefined).actions;
    this.decoded.set(digest, actions);
    return actions;
  }

  /** A transaction's events with their JSON, read once per digest. Null when they could not be read. */
  private eventsOf(digest: string): Promise<SuiEventNode[] | null> {
    let p = this.eventCache.get(digest);
    if (!p) {
      p = (async () => {
        const gql = await fetchEventJson(digest);
        if (gql && gql.length > 0) {
          return gql.map((e) => ({ contents: { type: e.type ? { repr: e.type } : undefined, json: e.json } }));
        }
        // GraphQL can answer a pruned transaction without its events; the
        // archive's gRPC events carry their JSON.
        const r = await readAttackTransactions([digest]).catch(() => null);
        const t = r?.txs[0];
        return t ? t.events.map((e) => ({ contents: { type: { repr: e.type }, json: e.json } })) : null;
      })();
      this.eventCache.set(digest, p);
    }
    return p;
  }

  /** Far-side beneficiaries of a bridge exit, read from the transaction's own events. */
  private async beneficiariesOf(digest: string): Promise<{ beneficiaries: Beneficiary[]; unavailable?: string }> {
    const events = await this.eventsOf(digest);
    if (!events) {
      return { beneficiaries: [], unavailable: `The events of ${digest} could not be read; run resolve_bridge_transfer on it.` };
    }
    return { beneficiaries: readBridgeEvents(events, this.qualify).beneficiaries };
  }

  /**
   * Cross-chain message shapes in the events of a transaction that consumed
   * traced value, for up to {@link LEAD_READS} transactions per graph. A
   * transaction with no event from a package outside the plumbing is not read.
   */
  private async leadsOf(digest: string): Promise<CrossChainLead[]> {
    if (!this.leadDigests.has(digest)) {
      if (this.leadDigests.size >= LEAD_READS) return [];
      this.leadDigests.add(digest);
    }
    const tx = await this.read(digest);
    if (!tx?.eventTypes?.some((t) => !isPlumbingPackage(t.split("::")[0]))) return [];
    const events = await this.eventsOf(digest);
    return events ? crossChainLeads(events) : [];
  }

  /** Prices for a transaction's coins at its time, from the hourly cache. */
  private valuer(tx: FetchedTx): Promise<ValueUsd> {
    return this.valuerAt(
      tx.balanceChanges.map((b) => b.coin_type),
      tx.timestamp,
    );
  }

  /** Prices for `coins` at `timestamp`, or now when it is unknown, from the hourly cache. */
  private async valuerAt(coins: string[], timestamp: string | null | undefined): Promise<ValueUsd> {
    const ms = timestamp ? Date.parse(timestamp) : NaN;
    const points = await this.pricesAt(coins, Number.isNaN(ms) ? null : ms);
    return (c) => {
      const pp = points.get(coinKey(c.coin_type));
      if (!pp) return null;
      return usdValue(c.amount, pricingScale(c.coin_type, pp).decimals, pp.price);
    };
  }

  private async pricesAt(coins: string[], ms: number | null): Promise<Map<string, PricePoint>> {
    const bucket = ms === null ? -1 : Math.floor(ms / PRICE_BUCKET_MS);
    let entry = this.prices.get(bucket);
    if (!entry) {
      entry = { at: ms === null ? undefined : Math.floor(ms / 1000), points: new Map() };
      this.prices.set(bucket, entry);
    }
    const missing = [...new Set(coins.filter((c) => c && !entry!.points.has(coinKey(c)) && !this.unpriced.has(`${bucket}|${coinKey(c)}`)))];
    // A coin already requested for this hour waits on that request, so valuers started together send one.
    const waits: Array<Promise<void>> = [];
    const fresh: string[] = [];
    for (const c of missing) {
      const inFlight = this.priceRequests.get(`${bucket}|${coinKey(c)}`);
      if (inFlight) waits.push(inFlight);
      else fresh.push(c);
    }
    if (fresh.length > 0) {
      const points = entry.points;
      const request = priceUsdAtTime(fresh, entry.at)
        .catch(() => null)
        .then((res) => {
          for (const [ct, pp] of res?.points ?? []) points.set(coinKey(ct), pp);
          for (const u of res?.unpriced ?? []) this.unpriced.set(`${bucket}|${coinKey(u.coin_type)}`, u.reason);
          if (!res) for (const c of fresh) this.unpriced.set(`${bucket}|${coinKey(c)}`, "request_failed");
          for (const c of fresh) this.priceRequests.delete(`${bucket}|${coinKey(c)}`);
        });
      for (const c of fresh) this.priceRequests.set(`${bucket}|${coinKey(c)}`, request);
      waits.push(request);
    }
    await Promise.all(waits);
    return entry.points;
  }

  /** USD of part of a node's traced amount, at the price its arrivals were valued at. */
  private usdAt(amount: bigint | null, n: GraphNode): number | null {
    if (amount === null || n.traced === 0n || n.usd === null) return null;
    // The node's own USD per traced unit, from its arrivals.
    return n.usd * (Number((amount * 1_000_000n) / n.traced) / 1e6);
  }
}

/** Object values one transaction's effects give, with the raw movements. */
interface ObjectRead {
 rows: MovedObjectValue[];
 movements: ObjectMovement[];
 unread: Array<{ what: string; reason: string }>;
 unvalued: UnvaluedEntry[];
}

const NO_OBJECTS: ObjectRead = { rows: [], movements: [], unread: [], unvalued: [] };

/** An object movement into or out of an address that has no established value. */
interface UnvaluedEntry {
 digest: string;
 object_id: string;
 type: string | null;
 reason: string;
 from: string | null;
 to: string | null;
 /** Wrapped into or unwrapped from another object. */
 custody: boolean;
}

/** The address that holds an object directly, or null. */
function holderOf(ref: OwnerRef | null | undefined): string | null {
 return ref?.kind === "address" && ref.address ? normalizeSuiAddress(ref.address) : null;
}

/** Movements into or out of an address whose object has no priced value among `rows`, and every unpriced row. */
function unvaluedOf(
 digest: string, movements: ObjectMovement[], rows: MovedObjectValue[], unread: Map<string, string>,
 fallback = "No position reader returned a value for this object.",
): UnvaluedEntry[] {
 const byId = new Map(rows.filter((r) => !r.changed_in_place).map((r) => [r.object_id, r]));
 const out: UnvaluedEntry[] = [];
 for (const m of movements) {
  if (!m.type || m.category === "coin") continue;
  const from = holderOf(m.from);
  const to = holderOf(m.to);
  if ((!from && !to) || from === to) continue;
  const id = normalizeSuiAddress(m.object_id);
  const row = byId.get(id);
  if (row && row.usd !== null) continue;
  out.push({
   digest, object_id: id, type: m.type, from, to, custody: m.kind === "wrapped" || m.kind === "unwrapped",
   reason: unread.get(id) ?? (row ? (row.unpriced_reason ?? "The object's asset legs have no price.") : fallback),
  });
 }
 for (const r of byId.values()) {
  if (r.usd !== null || out.some((u) => u.object_id === r.object_id)) continue;
  out.push({
   digest, object_id: r.object_id, type: r.type, from: r.from, to: r.to, custody: r.custody === "wrapped" || r.custody === "unwrapped",
   reason: r.unpriced_reason ?? "The object's asset legs have no price.",
  });
 }
 return out;
}

/** USD an object gave up in a conversion (forward) or took in (backward); 0 when it did neither. */
function conversionValue(r: MovedObjectValue, forward: boolean): number {
 if (r.usd === null || r.custody) return 0;
 if (r.changed_in_place) return Math.max(0, forward ? -r.usd : r.usd);
 return (forward ? r.from !== null && r.to === null : r.to !== null && r.from === null) ? Math.max(0, r.usd) : 0;
}

/** One coin's part of one transaction a node drew on. */
interface Leg {
  /** Index into the scan's spends (forward) or inflows (backward). */
  spend: number;
  /** For an unreadable transaction, the split of its search row's balance changes. */
  split: Split;
  /** False when the transaction could not be read. */
  read: boolean;
  valuer: ValueUsd;
  /** The coin the leg moved. */
  coin: string | null;
  /** Raw amount of `coin` the leg moved. */
  amount: bigint;
  /** USD of the leg: what it moved, or with no price for that coin the priced side of its own branches. */
  value: number | null;
}

/** How an address-start root weighs its legs. */
interface RootPlan {
  /** Each leg's part of the root's share. */
  fractions: number[];
  /** The part of each leg's value the plan did not drop. */
  keep: number[];
  /** Every branch back to the start address, with the amount later legs moved again. */
  matched: Map<Branch, bigint>;
  /** Branches still open when a transaction whose balance changes could not all be read drew on them. */
  uncertain: ReadonlySet<Branch>;
}

/**
 * The conversions an address-start root made in place, open to its later
 * legs. The root reads every spend (or inflow) of every coin at its address,
 * so a conversion made there is counted twice when a later leg moves the
 * converted coin: forward, a spend of the proceeds; backward, an older inflow
 * of the coin that was paid in. Taking transactions in scan order, each leg
 * in a coin, readable or not, draws on the branches back to the address in
 * that coin opened before it, first opened first. A coin with no price is
 * valued at what its leg drew, before the leg is split.
 */
class RootPools {
  /** Every branch back to the start address, with the amount later legs drew. */
  readonly matched = new Map<Branch, bigint>();
  /** See {@link RootPlan.uncertain}. */
  readonly uncertain = new Set<Branch>();
  private readonly queues = new Map<string, Array<{ branch: Branch; left: bigint; value: number | null }>>();

  constructor(private readonly address: string) {}

  /** Draws what one transaction moved, and returns `base` with each coin that has no price valued at the rate its draws carried. */
  draw(base: ValueUsd, moves: Array<{ coin: string | null; amount: bigint }>): ValueUsd {
    const rates = new Map<string, { usd: number; amount: bigint }>();
    for (const { coin, amount } of moves) {
      const queue = coin ? this.queues.get(coinKey(coin)) : undefined;
      let rest = amount;
      while (coin && queue && queue.length > 0 && rest > 0n) {
        const head = queue[0];
        const take = head.left < rest ? head.left : rest;
        head.left -= take;
        rest -= take;
        this.matched.set(head.branch, this.matched.get(head.branch)! + take);
        if (head.value !== null) {
          const rate = rates.get(coinKey(coin)) ?? { usd: 0, amount: 0n };
          rate.usd += head.value * ratio(take, head.branch.amount);
          rate.amount += take;
          rates.set(coinKey(coin), rate);
        }
        if (head.left === 0n) queue.shift();
      }
    }
    return (c) => {
      const own = base(c);
      const rate = rates.get(coinKey(c.coin_type));
      return own ?? (rate && rate.amount > 0n ? rate.usd * ratio(BigInt(c.amount), rate.amount) : null);
    };
  }

  /** Marks every branch still open as possibly moved by a transaction the root could not read in full. */
  blind(): void {
    for (const queue of this.queues.values()) for (const entry of queue) this.uncertain.add(entry.branch);
  }

  /** Opens a transaction's branches back to the address, each valued at its part of its leg's value. */
  open(legs: Leg[]): void {
    for (const leg of legs) {
      for (const b of leg.split.branches) {
        if (b.address !== this.address) continue;
        this.matched.set(b, 0n);
        if (b.amount === 0n) continue;
        const entry = { branch: b, left: b.amount, value: leg.value === null ? null : leg.value * b.weight };
        const queue = this.queues.get(coinKey(b.coin_type));
        if (queue) queue.push(entry);
        else this.queues.set(coinKey(b.coin_type), [entry]);
      }
    }
  }
}

/** The part of a branch back to the start address that later legs moved again, or all of it when the branch carries no amount. */
function dropped(b: Branch, matched: bigint): number {
  return b.amount === 0n ? 1 : ratio(matched, b.amount);
}

/**
 * An address-start root's weight per leg: its value less what later legs
 * drew from its branches back to the address, normalized. What no leg drew is
 * still at the address in that coin and keeps its share. With no value
 * anywhere, `fallback` (the allocation's raw or equal weights) stands in.
 */
function rootPlan(legs: Leg[], pools: RootPools, fallback: number[]): RootPlan {
  const { matched } = pools;
  const keep = legs.map((leg) =>
    Math.max(0, 1 - leg.split.branches.reduce((s, b) => s + (matched.has(b) ? b.weight * dropped(b, matched.get(b)!) : 0), 0)),
  );
  // The last transaction's legs are never drawn on, so the equal weights always leave something.
  const bases = [...(legs.some((l) => l.value !== null) ? [legs.map((l) => l.value ?? 0)] : []), fallback, legs.map(() => 1)];
  const crossed = bases.map((base) => base.map((v, i) => v * keep[i])).find((c) => c.reduce((s, v) => s + v, 0) > 0) ?? keep;
  const total = crossed.reduce((s, v) => s + v, 0);
  return { fractions: crossed.map((v) => v / total), keep, matched, uncertain: pools.uncertain };
}

/** USD of a whole leg from the priced branches of its split, or null when none is priced. */
function pricedSide(split: Split, valueUsd: ValueUsd): number | null {
  let usd = 0;
  let weight = 0;
  for (const b of split.branches) {
    const u = valueUsd({ amount: b.amount.toString(), coin_type: b.coin_type });
    if (u === null) continue;
    usd += u;
    weight += b.weight;
  }
  return weight > 0 ? usd / weight : null;
}

/**
 * The part of a branch a leg passes on: all of it, or for an address-start
 * root's branch back to its own address, what no later leg moved again, which
 * is `held` at the start address, or `unknown` when a transaction the root
 * could not read in full may have moved it.
 */
function keptPart(b: Branch, plan: RootPlan | null, txFrac: number): { weight: number; traced: bigint; held: "held" | "unknown" | null } {
  const need = scaleAmount(b.amount, txFrac);
  const matched = plan?.matched.get(b);
  if (matched === undefined) return { weight: b.weight, traced: need, held: null };
  return { weight: b.weight * (1 - dropped(b, matched)), traced: need - scaleAmount(matched, txFrac), held: plan!.uncertain.has(b) ? "unknown" : "held" };
}

/** What each leg moved, for FIFO allocation, valued at its transaction's prices. */
function movesOf(legs: Leg[]): Array<{ amount: bigint; coin_type: string; usd: number | null }> {
  return legs.map((l) => {
    const coinType = l.coin ?? "";
    return { amount: l.amount, coin_type: coinType, usd: l.valuer({ amount: l.amount.toString(), coin_type: coinType }) };
  });
}

/** The readable transaction nearest to `i` in the scan. */
function nearestRead(txs: Array<FetchedTx | null>, i: number): FetchedTx | null {
  for (let d = 1; d < txs.length; d++) {
    const tx = txs[i - d] ?? txs[i + d];
    if (tx) return tx;
  }
  return null;
}

function gasOf(tx: FetchedTx): GasCharge {
  return { payer: tx.gasPayer ?? null, net: tx.netGas == null ? null : BigInt(tx.netGas) };
}

function mergeBeneficiaries(a: Beneficiary[], b: Beneficiary[]): Beneficiary[] {
  const out = [...a];
  for (const x of b) {
    const same = out.find((y) => y.protocol === x.protocol && (y.account ?? y.address) === (x.account ?? x.address));
    if (!same) out.push({ ...x });
    else if (same.amount && x.amount && /^\d+$/.test(same.amount) && /^\d+$/.test(x.amount)) {
      same.amount = (BigInt(same.amount) + BigInt(x.amount)).toString();
    }
  }
  return out;
}
