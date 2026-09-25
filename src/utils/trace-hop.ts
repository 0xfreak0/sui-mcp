/**
 * Decision logic for "where do the funds go next" in a fund trace. Extracted as
 * pure functions so the swap-aware / pool-skipping heuristics, and the choice
 * of which later or earlier transaction continues the trace, can be
 * unit-tested without touching the chain.
 */

import { normalizeCoinType } from "./coin-registry.js";

export interface HopChange {
  address: string;
  amount: string; // signed, raw units
  coin_type: string;
}

/** A recipient (forward) or source (backward) the trace saw but did not follow. */
export interface UnfollowedRecipient {
  address: string;
  amount: string;
  coin_type: string;
  /** Comparable value used for ranking, when a price was available. */
  usd_value: number | null;
  /** Set when the party appeared in a different transaction from the hop's own. */
  digest?: string;
}

/**
 * Who paid gas on a transaction, and the net charge.
 *
 * The payer's SUI balance change is the value it moved PLUS gas, so a hop that
 * compares SUI changes without removing gas reads every transaction an address
 * sends as a SUI outflow. `net` is computation + storage - rebate, and is
 * negative when the rebate exceeded the cost.
 */
export interface GasCharge {
  payer: string | null;
  net: bigint | null;
}

export type HopBasis =
  | "direct"
  | "swap-follow"
  | "self-credit"
  | "conversion"
  | "pool-fallback"
  | "none";

export interface NextHop {
  /** Address to follow next, or null to stop. */
  nextAddress: string | null;
  /** Coin to track from here on (may change after a swap). */
  nextCoinType: string | null;
  /** True when this hop was a swap and we kept following the same actor. */
  isSwap: boolean;
  /** Human note explaining a non-obvious choice (swap follow-through, pool skip). */
  note?: string;
  /**
   * Recipients (forward) or other payers (backward) on this hop that were not
   * followed.
   *
   * A trace follows one branch. Splitting funds across several wallets is the
   * ordinary laundering move, and reporting only the followed branch reads as
   * "the money went here" when it went to five places. Reported so the reader
   * can see what was set aside rather than having to infer it.
   */
  unfollowed: UnfollowedRecipient[];
  /**
   * How the next address was chosen. `direct` is a plain transfer,
   * `swap-follow` keeps the actor across an asset change, `self-credit`
   * follows the actor when it was the only party that gained (an exploit,
   * a withdrawal, a claim), `conversion` follows another party who received a
   * different asset for the tracked one, and `pool-fallback` means every
   * recipient was a protocol address, the weakest case, where the trace is
   * about to walk into a shared contract.
   */
  basis: HopBasis;
  /**
   * Set when nothing was followed but the holder's tracked coin went down:
   * the value was consumed on this hop (deposited, burned or locked in an
   * object) rather than paid to an address.
   */
  consumed?: boolean;
}

/** Normalised coin type, so `0x2::sui::SUI` and the padded form compare equal. */
export function coinKey(coinType: string): string {
  return normalizeCoinType(coinType) ?? coinType.trim();
}

export function sameCoin(a: string, b: string): boolean {
  return coinKey(a) === coinKey(b);
}

const SUI = coinKey("0x2::sui::SUI");

function absBig(amount: string | bigint): bigint {
  const v = typeof amount === "bigint" ? amount : BigInt(amount);
  return v < 0n ? -v : v;
}

/**
 * A balance change with the gas charge removed.
 *
 * Only the gas payer's SUI change carries gas. Without this, the payer of any
 * transaction shows a SUI outflow, so "the next transaction that moves SUI" is
 * simply the next transaction it sent, and a sponsor's rebate reads as a
 * payment to it.
 */
export function nonGasAmount(change: HopChange, gas?: GasCharge): bigint {
  const amount = BigInt(change.amount);
  if (!gas || gas.net === null || gas.payer === null) return amount;
  if (change.address !== gas.payer || coinKey(change.coin_type) !== SUI) return amount;
  return amount + gas.net;
}

/** Changes with gas removed, dropping any that net to zero. */
export function withoutGas(changes: HopChange[], gas?: GasCharge): HopChange[] {
  const out: HopChange[] = [];
  for (const c of changes) {
    const amount = nonGasAmount(c, gas);
    if (amount !== 0n) out.push({ ...c, amount: amount.toString() });
  }
  return out;
}

/**
 * Did this hop perform a swap the actor kept the proceeds of?
 *
 * Decoder emits actions like "Swap USDC → SUI on Cetus", and an undecoded call
 * renders as `Call 0x…::market::swap_exact_pt_for_sy`. A word boundary does
 * not separate `swap` from `_exact` because `_` is a word character, so the
 * match is on any non-letter before `swap`. A **flash** swap is excluded: it
 * borrows and repays inside the same transaction, so the actor ends up holding
 * nothing, and switching the tracked asset to what they momentarily received
 * would follow a coin they never kept.
 */
export function isSwapHop(actions: string[]): boolean {
  return actions.some((a) => /(^|[^a-z])swap/i.test(a) && !/flash/i.test(a));
}

/**
 * Rank two candidates.
 *
 * USD first, because raw amounts are not comparable across coins: 1 USDC is
 * 1e6 units and 1 SUI is 1e9, so a raw comparison ranks by decimal places
 * rather than by value and would follow dust over the real transfer. Falls back
 * to raw magnitude only when neither side has a price, where it is at least
 * consistent within one coin.
 */
function byValueDesc(
  a: { usd: number | null; amount: string },
  b: { usd: number | null; amount: string },
): number {
  if (a.usd !== null && b.usd !== null) return b.usd - a.usd;
  if (a.usd !== null) return -1;
  if (b.usd !== null) return 1;
  const av = absBig(a.amount);
  const bv = absBig(b.amount);
  return bv > av ? 1 : bv < av ? -1 : 0;
}

function rank(cs: HopChange[], valueUsd: (c: HopChange) => number | null): HopChange[] {
  return cs
    .map((c) => ({ c, usd: valueUsd({ ...c, amount: absBig(c.amount).toString() }) }))
    .sort((a, b) => byValueDesc({ usd: a.usd, amount: a.c.amount }, { usd: b.usd, amount: b.c.amount }))
    .map((r) => r.c);
}

/**
 * Choose the next address (and coin) to follow.
 *
 * Forward, from the `holder` (the address whose funds this hop moved; the
 * sender unless the value was released from an object):
 * - **swap hop**: the actor swapped A→B and still holds the proceeds, so keep
 *   following the same actor and switch the tracked coin to what they received,
 *   instead of diving into the DEX pool that only received the input leg.
 * - **plain hop**: follow the highest-value recipient of the TRACKED coin,
 *   skipping protocol/pool addresses when a non-pool recipient exists. A
 *   recipient of some other asset is not where these funds went.
 * - **self-credit**: nobody else received the tracked coin and the actor
 *   gained something (an exploit that credits only its sender, a withdrawal,
 *   a claim). Follow the actor and switch to its largest gain.
 * - **conversion**: the tracked coin left the holder and another party
 *   received a different asset for it. Follow that party and switch coin.
 * - otherwise stop; `consumed` says the holder's tracked coin went down with
 *   no recipient, i.e. it went into an object.
 *
 * Backward, explaining how `recipient` (null on the starting transaction) got
 * the tracked coin:
 * - the actor's own swap or conversion: follow the actor and switch to the
 *   asset it paid.
 * - otherwise follow the owner of the largest decrease in the tracked coin,
 *   which is who paid it in. The sender is not assumed to be the payer: a
 *   claim through `Receiving<T>` is sent by whoever holds the link key while
 *   the coin leaves the object that held it.
 *
 * `valueUsd` converts a change to a comparable number. It is injected rather
 * than computed here so this stays pure and testable; pass `() => null` when
 * no prices are available and ranking falls back to raw magnitude.
 */
export function chooseNextHop(params: {
  sender: string | null;
  changes: HopChange[];
  actions: string[];
  direction: "forward" | "backward";
  trackedCoin: string | null;
  isPassThrough: (address: string) => boolean;
  valueUsd?: (change: HopChange) => number | null;
  gas?: GasCharge;
  /** Forward: whose funds moved on this hop. Defaults to the sender. */
  holder?: string | null;
  /** Backward: the address whose inflow this hop explains. */
  recipient?: string | null;
}): NextHop {
  const { sender, actions, direction, trackedCoin, isPassThrough } = params;
  const valueUsd = params.valueUsd ?? (() => null);
  const changes = withoutGas(params.changes, params.gas);
  const tracked = (c: HopChange) => trackedCoin === null || sameCoin(c.coin_type, trackedCoin);
  const pos = (c: HopChange) => BigInt(c.amount) > 0n;
  const neg = (c: HopChange) => BigInt(c.amount) < 0n;

  const asUnfollowed = (cs: HopChange[]): UnfollowedRecipient[] =>
    cs.map((c) => ({
      address: c.address,
      amount: c.amount,
      coin_type: c.coin_type,
      usd_value: valueUsd({ ...c, amount: absBig(c.amount).toString() }),
    }));

  if (direction === "backward") {
    const recipient = params.recipient ?? null;
    const actor = recipient ?? sender;
    const payers = changes.filter((c) => c.address !== recipient && neg(c) && tracked(c));
    const actorPaidOther = actor
      ? rank(changes.filter((c) => c.address === actor && neg(c) && !tracked(c)), valueUsd)
      : [];
    const actorGotTracked = actor ? changes.some((c) => c.address === actor && pos(c) && tracked(c)) : false;

    // The actor turned another asset into the tracked one. Its own outflow is
    // where the value came from, and the pool that took it is not a source.
    if (
      actor &&
      actor === sender &&
      actorGotTracked &&
      actorPaidOther.length > 0 &&
      payers.filter((c) => !isPassThrough(c.address) && c.address !== actor).length === 0
    ) {
      const paid = actorPaidOther[0];
      const swap = isSwapHop(actions);
      return {
        nextAddress: actor,
        nextCoinType: paid.coin_type,
        isSwap: swap,
        unfollowed: [],
        basis: swap ? "swap-follow" : "conversion",
        note: `${swap ? "Swap" : "Conversion"} by the actor: it received the tracked asset for ${paid.coin_type}, so the trace keeps following it and switches to that asset.`,
      };
    }

    if (payers.length === 0) {
      return {
        nextAddress: null,
        nextCoinType: trackedCoin,
        isSwap: false,
        unfollowed: [],
        basis: "none",
      };
    }

    const ranked = rank(payers, valueUsd);
    const nonPool = ranked.find((c) => !isPassThrough(c.address));
    const chosen = nonPool ?? ranked[0];
    return {
      nextAddress: chosen.address,
      nextCoinType: chosen.coin_type,
      isSwap: false,
      unfollowed: asUnfollowed(ranked.filter((c) => c !== chosen)),
      basis: nonPool ? "direct" : "pool-fallback",
      ...(chosen.address !== sender && sender
        ? {
            note: `The value left ${chosen.address}, not the sender ${sender}; following the address it left.`,
          }
        : {}),
      ...(nonPool
        ? {}
        : {
            note: "Only pool/protocol addresses paid in; following the largest. The next hop is a shared contract, so anything before it may belong to someone else.",
          }),
    };
  }

  const holder = params.holder ?? sender;
  // With a null sender every `c.address !== sender` comparison is true, so the
  // subject's own inflows would be treated as payments to third parties and
  // followed. No sender means there is no actor whose outflow could be traced.
  if (!holder) {
    return {
      nextAddress: null,
      nextCoinType: trackedCoin,
      isSwap: false,
      unfollowed: [],
      basis: "none",
      note: "No sender on this transaction, so there is no actor whose outflow could be followed.",
    };
  }

  const positiveToOthers = changes.filter((c) => c.address !== holder && pos(c));
  const holderGains = rank(
    changes.filter((c) => c.address === holder && pos(c)),
    valueUsd,
  );
  const holderSpent = changes.some((c) => c.address === holder && neg(c) && tracked(c));

  if (isSwapHop(actions) && holder === sender) {
    const received = holderGains[0];
    return {
      nextAddress: holder,
      nextCoinType: received?.coin_type ?? trackedCoin,
      isSwap: true,
      // Anyone else paid on a swap hop is still a branch the trace dropped —
      // a swap that also pays a fee collector or a second wallet is common.
      unfollowed: asUnfollowed(positiveToOthers),
      basis: "swap-follow",
      note: received
        ? `Swap detected — following the swapper and switching tracked asset to ${received.coin_type}.`
        : "Swap detected — following the swapper.",
    };
  }

  const recipients = positiveToOthers.filter(tracked);
  if (recipients.length > 0) {
    // Rank by value, then prefer a non-pass-through recipient (skip DEX pools /
    // protocol addresses). Ranking before filtering matters: the note used to
    // claim it followed "the largest" while taking whichever element happened
    // to be first in the array.
    const ranked = rank(recipients, valueUsd);
    const nonPool = ranked.find((c) => !isPassThrough(c.address));
    const chosen = nonPool ?? ranked[0];
    return {
      nextAddress: chosen.address,
      nextCoinType: trackedCoin ?? chosen.coin_type,
      isSwap: false,
      unfollowed: asUnfollowed(positiveToOthers.filter((c) => c !== chosen)),
      basis: nonPool ? "direct" : "pool-fallback",
      note: nonPool
        ? undefined
        : "Only pool/protocol recipients found; following the highest-value one. The next hop is a shared contract, so anything beyond it may belong to someone else.",
    };
  }

  if (holder === sender && holderGains.length > 0) {
    const gain = holderGains[0];
    // Spent the tracked coin and got another back with nobody else paid: an
    // unstake, a redemption, or a swap the decoder did not name. Otherwise it
    // only gained: an exploit that credits its caller, a withdrawal, a claim.
    return {
      nextAddress: holder,
      nextCoinType: gain.coin_type,
      isSwap: false,
      unfollowed: asUnfollowed(positiveToOthers),
      basis: holderSpent ? "conversion" : "self-credit",
      note: holderSpent
        ? `The sender turned the tracked asset into ${gain.coin_type} and nobody else received it (an unstake, a redemption, or a swap the decoder did not name). Following the sender and switching the tracked asset to it.`
        : `Nobody but the sender received anything here, and the sender gained ${gain.coin_type} (an exploit that credits its caller, a withdrawal or a claim). Following the sender and switching the tracked asset to it.`,
    };
  }

  if (holderSpent && positiveToOthers.length > 0) {
    const ranked = rank(positiveToOthers, valueUsd);
    const nonPool = ranked.find((c) => !isPassThrough(c.address));
    const chosen = nonPool ?? ranked[0];
    return {
      nextAddress: chosen.address,
      nextCoinType: chosen.coin_type,
      isSwap: false,
      unfollowed: asUnfollowed(ranked.filter((c) => c !== chosen)),
      basis: nonPool ? "conversion" : "pool-fallback",
      note: `The tracked asset left ${holder} and nobody received it directly; ${chosen.address} received ${chosen.coin_type} in the same transaction. Following it and switching the tracked asset.`,
    };
  }

  return {
    nextAddress: null,
    nextCoinType: trackedCoin,
    isSwap: false,
    unfollowed: asUnfollowed(positiveToOthers),
    basis: "none",
    ...(holderSpent ? { consumed: true } : {}),
  };
}

/** One transaction from a candidate page, reduced to what hop selection needs. */
export interface CandidateTx {
  digest: string;
  sender: string | null;
  gas: GasCharge;
  changes: HopChange[];
}

/**
 * `address`'s non-gas change on a candidate, in `coin`. With no tracked coin
 * yet, the largest change of the requested sign in any one asset: summing
 * across assets would add units that do not compare.
 */
function changeFor(tx: CandidateTx, address: string, coin: string | null, sign: 1n | -1n): bigint {
  let total = 0n;
  let extreme = 0n;
  for (const c of tx.changes) {
    if (c.address !== address) continue;
    const v = nonGasAmount(c, tx.gas);
    if (coin === null) {
      if (v * sign > extreme * sign) extreme = v;
    } else if (sameCoin(c.coin_type, coin)) {
      total += v;
    }
  }
  return coin === null ? extreme : total;
}

/**
 * Forward: the first candidate (in the ascending order the page arrives in)
 * in which `address` spends the tracked coin.
 *
 * "The next transaction the recipient sent" is not "the next move of these
 * funds": a wallet that received SUI and then moved an unrelated token was
 * reported as moving the SUI. Gas is removed first, since every transaction
 * the payer sends lowers its SUI.
 *
 * Candidates up to and including `current` are dropped when `current` is in
 * the page: they are earlier transactions of the same checkpoint.
 */
export function firstSpend(
  candidates: CandidateTx[],
  address: string,
  coin: string | null,
  skip: ReadonlySet<string>,
  current?: string,
): { tx: CandidateTx; spent: bigint } | null {
  const at = current ? candidates.findIndex((t) => t.digest === current) : -1;
  for (const tx of candidates.slice(at + 1)) {
    if (skip.has(tx.digest)) continue;
    const net = changeFor(tx, address, coin, -1n);
    if (net < 0n) return { tx, spent: -net };
  }
  return null;
}

/**
 * Backward: every candidate in which `address` gained the tracked coin,
 * newest first.
 *
 * GraphQL returns a `last` page in ascending order. Taking the first element
 * that was not the current hop picked the OLDEST of the window, and without a
 * direction filter it picked the address's own outflows: a stranger's deposit
 * five transactions back became "the funder", and an outflow sent by the
 * address itself read as a cycle. Candidates at or after `current` in the page
 * are later than the hop being explained and are dropped.
 */
export function inflowsNewestFirst(
  candidates: CandidateTx[],
  address: string,
  coin: string | null,
  skip: ReadonlySet<string>,
  current?: string,
): Array<{ tx: CandidateTx; received: bigint }> {
  const at = current ? candidates.findIndex((t) => t.digest === current) : -1;
  const earlier = at >= 0 ? candidates.slice(0, at) : candidates;
  const out: Array<{ tx: CandidateTx; received: bigint }> = [];
  for (const tx of [...earlier].reverse()) {
    if (skip.has(tx.digest)) continue;
    const net = changeFor(tx, address, coin, 1n);
    if (net > 0n) out.push({ tx, received: net });
  }
  return out;
}

/**
 * The largest payer on an inflow candidate, for naming where an unfollowed
 * inflow came from. Falls back to the sender when nobody's balance went down
 * (a withdrawal or a mint).
 */
export function payerOf(tx: CandidateTx, recipient: string, coin: string | null): string | null {
  let best: { address: string; amount: bigint } | null = null;
  for (const c of tx.changes) {
    if (c.address === recipient) continue;
    if (coin !== null && !sameCoin(c.coin_type, coin)) continue;
    const v = nonGasAmount(c, tx.gas);
    if (v >= 0n) continue;
    if (!best || -v > best.amount) best = { address: c.address, amount: -v };
  }
  return best?.address ?? tx.sender;
}
