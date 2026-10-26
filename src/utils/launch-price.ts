import { gqlQuery } from "../clients/graphql.js";
import { priceUsdAtTime } from "./valuation.js";
import { SUI_LAUNCH_TYPE } from "./launch-evidence.js";

const Q64 = 1n << 64n;
const MIST = 1_000_000_000n;
const STATE_QUERY = `query($id:SuiAddress!,$cp:UInt53!){object(address:$id,atCheckpoint:$cp){asMoveObject{contents{json}}}}`;
interface StateRead { object: { asMoveObject?: { contents?: { json?: Record<string, unknown> } } } | null }
const positive = (value: unknown): bigint | null => typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > 0n ? BigInt(value) : null;

/** Raw SUI that a raw launch-coin amount can buy at this checkpoint's own curve or pool spot rate. */
export function suiAtLaunchPrice(amount: bigint, state: Record<string, unknown>, venue: "curve" | "pool", coinIsA: boolean | null): bigint | null {
  if (venue === "curve") {
    const sui = positive(state.sui_reserve);
    const token = positive(state.token_reserve);
    return sui !== null && token !== null ? amount * sui / token : null;
  }
  if (coinIsA === null) return null;
  const sqrt = positive(state.current_sqrt_price);
  if (sqrt !== null) return coinIsA ? amount * sqrt * sqrt / (Q64 * Q64) : amount * Q64 * Q64 / (sqrt * sqrt);
  const a = positive(state.coin_a);
  const b = positive(state.coin_b);
  return a !== null && b !== null ? amount * (coinIsA ? b : a) / (coinIsA ? a : b) : null;
}

/** Unknown on-chain state or historical SUI price never means a known-below-floor transfer. */
export async function launchTokenUsd(
  amount: bigint,
  timestamp: string,
  checkpoint: number | null,
  curveId: string,
  pool: { id: string; coinIsA: boolean | null } | null,
  states: Map<string, Record<string, unknown> | null>,
  suiPrices: Map<number, number | null>,
): Promise<number | null> {
  if (checkpoint === null || !Number.isFinite(checkpoint)) return null;
  const stateAt = async (id: string): Promise<Record<string, unknown> | null> => {
    const key = `${id}:${checkpoint}`;
    if (!states.has(key)) {
      const read = await gqlQuery<StateRead>(STATE_QUERY, { id, cp: checkpoint }).catch(() => null);
      states.set(key, read?.object?.asMoveObject?.contents?.json ?? null);
    }
    return states.get(key) ?? null;
  };
  const curve = await stateAt(curveId);
  let rawSui = curve ? suiAtLaunchPrice(amount, curve, "curve", null) : null;
  if (rawSui === null && pool) {
    const state = await stateAt(pool.id);
    rawSui = state ? suiAtLaunchPrice(amount, state, "pool", pool.coinIsA) : null;
  }
  if (rawSui === null) return null;
  const hour = Math.floor(Date.parse(timestamp) / 3_600_000);
  if (!Number.isFinite(hour)) return null;
  if (!suiPrices.has(hour)) {
    const at = Math.floor(Date.parse(timestamp) / 1000);
    const quote = await priceUsdAtTime([SUI_LAUNCH_TYPE], at).catch(() => null);
    const point = quote?.points.get(SUI_LAUNCH_TYPE);
    suiPrices.set(hour, point && Math.abs((point.publishTime ?? at) - at) <= 3_600 && point.price > 0 ? point.price : null);
  }
  const usd = suiPrices.get(hour);
  return usd == null ? null : Number(rawSui) / Number(MIST) * usd;
}
