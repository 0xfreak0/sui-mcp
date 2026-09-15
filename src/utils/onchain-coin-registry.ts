/**
 * Sui's on-chain currency registry, `0x2::coin_registry` (state at `0xc`).
 *
 * Not to be confused with `coin-registry.ts`, which is this project's CURATED
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
 * Decimals. `analyze_token` fell back to 9 whenever neither `CoinMetadata` nor
 * the curated list knew, and a wrong scale misstates every amount derived from
 * it by orders of magnitude. 47 of 289 sampled impostors declare a different
 * scale from the coin they imitate, one of them by 10^9, so the coins most
 * likely to reach the fallback are the ones it is most dangerous for. A
 * registry entry replaces that guess with a fact, and where nothing knows, the
 * caller is told the scale was assumed.
 *
 * It also states whether a coin is regulated and names the cap that can freeze
 * holders, which is the same authority `check_coin_restrictions` reads.
 *
 * ## Lookup
 *
 * A `Currency` carries the coin type as a type ARGUMENT —
 * `0x2::coin_registry::Currency<0x2::sui::SUI>` — so this is a direct filtered
 * object read, with no derivation to get wrong. Verified on mainnet: SUI
 * returns decimals 9, and Circle's USDC returns decimals 6 with a `Regulated`
 * variant naming its deny cap.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { normalizeCoinType } from "./coin-registry.js";

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
}

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
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The registry's entry for a coin, or null when it has none.
 *
 * Null means "not registered", which is the common case and says nothing about
 * the coin. A failed lookup also returns null rather than throwing: this
 * enriches an answer the caller already has and must never be the reason
 * `analyze_token` fails.
 */
export async function fetchRegistryCurrency(
  coinType: string,
): Promise<RegistryCurrency | null> {
  const canonical = normalizeCoinType(coinType);
  if (!canonical) return null;
  const type = `${normalizeSuiAddress("0x2")}::coin_registry::Currency<${canonical}>`;

  try {
    const d = await gqlQuery<{
      objects?: { nodes?: Array<{ asMoveObject?: { contents?: { json?: CurrencyJson } } }> };
    }>(CURRENCY_QUERY, { type });
    const json = d.objects?.nodes?.[0]?.asMoveObject?.contents?.json;
    if (!json) return null;

    // Decimals is the field worth having, so an entry that cannot supply one is
    // no better than no entry at all.
    const decimals = typeof json.decimals === "number" ? json.decimals : undefined;
    if (decimals === undefined) return null;

    const variant = str(json.regulated?.["@variant"]);
    const regulated: RegulatedState =
      variant === "Regulated" ? "regulated" : variant === "Unregulated" ? "unregulated" : "unknown";

    return {
      decimals,
      ...(str(json.symbol) ? { symbol: str(json.symbol) } : {}),
      ...(str(json.name) ? { name: str(json.name) } : {}),
      ...(str(json.description) ? { description: str(json.description) } : {}),
      ...(str(json.icon_url) ? { icon_url: str(json.icon_url) } : {}),
      regulated,
      ...(regulated === "regulated" && str(json.regulated?.cap)
        ? { regulated_cap_id: str(json.regulated?.cap) }
        : {}),
    };
  } catch {
    return null;
  }
}
