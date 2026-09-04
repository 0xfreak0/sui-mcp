/**
 * When an address is active, by hour of day.
 *
 * A human operator sleeps, and the gap shows up as a run of quiet hours whose
 * position implies a longitude. That is the theory. The measurement on Sui is
 * far less encouraging, and the shape of this module is built around it:
 *
 * - **Most active wallets have no rhythm at all.** Of 14 sampled active
 *   senders, 11 did 500 transactions inside a single day. Bursts and bots have
 *   no circadian signal to read, and reporting one anyway would be invention.
 * - **Even long-lived wallets are often flat.** Of the 3 spanning a week or
 *   more, 2 had a quiet-window share of ~30% against a flat baseline of 33%.
 * - **The estimate is unstable when thin.** Sampling down from a full history,
 *   the quiet window matched the full-sample answer only 52-60% of the time at
 *   20-100 transactions, and 85% at 200.
 *
 * So this reports the distribution always, and offers a timezone reading only
 * when sample size, span and depth all support one. "Flat, consistent with
 * automation" is the common answer, and it is a finding rather than a failure.
 *
 * A longitude is not a country. UTC+2 is Berlin, Cairo and Johannesburg, and
 * nothing here narrows that.
 */

/** Below this, the hour distribution is noise. Derived from the sampling test. */
const MIN_SAMPLES = 50;

/** Activity inside one day cannot show a daily rhythm. */
const MIN_SPAN_DAYS = 7;

/**
 * Quiet-window share below which a gap is real rather than sampling noise.
 *
 * A flat distribution puts 8 of 24 hours — 33% — in any window. Two of three
 * long-lived wallets measured at ~30%, so the bar has to sit well under that.
 */
const MAX_QUIET_SHARE = 0.20;

/** Hours in the sleep window this looks for. */
const WINDOW = 8;

export interface ActivityHours {
  /** Transactions per UTC hour, index 0-23. */
  histogram: number[];
  sample_size: number;
  span_days: number;
  /** Quietest 8-hour run, as UTC hours. */
  quiet_window_utc: { start: number; end: number };
  /** Share of all activity falling in that window. 0.33 is flat. */
  quiet_share: number;
  /**
   * Estimated UTC offset, or null when the evidence does not support one.
   *
   * Derived by placing the middle of the quiet window at 03:00 local — the
   * middle of a night's sleep. Coarse by construction.
   */
  utc_offset_estimate: number | null;
  reading: string;
}

/** Lowest-activity rotation of {@link WINDOW} hours. */
function quietWindow(histogram: number[]): { start: number; count: number } {
  let best = { start: 0, count: Infinity };
  for (let s = 0; s < 24; s++) {
    let c = 0;
    for (let i = 0; i < WINDOW; i++) c += histogram[(s + i) % 24];
    if (c < best.count) best = { start: s, count: c };
  }
  return best;
}

/**
 * Summarise activity by hour.
 *
 * `timestamps` are ISO strings; anything unparseable is skipped rather than
 * counted as epoch zero, which would invent activity at 00:00 UTC.
 */
export function activityHours(timestamps: Array<string | null | undefined>): ActivityHours | null {
  const times: number[] = [];
  for (const t of timestamps) {
    if (!t) continue;
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) times.push(ms);
  }
  if (times.length === 0) return null;

  const histogram = new Array(24).fill(0);
  for (const ms of times) histogram[new Date(ms).getUTCHours()]++;

  times.sort((a, b) => a - b);
  const spanDays = (times[times.length - 1] - times[0]) / 86_400_000;
  const qw = quietWindow(histogram);
  const share = qw.count / times.length;

  const thin = times.length < MIN_SAMPLES;
  const brief = spanDays < MIN_SPAN_DAYS;
  const flat = share > MAX_QUIET_SHARE;

  let offset: number | null = null;
  let reading: string;
  if (thin || brief) {
    reading =
      `Not enough to read a daily rhythm: ${times.length} transactions over ${spanDays.toFixed(1)} days ` +
      `(needs ${MIN_SAMPLES}+ spanning ${MIN_SPAN_DAYS}+ days). The histogram is reported, but do not infer a timezone from it.`;
  } else if (flat) {
    reading =
      `Activity is spread evenly across the day — the quietest 8 hours still hold ${(share * 100).toFixed(0)}% ` +
      "of it, against 33% for a perfectly flat distribution. No human sleep pattern is present, which is " +
      "consistent with automation or with several people sharing the address. That absence is itself a finding.";
  } else {
    // Middle of the quiet run, placed at 03:00 local.
    const mid = (qw.start + WINDOW / 2) % 24;
    offset = ((3 - mid + 12 + 24) % 24) - 12;
    reading =
      `Quiet between ${qw.start}:00 and ${(qw.start + WINDOW) % 24}:00 UTC, holding only ` +
      `${(share * 100).toFixed(0)}% of activity. If that gap is sleep, the operator is near UTC${offset >= 0 ? "+" : ""}${offset}. ` +
      "That is a LONGITUDE, not a country — UTC+2 covers Berlin, Cairo and Johannesburg — and it assumes one " +
      "person on an ordinary schedule. Corroborate before relying on it.";
  }

  return {
    histogram,
    sample_size: times.length,
    span_days: Number(spanDays.toFixed(1)),
    quiet_window_utc: { start: qw.start, end: (qw.start + WINDOW) % 24 },
    quiet_share: Number(share.toFixed(3)),
    utc_offset_estimate: offset,
    reading,
  };
}
