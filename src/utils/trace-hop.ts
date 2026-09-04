/**
 * Decision logic for "where do the funds go next" in a fund trace. Extracted as
 * a pure function so the swap-aware / pool-skipping heuristics can be unit-tested
 * without touching the chain.
 */

export interface HopChange {
  address: string;
  amount: string; // signed, raw units
  coin_type: string;
}

/** A recipient the trace saw but did not follow. */
export interface UnfollowedRecipient {
  address: string;
  amount: string;
  coin_type: string;
  /** Comparable value used for ranking, when a price was available. */
  usd_value: number | null;
}

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
   * Recipients that received value on this hop and were not followed.
   *
   * A trace follows one branch. Splitting funds across several wallets is the
   * ordinary laundering move, and reporting only the followed branch reads as
   * "the money went here" when it went to five places. Reported so the reader
   * can see what was set aside rather than having to infer it.
   */
  unfollowed: UnfollowedRecipient[];
  /**
   * How the next address was chosen. `direct` is a plain transfer,
   * `swap-follow` keeps the actor across an asset change, and `pool-fallback`
   * means every recipient was a protocol address — the weakest case, where the
   * trace is about to walk into a shared contract.
   */
  basis: "direct" | "swap-follow" | "pool-fallback" | "none";
}

function absBig(amount: string): bigint {
  const v = BigInt(amount);
  return v < 0n ? -v : v;
}

/** Did this hop perform a swap? Decoder emits actions like "Swap USDC → SUI ...". */
function isSwapHop(actions: string[]): boolean {
  return actions.some((a) => /(^|\b)swap\b/i.test(a));
}

/**
 * Rank two candidate outflows.
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

/**
 * Choose the next address (and coin) to follow.
 *
 * - **backward**: follow the sender (the funding source), unchanged.
 * - **forward, swap hop**: the actor swapped asset A→B and still holds the
 *   proceeds, so we keep following the *same actor* and switch the tracked coin
 *   to what they received — instead of diving into the DEX pool that only
 *   received the input leg (which would lead into unrelated pool internals).
 * - **forward, plain hop**: follow the highest-value recipient of the outflow,
 *   skipping protocol/pool addresses when a non-pool recipient exists.
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
}): NextHop {
  const { sender, changes, actions, direction, trackedCoin, isPassThrough } = params;
  const valueUsd = params.valueUsd ?? (() => null);

  if (direction === "backward") {
    return {
      nextAddress: sender,
      nextCoinType: trackedCoin,
      isSwap: false,
      unfollowed: [],
      basis: "direct",
    };
  }

  const positiveToOthers = changes.filter((c) => c.address !== sender && BigInt(c.amount) > 0n);

  const asUnfollowed = (cs: HopChange[]): UnfollowedRecipient[] =>
    cs.map((c) => ({
      address: c.address,
      amount: c.amount,
      coin_type: c.coin_type,
      usd_value: valueUsd(c),
    }));

  if (isSwapHop(actions) && sender) {
    // What did the actor receive? Highest-value positive change credited to them.
    const received = changes
      .filter((c) => c.address === sender && BigInt(c.amount) > 0n)
      .map((c) => ({ c, usd: valueUsd(c) }))
      .sort((a, b) => byValueDesc({ usd: a.usd, amount: a.c.amount }, { usd: b.usd, amount: b.c.amount }))[0]?.c;
    return {
      nextAddress: sender,
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

  if (positiveToOthers.length === 0) {
    return {
      nextAddress: null,
      nextCoinType: trackedCoin,
      isSwap: false,
      unfollowed: [],
      basis: "none",
    };
  }

  // Rank by value, then prefer a non-pass-through recipient (skip DEX pools /
  // protocol addresses). Ranking before filtering matters: the note used to
  // claim it followed "the largest" while taking whichever element happened to
  // be first in the array.
  const ranked = positiveToOthers
    .map((c) => ({ c, usd: valueUsd(c) }))
    .sort((a, b) => byValueDesc({ usd: a.usd, amount: a.c.amount }, { usd: b.usd, amount: b.c.amount }))
    .map((r) => r.c);

  const nonPool = ranked.find((c) => !isPassThrough(c.address));
  const chosen = nonPool ?? ranked[0];

  return {
    nextAddress: chosen.address,
    nextCoinType: trackedCoin,
    isSwap: false,
    unfollowed: asUnfollowed(ranked.filter((c) => c !== chosen)),
    basis: nonPool ? "direct" : "pool-fallback",
    note: nonPool
      ? undefined
      : "Only pool/protocol recipients found; following the highest-value one. The next hop is a shared contract, so anything beyond it may belong to someone else.",
  };
}
