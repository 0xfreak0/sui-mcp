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
   * The part of what this party received (forward) or paid (backward) that
   * the split transaction's traced side accounts for, raw units, positive. A
   * direct branch carries at most the holder's own outflow (forward) or
   * inflow (backward) of the coin; a swap or conversion, the part of the
   * proceeds bought with the traced coin.
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
  return (amount * BigInt(Math.floor(fraction * 1e12))) / 1_000_000_000_000n;
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

/** `address`'s net change in `coin` on one transaction, gas removed, as a positive amount: what moved on chain. */
export function movedOnChain(changes: HopChange[], address: string, coin: string, gas?: GasCharge): bigint {
  return abs(netOf(withoutGas(changes, gas), address, coin));
}

/**
 * Every coin `address` net spent (`sign` -1) or net received (`sign` 1) on one
 * transaction, gas removed, once per coin. An address-start root splits each
 * of them, so a transaction that pays several coins out is traced in all of
 * them rather than in the dominant one alone.
 */
export function coinsMoved(changes: HopChange[], address: string, sign: 1 | -1, gas?: GasCharge): string[] {
  const cs = withoutGas(changes, gas);
  const byKey = new Map<string, string>();
  for (const c of cs) if (c.address === address && !byKey.has(coinKey(c.coin_type))) byKey.set(coinKey(c.coin_type), c.coin_type);
  return [...byKey.values()].filter((coin) => {
    const net = netOf(cs, address, coin);
    return sign > 0 ? net > 0n : net < 0n;
  });
}

/** Positive changes in `coin` of every address but `holder`. */
function receiptsOfOthers(cs: HopChange[], holder: string, coin: string): HopChange[] {
  return cs.filter((c) => c.address !== holder && BigInt(c.amount) > 0n && sameCoin(c.coin_type, coin));
}

function sumAbs(cs: HopChange[]): bigint {
  return cs.reduce((s, c) => s + abs(BigInt(c.amount)), 0n);
}

interface Part {
  address: string;
  coin_type: string;
  amount: bigint;
}

/**
 * What `holder` put into a transaction that no other address took in the same
 * coin, per coin it net spent: its net outflow less what the other addresses
 * received of that coin. That part went into a conversion or reached no address.
 */
function unpaidOutflows(cs: HopChange[], holder: string): Part[] {
  return coinsMoved(cs, holder, -1)
    .map((coin) => {
      const spent = -netOf(cs, holder, coin);
      const received = sumAbs(receiptsOfOthers(cs, holder, coin));
      return { address: holder, coin_type: coin, amount: received >= spent ? 0n : spent - received };
    })
    .filter((p) => p.amount > 0n);
}

/**
 * What other addresses took out of a transaction beyond what `holder` paid
 * them in the same coin. When recipients of a coin got more than the holder
 * spent of it, each one's excess is its pro-rata part of that difference.
 */
function unpaidReceipts(cs: HopChange[], holder: string): Part[] {
  const excess = new Map<string, { received: bigint; unpaid: bigint }>();
  const out: Part[] = [];
  for (const c of cs) {
    const amount = BigInt(c.amount);
    if (c.address === holder || amount <= 0n) continue;
    const key = coinKey(c.coin_type);
    let e = excess.get(key);
    if (!e) {
      const received = sumAbs(receiptsOfOthers(cs, holder, c.coin_type));
      const net = netOf(cs, holder, c.coin_type);
      const spent = net < 0n ? -net : 0n;
      e = { received, unpaid: received > spent ? received - spent : 0n };
      excess.set(key, e);
    }
    const unpaid = (amount * e.unpaid) / e.received;
    if (unpaid > 0n) out.push({ address: c.address, coin_type: c.coin_type, amount: unpaid });
  }
  return out;
}

/**
 * {@link valueWeights} of one side of a conversion. When that side has parts
 * with no market price and every part of the `other` side has a market price
 * or a `drawn` one, the unpriced parts are worth what the other side is worth
 * beyond this side's priced parts, split between them as `valueWeights`
 * splits unpriced amounts. Otherwise the side is weighed at `drawn` prices,
 * which fall back to the market's.
 */
function conversionWeights(side: Part[], other: Part[], valueUsd: ValueUsd, drawn: ValueUsd): { weights: number[]; weighting: Weighting } {
  const at = (v: ValueUsd) => (p: Part) => v({ amount: p.amount.toString(), coin_type: p.coin_type });
  const usd = side.map(at(valueUsd));
  const unpriced = side.filter((_, i) => usd[i] === null);
  if (unpriced.length === 0) return valueWeights(side, valueUsd);
  const otherUsd = other.map((p) => at(valueUsd)(p) ?? at(drawn)(p));
  if (otherUsd.some((u) => u === null)) return valueWeights(side, drawn);
  const residual = otherUsd.reduce<number>((s, u) => s + (u ?? 0), 0) - usd.reduce<number>((s, u) => s + (u ?? 0), 0);
  if (residual <= 0) return valueWeights(side, drawn);
  const split = valueWeights(unpriced).weights;
  let next = 0;
  return valueWeights(side.map((p, i) => ({ ...p, usd: usd[i] ?? residual * split[next++] })));
}

/**
 * Below this ratio of one side of a conversion to the other, both at market
 * prices, a readable transaction is not a swap. Forward, proceeds this small
 * are change or dust, and the rest of the outflow went into a contract.
 * Backward, inputs this small are a fee, and the rest of the inflow came out
 * of a contract. Forward, a transaction that swaps without depositing is a
 * sale at whatever price the pool gave, however far below the market price,
 * and converts in full.
 */
const DUST_RETURN_RATIO = 0.1;

/** A call that puts value into a contract: a deposit, stake, loan, lock or liquidity add. */
function isDepositHop(actions: string[]): boolean {
  return actions.some((a) => /(^|[^a-z])(deposit|supply|stake|lend|lock|add_liquidity)/i.test(a));
}

/** What `part` is worth as a fraction of `whole`, at most 1; 1 when either has a part with no price. */
function worthRatio(whole: Part[], part: Part[], valueUsd: ValueUsd): number {
  const total = (parts: Part[]) => {
    let usd = 0;
    for (const p of parts) {
      const u = valueUsd({ amount: p.amount.toString(), coin_type: p.coin_type });
      if (u === null) return null;
      usd += u;
    }
    return usd;
  };
  const [w, p] = [total(whole), total(part)];
  return w === null || p === null || w <= 0 ? 1 : Math.min(1, p / w);
}

/**
 * What went into a transaction that no address took, per payer: for each
 * coin, the amount paid out beyond what every address received of it, split
 * between the payers `include` accepts in proportion to what each paid.
 */
function unpaidPayments(cs: HopChange[], include: (address: string) => boolean): Part[] {
  const totals = new Map<string, { paid: bigint; consumed: bigint }>();
  const out: Part[] = [];
  for (const c of cs) {
    const amount = BigInt(c.amount);
    if (amount >= 0n || !include(c.address)) continue;
    const key = coinKey(c.coin_type);
    let t = totals.get(key);
    if (!t) {
      const same = cs.filter((x) => sameCoin(x.coin_type, c.coin_type));
      const paid = sumAbs(same.filter((x) => BigInt(x.amount) < 0n));
      const received = sumAbs(same.filter((x) => BigInt(x.amount) > 0n));
      t = { paid, consumed: paid > received ? paid - received : 0n };
      totals.set(key, t);
    }
    const unpaid = (-amount * t.consumed) / t.paid;
    if (unpaid > 0n) out.push({ address: c.address, coin_type: c.coin_type, amount: unpaid });
  }
  return out;
}

/**
 * Forward: where the `holder`'s outflow of the tracked coin went on one
 * transaction.
 *
 * Recipients of the tracked coin take their share first, in proportion to
 * what each received, and carry at most what the holder spent: when they got
 * more of it than the holder spent, the rest came from another input. What
 * the holder spent beyond what they received went into a conversion or
 * reached no address (a bridge burn, a protocol deposit, a burn), which is
 * `unallocated`. A conversion's proceeds are the holder's own gains when it
 * sent the transaction and what other addresses took out beyond what the
 * holder paid them in the same coin. On a bridge exit the remainder is always
 * the exit. Gas is removed first: the payer's SUI change includes it.
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
  /**
   * The changes come from a search row, which carries no events, so a bridge
   * marker cannot be seen. When both sides of the conversion are priced, only
   * the part of the outflow its proceeds are worth is converted; the rest
   * stays unallocated. Without it the same cap applies only when the
   * proceeds are worth less than {@link DUST_RETURN_RATIO} of the inputs at
   * market prices.
   */
  capToProceeds?: boolean;
  /** Prices that also value a coin with no market price at a rate drawn from an earlier conversion; defaults to `valueUsd`. */
  drawnUsd?: ValueUsd;
}): Split {
  const valueUsd = params.valueUsd ?? (() => null);
  const drawn = params.drawnUsd ?? valueUsd;
  const { holder, sender } = params;
  const cs = withoutGas(params.changes, params.gas);
  const coin = params.trackedCoin ?? dominantCoin(cs, holder, -1, valueUsd);
  const empty: Split = { coin_type: coin, total: 0n, branches: [], unallocated: 0, weighting: "raw" };
  if (!coin) return empty;
  const net = netOf(cs, holder, coin);
  if (net >= 0n) return empty;
  const spent = -net;

  const recipients = receiptsOfOthers(cs, holder, coin);
  const received = sumAbs(recipients);
  const base = received > spent ? received : spent;
  const branches: Branch[] = recipients.map((c) => ({
    address: c.address,
    coin_type: c.coin_type,
    amount: received > spent ? (BigInt(c.amount) * spent) / received : BigInt(c.amount),
    weight: ratio(BigInt(c.amount), base),
    basis: "direct",
  }));
  let weighting: Weighting = "raw";
  let unallocated = received >= spent ? 0 : ratio(spent - received, spent);

  if (unallocated > 0 && !params.bridgeExit) {
    const gains: Part[] =
      holder === sender
        ? coinsMoved(cs, holder, 1).map((c) => ({ address: holder, coin_type: c, amount: netOf(cs, holder, c) }))
        : [];
    const into = [...gains, ...unpaidReceipts(cs, holder)];
    if (into.length > 0) {
      // Proceeds bought with several inputs belong to the traced coin only in
      // proportion to its part of what went in: a swap that spent 0.1 SUI and
      // 18,000 USDT for 18,000 USDC did not turn the SUI into 18,000 USDC.
      const inputs = unpaidOutflows(cs, holder);
      const inputShare = conversionWeights(inputs, into, valueUsd, drawn).weights[inputs.findIndex((p) => sameCoin(p.coin_type, coin))];
      const w = conversionWeights(into, inputs, valueUsd, drawn);
      weighting = w.weighting;
      const swap = isSwapHop(params.actions);
      const cover = params.capToProceeds ? worthRatio(inputs, into, drawn) : worthRatio(inputs, into, valueUsd);
      const dust = cover < DUST_RETURN_RATIO && (!swap || isDepositHop(params.actions));
      const converted = unallocated * (params.capToProceeds || dust ? cover : 1);
      into.forEach((c, i) => {
        if (w.weights[i] <= 0) return;
        branches.push({
          address: c.address,
          coin_type: c.coin_type,
          amount: scaleAmount(c.amount, inputShare),
          weight: converted * w.weights[i],
          basis: swap && c.address === holder ? "swap-follow" : "conversion",
        });
      });
      unallocated -= converted;
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
 * what each paid, carrying at most the recipient's inflow. What the recipient
 * received beyond what they paid came out of a conversion: the assets that
 * went into the transaction and that no address took (a swap, an unstake, a
 * redemption) are where the value came from, at the addresses that paid them
 * in, in proportion to this coin's part of everything the conversion
 * produced. The recipient's own such outflows count only when it sent the
 * transaction, and a curated pool paying the coin is then the other side of
 * its swap, not a payer. With no such asset, the coin was minted, withdrawn
 * from a protocol or claimed from a bridge: `unallocated`. When those assets
 * are worth less than {@link DUST_RETURN_RATIO} of what the conversion
 * produced, they were a fee, and only the part of the inflow they are worth
 * comes from them; the rest is `unallocated`.
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
  /** See {@link splitSpend}. */
  drawnUsd?: ValueUsd;
}): Split {
  const valueUsd = params.valueUsd ?? (() => null);
  const drawn = params.drawnUsd ?? valueUsd;
  const { recipient, sender } = params;
  const cs = withoutGas(params.changes, params.gas);
  const coin = params.trackedCoin ?? dominantCoin(cs, recipient, 1, valueUsd);
  const empty: Split = { coin_type: coin, total: 0n, branches: [], unallocated: 0, weighting: "raw" };
  if (!coin) return empty;
  const net = netOf(cs, recipient, coin);
  if (net <= 0n) return empty;

  const own = recipient === sender;
  // A curated pool's changes are the other side of the recipient's own swap.
  const swapView = own ? cs.filter((c) => c.address === recipient || !params.isPassThrough(c.address)) : cs;
  const sources = unpaidPayments(swapView, (address) => address !== recipient || own);
  const view = sources.length > 0 ? swapView : cs;
  const payersOf = (c: string) => view.filter((x) => x.address !== recipient && BigInt(x.amount) < 0n && sameCoin(x.coin_type, c));
  const payers = payersOf(coin);
  const paid = sumAbs(payers);
  const base = paid > net ? paid : net;
  const branches: Branch[] = payers.map((c) => ({
    address: c.address,
    coin_type: c.coin_type,
    amount: paid > net ? (-BigInt(c.amount) * net) / paid : -BigInt(c.amount),
    weight: ratio(-BigInt(c.amount), base),
    basis: "inflow",
  }));
  let weighting: Weighting = "raw";
  let unallocated = paid >= net ? 0 : ratio(net - paid, net);

  if (unallocated > 0 && sources.length > 0) {
    // Everything the conversion produced: the recipient's gains beyond what
    // payers paid it, and what other addresses took out beyond what the
    // recipient paid them.
    const outputs: Part[] = [
      ...coinsMoved(view, recipient, 1).map((c) => {
        const gained = netOf(view, recipient, c);
        const paidIn = sumAbs(payersOf(c));
        return { address: recipient, coin_type: c, amount: paidIn >= gained ? 0n : gained - paidIn };
      }),
      ...unpaidReceipts(view, recipient),
    ].filter((p) => p.amount > 0n);
    const outputShare = conversionWeights(outputs, sources, valueUsd, drawn).weights[
      outputs.findIndex((p) => p.address === recipient && sameCoin(p.coin_type, coin))
    ];
    const w = conversionWeights(sources, outputs, valueUsd, drawn);
    weighting = w.weighting;
    const swap = isSwapHop(params.actions);
    // Inputs worth this little beside the outputs are a fee; the rest came out of a contract.
    const cover = worthRatio(outputs, sources, valueUsd);
    const converted = unallocated * (cover < DUST_RETURN_RATIO ? cover : 1);
    sources.forEach((c, i) => {
      if (w.weights[i] <= 0) return;
      branches.push({
        address: c.address,
        coin_type: c.coin_type,
        amount: scaleAmount(c.amount, outputShare),
        weight: converted * w.weights[i],
        basis: swap && c.address === recipient ? "swap-follow" : "conversion",
      });
    });
    unallocated -= converted;
  }
  return { coin_type: coin, total: net, branches, unallocated, weighting };
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
  cycle: "Value converged with an address's own activity already expanded elsewhere in the graph: on its own upstream path, or a different coin-lineage of the same address counted under another node.",
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
