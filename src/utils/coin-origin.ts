/**
 * What the chain says about where a coin came from: its total supply and the
 * address that published it.
 *
 * Read only for a coin no price source quotes, when an inflow of it has to be
 * judged as funding or spam (`CoinOrigin` in `funding.ts`). Both answers are
 * cached per network for the process. A failed read is not cached, so a
 * transient error costs one conclusion rather than every later one, and it is
 * reported as `failed` rather than as a null value: "the chain reports no
 * supply" keeps an inflow spam, while "the supply could not be read" leaves
 * the question open and has to be disclosed.
 */
import { sui } from "../clients/grpc.js";
import { getNetwork } from "../config.js";
import { isNotFound } from "./errors.js";
import { resolvePublisher } from "./publisher.js";

const supplies = new Map<string, Promise<bigint | null>>();
const publishers = new Map<string, Promise<string | null>>();

/** A cached read, whether this call is the one that went to the network, and why it failed. */
export interface OriginRead<T> {
  /** The answer. Null is a read negative only when `failed` is absent. */
  value: T | null;
  fetched: boolean;
  /** Set when the read threw after retries; `value` is then null and says nothing. */
  failed?: string;
}

async function memoized<T>(
  cache: Map<string, Promise<T | null>>,
  coinType: string,
  read: () => Promise<T | null>,
): Promise<OriginRead<T>> {
  const key = `${getNetwork()}:${coinType}`;
  let pending = cache.get(key);
  const fetched = !pending;
  if (!pending) {
    const p = read();
    cache.set(key, p);
    p.catch(() => {
      if (cache.get(key) === p) cache.delete(key);
    });
    pending = p;
  }
  try {
    return { value: await pending, fetched };
  } catch (err) {
    return { value: null, fetched, failed: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Total supply in raw units, from the coin's `TreasuryCap` as `getCoinInfo`
 * reports it. Null when the service reports none: a regulated coin whose cap
 * it does not track, OCEAN for one, has no `treasury` in the response, and a
 * coin with no CoinMetadata is NOT_FOUND. Any other error is `failed`.
 */
export function coinTotalSupply(coinType: string): Promise<OriginRead<bigint>> {
  return memoized(supplies, coinType, async () => {
    try {
      const { response } = await sui.stateService.getCoinInfo({ coinType });
      const supply = response.treasury?.totalSupply;
      return supply === undefined || supply === null ? null : BigInt(supply);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  });
}

/**
 * Who published the package that defines `coinType`, through the same
 * `resolvePublisher` `identify_address` and `analyze_package` use (package
 * object, then its creating transaction, archive included). A coin type names
 * the package version that defined it, the lineage's first for a
 * one-time-witness coin, so this is the original publisher. A framework
 * package has no publisher here. A read that could not resolve one is
 * `failed`, and is not cached.
 */
export function coinPublisher(coinType: string): Promise<OriginRead<string>> {
  return memoized(publishers, coinType, async () => {
    const r = await resolvePublisher(coinType.split("::")[0]);
    if (r.system_package) return null;
    if (!r.publisher) throw new Error(r.unresolved ?? "publisher unresolved");
    return r.publisher;
  });
}

/** Tests only: forget every cached supply and publisher. */
export function resetCoinOrigins(): void {
  supplies.clear();
  publishers.clear();
}
