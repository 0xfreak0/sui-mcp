/**
 * Signals derived from a completed funding walk.
 *
 * Both of these answer questions the raw chains contain but do not state, and
 * that a reader will not spot by eye once a batch runs past a handful of
 * addresses.
 */

export interface SignalStep {
  address: string;
  funded_by: string;
  funding_tx?: string;
  timestamp?: string | null;
  amount?: string;
}

/* ------------------------------------------------------------------ *
 * Subject-to-subject links
 * ------------------------------------------------------------------ */

export interface SubjectLink {
  /** A subject address that funded another subject. */
  funder: string;
  /** The subject it funded. */
  funded: string;
  funding_tx?: string;
  timestamp?: string | null;
  amount?: string;
}

/**
 * Find cases where one address under investigation funded another.
 *
 * This is a stronger relation than sharing an ancestor and it needs no
 * denominator to interpret: there is no base rate to compare against, because
 * the money went directly from one subject to another. It is easy to miss by
 * eye — the funder appears in one address's chain while sitting several rows
 * away in the input list — and easy to miss entirely once a batch has fifty
 * members.
 */
export function detectSubjectLinks(steps: SignalStep[], subjects: Iterable<string>): SubjectLink[] {
  const subjectSet = new Set(subjects);
  const seen = new Set<string>();
  const links: SubjectLink[] = [];

  for (const s of steps) {
    if (s.funded_by === "unknown") continue;
    // Self-funding is an artefact of how the walk attributes a transaction an
    // address sent itself, not a relationship between two subjects.
    if (s.address === s.funded_by) continue;
    if (!subjectSet.has(s.funded_by) || !subjectSet.has(s.address)) continue;

    const key = `${s.funded_by}->${s.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      funder: s.funded_by,
      funded: s.address,
      funding_tx: s.funding_tx,
      timestamp: s.timestamp,
      amount: s.amount,
    });
  }
  return links;
}

/* ------------------------------------------------------------------ *
 * Funding bursts
 * ------------------------------------------------------------------ */

export interface FundingBurst {
  started_at: string;
  ended_at: string;
  /** Wall-clock width of the burst. Zero when everything landed at once. */
  span_seconds: number;
  addresses: string[];
  /** Distinct funders paying inside this burst. */
  funders: string[];
  /** True when one funder paid every address in the burst. */
  single_funder: boolean;
  /** Distinct funding transactions inside the burst. */
  distinct_transactions: number;
  /**
   * True when the whole burst is one transaction — in which case this is the
   * same fact the co-funding section already reports, not a second signal.
   */
  same_transaction: boolean;
}

/** Default gap that separates bursts. Chosen to match the documented case. */
export const DEFAULT_BURST_GAP_SECONDS = 60;

/**
 * Cluster funding events by time, splitting wherever the gap exceeds
 * `gapSeconds`.
 *
 * Timing is the discriminator that survives when co-funding does not. A batch
 * payout tells you little on its own, but a set of addresses funded inside a
 * few seconds of each other did not arrive there independently — people do not
 * coordinate to the second, scripts do.
 *
 * Only clusters of two or more are returned: a lone funding event is not a
 * burst, and reporting it as one would pad a report with noise.
 *
 * A burst whose events all belong to one transaction carries `same_transaction`,
 * because it restates what co-funding already says. Independent corroboration
 * requires separate payments that happened to land close together.
 *
 * Addresses with no timestamp are skipped rather than bucketed together, which
 * would invent a burst out of missing data.
 */
export function detectFundingBursts(
  steps: SignalStep[],
  gapSeconds: number = DEFAULT_BURST_GAP_SECONDS,
): FundingBurst[] {
  const timed = steps
    .filter((s) => s.timestamp && s.funded_by !== "unknown")
    .map((s) => ({ ...s, ms: Date.parse(s.timestamp!) }))
    .filter((s) => Number.isFinite(s.ms))
    .sort((a, b) => a.ms - b.ms);

  const bursts: FundingBurst[] = [];
  let current: typeof timed = [];

  const flush = () => {
    // De-duplicate: one address funded twice inside a window is one address,
    // and counting it twice would inflate an apparent cluster.
    const addresses = [...new Set(current.map((s) => s.address))];
    if (addresses.length < 2) return;
    const funders = [...new Set(current.map((s) => s.funded_by))];
    // A burst made of one transaction is co-funding restated: same addresses,
    // same instant, same payment. Reported with the flag set so a reader does
    // not tally it as independent corroboration of the co-funding entry.
    const txs = new Set(current.map((s) => s.funding_tx).filter(Boolean));
    bursts.push({
      started_at: new Date(current[0].ms).toISOString(),
      ended_at: new Date(current[current.length - 1].ms).toISOString(),
      span_seconds: (current[current.length - 1].ms - current[0].ms) / 1000,
      addresses,
      funders,
      single_funder: funders.length === 1,
      distinct_transactions: txs.size,
      same_transaction: txs.size === 1,
    });
  };

  for (const s of timed) {
    if (current.length && s.ms - current[current.length - 1].ms > gapSeconds * 1000) {
      flush();
      current = [];
    }
    current.push(s);
  }
  flush();

  // Tightest first: a burst spanning two seconds says more than one spanning a
  // minute, independent of how many addresses each covers.
  return bursts.sort(
    (a, b) => a.span_seconds - b.span_seconds || b.addresses.length - a.addresses.length,
  );
}
