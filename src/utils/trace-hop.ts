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

export interface NextHop {
  /** Address to follow next, or null to stop. */
  nextAddress: string | null;
  /** Coin to track from here on (may change after a swap). */
  nextCoinType: string | null;
  /** True when this hop was a swap and we kept following the same actor. */
  isSwap: boolean;
  /** Human note explaining a non-obvious choice (swap follow-through, pool skip). */
  note?: string;
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
 * Choose the next address (and coin) to follow.
 *
 * - **backward**: follow the sender (the funding source), unchanged.
 * - **forward, swap hop**: the actor swapped asset A→B and still holds the
 *   proceeds, so we keep following the *same actor* and switch the tracked coin
 *   to what they received — instead of diving into the DEX pool that only
 *   received the input leg (which would lead into unrelated pool internals).
 * - **forward, plain hop**: follow the recipient of the outflow, skipping
 *   protocol/pool addresses when a non-pool recipient exists.
 */
export function chooseNextHop(params: {
  sender: string | null;
  changes: HopChange[];
  actions: string[];
  direction: "forward" | "backward";
  trackedCoin: string | null;
  isPassThrough: (address: string) => boolean;
}): NextHop {
  const { sender, changes, actions, direction, trackedCoin, isPassThrough } = params;

  if (direction === "backward") {
    return { nextAddress: sender, nextCoinType: trackedCoin, isSwap: false };
  }

  const positiveToOthers = changes.filter((c) => c.address !== sender && BigInt(c.amount) > 0n);

  if (isSwapHop(actions) && sender) {
    // What did the actor receive? Largest positive change credited to the sender.
    const received = changes
      .filter((c) => c.address === sender && BigInt(c.amount) > 0n)
      .sort((a, b) => (absBig(b.amount) > absBig(a.amount) ? 1 : -1))[0];
    return {
      nextAddress: sender,
      nextCoinType: received?.coin_type ?? trackedCoin,
      isSwap: true,
      note: received
        ? `Swap detected — following the swapper and switching tracked asset to ${received.coin_type}.`
        : "Swap detected — following the swapper.",
    };
  }

  if (positiveToOthers.length === 0) {
    return { nextAddress: null, nextCoinType: trackedCoin, isSwap: false };
  }

  // Prefer a non-pass-through recipient (skip DEX pools / protocol addresses).
  const nonPool = positiveToOthers.find((c) => !isPassThrough(c.address));
  const chosen = nonPool ?? positiveToOthers[0];
  return {
    nextAddress: chosen.address,
    nextCoinType: trackedCoin,
    isSwap: false,
    note: nonPool ? undefined : "Only pool/protocol recipients found; following the largest anyway.",
  };
}
