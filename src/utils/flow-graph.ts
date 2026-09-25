/**
 * Pure logic for a multi-branch fund-flow graph: how one transaction splits
 * the traced value between the parties it paid, and how the graph keeps
 * account of where every share of the traced value ended.
 *
 * `trace_funds` follows one branch and lists the rest as unfollowed.
 * Splitting funds across wallets is the ordinary laundering move, so the
 * graph follows every branch and allocates the traced value between them in
 * proportion to what each received. The network reads live in
 * `flow-engine.ts`; nothing here touches the chain.
 */

import { coinKey, isSwapHop, sameCoin, withoutGas, type GasCharge, type HopChange } from "./trace-hop.js";

/** How a branch received its share. */
export type FlowBasis =
  /** Received the tracked coin directly. */
  | "direct"
  /** The holder swapped the tracked coin and kept the proceeds. */
  | "swap-follow"
  /** The holder, or another party, received a different asset for the tracked one. */
  | "conversion"
  /** Credited by the starting transaction. */
  | "origin"
  /** Paid the tracked coin in (backward). */
  | "inflow"
  /** Value that went into a bridge, a protocol object or a burn. */
  | "consumed";

export interface Branch {
  address: string;
  coin_type: string;
  /**
   * What this party received (forward) or paid (backward), raw units,
   * positive. For a swap or conversion, the part of the proceeds bought with
   * the traced coin.
   */
  amount: bigint;
  /** Fraction of the split transaction's traced value this branch carries. */
  weight: number;
  basis: FlowBasis;
}

export interface Split {
  /** The coin the split was measured in: the tracked one, or the one picked when none was. */
  coin_type: string | null;
  /** Forward: the holder's outflow of the coin. Backward: the recipient's inflow. */
  total: bigint;
  branches: Branch[];
  /**
   * Fraction of the traced value no address took (forward: burned, bridged or
   * locked in an object) or that no address paid (backward: minted, withdrawn
   * from a protocol, claimed from a bridge).
   */
  unallocated: number;
  /** How branch weights across different assets were compared. */
  weighting: Weighting;
}

export type Weighting = "usd" | "raw" | "equal";

/** USD value of an amount of a coin, or null when the coin has no price. */
export type ValueUsd = (c: { amount: string; coin_type: string }) => number | null;

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * Relative weights of several amounts.
 *
 * USD when every item has a price, since raw units of different coins do not
 * compare (1 USDC is 1e6 units, 1 SUI 1e9). Raw magnitude when they are all
 * one coin. With a mix, the priced items share the weight and an unpriced coin
 * next to them carries none: a coin nobody quotes has no measurable value,
 * the rule funding detection applies to unpriced inflows. With nothing priced
 * across several coins there is no comparison at all, and the split is equal.
 */
export function valueWeights(
  items: Array<{ amount: bigint; coin_type: string; usd?: number | null }>,
  valueUsd: ValueUsd = () => null,
): { weights: number[]; weighting: Weighting } {
  if (items.length === 0) return { weights: [], weighting: "raw" };
  if (items.length === 1) return { weights: [1], weighting: "raw" };
  const usd = items.map((i) =>
    i.usd !== undefined ? i.usd : valueUsd({ amount: abs(i.amount).toString(), coin_type: i.coin_type }),
  );
  const usdTotal = usd.reduce<number>((s, u) => s + (u ?? 0), 0);
  const oneCoin = items.every((i) => sameCoin(i.coin_type, items[0].coin_type));
  if (usd.every((u) => u !== null) && usdTotal > 0) {
    return { weights: usd.map((u) => (u as number) / usdTotal), weighting: "usd" };
  }
  if (oneCoin) {
    const total = items.reduce((s, i) => s + abs(i.amount), 0n);
    if (total > 0n) return { weights: items.map((i) => ratio(abs(i.amount), total)), weighting: "raw" };
  }
  if (usdTotal > 0) return { weights: usd.map((u) => (u ?? 0) / usdTotal), weighting: "usd" };
  return { weights: items.map(() => 1 / items.length), weighting: "equal" };
}

/** `a / b` as a float, exact enough for amounts past 2^53. */
export function ratio(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  // Scale to 1e12 in integer space first, then divide in floating point.
  return Number((a * 1_000_000_000_000n) / b) / 1e12;
}

/** `amount × fraction` in raw units, rounding down. */
export function scaleAmount(amount: bigint, fraction: number): bigint {
  if (fraction >= 1) return amount;
  if (fraction <= 0) return 0n;
  return (amount * BigInt(Math.round(fraction * 1e12))) / 1_000_000_000_000n;
}

/** The coin of a party's largest-value change of one sign, for a split with no tracked coin. */
function dominantCoin(
  changes: HopChange[],
  address: string,
  sign: 1 | -1,
  valueUsd: ValueUsd,
): string | null {
  const mine = changes.filter((c) => c.address === address && (sign > 0 ? BigInt(c.amount) > 0n : BigInt(c.amount) < 0n));
  if (mine.length === 0) return null;
  const { weights } = valueWeights(
    mine.map((c) => ({ amount: BigInt(c.amount), coin_type: c.coin_type })),
    valueUsd,
  );
  let best = 0;
  for (let i = 1; i < mine.length; i++) {
    if (weights[i] > weights[best]) best = i;
    else if (weights[i] === weights[best] && abs(BigInt(mine[i].amount)) > abs(BigInt(mine[best].amount))) best = i;
  }
  return mine[best].coin_type;
}

function netOf(changes: HopChange[], address: string, coin: string): bigint {
  return changes
    .filter((c) => c.address === address && sameCoin(c.coin_type, coin))
    .reduce((s, c) => s + BigInt(c.amount), 0n);
}

/**
 * Forward: where the `holder`'s outflow of the tracked coin went on one
 * transaction.
 *
 * Recipients of the tracked coin take their share first, in proportion to
 * what each received. What the holder spent beyond that was either turned into
 * another asset (the holder's own swap or conversion when it sent the
 * transaction, or another party paid a different coin for it) or reached no
 * address (a bridge burn, a protocol deposit, a burn), which is `unallocated`.
 * On a bridge exit the remainder is always the exit. Gas is removed first:
 * the payer's SUI change includes it.
 */
export function splitSpend(params: {
  sender: string | null;
  holder: string;
  changes: HopChange[];
  actions: string[];
  trackedCoin: string | null;
  gas?: GasCharge;
  valueUsd?: ValueUsd;
  /**
   * The transaction carries a bridge marker. What no address received was
   * burned or locked for the far side, so a relayer's gas drop or a fee paid
   * in another coin is not a conversion of it.
   */
  bridgeExit?: boolean;
}): Split {
  const valueUsd = params.valueUsd ?? (() => null);
  const { holder, sender } = params;
  const cs = withoutGas(params.changes, params.gas);
  const coin = params.trackedCoin ?? dominantCoin(cs, holder, -1, valueUsd);
  const empty: Split = { coin_type: coin, total: 0n, branches: [], unallocated: 0, weighting: "raw" };
  if (!coin) return empty;
  const net = netOf(cs, holder, coin);
  if (net >= 0n) return empty;
  const spent = -net;

  const recipients = cs.filter((c) => c.address !== holder && BigInt(c.amount) > 0n && sameCoin(c.coin_type, coin));
  const received = recipients.reduce((s, c) => s + BigInt(c.amount), 0n);
  const base = received > spent ? received : spent;
  const branches: Branch[] = recipients.map((c) => ({
    address: c.address,
    coin_type: c.coin_type,
    amount: BigInt(c.amount),
    weight: ratio(BigInt(c.amount), base),
    basis: "direct",
  }));
  let weighting: Weighting = "raw";
  let unallocated = received >= spent ? 0 : ratio(spent - received, spent);

  if (unallocated > 0 && !params.bridgeExit) {
    const gains =
      holder === sender
        ? cs.filter((c) => c.address === holder && BigInt(c.amount) > 0n && !sameCoin(c.coin_type, coin))
        : [];
    const others = cs.filter((c) => c.address !== holder && BigInt(c.amount) > 0n && !sameCoin(c.coin_type, coin));
    const into = gains.length > 0 ? gains : others;
    if (into.length > 0) {
      // Proceeds bought with several inputs belong to the traced coin only in
      // proportion to its part of what went in: a swap that spent 0.1 SUI and
      // 18,000 USDT for 18,000 USDC did not turn the SUI into 18,000 USDC.
      const otherInputs = cs.filter((c) => c.address === holder && BigInt(c.amount) < 0n && !sameCoin(c.coin_type, coin));
      const inputShare = valueWeights(
        [{ amount: spent - received, coin_type: coin }, ...otherInputs.map((c) => ({ amount: -BigInt(c.amount), coin_type: c.coin_type }))],
        valueUsd,
      ).weights[0];
      const w = valueWeights(into.map((c) => ({ amount: BigInt(c.amount), coin_type: c.coin_type })), valueUsd);
      weighting = w.weighting;
      const basis: FlowBasis = gains.length > 0 && isSwapHop(params.actions) ? "swap-follow" : "conversion";
      into.forEach((c, i) => {
        if (w.weights[i] <= 0) return;
        branches.push({
          address: c.address,
          coin_type: c.coin_type,
          amount: scaleAmount(BigInt(c.amount), inputShare),
          weight: unallocated * w.weights[i],
          basis,
        });
      });
      unallocated = 0;
    }
  }
  return { coin_type: coin, total: spent, branches, unallocated, weighting };
}

/**
 * Forward, on the starting transaction: everyone it credited, in the tracked
 * coin when one is given. An exploit that credits only its sender makes the
 * sender the one root; a transfer makes the recipient it.
 */
export function splitOrigin(params: {
  changes: HopChange[];
  trackedCoin: string | null;
  gas?: GasCharge;
  valueUsd?: ValueUsd;
}): Split {
  const valueUsd = params.valueUsd ?? (() => null);
  const cs = withoutGas(params.changes, params.gas).filter(
    (c) => BigInt(c.amount) > 0n && (params.trackedCoin === null || sameCoin(c.coin_type, params.trackedCoin)),
  );
  const w = valueWeights(cs.map((c) => ({ amount: BigInt(c.amount), coin_type: c.coin_type })), valueUsd);
  return {
    coin_type: params.trackedCoin,
    total: cs.reduce((s, c) => s + BigInt(c.amount), 0n),
    branches: cs
      .map((c, i): Branch => ({
        address: c.address,
        coin_type: c.coin_type,
        amount: BigInt(c.amount),
        weight: w.weights[i],
        basis: "origin",
      }))
      .filter((b) => b.weight > 0),
    unallocated: cs.length === 0 ? 1 : 0,
    weighting: w.weighting,
  };
}

/**
 * Backward, on the starting transaction: everyone who paid into it, in the
 * tracked coin when one is given.
 */
export function splitOriginBackward(params: {
  changes: HopChange[];
  trackedCoin: string | null;
  gas?: GasCharge;
  valueUsd?: ValueUsd;
}): Split {
  const valueUsd = params.valueUsd ?? (() => null);
  const cs = withoutGas(params.changes, params.gas).filter(
    (c) => BigInt(c.amount) < 0n && (params.trackedCoin === null || sameCoin(c.coin_type, params.trackedCoin)),
  );
  const w = valueWeights(cs.map((c) => ({ amount: BigInt(c.amount), coin_type: c.coin_type })), valueUsd);
  return {
    coin_type: params.trackedCoin,
    total: cs.reduce((s, c) => s - BigInt(c.amount), 0n),
    branches: cs
      .map((c, i): Branch => ({
        address: c.address,
        coin_type: c.coin_type,
        amount: -BigInt(c.amount),
        weight: w.weights[i],
        basis: "inflow",
      }))
      .filter((b) => b.weight > 0),
    unallocated: cs.length === 0 ? 1 : 0,
    weighting: w.weighting,
  };
}

/**
 * Backward: who paid `recipient`'s inflow of the tracked coin on one
 * transaction.
 *
 * Every other party whose balance of the coin went down, in proportion to
 * what each paid. When the recipient sent the transaction and turned another
 * asset into the tracked one (a swap, an unstake, a redemption) with no
 * wallet paying it, its own outflow of that asset is where the value came
 * from. With nobody paying, the coin was minted, withdrawn from a protocol or
 * claimed from a bridge: `unallocated`.
 */
export function splitInflow(params: {
  sender: string | null;
  recipient: string;
  changes: HopChange[];
  actions: string[];
  trackedCoin: string | null;
  isPassThrough: (address: string) => boolean;
  gas?: GasCharge;
  valueUsd?: ValueUsd;
}): Split {
  const valueUsd = params.valueUsd ?? (() => null);
  const { recipient, sender } = params;
  const cs = withoutGas(params.changes, params.gas);
  const coin = params.trackedCoin ?? dominantCoin(cs, recipient, 1, valueUsd);
  const empty: Split = { coin_type: coin, total: 0n, branches: [], unallocated: 0, weighting: "raw" };
  if (!coin) return empty;
  const net = netOf(cs, recipient, coin);
  if (net <= 0n) return empty;

  const payers = cs.filter((c) => c.address !== recipient && BigInt(c.amount) < 0n && sameCoin(c.coin_type, coin));
  const paidOther =
    recipient === sender
      ? cs.filter((c) => c.address === recipient && BigInt(c.amount) < 0n && !sameCoin(c.coin_type, coin))
      : [];
  if (paidOther.length > 0 && payers.every((p) => params.isPassThrough(p.address))) {
    const w = valueWeights(paidOther.map((c) => ({ amount: -BigInt(c.amount), coin_type: c.coin_type })), valueUsd);
    const basis: FlowBasis = isSwapHop(params.actions) ? "swap-follow" : "conversion";
    return {
      coin_type: coin,
      total: net,
      branches: paidOther
        .map((c, i): Branch => ({
          address: c.address,
          coin_type: c.coin_type,
          amount: -BigInt(c.amount),
          weight: w.weights[i],
          basis,
        }))
        .filter((b) => b.weight > 0),
      unallocated: 0,
      weighting: w.weighting,
    };
  }
  if (payers.length === 0) return { ...empty, total: net, unallocated: 1 };
  const paid = payers.reduce((s, c) => s - BigInt(c.amount), 0n);
  return {
    coin_type: coin,
    total: net,
    branches: payers.map((c) => ({
      address: c.address,
      coin_type: c.coin_type,
      amount: -BigInt(c.amount),
      weight: ratio(-BigInt(c.amount), paid),
      basis: "inflow",
    })),
    unallocated: 0,
    weighting: "raw",
  };
}

/**
 * FIFO allocation of a node's traced amount across the transactions that
 * moved it: each takes what it moved until the traced amount is used up.
 *
 * With no traced amount (a graph started from an address rather than from a
 * transaction) every transaction counts in full, weighted by `usd` where the
 * moves carry it.
 */
export function allocateFifo(
  moves: Array<{ amount: bigint; coin_type: string; usd?: number | null }>,
  need: bigint | null,
): { allocated: bigint[]; fractions: number[]; remaining: number } {
  if (need === null) {
    const { weights } = valueWeights(moves);
    return { allocated: moves.map((m) => m.amount), fractions: weights, remaining: moves.length ? 0 : 1 };
  }
  if (need <= 0n) return { allocated: moves.map(() => 0n), fractions: moves.map(() => 0), remaining: 0 };
  const allocated: bigint[] = [];
  let left = need;
  for (const m of moves) {
    const take = m.amount < left ? m.amount : left;
    allocated.push(take);
    left -= take;
  }
  return {
    allocated,
    fractions: allocated.map((a) => ratio(a, need)),
    remaining: ratio(left, need),
  };
}

/** Node id for an address holding one coin. */
export function nodeId(address: string, coin: string | null): string {
  return `${address}|${coin ? coinKey(coin) : "*"}`;
}

/** Why part of the traced value stopped where it did. */
export type StopCode =
  | "sink"
  | "bridge_exit"
  | "hub"
  | "unspent"
  | "consumed"
  | "protocol"
  | "source"
  | "bridge_entry"
  | "cycle"
  | "signer_not_sender"
  | "read_failed"
  | "budget"
  | "below_threshold"
  | "target";

/** What each code means, stated once in the output. */
export const STOP_MEANING: Record<StopCode, string> = {
  sink: "Reached an address with a sink label (an exchange, mixer or burn address).",
  bridge_exit: "Left Sui through a bridge. Each exit names the far-side beneficiary where the transaction states one.",
  hub: "Reached an address with 100+ counterparties in its last 200 transactions. It pools other parties' money, so its next moves are not a continuation of these funds.",
  unspent: "Still held: the address has not moved this coin since receiving it.",
  consumed: "Went into a protocol object, or was burned, with no address receiving it. The holder has the claim (a receipt, share or position).",
  protocol: "Paid to a curated protocol or pool address, a shared contract whose later moves belong to its other users.",
  source: "Backward: no address paid it in. It was minted, withdrawn from a protocol, or claimed.",
  bridge_entry: "Backward: it arrived on Sui through a bridge.",
  cycle: "Came back to an address already expanded from another address.",
  signer_not_sender: "The transaction was signed by another address acting for the sender (an alias or a protocol substitution), so its moves are not attributed to the sender.",
  read_failed: "A transaction or search could not be read. This is incomplete, not finished.",
  budget: "Not expanded: the depth, node or search limit was reached. The funds may have moved further.",
  below_threshold: "Branches below min_share (or min_usd) were not expanded.",
  target: "Reached the address being searched for.",
};

export interface TerminalEntry {
  node: string;
  share: number;
  usd: number | null;
  detail?: string;
}

/**
 * Where every share of the traced value ended, by reason.
 *
 * Shares add up across groups: an expanded node that moved half of what it
 * received and still holds the rest appears under `unspent` with the half it
 * holds. What is not accounted for here is in `unaccounted`, the part the
 * graph lost to rounding or to reads that returned less than expected.
 */
export class TerminalLedger {
  private readonly groups = new Map<StopCode, TerminalEntry[]>();

  add(code: StopCode, entry: TerminalEntry): void {
    if (entry.share <= 0 && code !== "target") return;
    const list = this.groups.get(code) ?? [];
    const same = list.find((e) => e.node === entry.node && e.detail === entry.detail);
    if (same) {
      same.share += entry.share;
      same.usd = same.usd === null && entry.usd === null ? null : (same.usd ?? 0) + (entry.usd ?? 0);
    } else {
      list.push({ ...entry });
    }
    this.groups.set(code, list);
  }

  total(): number {
    let t = 0;
    for (const list of this.groups.values()) for (const e of list) t += e.share;
    return t;
  }

  codesFor(node: string): StopCode[] {
    const out: StopCode[] = [];
    for (const [code, list] of this.groups) if (list.some((e) => e.node === node)) out.push(code);
    return out;
  }

  /** Groups, largest share first, entries within each largest first. */
  summary(): Array<{ code: StopCode; share: number; usd: number | null; entries: TerminalEntry[] }> {
    return [...this.groups]
      .map(([code, entries]) => {
        const sorted = [...entries].sort((a, b) => b.share - a.share);
        const priced = entries.filter((e) => e.usd !== null);
        return {
          code,
          share: entries.reduce((s, e) => s + e.share, 0),
          usd: priced.length ? priced.reduce((s, e) => s + (e.usd ?? 0), 0) : null,
          entries: sorted,
        };
      })
      .sort((a, b) => b.share - a.share);
  }
}

/** One step of a path, in the direction the money moved. */
export interface PathStep {
  from: string;
  to: string;
  edge: string;
}

/**
 * The chain of first-arrival edges from a root to `node`.
 *
 * `parentOf` maps a node to the edge that first reached it and that edge's
 * source. The first arrival is the earliest, so the path it gives is one the
 * money can actually have taken in time order.
 */
export function pathTo(
  node: string,
  parentOf: ReadonlyMap<string, { edge: string; from: string }>,
  maxSteps = 64,
): PathStep[] {
  const steps: PathStep[] = [];
  const seen = new Set<string>([node]);
  let at = node;
  for (let i = 0; i < maxSteps; i++) {
    const p = parentOf.get(at);
    if (!p || seen.has(p.from)) break;
    steps.unshift({ from: p.from, to: at, edge: p.edge });
    seen.add(p.from);
    at = p.from;
  }
  return steps;
}

/**
 * Where a forward search from one address and a backward search from another
 * meet: an address both reached, where the forward side arrived no later than
 * the backward side's payment toward the target. Earlier would be money
 * leaving before it came in.
 */
export function meetingPoints(
  forward: ReadonlyMap<string, { address: string; arrivedAt: number | null }>,
  backward: ReadonlyMap<string, { address: string; arrivedAt: number | null }>,
): Array<{ forwardNode: string; backwardNode: string; address: string }> {
  const byAddress = new Map<string, Array<[string, number | null]>>();
  for (const [id, n] of backward) {
    const list = byAddress.get(n.address) ?? [];
    list.push([id, n.arrivedAt]);
    byAddress.set(n.address, list);
  }
  const out: Array<{ forwardNode: string; backwardNode: string; address: string }> = [];
  for (const [fid, f] of forward) {
    for (const [bid, paidAt] of byAddress.get(f.address) ?? []) {
      if (f.arrivedAt !== null && paidAt !== null && f.arrivedAt > paidAt) continue;
      out.push({ forwardNode: fid, backwardNode: bid, address: f.address });
    }
  }
  return out;
}
