/**
 * Sui's on-chain currency registry, `0x2::coin_registry` (state at `0xc`).
 *
 * Not to be confused with `coin-registry.ts`, which is this project's curated
 * list. The two answer different questions and must not be merged:
 *
 * - The curated list answers "does anyone vouch that this is the coin you
 *   meant". That is what `verified` reports.
 * - This module answers "what does the chain record about this coin". It is a
 *   canonical metadata location, **not a whitelist**: anyone who can publish a
 *   coin can register it, so an impostor's entry sits beside the real asset's
 *   and looks identical. Presence here is never a vouch.
 *
 * ## Why read it
 *
 * It records decimals. `analyze_token` falls back to 9 when nothing knows the
 * scale, and a wrong scale misstates every amount derived from it by orders of
 * magnitude. Impostors often declare a different scale from the coin they
 * imitate, so the coins most likely to reach that fallback are the ones it is
 * most dangerous for. A registry entry replaces the guess with a fact, and
 * where nothing knows, the caller is told the scale was assumed.
 *
 * It also states whether a coin is regulated and names the cap that can freeze
 * holders, which is the same authority `check_coin_restrictions` reads.
 *
 * ## Lookup
 *
 * A `Currency` carries the coin type as a type argument, written
 * `0x2::coin_registry::Currency<0x2::sui::SUI>`, so this is a direct filtered
 * object read with no derivation to get wrong. The regulated-state variants
 * are `Unknown`, `Regulated` and `Unregulated`, and a `Regulated` entry always
 * carries a cap.
 *
 * A `Currency` made by `new_currency` or registered through
 * `finalize_registration` also sits at an id derived from its type:
 * `derived_object::claim(&mut registry.id, CurrencyKey<T>())` under `0xc`.
 * `CurrencyKey<T>()` has no fields, so its BCS is the one `false` byte of
 * the compiler's dummy field (checked live against HFROG's and wUSDC's
 * entries). That lets many candidate types be checked in one multi-get
 * without knowing which of them are coins.
 */

import { deriveObjectID, normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { normalizeCoinType } from "./coin-registry.js";
import type { FrameworkClaim } from "./framework-claims.js";

/** Whether an issuer can freeze holders of this coin, as the registry states it. */
export type RegulatedState = "regulated" | "unregulated" | "unknown";

export interface RegistryCurrency {
  decimals: number;
  symbol?: string;
  name?: string;
  description?: string;
  icon_url?: string;
  regulated: RegulatedState;
  /** The cap that can freeze addresses, when the registry names one. */
  regulated_cap_id?: string;
  /**
   * The registry's supply state. `fixed` and `burn_only` mean the TreasuryCap
   * was consumed into the registry, so nothing can mint; `unknown` says
   * nothing either way.
   */
  supply: SupplyState;
  /**
   * The TreasuryCap id the registry records. Set at creation for a coin made
   * through `new_currency` or `new_currency_with_otw`; a coin migrated from
   * `CoinMetadata` has one only after `set_treasury_cap_id`.
   */
  treasury_cap_id?: string;
}

export type SupplyState = "fixed" | "burn_only" | "unknown";

const CURRENCY_QUERY = `
  query($type: String!) {
    objects(filter: { type: $type }, first: 1) {
      nodes { asMoveObject { contents { json } } }
    }
  }
`;

interface CurrencyJson {
  decimals?: unknown;
  symbol?: unknown;
  name?: unknown;
  description?: unknown;
  icon_url?: unknown;
  regulated?: { "@variant"?: unknown; cap?: unknown };
  supply?: { "@variant"?: unknown } | null;
  treasury_cap_id?: unknown;
}

/** The `CoinRegistry` object, the parent every derived `Currency` id is computed under. */
const COIN_REGISTRY_ID = "0xc";

/**
 * The registry layout this reader relies on: the registry's id, a `Currency`
 * from `new_currency` or `finalize_registration` claiming the id derived from
 * `CurrencyKey<T>()` under it, `Currency`'s field names, the variant names of
 * its supply and regulated states, and `CurrencyKey<T>()` having no fields,
 * so its BCS is the compiler's one dummy byte.
 */
export const REGISTRY_LAYOUT_CLAIMS: FrameworkClaim[] = [
  { constant: "object::SUI_COIN_REGISTRY_OBJECT_ID", address: COIN_REGISTRY_ID, why: "Currency ids are derived under the CoinRegistry" },
  { fn: "coin_registry::new_currency", calls: ["derived_object::claim"], why: "a new_currency Currency sits at the id derived from its type" },
  { fn: "coin_registry::finalize_registration", calls: ["derived_object::claim"], why: "a registered one-time-witness Currency sits at the id derived from its type" },
  {
    struct: "coin_registry::Currency",
    fields: ["id", "decimals", "name", "symbol", "description", "icon_url", "supply", "regulated", "treasury_cap_id", "metadata_cap_id", "extra_fields"],
    why: "a registry entry is read by field name",
  },
  { struct: "coin_registry::SupplyState", fields: ["Fixed", "BurnOnly", "Unknown"], why: "supply state is read by variant name" },
  { struct: "coin_registry::RegulatedState", fields: ["Regulated", "Unregulated", "Unknown"], why: "regulated state is read by variant name" },
  { struct: "coin_registry::CurrencyKey", abilities: ["copy", "drop", "store"], fields: [], why: "a Currency's derived id uses the one-byte BCS of an empty key" },
];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The registry's entry for a coin, or null when it has none. Null means "not
 * registered", which is the common case and says nothing about the coin. A
 * failed read throws.
 */
export async function readRegistryCurrency(
  coinType: string,
): Promise<RegistryCurrency | null> {
  const canonical = normalizeCoinType(coinType);
  if (!canonical) return null;
  const type = `${normalizeSuiAddress("0x2")}::coin_registry::Currency<${canonical}>`;

  const d = await gqlQuery<{
    objects?: { nodes?: Array<{ asMoveObject?: { contents?: { json?: CurrencyJson } } }> };
  }>(CURRENCY_QUERY, { type });
  const json = d.objects?.nodes?.[0]?.asMoveObject?.contents?.json;
  return json ? parseCurrency(json) : null;
}

function parseCurrency(json: CurrencyJson): RegistryCurrency | null {
  // Decimals is the field worth having, so an entry that cannot supply one is
  // no better than no entry at all.
  const decimals = typeof json.decimals === "number" ? json.decimals : undefined;
  if (decimals === undefined) return null;

  const variant = str(json.regulated?.["@variant"]);
  const regulated: RegulatedState =
    variant === "Regulated" ? "regulated" : variant === "Unregulated" ? "unregulated" : "unknown";

  const supplyVariant = str(json.supply?.["@variant"]);
  const supply: SupplyState = supplyVariant === "Fixed" ? "fixed" : supplyVariant === "BurnOnly" ? "burn_only" : "unknown";

  return {
    decimals,
    ...(str(json.symbol) ? { symbol: str(json.symbol) } : {}),
    ...(str(json.name) ? { name: str(json.name) } : {}),
    ...(str(json.description) ? { description: str(json.description) } : {}),
    ...(str(json.icon_url) ? { icon_url: str(json.icon_url) } : {}),
    regulated,
    supply,
    ...(regulated === "regulated" && str(json.regulated?.cap)
      ? { regulated_cap_id: str(json.regulated?.cap) }
      : {}),
    ...(str(json.treasury_cap_id) ? { treasury_cap_id: str(json.treasury_cap_id) } : {}),
  };
}

/** Ids per multi-get: the service caps a request at 50 keys and 5,000 bytes, and a key costs about 81. */
const DERIVED_BATCH = 40;

const MULTI_CURRENCY_QUERY = `query ($keys: [ObjectKey!]!) {
  multiGetObjects(keys: $keys) { address asMoveObject { contents { json } } }
}`;

/**
 * The registry entry of each type that has one at its derived id, keyed by
 * the canonical type. A type absent from the result has no `Currency` at that
 * id: it is no coin made by `new_currency`, though a coin whose one-time
 * witness `Currency` was never finalized sits elsewhere (`readRegistryCurrency`
 * finds that one). A failed read throws.
 */
export async function readDerivedCurrencies(coinTypes: string[]): Promise<Map<string, RegistryCurrency>> {
  const byId = new Map<string, string>();
  for (const t of coinTypes) {
    const canonical = normalizeCoinType(t);
    if (!canonical) continue;
    byId.set(normalizeSuiAddress(deriveObjectID(COIN_REGISTRY_ID, `0x2::coin_registry::CurrencyKey<${canonical}>`, new Uint8Array([0]))), canonical);
  }
  const ids = [...byId.keys()];
  const out = new Map<string, RegistryCurrency>();
  for (let i = 0; i < ids.length; i += DERIVED_BATCH) {
    const d = await gqlQuery<{ multiGetObjects?: Array<{ address?: string; asMoveObject?: { contents?: { json?: CurrencyJson } } | null } | null> }>(
      MULTI_CURRENCY_QUERY,
      { keys: ids.slice(i, i + DERIVED_BATCH).map((address) => ({ address })) },
    );
    for (const o of d.multiGetObjects ?? []) {
      const type = o?.address ? byId.get(normalizeSuiAddress(o.address)) : undefined;
      const json = o?.asMoveObject?.contents?.json;
      const entry = type && json ? parseCurrency(json) : null;
      if (type && entry) out.set(type, entry);
    }
  }
  return out;
}

/**
 * The registry's entry for a coin, or null when it has none or the read
 * failed: this enriches an answer the caller already has and must never be
 * the reason `analyze_token` fails.
 */
export async function fetchRegistryCurrency(
  coinType: string,
): Promise<RegistryCurrency | null> {
  try {
    return await readRegistryCurrency(coinType);
  } catch {
    return null;
  }
}
