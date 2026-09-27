/**
 * One row per run of identical swaps: same pool, protocol, event type,
 * direction and coins. A swap whose direction and coins are both unknown is
 * never folded, since swaps either way on its pool would share a key and sum
 * two coins' raw units. A row keeps every event index, the summed amounts, the
 * pool price before the first and after the last swap, and price_change_pct
 * once when every swap moved the price alike, per swap when they differ.
 */
export interface SwapRow {
  event: number;
  event_type: string;
  pool: string | null;
  protocol: string | null;
  a_to_b: boolean | null;
  amount_in: string | null;
  amount_out: string | null;
  coin_in: string | null;
  coin_out: string | null;
  price_before: number | null;
  price_after: number | null;
  price_change_pct: number | null;
  price_basis: string | null;
}

export type FoldedSwap =
  | SwapRow
  | (Omit<SwapRow, "event" | "price_change_pct"> & {
      count: number;
      events: number[];
      price_change_pct?: number | null;
      price_change_pcts?: Array<number | null>;
    });

const sum = (values: Array<string | null>) => (values.some((v) => v === null) ? null : values.reduce((s, v) => s + BigInt(v!), 0n).toString());

export function foldSwaps(swaps: SwapRow[]): FoldedSwap[] {
  const groups = new Map<string, SwapRow[]>();
  swaps.forEach((s, i) => {
    const known = s.a_to_b !== null || (s.coin_in !== null && s.coin_out !== null);
    const key = known ? JSON.stringify([s.pool, s.protocol, s.event_type, s.a_to_b, s.coin_in, s.coin_out]) : `unknown:${i}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  });
  return [...groups.values()].map((rows) => {
    if (rows.length === 1) return rows[0];
    const [first] = rows;
    const last = rows[rows.length - 1];
    const pcts = rows.map((r) => r.price_change_pct);
    const alike = pcts.every((p) => p === pcts[0]);
    return {
      event_type: first.event_type,
      pool: first.pool,
      protocol: first.protocol,
      a_to_b: first.a_to_b,
      coin_in: first.coin_in,
      coin_out: first.coin_out,
      count: rows.length,
      events: rows.map((r) => r.event),
      amount_in: sum(rows.map((r) => r.amount_in)),
      amount_out: sum(rows.map((r) => r.amount_out)),
      price_before: first.price_before,
      price_after: last.price_after,
      ...(alike ? { price_change_pct: pcts[0] } : { price_change_pcts: pcts }),
      price_basis: first.price_basis,
    };
  });
}
