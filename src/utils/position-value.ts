/**
 * Shared contract for valuing what an address holds beyond plain coins:
 * staked SUI, liquid-staking and receipt coins, LP and CLMM positions,
 * lending positions, vault shares and NFTs.
 *
 * Each protocol's reader lives in `src/utils/valuers/<name>.ts` and registers
 * itself here. Tools read positions only through `valuePositions`, so every
 * value carries how it was computed and how far to trust it.
 */

/** How far a value can be trusted, in the server's evidence tiers. */
export type ValueTier = "chain-derived" | "price-provider" | "heuristic";

/** What one asset leg of a position is. */
export type AssetSide = "supply" | "borrow" | "liquidity" | "reward" | "stake" | "item";

export interface ValuedAsset {
  coin_type: string;
  /** Raw base units as a decimal string. */
  amount: string;
  side: AssetSide;
  /** USD at the valuation time; null when no price is known. */
  usd: number | null;
  /** USD per whole unit that `usd` was computed at. */
  price_usd?: number;
  /** Where `price_usd` came from: a protocol's own oracle (e.g. "navi_oracle") or a price provider. */
  price_source?: string;
  /**
   * Both prices, set when the protocol's oracle price and a provider's differ
   * by more than 2%, or when the oracle price was too old to use and the
   * provider's valued the leg (`oracle_age_sec` is then how old it was).
   */
  price_check?: { oracle_price: number; provider_price: number; provider_source: string; diff_pct: number; oracle_age_sec?: number };
  /** What the leg is when the coin type alone does not say, e.g. a perpetual's unrealized PnL. */
  note?: string;
}

export interface ValuedPosition {
  /** Curated protocol name, or null when the reader is generic. */
  protocol: string | null;
  kind: "staked_sui" | "lst" | "lp" | "clmm" | "lending" | "vault" | "nft";
  /** The object that holds or proves the position, when there is one. */
  object_id: string | null;
  assets: ValuedAsset[];
  /** Supply, liquidity, stake and rewards minus borrows, in USD; null when any leg is unpriced. */
  usd_net: number | null;
  /** How the amounts and prices were derived, in one sentence. */
  method: string;
  tier: ValueTier;
  /** Why the position or a leg has no USD value. */
  unpriced_reason?: string;
  /** Per-kind evidence behind the value, e.g. an NFT's floor and last sale. */
  detail?: Record<string, unknown>;
  /** Health figures as the protocol stores or defines them, e.g. a stored borrow limit in USD. */
  health?: Record<string, number | boolean | null>;
  /** Which figures measure distance to liquidation and which measure worth, when the protocol's own USD totals and the legs' disagree. */
  health_basis?: string;
}

export interface ValuationContext {
  owner: string;
  /** Value as of this checkpoint; the latest state when absent. */
  atCheckpoint?: string;
  /** Unix seconds for historical prices; now when absent. */
  atTime?: number;
  /**
   * Reads shared across one tool call (prices at one time, for one), so a
   * call valuing many objects does not repeat them. Keys are the reader's.
   */
  memo?: Map<string, Promise<unknown>>;
}

export interface ValuerResult {
  positions: ValuedPosition[];
  /** Objects or protocols the reader could not read, with the reason. */
  unread: Array<{ what: string; reason: string }>;
}

/** One object to value whatever its owner, e.g. one a transaction moved. */
export interface ObjectToValue {
  object_id: string;
  /** Full Move type of the object. */
  type: string;
  /** Move JSON of the object at the version being valued; null when unread. */
  json: Record<string, unknown> | null;
  version?: string;
}

export interface PositionValuer {
  /** Stable name, e.g. "staked_sui", "navi", "nft". */
  name: string;
  value(ctx: ValuationContext): Promise<ValuerResult>;
  /** Whether `valueObject` can value an object of this type. */
  handles?(type: string): boolean;
  /** A broad reader tried only after every specific reader declined the type. */
  fallback?: boolean;
  /**
   * Read what `handles` needs for these types (a type's field layout, say),
   * so `handles` itself answers without a request. `valueObjects` calls it
   * first; a caller asking `readerFor` about fallback readers calls
   * `prepareReaders` first.
   */
  prepare?(types: string[]): Promise<void>;
  /**
   * Value one object by its id and JSON rather than by listing an owner's
   * holdings. `ctx.owner` is the holder the caller is asking about.
   */
  valueObject?(obj: ObjectToValue, ctx: ValuationContext): Promise<ValuerResult>;
}

const valuers = new Map<string, PositionValuer>();

/**
 * More than any protocol on Sui holds. A position valued above it is a
 * reading error (an overflowed liquidity, a raw amount taken as USD) and is
 * listed as unread, never summed.
 */
export const MAX_PLAUSIBLE_USD = 10_000_000_000;

/** Positions past the plausible bound moved to `unread`. */
function plausible(r: ValuerResult): ValuerResult {
  const bad = r.positions.filter((p) => p.usd_net !== null && !(Math.abs(p.usd_net) <= MAX_PLAUSIBLE_USD));
  if (bad.length === 0) return r;
  return {
    positions: r.positions.filter((p) => !bad.includes(p)),
    unread: [
      ...r.unread,
      ...bad.map((p) => ({
        what: p.object_id ?? `${p.protocol ?? p.kind} position`,
        reason: `valued at ${p.usd_net} USD, more than any protocol on Sui holds, so it is treated as a reading error and not counted`,
      })),
    ],
  };
}

/** Register a reader. A second reader with the same name replaces the first. */
export function registerValuer(v: PositionValuer): void {
  valuers.set(v.name, v);
}

export function registeredValuers(): string[] {
  return [...valuers.keys()];
}

/**
 * Run every registered reader for one owner. A reader that throws is listed
 * in `unread` with its error and never hides the others' results. An object
 * a specific reader valued is not also counted from a fallback reader, which
 * can reach it wrapped inside another object.
 */
export async function valuePositions(ctx: ValuationContext, only?: string[]): Promise<ValuerResult & { valuers_run: string[] }> {
  const run = [...valuers.values()].filter((v) => !only || only.includes(v.name));
  const results = await Promise.allSettled(run.map((v) => v.value(ctx)));
  const specific: ValuedPosition[] = [];
  const broad: ValuedPosition[] = [];
  const unread: ValuerResult["unread"] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const checked = plausible(r.value);
      (run[i].fallback ? broad : specific).push(...checked.positions);
      unread.push(...checked.unread);
    } else {
      unread.push({ what: run[i].name, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }
  });
  const valued = new Set(specific.map((p) => p.object_id).filter((id): id is string => id !== null));
  const positions = [...specific, ...broad.filter((p) => p.object_id === null || !valued.has(p.object_id))];
  return { positions, unread, valuers_run: run.map((v) => v.name) };
}

/** Let every reader read what its `handles` needs for these types. A failed read leaves the reader declining them. */
export async function prepareReaders(types: string[]): Promise<void> {
  if (types.length === 0) return;
  await Promise.all([...valuers.values()].map((v) => v.prepare?.(types).catch(() => undefined)));
}

/** Readers that value single objects, specific ones before fallbacks. */
function objectReaders(): PositionValuer[] {
  const all = [...valuers.values()].filter((v) => v.handles && v.valueObject);
  return [...all.filter((v) => !v.fallback), ...all.filter((v) => v.fallback)];
}

/**
 * The reader `valueObjects` would give an object of this type, or null. A
 * broad reader listing an owner's objects skips types another reader owns,
 * so no object is valued twice. `specificOnly` leaves fallback readers out.
 */
export function readerFor(type: string, specificOnly = false): string | null {
  return objectReaders().find((v) => (!specificOnly || !v.fallback) && v.handles!(type))?.name ?? null;
}

/**
 * Value specific objects, each by the first reader whose `handles` accepts
 * its type, fallback readers last. Objects no reader handles are listed in
 * `unhandled` by id; a reader that throws lists the object in `unread`.
 */
export async function valueObjects(
  objs: ObjectToValue[],
  ctx: ValuationContext,
): Promise<ValuerResult & { unhandled: string[] }> {
  // Fallback readers can decide only once their reads are done; a type a
  // specific reader owns needs none.
  await prepareReaders([...new Set(objs.map((o) => o.type))].filter((t) => readerFor(t, true) === null));
  const readers = objectReaders();
  const positions: ValuedPosition[] = [];
  const unread: ValuerResult["unread"] = [];
  const unhandled: string[] = [];
  const jobs: Array<Promise<void>> = [];
  for (const obj of objs) {
    const reader = readers.find((v) => v.handles!(obj.type));
    if (!reader) {
      unhandled.push(obj.object_id);
      continue;
    }
    jobs.push(
      reader.valueObject!(obj, ctx).then(
        (r) => {
          const checked = plausible(r);
          positions.push(...checked.positions);
          unread.push(...checked.unread);
        },
        (err: unknown) => {
          unread.push({ what: obj.object_id, reason: err instanceof Error ? err.message : String(err) });
        },
      ),
    );
  }
  await Promise.all(jobs);
  return { positions, unread, unhandled };
}
