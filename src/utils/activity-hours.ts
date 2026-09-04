/**
 * When an address is active, by hour of day.
 *
 * Hours are points on a circle, so this uses circular statistics rather than
 * scanning for a quiet run: the **circular mean** of activity gives a peak hour,
 * and the **resultant length R** — 0 for activity spread evenly around the
 * clock, 1 for everything in one hour — measures how concentrated it is. R is
 * the confidence, and it falls out of the same computation as the peak.
 *
 * That approach, the local-16:00 anchor and the deliberately wide region bands
 * are taken from a production implementation of the same idea rather than
 * invented here. A quiet-window scan, which was the first attempt, treats hour
 * 23 and hour 0 as unrelated and has no natural confidence measure.
 *
 * One improvement on that prior version: it consumed a *ranking* of active
 * hours with no counts, and its own comment notes confidence therefore could not
 * reflect activity mass. This weights by the real histogram.
 *
 * **`always_on` is a finding, not a failure.** Activity spread evenly around the
 * clock is what automation looks like, and on Sui it is the common answer: of 14
 * sampled active senders, 11 did 500 transactions inside a single day. An
 * address with no human rhythm is telling you something.
 *
 * A region is not a city. The bands below are multi-hour-wide on purpose,
 * because the inference is worth about ±1-2 hours.
 */

/** Below this the hour distribution is noise rather than a rhythm. */
const MIN_SAMPLES = 50;

/** Activity inside a single day cannot show a daily rhythm. */
const MIN_SPAN_DAYS = 7;

/**
 * Resultant length below which activity is not concentrated enough to read.
 *
 * Taken from the production implementation. 0 is uniform around the clock, 1 is
 * a single hour; below this the peak is not meaningfully distinguishable.
 */
const MIN_RESULTANT = 0.35;

/**
 * Transactions per day above which no human is doing this by hand.
 *
 * Measured: 17 of 20 sampled active senders did 400 transactions inside a
 * single day, which is thousands per day. A busy human trader might reach a few
 * dozen. This catches automation the circadian test cannot, because a burst has
 * no daily rhythm to read and would otherwise be reported as "not enough data".
 */
const HUMAN_RATE_CEILING = 200;

/**
 * Rate below which a flat clock says nothing about automation.
 *
 * `always_on` asks whether activity is spread evenly, and a 24/7 script and an
 * occasional person produce the same answer: a wallet doing 0.4 transactions a
 * day over 292 days CANNOT concentrate, because 120 points scattered across a
 * year never form a peak. Reading that as automation was wrong on a real
 * mainnet wallet, and it is the failure this codebase exists to avoid — a
 * confident label on an address that simply is not used much.
 *
 * Above this, flatness is informative: a person transacting several times a day
 * would have left a working-hours shape, and its absence means something.
 */
const MIN_RATE_FOR_FLATNESS = 3;

/**
 * Share of activity in a single hour above which a "human working session"
 * reading is not the only one worth naming.
 *
 * A person's day spreads over several hours. Nearly everything inside one hour
 * is equally consistent with a job that runs on a schedule, and a reader told
 * only about a timezone will not think of that themselves.
 */
const SCHEDULED_JOB_HOUR_SHARE = 0.4;

/** Assumed local hour of peak activity — late afternoon / evening. */
const LOCAL_ACTIVITY_CENTER = 16;

/**
 * Coarse region for an inferred UTC offset.
 *
 * Bands are intentionally wide and named for their whole span. The offset is
 * the precise output; this is the honest fuzzy bucket, and it exists so a
 * reader is not left to turn a number into a country themselves.
 */
function regionForOffset(off: number): string {
  if (off <= -7) return "W. N. America (Pacific/Mountain)";
  if (off <= -4) return "N. America (Central–Eastern)";
  if (off <= -1) return "Atlantic / E. South America";
  if (off <= 1) return "UK / W. Europe / W. Africa";
  if (off <= 3) return "C. Europe / Africa / Middle East";
  if (off <= 6) return "W/Central Asia / India";
  if (off <= 9) return "E. / SE Asia";
  return "E. Asia / Oceania";
}

export interface ActivityHours {
  /** Transactions per UTC hour, index 0-23. */
  histogram: number[];
  sample_size: number;
  span_days: number;
  /** Circular mean of activity, in UTC hours. Null when there is no signal. */
  peak_hour_utc: number | null;
  /**
   * Resultant length: 0 is evenly spread around the clock, 1 is one hour.
   * Doubles as the confidence in everything derived from it.
   */
  concentration: number;
  /** True when activity is spread evenly — the automation signal. */
  always_on: boolean;
  /** Mean transactions per day over the observed span. */
  transactions_per_day: number | null;
  /**
   * Automation is indicated, by either route: a flat clock over a long span, or
   * a rate no person sustains by hand. The two catch different populations —
   * measured on Sui, most active wallets are the second.
   */
  automation_indicated: boolean;
  utc_offset_estimate: number | null;
  region_estimate: string | null;
  reading: string;
}

export function activityHours(timestamps: Array<string | null | undefined>): ActivityHours | null {
  const times: number[] = [];
  for (const t of timestamps) {
    if (!t) continue;
    const ms = Date.parse(t);
    // Unparseable is skipped, never counted as epoch zero — that would invent
    // activity at 00:00 UTC and drag every reading toward the same answer.
    if (Number.isFinite(ms)) times.push(ms);
  }
  if (times.length === 0) return null;

  const histogram = new Array(24).fill(0);
  for (const ms of times) histogram[new Date(ms).getUTCHours()]++;

  times.sort((a, b) => a - b);
  const spanDays = (times[times.length - 1] - times[0]) / 86_400_000;

  // Circular mean, weighted by how much activity each hour actually holds.
  let sx = 0;
  let sy = 0;
  for (let h = 0; h < 24; h++) {
    const a = (h / 24) * 2 * Math.PI;
    sx += Math.cos(a) * histogram[h];
    sy += Math.sin(a) * histogram[h];
  }
  sx /= times.length;
  sy /= times.length;
  const R = Math.sqrt(sx * sx + sy * sy);

  let peak: number | null = null;
  let offset: number | null = null;
  let region: string | null = null;
  let reading: string;

  const thin = times.length < MIN_SAMPLES;
  const brief = spanDays < MIN_SPAN_DAYS;
  const alwaysOn = R < MIN_RESULTANT;
  // Rate needs a span to divide by; a handful of transactions in one minute is
  // not evidence of a sustained rate.
  const rate = spanDays > 0 ? times.length / spanDays : null;
  const tooFast = rate !== null && times.length >= 20 && rate > HUMAN_RATE_CEILING;

  if (tooFast) {
    reading =
      `${times.length} transactions over ${spanDays.toFixed(2)} days — about ${Math.round(rate!)} per day. ` +
      "No person does that by hand, so this is automated regardless of what the clock shows. The hour " +
      "distribution below reflects when the script ran, not when anyone was awake.";
  } else if (thin || brief) {
    reading =
      `Not enough to read a daily rhythm: ${times.length} transactions over ${spanDays.toFixed(1)} days ` +
      `(needs ${MIN_SAMPLES}+ spanning ${MIN_SPAN_DAYS}+ days). The histogram is reported, but do not ` +
      "infer a timezone from it.";
  } else if (alwaysOn && rate !== null && rate < MIN_RATE_FOR_FLATNESS) {
    // Flat, but too sparse for flatness to mean anything.
    reading =
      `Activity is spread around the clock (concentration ${R.toFixed(2)}), but at only ` +
      `${rate.toFixed(1)} transactions a day it could not look otherwise — ${times.length} points across ` +
      `${spanDays.toFixed(0)} days cannot form a peak whoever is behind them. This is an occasionally used ` +
      "wallet, and no conclusion about automation or timezone follows from it either way.";
  } else if (alwaysOn) {
    reading =
      `Activity is spread around the clock (concentration ${R.toFixed(2)}, below ${MIN_RESULTANT}) at ` +
      `${rate !== null ? rate.toFixed(1) : "?"} transactions a day — enough that a person keeping ordinary ` +
      "hours would have left a shape, and none is present. That is what an automated or always-on wallet " +
      "looks like, or several people sharing one address. The absence is itself a finding.";
  } else {
    let meanHour = (Math.atan2(sy, sx) / (2 * Math.PI)) * 24;
    if (meanHour < 0) meanHour += 24;
    peak = Number(meanHour.toFixed(1));
    let off = Math.round(LOCAL_ACTIVITY_CENTER - meanHour);
    while (off > 12) off -= 24;
    while (off < -11) off += 24;
    offset = off;
    region = regionForOffset(off);
    // A single hour holding most of the activity is as consistent with a
    // scheduled job as with a working session, and a reader given only a
    // timezone will not think of that themselves.
    const topHour = histogram.indexOf(Math.max(...histogram));
    const topShare = histogram[topHour] / times.length;
    const concentratedInOneHour = topShare >= SCHEDULED_JOB_HOUR_SHARE;
    reading =
      `Activity peaks around ${peak.toFixed(1)}:00 UTC with concentration ${R.toFixed(2)}. ` +
      `If that peak is a normal late-afternoon one, the operator sits near UTC${off >= 0 ? "+" : ""}${off} ` +
      `— ${region}. A REGION, not a city, and it assumes one person on an ordinary schedule. The same ` +
      "pattern is produced by two people who merely share a timezone or a working day, so corroborate it." +
      (concentratedInOneHour
        ? ` NOTE: ${(topShare * 100).toFixed(0)}% of activity falls in the single hour ${topHour}:00 UTC. ` +
          "A person's day spreads wider than that, so a job running on a schedule fits this equally well — " +
          "and a scheduled job has no timezone at all, only a cron line."
        : "");
  }

  return {
    histogram,
    sample_size: times.length,
    span_days: Number(spanDays.toFixed(1)),
    peak_hour_utc: peak,
    concentration: Number(R.toFixed(3)),
    // Flatness at a rate too low to be informative is not an automation claim.
    always_on:
      !thin && !brief && !tooFast && alwaysOn && rate !== null && rate >= MIN_RATE_FOR_FLATNESS,
    transactions_per_day: rate === null ? null : Number(rate.toFixed(1)),
    automation_indicated:
      tooFast ||
      (!thin && !brief && alwaysOn && rate !== null && rate >= MIN_RATE_FOR_FLATNESS),
    utc_offset_estimate: offset,
    region_estimate: region,
    reading,
  };
}
