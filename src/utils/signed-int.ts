/**
 * Two's-complement readings of unsigned integers. Move has no signed integer
 * type in most deployed code, so signed quantities travel as `u64`, `u128`
 * or `u256` holding their two's complement (an `ifixed` fee, an `I64` tick
 * without its wrapper). The unsigned value is kept; the signed reading is
 * shown beside it where the width or the value makes it the plausible one.
 */

/** The negative reading of `v` as a `bits`-wide two's-complement integer, or null when its top bit is clear or it does not fit. */
export function twosComplement(v: bigint, bits: number): bigint | null {
  const top = 1n << BigInt(bits - 1);
  const span = 1n << BigInt(bits);
  return v >= top && v < span ? v - span : null;
}

/** Narrower integer widths whose top half a value below 2^255 can fall in. */
const NARROW_WIDTHS = [64, 128];

/**
 * Every plausible reading of an unsigned integer whose width is unknown. A
 * value in the top half of the `u256` range reads only as its negative (no
 * amount, supply or price reaches 2^255); below that, itself and the
 * negative reading at each width whose top bit it sets.
 */
export function signedReadings(v: bigint): bigint[] {
  const wide = twosComplement(v, 256);
  if (wide !== null) return [wide];
  const out = [v];
  for (const w of NARROW_WIDTHS) {
    const n = twosComplement(v, w);
    if (n !== null) out.push(n);
  }
  return out;
}

/**
 * The signed reading to show beside an unsigned value. With the width known
 * (`u64`, `u128`, `u256`), any value with the top bit set. With it unknown,
 * only a value in the top half of the `u256` range: no amount, supply or
 * price reaches 2^255, while a `u128` in its top half can be a wrapping
 * accumulator.
 */
export function signedReading(value: string | bigint, bits?: number): string | null {
  let v: bigint;
  try {
    v = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    return null;
  }
  if (v < 0n) return null;
  const n = twosComplement(v, bits ?? 256);
  return n === null ? null : n.toString();
}

/**
 * The signed readings of every number in decoded JSON that sits in the top
 * half of the `u256` range, by dotted path, for display beside the JSON
 * itself. Null when there are none.
 */
export function signedFieldReadings(json: unknown): Record<string, string> | null {
  const out: Record<string, string> = {};
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 8) return;
    if (typeof v === "string" && /^\d{77,78}$/.test(v)) {
      const n = signedReading(v);
      if (n !== null) out[path] = n;
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i), depth + 1));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(json, "", 0);
  return Object.keys(out).length ? out : null;
}
