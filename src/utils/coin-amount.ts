import { coinScale, displayCoin } from "./valuation.js";

/**
 * A raw base-unit amount in human units with its symbol, e.g. `"0.05 SUI"`.
 *
 * Raw amounts are exact but unreadable at a glance: 50000000 is 0.05 SUI, and
 * in a case about hundreds of millions it reads as fifty million. Anything
 * that reports a raw amount to a reader carries this beside it.
 *
 * Exact: the division is done on bigints, so a balance above 2^53 base units
 * loses no digits. Scale comes from {@link coinScale}, which resolves by coin
 * TYPE and marks a guessed scale `assumed scale`; a coin no curated list
 * vouches for is marked `unverified`, because its symbol is whatever its
 * minter chose.
 *
 * Null in, null out, so a caller whose read failed reports null here too
 * rather than a formatted zero.
 */
export function formatCoinAmount(
  raw: string | bigint | null | undefined,
  coinType: string,
): string | null {
  if (raw === null || raw === undefined) return null;
  let value: bigint;
  try {
    value = typeof raw === "bigint" ? raw : BigInt(raw);
  } catch {
    return null;
  }
  const abs = value < 0n ? -value : value;
  const { decimals, source } = coinScale(coinType);
  const { symbol, verified } = displayCoin(coinType);

  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  const marks = [
    verified === false ? "unverified" : null,
    source === "assumed" ? "assumed scale" : null,
  ].filter(Boolean);
  return (
    `${value < 0n ? "-" : ""}${frac ? `${whole}.${frac}` : whole} ${symbol}` +
    (marks.length ? ` (${marks.join(", ")})` : "")
  );
}
