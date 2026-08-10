/**
 * Draw a control group from a population.
 *
 * Every conclusion in this toolkit that rests on "these addresses share X" is
 * only as good as the answer to "how often does X happen anyway?". Twenty-three
 * of twenty-five wallets sharing a funder means nothing until you know that a
 * random twenty-five from the same protocol share one at a rate near zero. The
 * documentation has always said to run that comparison; there was no way to
 * assemble the control except by hand, so in practice it was skipped.
 *
 * Two properties matter, and both are easy to get wrong by hand:
 *
 * - **Random, not top-N.** Sampling the largest actors compares a cohort
 *   against whales, which are unlike the general population in exactly the ways
 *   that produce false positives — they transact more, so they collide more.
 * - **Reproducible.** A control drawn once and unrepeatable cannot be checked
 *   by anyone reading the report. Passing a seed makes the draw deterministic,
 *   so the same seed and pool always yield the same control.
 */

/**
 * Small deterministic PRNG (mulberry32). Node has no seedable random, and the
 * alternative — Math.random — makes a control impossible to reproduce, which
 * defeats the point of having one in a report someone else must check.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ControlSample {
  addresses: string[];
  /** Distinct candidates left after exclusions — what was drawn from. */
  population_size: number;
  /** How many were asked for, when that exceeds what was available. */
  requested: number;
  seed: number | null;
  /** True when the pool was too small to fill the request. */
  undersampled: boolean;
}

export interface SampleOptions {
  /** Addresses to remove first — normally the cohort under test. */
  exclude?: Iterable<string>;
  /** Omit for a non-reproducible draw. */
  seed?: number;
}

/**
 * Sample `n` distinct addresses from `pool`, excluding `opts.exclude`.
 *
 * A partial Fisher-Yates shuffle: unbiased, and it stops after `n` draws rather
 * than ordering the whole pool.
 */
export function sampleControl(pool: string[], n: number, opts: SampleOptions = {}): ControlSample {
  const excluded = new Set(opts.exclude ?? []);
  // De-duplicate before excluding: a pool built from event senders repeats an
  // address once per event, and without this an active wallet would be far more
  // likely to be drawn than a quiet one — reintroducing the activity bias that
  // random sampling exists to remove.
  const candidates = [...new Set(pool)].filter((a) => !excluded.has(a));

  const seed = opts.seed ?? null;
  const rand = seed === null ? Math.random : mulberry32(seed);

  const take = Math.min(n, candidates.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (candidates.length - i));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  return {
    addresses: candidates.slice(0, take),
    population_size: candidates.length,
    requested: n,
    seed,
    undersampled: take < n,
  };
}
