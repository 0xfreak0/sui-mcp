/**
 * Breadth-first fund-flow graph over (address, coin) nodes, on the hop
 * machinery `trace_funds` uses: the same transaction read, the same searches
 * for an address's next spend or earlier inflow, the same stops (sinks,
 * bridges, hubs, signer substitution). Where `trace_funds` picks one branch,
 * this follows every branch and allocates the traced value between them.
 *
 * Level by level, so every inflow found at one depth reaches a node before
 * that node is expanded; `find_flow_path` alternates levels of a forward and a
 * backward engine. The split and accounting rules are pure, in `flow-graph.ts`.
 */

import { prefetchProtocolNames } from "../protocols/registry.js";
import { collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { getNetwork } from "../config.js";
import { detectBridges, type BridgeHit } from "./bridge/detect.js";
import { readBridgeEvents, sameForeignAddress } from "./bridge/exits.js";
import type { Beneficiary } from "./bridge/beneficiary.js";
import type { SuiEventNode } from "./bridge/wormhole.js";
import { fetchEventJson } from "./event-json.js";
import { readAttackTransactions } from "./attack-read.js";
import { measureFanout, type FanoutResult } from "./fanout.js";
import { getLabel, isSink } from "./labels.js";
import { assignSignerRoles } from "./multisig.js";
import { priceUsdAtTime, pricingScale, usdValue, type PricePoint } from "./valuation.js";
import { coinKey, type GasCharge } from "./trace-hop.js";
import {
  backwardDeadEnd,
  callTarget,
  fetchTx,
  forwardDeadEnd,
  HUB_SCAN_TRANSACTIONS,
  isPassThroughAddress,
  noInflowReason,
  noSpendReason,
  scanForwardSpends,
  scanPriorInflows,
  type FetchedTx,
  type SearchWindow,
} from "./trace-read.js";
import {
  allocateFifo,
  nodeId,
  pathTo,
  scaleAmount,
  splitInflow,
  splitOrigin,
  splitOriginBackward,
  splitSpend,
  TerminalLedger,
  type FlowBasis,
  type PathStep,
  type Split,
  type StopCode,
  type ValueUsd,
} from "./flow-graph.js";

/** Spends (forward) or inflows (backward) read per node expansion. */
export const MOVES_PER_NODE = 20;
/**
 * The same for an address the caller started from. It has no traced amount to
 * cover, so every move in the window counts, and an attacker's wallet makes
 * hundreds of them.
 */
export const MOVES_PER_START_ADDRESS = 100;
/** Expansions of one node: a wallet that receives the traced coin several times is expanded once per arrival. */
const EXPANSIONS_PER_NODE = 4;

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

export type NodeKind = "origin_tx" | "address" | "bridge_exit" | "consumed" | "source";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  address: string | null;
  coin_type: string | null;
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
  /** Held by the node when the walk ended, in `coin_type`. */
  unspent?: bigint;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
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
  share: number;
  usd: number | null;
  digest: string;
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
  txReads = 0;
  archiveReads = 0;
  expandedNodes = 0;
  depthReached = 0;
  /** Nodes left in the frontier or refused for a limit, so a caller can say the graph is partial. */
  truncated = false;
  readonly unpriced = new Map<string, string>();

  private level: Job[] = [];
  private next = new Map<string, Job>();
  private readonly txCache = new Map<string, Promise<FetchedTx | null>>();
  private readonly decoded = new Map<string, string[]>();
  private readonly allocated = new Map<string, Set<string>>();
  private readonly expansions = new Map<string, number>();
  private readonly hubChecked = new Map<string, FanoutResult | null>();
  private readonly prices = new Map<number, { at: number | undefined; points: Map<string, PricePoint> }>();
  private readonly exitCache = new Map<string, Promise<{ beneficiaries: Beneficiary[]; unavailable?: string }>>();
  private readonly qualify = getNetwork() === "mainnet";

  constructor(readonly opts: EngineOptions) {}

  get frontierSize(): number {
    return this.level.length + this.next.size;
  }

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

    for (const b of split.branches) {
      const job: Job = {
        node: nodeId(b.address, b.coin_type),
        share: b.weight,
        need: b.amount,
        arrival: { digest, checkpoint: tx.checkpoint ?? undefined },
        depth: 0,
        from: tx.sender,
        via: origin.id,
      };
      const usd = valueUsd({ amount: b.amount.toString(), coin_type: b.coin_type });
      this.connect(job, b.address, b.coin_type, forward ? origin.id : job.node, forward ? job.node : origin.id, {
        amount: b.amount,
        traced: b.amount,
        usd,
        basis: b.basis,
        digest,
        tx,
      });
    }
    if (split.branches.length === 0) {
      // Credited nobody (forward) or paid by nobody (backward): the start is
      // itself a bridge exit, a deposit or burn, a mint or a withdrawal.
      const actions = await this.actions(digest, tx);
      const hits = detectBridges(tx.callSites, tx.eventTypes ?? []);
      if (forward && tx.sender) {
        const spend = splitSpend({ sender: tx.sender, holder: tx.sender, changes: tx.balanceChanges, actions, trackedCoin: this.opts.coin, gas, valueUsd, bridgeExit: hits.length > 0 });
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
    const id = nodeId(address, this.opts.coin);
    const n = this.node(id, "address", address, this.opts.coin, 0);
    this.roots.push(n.id);
    this.next.set(id, { node: id, share: 1, need: null, arrival: {}, depth: 0, from: null, via: null });
    n.share = 1;
  }

  /* ------------------------------------------------------------------ *
   * Levels
   * ------------------------------------------------------------------ */

  /** Expand every queued node one level. False when nothing was left to expand. */
  async expandLevel(): Promise<boolean> {
    if (this.next.size === 0) return false;
    this.level = [...this.next.values()].sort((a, b) => b.share - a.share);
    this.next = new Map();
    for (const job of this.level) {
      this.depthReached = Math.max(this.depthReached, job.depth);
      try {
        if (this.opts.direction === "forward") await this.expandForward(job);
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
    }
    this.level = [];
    return true;
  }

  async run(): Promise<void> {
    while (await this.expandLevel()) {
      /* level by level until the frontier is empty or every node hits a limit */
    }
  }

  /** Nodes whose expansion was refused, for find_flow_path to stop early. */
  get pending(): number {
    return this.next.size;
  }

  /* ------------------------------------------------------------------ *
   * Node checks shared by both directions
   * ------------------------------------------------------------------ */

  /** Decide whether a job's node ends here. Returns the stop, or null to expand. */
  private async gate(job: Job, n: GraphNode): Promise<{ code: StopCode; detail: string; nodeLevel: boolean } | null> {
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
      return { code: "sink", detail: `${label?.label ?? address} (${label?.category ?? "sink"}).`, nodeLevel: true };
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
      return { code: "budget", detail: `Node limit (${this.opts.maxNodes}) reached before expanding it.`, nodeLevel: false };
    }
    if ((this.expansions.get(n.id) ?? 0) >= EXPANSIONS_PER_NODE) {
      return { code: "budget", detail: `Expanded ${EXPANSIONS_PER_NODE} times already; later arrivals were not followed.`, nodeLevel: false };
    }
    if (this.txReads >= this.opts.maxTxReads) {
      return { code: "budget", detail: `Transaction read limit (${this.opts.maxTxReads}) reached before expanding it.`, nodeLevel: false };
    }
    // A new party is measured before its moves are attributed to these funds.
    // The same actor continuing (a swap, a self-credit) is the subject, not a
    // new party; neither is the address the caller started from.
    if (job.from !== null && job.from !== address) {
      let fanout = this.hubChecked.get(address);
      if (fanout === undefined) {
        fanout = await measureFanout(address, HUB_SCAN_TRANSACTIONS).catch(() => null);
        this.hubChecked.set(address, fanout);
      }
      if (fanout && fanout.classification !== "narrow") {
        return {
          code: "hub",
          detail:
            `A ${fanout.classification}: ${fanout.counterparty_count}${fanout.truncated ? "+" : ""} counterparties in its last ` +
            `${fanout.scanned_transactions} transactions. Attribute it (manage_labels, classify_deposit_address) rather than walking past it.`,
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
    if (stop.code === "budget") this.truncated = true;
    this.ledger.add(stop.code, {
      node: n.id,
      share: job.share,
      usd: this.usdAt(job.need, n),
      detail: stop.nodeLevel ? undefined : stop.detail,
    });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Forward
   * ------------------------------------------------------------------ */

  private async expandForward(job: Job): Promise<void> {
    const n = this.nodes.get(job.node)!;
    if (await this.stopJob(job, n)) return;
    const address = n.address!;
    const coin = n.coin_type;
    const done = this.allocatedFor(n.id);

    const scan = await scanForwardSpends(address, job.arrival.checkpoint, coin, done, job.arrival.digest, {
      ...(job.need !== null ? { need: job.need } : {}),
      maxSpends: job.need === null ? MOVES_PER_START_ADDRESS : MOVES_PER_NODE,
      window: this.opts.window,
    });
    this.markExpanded(n);

    if (scan.spends.length === 0) {
      const code: StopCode = scan.exhausted ? "unspent" : "budget";
      if (code === "budget") this.truncated = true;
      if (job.need !== null) n.unspent = (n.unspent ?? 0n) + job.need;
      this.ledger.add(code, {
        node: n.id,
        share: job.share,
        usd: this.usdAt(job.need, n),
        detail: noSpendReason(address, coin, scan),
      });
      return;
    }

    const txs = await Promise.all(scan.spends.map((s) => this.read(s.tx.digest)));
    const splits: Array<Split | null> = [];
    const valuers: Array<ValueUsd | null> = [];
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      if (!tx) {
        splits.push(null);
        valuers.push(null);
        continue;
      }
      const valueUsd = await this.valuer(tx);
      valuers.push(valueUsd);
      // Decoding prefetches the packages' protocol names, which the
      // registry tier of bridge detection reads.
      const actions = await this.actions(scan.spends[i].tx.digest, tx);
      splits.push(
        splitSpend({
          sender: tx.sender,
          holder: address,
          changes: tx.balanceChanges,
          actions,
          trackedCoin: coin,
          gas: gasOf(tx),
          valueUsd,
          bridgeExit: detectBridges(tx.callSites, tx.eventTypes ?? []).length > 0,
        }),
      );
    }
    const alloc = allocateFifo(movesOf(scan.spends.map((s) => s.spent), splits, valuers, coin), job.need);

    for (let i = 0; i < scan.spends.length; i++) {
      const digest = scan.spends[i].tx.digest;
      done.add(digest);
      const share = job.share * alloc.fractions[i];
      if (share <= 0) continue;
      const tx = txs[i];
      const split = splits[i];
      if (!tx || !split) {
        this.truncated = true;
        this.ledger.add("read_failed", { node: n.id, share, usd: null, detail: `Could not read ${digest} from the fullnode or the archive.` });
        continue;
      }
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
      const traced = alloc.allocated[i];
      const txFrac = split.total > 0n ? Math.min(1, Number((traced * 1_000_000n) / split.total) / 1e6) : 0;
      const valueUsd = valuers[i]!;
      for (const b of split.branches) {
        const need = scaleAmount(b.amount, txFrac);
        const target = nodeId(b.address, b.coin_type);
        this.connect(
          { node: target, share: share * b.weight, need, arrival: { digest, checkpoint: tx.checkpoint ?? undefined }, depth: job.depth + 1, from: address, via: n.id },
          b.address,
          b.coin_type,
          n.id,
          target,
          { amount: b.amount, traced: need, usd: valueUsd({ amount: b.amount.toString(), coin_type: b.coin_type }), basis: b.basis, digest, tx },
        );
      }
      if (split.unallocated > 0) {
        const hits = detectBridges(tx.callSites, tx.eventTypes ?? []);
        const amount = scaleAmount(split.total, split.unallocated);
        const usd = valueUsd({ amount: amount.toString(), coin_type: split.coin_type ?? "" });
        await this.terminalOut(n.id, address, tx, digest, hits, share * split.unallocated, amount, scaleAmount(amount, txFrac), split.coin_type ?? "", usd);
      }
    }

    if (alloc.remaining > 0) {
      const code: StopCode = scan.satisfied ? "budget" : scan.exhausted ? "unspent" : "budget";
      if (code === "budget") this.truncated = true;
      const left = job.need === null ? null : scaleAmount(job.need, alloc.remaining);
      if (left !== null && code === "unspent") n.unspent = (n.unspent ?? 0n) + left;
      this.ledger.add(code, {
        node: n.id,
        share: job.share * alloc.remaining,
        usd: this.usdAt(left, n),
        detail:
          code === "unspent"
            ? `${address} has moved only part of the traced amount since receiving it; the rest is still there.`
            : `${address}'s first ${scan.spends.length} spend(s) did not account for the whole traced amount, and the search stopped at that limit.`,
      });
    }
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
      exit.beneficiaries = mergeBeneficiaries(exit.beneficiaries ?? [], beneficiaries);
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
    this.edge(from, id, { amount, traced, usd, basis: "consumed", digest, tx, coin, share });
    record(c);
    this.ledger.add("consumed", { node: id, share, usd: tracedUsd });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Backward
   * ------------------------------------------------------------------ */

  private async expandBackward(job: Job): Promise<void> {
    const n = this.nodes.get(job.node)!;
    if (await this.stopJob(job, n)) return;
    const address = n.address!;
    const coin = n.coin_type;
    const done = this.allocatedFor(n.id);

    // An address start explains every inflow up to the limit: no amount to cover.
    const need = job.need ?? (1n << 255n);
    const scan = await scanPriorInflows(address, job.arrival.checkpoint, coin, done, job.arrival.digest, need, {
      maxInflows: job.need === null ? MOVES_PER_START_ADDRESS : MOVES_PER_NODE,
      window: this.opts.window,
    });
    this.markExpanded(n);

    if (scan.found.length === 0) {
      const code: StopCode = scan.exhausted ? "source" : "budget";
      if (code === "budget") this.truncated = true;
      this.ledger.add(code, {
        node: n.id,
        share: job.share,
        usd: this.usdAt(job.need, n),
        detail: noInflowReason(address, coin, scan),
      });
      return;
    }

    const txs = await Promise.all(scan.found.map((f) => this.read(f.tx.digest)));
    const splits: Array<Split | null> = [];
    const valuers: Array<ValueUsd | null> = [];
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      if (!tx) {
        splits.push(null);
        valuers.push(null);
        continue;
      }
      const valueUsd = await this.valuer(tx);
      valuers.push(valueUsd);
      splits.push(
        splitInflow({
          sender: tx.sender,
          recipient: address,
          changes: tx.balanceChanges,
          actions: await this.actions(scan.found[i].tx.digest, tx),
          trackedCoin: coin,
          isPassThrough: isPassThroughAddress,
          gas: gasOf(tx),
          valueUsd,
        }),
      );
    }
    const alloc = allocateFifo(movesOf(scan.found.map((f) => f.received), splits, valuers, coin), job.need);

    for (let i = 0; i < scan.found.length; i++) {
      const digest = scan.found[i].tx.digest;
      done.add(digest);
      const share = job.share * alloc.fractions[i];
      if (share <= 0) continue;
      const tx = txs[i];
      const split = splits[i];
      if (!tx || !split) {
        this.truncated = true;
        this.ledger.add("read_failed", { node: n.id, share, usd: null, detail: `Could not read ${digest} from the fullnode or the archive.` });
        continue;
      }
      const txFrac = split.total > 0n ? Math.min(1, Number((alloc.allocated[i] * 1_000_000n) / split.total) / 1e6) : 0;
      const valueUsd = valuers[i]!;
      for (const b of split.branches) {
        const needHere = scaleAmount(b.amount, txFrac);
        const payer = nodeId(b.address, b.coin_type);
        this.connect(
          { node: payer, share: share * b.weight, need: needHere, arrival: { digest, checkpoint: tx.checkpoint ?? undefined }, depth: job.depth + 1, from: address, via: n.id },
          b.address,
          b.coin_type,
          payer,
          n.id,
          { amount: b.amount, traced: needHere, usd: valueUsd({ amount: b.amount.toString(), coin_type: b.coin_type }), basis: b.basis, digest, tx },
        );
      }
      if (split.unallocated > 0) {
        const hits = detectBridges(tx.callSites, tx.eventTypes ?? []);
        const code: StopCode = hits.length ? "bridge_entry" : "source";
        const from = hits.length
          ? `entry:${[...new Set(hits.map((h) => h.protocol))].sort().join("+")}`
          : `source:${[...new Set(tx.callSites.map(callTarget))].slice(0, 3).join("+") || "none"}`;
        const src = this.node(from, "source", null, null, 0);
        if (hits.length) src.protocols = [...new Set(hits.map((h) => h.protocol))].sort();
        src.detail = backwardDeadEnd(tx, address, split.coin_type);
        const amount = scaleAmount(split.total, split.unallocated);
        const usd = valueUsd({ amount: amount.toString(), coin_type: split.coin_type ?? "" });
        const srcShare = share * split.unallocated;
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
        share: job.share * alloc.remaining,
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

  private allocatedFor(id: string): Set<string> {
    let s = this.allocated.get(id);
    if (!s) {
      s = new Set();
      this.allocated.set(id, s);
    }
    return s;
  }

  /**
   * Record a branch: prune it below the threshold, otherwise add its edge and
   * queue its node. A node already expanded is expanded again for a later
   * arrival, unless the value came back to an address it already passed
   * through, which is a cycle.
   */
  private connect(
    job: Job,
    address: string,
    coin: string,
    from: string,
    to: string,
    e: { amount: bigint; traced: bigint; usd: number | null; basis: FlowBasis; digest: string; tx: FetchedTx },
  ): void {
    const tracedUsd = e.usd === null || e.amount === 0n ? null : e.usd * (Number((e.traced * 1_000_000n) / e.amount) / 1e6);
    const below =
      this.opts.minUsd !== null && tracedUsd !== null ? tracedUsd < this.opts.minUsd : job.share < this.opts.minShare;
    if (below) {
      this.pruned.push({ address, coin_type: coin, share: job.share, usd: tracedUsd, digest: e.digest });
      this.ledger.add("below_threshold", { node: job.node, share: job.share, usd: tracedUsd });
      return;
    }
    const n = this.node(job.node, "address", address, coin, job.depth);
    n.share += job.share;
    n.traced += e.traced;
    if (tracedUsd !== null) n.usd = (n.usd ?? 0) + tracedUsd;
    const cp = e.tx.checkpoint;
    if (cp !== null && (n.arrivedAt === null || cp < n.arrivedAt)) n.arrivedAt = cp;
    this.edge(from, to, { ...e, coin, share: job.share, usd: e.usd });

    if (n.expanded && job.via && this.addressesUpstream(job.via).has(address)) {
      this.ledger.add("cycle", {
        node: n.id,
        share: job.share,
        usd: tracedUsd,
        detail: `Value returned to ${address}, which it had already passed through.`,
      });
      return;
    }
    const queued = this.next.get(n.id);
    if (queued) {
      queued.share += job.share;
      queued.need = queued.need === null || job.need === null ? null : queued.need + job.need;
      if ((job.arrival.checkpoint ?? Infinity) < (queued.arrival.checkpoint ?? Infinity)) queued.arrival = job.arrival;
      return;
    }
    this.next.set(n.id, job);
  }

  private edge(
    from: string,
    to: string,
    e: { amount: bigint; traced: bigint; usd: number | null; basis: FlowBasis; digest: string; tx: FetchedTx; coin: string; share: number },
  ): void {
    const id = `${from}>${to}>${coinKey(e.coin || "none")}`;
    let edge = this.edges.get(id);
    if (!edge) {
      edge = {
        id,
        from,
        to,
        coin_type: e.coin,
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

  /** Addresses on the first-arrival chain into `id`, `id`'s own included. */
  private addressesUpstream(id: string): Set<string> {
    const out = new Set<string>();
    const direction = this.opts.direction;
    let at: string | undefined = id;
    for (let i = 0; at && i < 64; i++) {
      const n = this.nodes.get(at);
      if (n?.address) out.add(n.address);
      if (direction === "forward") at = this.parentOf.get(at)?.from;
      else {
        // Backward edges point payer -> recipient, so the node that queued a
        // payer is the edge's target.
        const p = this.parentOf.get(at);
        at = p ? this.edges.get(p.edge)?.to : undefined;
        if (at === id) break;
      }
    }
    return out;
  }

  /** Edges from a root to `node`, in the direction the money moved. */
  pathFromRoot(node: string): PathStep[] {
    if (this.opts.direction === "forward") return pathTo(node, this.parentOf);
    // Backward: the parent of a payer is the recipient it paid toward the root.
    const steps: PathStep[] = [];
    const seen = new Set<string>([node]);
    let at = node;
    for (let i = 0; i < 64; i++) {
      const p = this.parentOf.get(at);
      const edge = p ? this.edges.get(p.edge) : undefined;
      if (!edge || seen.has(edge.to)) break;
      steps.push({ from: edge.from, to: edge.to, edge: edge.id });
      seen.add(edge.to);
      at = edge.to;
    }
    return steps;
  }

  /* ------------------------------------------------------------------ *
   * Reads
   * ------------------------------------------------------------------ */

  private read(digest: string): Promise<FetchedTx | null> {
    let p = this.txCache.get(digest);
    if (!p) {
      this.txReads++;
      p = fetchTx(digest).then((tx) => {
        if (tx?.source === "archive") this.archiveReads++;
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

  /** Far-side beneficiaries of a bridge exit, read from the transaction's own events. */
  private beneficiariesOf(digest: string): Promise<{ beneficiaries: Beneficiary[]; unavailable?: string }> {
    let p = this.exitCache.get(digest);
    if (!p) {
      p = (async () => {
        let events: SuiEventNode[] | null = null;
        const gql = await fetchEventJson(digest);
        if (gql && gql.length > 0) {
          events = gql.map((e) => ({ contents: { type: e.type ? { repr: e.type } : undefined, json: e.json } }));
        } else {
          // GraphQL can answer a pruned transaction without its events; the
          // archive's gRPC events carry their JSON.
          const r = await readAttackTransactions([digest]).catch(() => null);
          const t = r?.txs[0];
          if (t) events = t.events.map((e) => ({ contents: { type: { repr: e.type }, json: e.json } }));
        }
        if (!events) {
          return { beneficiaries: [], unavailable: `The events of ${digest} could not be read; run resolve_bridge_transfer on it.` };
        }
        return { beneficiaries: readBridgeEvents(events, this.qualify).beneficiaries };
      })();
      this.exitCache.set(digest, p);
    }
    return p;
  }

  /** Prices for a transaction's coins at its time, from the hourly cache. */
  private async valuer(tx: FetchedTx): Promise<ValueUsd> {
    const ms = tx.timestamp ? Date.parse(tx.timestamp) : NaN;
    const points = await this.pricesAt(
      tx.balanceChanges.map((b) => b.coin_type),
      Number.isNaN(ms) ? null : ms,
    );
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
    if (missing.length > 0) {
      const res = await priceUsdAtTime(missing, entry.at).catch(() => null);
      for (const [ct, pp] of res?.points ?? []) entry.points.set(coinKey(ct), pp);
      for (const u of res?.unpriced ?? []) this.unpriced.set(`${bucket}|${coinKey(u.coin_type)}`, u.reason);
      if (!res) for (const c of missing) this.unpriced.set(`${bucket}|${coinKey(c)}`, "request_failed");
    }
    return entry.points;
  }

  /** USD of part of a node's traced amount, at the price its arrivals were valued at. */
  private usdAt(amount: bigint | null, n: GraphNode): number | null {
    if (amount === null || n.traced === 0n || n.usd === null) return null;
    // The node's own USD per traced unit, from its arrivals.
    return n.usd * (Number((amount * 1_000_000n) / n.traced) / 1e6);
  }
}

/** What each transaction moved, for FIFO allocation: the split's measure, or the search's when the read failed. */
function movesOf(
  scanned: bigint[],
  splits: Array<Split | null>,
  valuers: Array<ValueUsd | null>,
  coin: string | null,
): Array<{ amount: bigint; coin_type: string; usd: number | null }> {
  return scanned.map((amount, i) => {
    const split = splits[i];
    const moved = split && split.total > 0n ? split.total : amount;
    const coinType = split?.coin_type ?? coin ?? "";
    return { amount: moved, coin_type: coinType, usd: valuers[i]?.({ amount: moved.toString(), coin_type: coinType }) ?? null };
  });
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
