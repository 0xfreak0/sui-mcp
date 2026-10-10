import { z } from "zod";
import {
  currentEpoch,
  findCoinConfig,
  readCoinRestrictions,
} from "../utils/deny-list-probe.js";
import { boolArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { fetchAftermathPrices } from "./prices.js";
import { sampledHolders, scanTokenTopHolders, stoppedWalks } from "./holders.js";
import { fetchRegistryCurrency } from "../utils/onchain-coin-registry.js";
import { fetchDefiLlamaChange24h } from "../utils/price-providers.js";

import { describeError, errorResult, isNotFound } from "../utils/errors.js";
import { getNetwork } from "../config.js";
import { resolveSymbolDetailed, type SymbolDetail } from "../discovery.js";
import type { TickerCandidate } from "../utils/ticker-search.js";
import { resolveVerifiedSymbol, vouchFor, normalizeCoinType } from "../utils/coin-registry.js";
import { guardiansFlagsForCoin } from "../utils/guardians.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Where a coin's decimals came from, strongest evidence first. */
export type DecimalsSource =
  | "coin_metadata"
  | "coin_registry"
  | "curated"
  | "symbol_scan"
  | "assumed";

/**
 * Pick the tier that actually supplied the decimals.
 *
 * Exported so the tests exercise this function rather than a copy of it.
 *
 * Decimals set the magnitude of every amount derived from them, and a guess has
 * to say it is one: impostors often declare a different scale from the coin
 * they imitate, so the coins most likely to reach the fallback are the ones it
 * is most dangerous for.
 *
 * **Test against null, not undefined.** `discoveredDecimals` is `number | null`,
 * so `!== undefined` is always true. That would make `assumed` unreachable
 * while the value chain's `??` falls through to 9, labelling the guess
 * `curated`, the strongest tier short of chain data, beside `verified: false`
 * in the same payload. TypeScript cannot catch it: that comparison is legal.
 *
 * A symbol the curated list resolved and one reached by scanning on-chain
 * metadata are separate tiers. Calling both `curated` asserts a vouch that
 * `unverified_note` denies a few lines earlier.
 */
export function decimalsTier(input: {
  metaDecimals?: number | null;
  registryDecimals?: number | null;
  discoveredDecimals?: number | null;
  symbolVerified: boolean;
}): DecimalsSource {
  if (input.metaDecimals != null) return "coin_metadata";
  if (input.registryDecimals != null) return "coin_registry";
  if (input.discoveredDecimals != null) {
    return input.symbolVerified ? "curated" : "symbol_scan";
  }
  return "assumed";
}

const POOL_COVERAGE_NOTE =
  "Candidates have a DEX pool on DexScreener or (when needed) GeckoTerminal and were confirmed by exact coin type on chain. Coins without a pool are not searched by indexers; other coins may use this symbol. Pool liquidity is not proof of identity.";

function notFoundMessage(query: string, detailed: Extract<SymbolDetail, { status: "not_found" | "could_not_confirm" }>): string {
  const incomplete = detailed.unconfirmed > 0
    ? `${detailed.unconfirmed} candidates could not be confirmed on chain (${detailed.unconfirmed_reason ?? "metadata unavailable"}). `
    : "";
  const partial = detailed.partial
    ? "Live search coverage is partial for this ticker: popular symbols exceed the providers' result caps. "
    : "";
  const failures = detailed.unavailable_providers.length
    ? `Live search providers unavailable: ${detailed.unavailable_providers.map((p) => `${p.provider}: ${p.reason}`).join("; ")}. `
    : "";
  const coverage = detailed.coverage.dexscreener === "skipped"
    ? "Live DEX search is mainnet-only. "
    : "DEX search covers only coins with indexed pools, not every coin using a symbol. ";
  if (detailed.scan.failed) {
    return `Token "${query}" could not be looked up: ${incomplete}${partial}${failures}${coverage}The bounded CoinMetadata scan failed after ${detailed.scan.scanned} objects (${detailed.scan.failed}); a failed read is not a miss. Pass the full coin type to look up a coin directly.`;
  }
  const unavailable = detailed.coverage.dexscreener === "rate_limited" || detailed.coverage.dexscreener === "unavailable";
  const fallbackUnavailable = detailed.coverage.geckoterminal === "rate_limited" || detailed.coverage.geckoterminal === "unavailable";
  const prefix = detailed.status === "could_not_confirm"
    ? `Token "${query}" could not be confirmed by live search and the bounded scan found no exact match`
    : unavailable && fallbackUnavailable
      ? `Token "${query}" could not be confirmed by live search: both providers were unavailable; the bounded scan found no exact match`
      : `Token "${query}" not found in the available pool-backed candidates or bounded on-chain scan`;
  return `${prefix}: ${incomplete}${partial}${failures}${coverage}The scan read ${detailed.scan.scanned} objects${detailed.scan.truncated ? " and stopped before the end" : ""}. Other coins may use this symbol; pass the full coin type to inspect one directly.`;
}

/** Which limited search found this exact type, not a claim of symbol uniqueness. */
interface SymbolResolutionNote {
  via: "dex_search" | "live_scan";
  note: string;
  coverage: Extract<SymbolDetail, { status: "unverified" }>["coverage"];
  unavailable_providers: Extract<SymbolDetail, { status: "unverified" }>["unavailable_providers"];
  partial: boolean;
  unconfirmed: number;
  unconfirmed_reason?: string;
  liquidity_usd?: number;
  pool_count?: number;
}

function symbolResolution(detailed: Extract<SymbolDetail, { status: "unverified" }>): SymbolResolutionNote {
  return {
    via: detailed.source === "dex_search" ? "dex_search" : "live_scan",
    coverage: detailed.coverage,
    unavailable_providers: detailed.unavailable_providers,
    partial: detailed.partial,
    unconfirmed: detailed.unconfirmed,
    ...(detailed.unconfirmed_reason ? { unconfirmed_reason: detailed.unconfirmed_reason } : {}),
    note: (detailed.partial ? "Live search coverage is partial for this ticker: popular symbols exceed the providers' result caps. " : "") +
      (detailed.unconfirmed ? `${detailed.unconfirmed} candidates could not be confirmed on chain (${detailed.unconfirmed_reason ?? "metadata unavailable"}). ` : "") +
      (detailed.source === "dex_search"
        ? POOL_COVERAGE_NOTE
        : "Found by a bounded CoinMetadata scan in object-ID order, which stops at the first exact symbol match. Other coins using the same symbol may exist outside the scanned window."),
    ...(detailed.source === "dex_search"
      ? { liquidity_usd: detailed.token.liquidity_usd, pool_count: detailed.token.pool_count }
      : {}),
  };
}

export function registerAnalyzeTokenTools(server: McpServer) {
  server.tool(
    "analyze_token",
    "(Recommended for token research) Analyze a Sui coin type or symbol: metadata, current price, 24h change, total supply and top holders. Verified symbols resolve from the curated list; other mainnet symbols use two DexScreener searches (ticker and ticker + SUI), with GeckoTerminal fallback for missing, capped or unavailable results. Up to 25 pool-backed coin types are confirmed on chain; only clean results are cached for 10 minutes. Multiple exact symbols return ambiguous_symbol. Provider caps and failed confirmations are reported, not mistaken for absent coins; a bounded on-chain scan is the fallback when no live match is confirmed.",
    {
      query: z
        .string()
        .describe("Symbol ('deep') or full coin type ('0x2::sui::SUI'). A symbol matches exactly, in any case; use search_token for partial names."),
      include_holders: boolArg()
        .optional()
        .describe("Include top 5 holders (default: true). Set false for faster response."),
    },
    async ({ query, include_holders }) => {
      const wantHolders = include_holders !== false;
      // Whether a curated list vouches for this coin, or the symbol merely
      // matched something on chain.
      let symbolVerified = true;

      // Resolve coin type: if it looks like a type (contains ::), use directly; else resolve dynamically
      let coinType: string;
      let discoveredName: string | null = null;
      let discoveredSymbol: string | null = null;
      let discoveredDecimals: number | null = null;
      let resolvedBySymbol: SymbolResolutionNote | null = null;
      let resolvedCandidate: TickerCandidate | null = null;

      if (query.includes("::")) {
        coinType = query;
      } else {
        // A symbol does not identify a coin here: many coins share one with
        // another, and the impostors are named to be mistaken. Ambiguity is
        // reported rather than resolved.
        const detailed = await resolveSymbolDetailed(query);
        if (detailed.status === "ambiguous") {
          const body =
            detailed.source === "dex_search"
              ? {
                  query,
                  status: "ambiguous_symbol",
                  message: `${detailed.candidates.length} pool-backed, on-chain-confirmed coins matched "${query}" exactly. A symbol does not identify a coin on Sui: pass a full coin_type instead. ${detailed.partial ? "Live search coverage is partial for this ticker: popular symbols exceed the providers' result caps. " : ""}${detailed.unconfirmed ? `${detailed.unconfirmed} candidates could not be confirmed on chain (${detailed.unconfirmed_reason ?? "metadata unavailable"}). ` : ""}${POOL_COVERAGE_NOTE}`,
                  coin_count: detailed.candidates.length,
                  candidates: detailed.candidates,
                  candidate_order: "Verified first, then exact symbol, then descending DEX pool liquidity; liquidity is not proof of legitimacy.",
                  search_coverage: {
                    providers: detailed.coverage, unavailable_providers: detailed.unavailable_providers,
                    partial: detailed.partial, unconfirmed: detailed.unconfirmed,
                    ...(detailed.unconfirmed_reason ? { unconfirmed_reason: detailed.unconfirmed_reason } : {}),
                  },
                }
              : {
                  query,
                  status: "ambiguous_symbol",
                  message: `${detailed.candidates.length} verified coins use the symbol "${query}". A symbol does not identify a coin on Sui — pass one of these coin_type values instead.`,
                  candidates: detailed.candidates.map((c) => ({
                    coin_type: c.coin_type, symbol: c.symbol, name: c.name, decimals: c.decimals,
                    verified: true, liquidity_usd: null,
                    ...(guardiansFlagsForCoin(c.coin_type).length ? { flagged_by: guardiansFlagsForCoin(c.coin_type) } : {}),
                  })),
                };
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
        }
        if (detailed.status === "not_found" || detailed.status === "could_not_confirm") return errorResult(notFoundMessage(query, detailed));
        symbolVerified = detailed.status === "resolved";
        if (detailed.status === "unverified") resolvedBySymbol = symbolResolution(detailed);
        if (detailed.status === "unverified" && detailed.source === "dex_search") resolvedCandidate = detailed.token;
        const match = detailed.token;
        coinType = match.coin_type;
        discoveredName = match.name;
        discoveredSymbol = match.symbol;
        discoveredDecimals = match.decimals;
      }

      // Fetch metadata, price, holders and the on-chain registry in parallel
      let coinInfoError: unknown = null;
      const [metaResult, priceResult, { changes: change24hByCoin }, holderResult, registry] = await Promise.all([
        sui.stateService
          .getCoinInfo({ coinType })
          .then(({ response }) => response)
          .catch((err: unknown) => ((coinInfoError = err), null)),

        fetchAftermathPrices([coinType]),

        fetchDefiLlamaChange24h([coinType]),

        wantHolders
          ? scanTokenTopHolders(coinType, 5, 2000).catch(() => null)
          : Promise.resolve(null),

        fetchRegistryCurrency(coinType),
      ]);

      // A type that does not parse, or that no metadata, registry entry or
      // holder knows, is not a coin. Analysed anyway, it came back with
      // decimals assumed and a deny-list verdict about a coin that does not exist.
      if (coinInfoError) {
        const code = typeof coinInfoError === "object" && "code" in coinInfoError ? coinInfoError.code : null;
        if (code === "INVALID_ARGUMENT") return errorResult(describeError(coinInfoError, getNetwork()));
        if (isNotFound(coinInfoError) && !registry && (holderResult?.holders.length ?? 0) === 0) {
          return errorResult(
            `No coin of type ${coinType} exists on ${getNetwork()}: it has no CoinMetadata and no coin registry entry${holderResult ? ", and no holders" : ""}.`,
          );
        }
      }

      const meta = metaResult?.metadata;
      const treasury = metaResult?.treasury;

      // The curated entry outranks the registry for anything self-declared. A
      // registry entry is whatever the minter wrote, and an impostor can write
      // one; the curated entry was reviewed. Chain metadata still wins over
      // both because it is what the coin itself publishes.
      const symbol = meta?.symbol ?? discoveredSymbol ?? registry?.symbol ?? coinType.split("::").pop() ?? coinType;
      const name = meta?.name ?? discoveredName ?? registry?.name ?? null;
      const description = meta?.description ?? registry?.description ?? null;
      const iconUrl = meta?.iconUrl ?? registry?.icon_url ?? null;

      const decimalsSource = decimalsTier({
        metaDecimals: meta?.decimals,
        registryDecimals: registry?.decimals,
        discoveredDecimals,
        symbolVerified,
      });
      const decimals = meta?.decimals ?? registry?.decimals ?? discoveredDecimals ?? 9;
      const totalSupplyRaw = treasury?.totalSupply?.toString() ?? null;

      // Compute human-readable supply
      let totalSupplyHuman: string | null = null;
      if (totalSupplyRaw) {
        const raw = BigInt(totalSupplyRaw);
        const human = Number(raw) / 10 ** decimals;
        totalSupplyHuman = human.toLocaleString("en-US", { maximumFractionDigits: 2 });
      }

      const priceEntry = priceResult?.[coinType];
      const priceUsd = priceEntry && priceEntry.price >= 0 ? priceEntry.price : null;
      const change24h = change24hByCoin.get(coinType) ?? null;

      // Compute market cap if we have price and supply
      let marketCapUsd: number | null = null;
      if (priceUsd != null && totalSupplyRaw) {
        const humanSupply = Number(BigInt(totalSupplyRaw)) / 10 ** decimals;
        marketCapUsd = Math.round(priceUsd * humanSupply * 100) / 100;
      }

      const verifiedSymbol = resolveVerifiedSymbol(symbol);

      const result: Record<string, unknown> = {
        coin_type: coinType,
        // Reported for the COIN, not for how it was reached. A full coin type
        // is unambiguous as an identifier — you get exactly what you asked
        // for — but that is not the same as anyone vouching for it, and the
        // impostor case arrives by type just as easily as by symbol.
        // Null off mainnet: the curated list holds mainnet coin types, so it can
        // say nothing either way about a coin on another network.
        verified: vouchFor(coinType) === "not-curated-here" ? null : vouchFor(coinType) !== null,
        ...(vouchFor(coinType) === "not-curated-here"
          ? {
              unverified_note:
                "The curated coin list covers mainnet only, so nothing here vouches for or against this coin. A coin type embeds a package ID, and package IDs differ per network — USDC exists on testnet, at a different type from mainnet's.",
            }
          : {}),
        ...(vouchFor(coinType) === null
          ? {
              unverified_note:
                "No curated list vouches for this coin. Symbols and names are self-declared by the issuer; check the full coin type against the transaction or balance you are investigating." +
                (symbolVerified ? "" : " A symbol search is not a unique identification, even with pool-backed on-chain confirmation."),
            }
          : { verified_by: vouchFor(coinType) }),
        ...(resolvedBySymbol ? { symbol_resolution: resolvedBySymbol } : {}),
        ...(resolvedCandidate ? {
          liquidity_usd: resolvedCandidate.liquidity_usd, pool_count: resolvedCandidate.pool_count,
          volume_24h: resolvedCandidate.volume_24h, providers: resolvedCandidate.providers,
        } : {}),
        ...(vouchFor(coinType) === null && verifiedSymbol.status === "resolved" &&
          normalizeCoinType(verifiedSymbol.coin.coin_type) !== normalizeCoinType(coinType)
          ? { impostor_of: verifiedSymbol.coin.coin_type } : {}),
        package_id: coinType.split("::")[0],
        publisher_hint: `Use identify_address on package ${coinType.split("::")[0]} to find its publisher, then get_wallet_packages on that publisher to pivot across deployed packages.`,
        // A third-party scam list, stated beside the curated answer rather
        // than folded into it: it is evidence about the coin, weaker than the
        // curated list and never attribution of anyone who holds it.
        ...(guardiansFlagsForCoin(coinType).length > 0 ? { flagged_by: guardiansFlagsForCoin(coinType) } : {}),
        symbol,
        name,
        decimals,
        decimals_source: decimalsSource,
        ...(decimalsSource === "assumed"
          ? {
              decimals_note:
                "No on-chain metadata, registry entry or curated record gives this coin's decimals, so 9 was assumed. Every human-readable amount below rests on that assumption and may be wrong by orders of magnitude.",
            }
          : {}),
        ...(decimalsSource === "symbol_scan"
          ? {
              decimals_note:
                "These decimals came from this exact coin type's on-chain metadata during symbol resolution, because the later metadata read did not return them. This is not a curated endorsement of the coin.",
            }
          : {}),
        // The registry is Sui's canonical on-chain metadata, not a whitelist:
        // anyone who can publish a coin can register it, so presence here is
        // never a vouch. `verified` above is the curated claim.
        ...(registry
          ? {
              coin_registry: {
                registered: true,
                regulated: registry.regulated,
                ...(registry.regulated_cap_id
                  ? { regulated_cap_id: registry.regulated_cap_id }
                  : {}),
              },
            }
          : {}),
        description,
        icon_url: iconUrl,
        total_supply: totalSupplyRaw,
        total_supply_human: totalSupplyHuman,
        price_usd: priceUsd,
        price_change_24h_percent: change24h,
        market_cap_usd: marketCapUsd,
      };

      // Is this a regulated coin, and is anyone frozen? One keyed lookup, so it
      // costs a request rather than a scan. Best-effort: a token analysis must
      // not fail because the deny list was unreachable.
      try {
        const configId = await findCoinConfig(coinType);
        if (configId) {
          const epoch = await currentEpoch();
          const r = await readCoinRestrictions(coinType, configId, epoch, 4);
          result.deny_list = {
            regulated: true,
            globally_paused: r.globally_paused,
            denied_address_count: r.denied.length,
            denied_count_truncated: r.truncated,
            note: "This coin's issuer can freeze individual addresses or pause it entirely. Use check_coin_restrictions for who is frozen.",
          };
        } else {
          // Said explicitly. Absent would read as "not checked", and whether a
          // token can freeze its holders is exactly what a holder wants to know.
          //
          // Spelled out because `regulated: false` is easy to read as a clean
          // bill of health, and it is the opposite: a scam token has no deny
          // list precisely because nobody legitimate issued it. This field
          // describes freeze capability, never legitimacy.
          result.deny_list = {
            regulated: false,
            note: "No deny list state, so nobody can freeze holders of this coin. That is a statement about issuer capability, NOT about the coin being safe or genuine — an impostor token has no deny list either.",
          };
        }
      } catch {
        result.deny_list = { regulated: null, note: "The deny list could not be read; this is not evidence the coin is unregulated." };
      }

      if (holderResult) {
        result.unique_holders_scanned = holderResult.unique_holders;
        result.holder_scan_truncated = holderResult.truncated;
        // The ranking merges two walks: Coin<T> objects and address balances.
        // Each holder carries the split, and these say how far each walk got.
        result.holder_scan_coin_objects = holderResult.coin_objects_scanned;
        result.holder_scan_address_balances = holderResult.address_balances_scanned;
        if (holderResult.unresolved_owners) {
          result.holder_scan_unresolved_owners = holderResult.unresolved_owners;
        }
        // Same distinction get_top_holders makes: the scan walks objects in
        // object-id order, so a truncated one names the biggest holder it
        // SAW, not the biggest holder. Concentration is the reason anyone
        // reads this field, and a sampled top holder invites exactly the
        // concentration claim the data cannot support.
        if (holderResult.total_scanned === 0) {
          // Same rule get_top_holders follows: a walk that found nothing has
          // not ranked anything. An empty top_holders beside
          // holder_scan_truncated: false reads as "this coin has no holders",
          // which is what a mistyped or cross-network type produces too.
          result.holder_scan_note =
            `No Coin<${coinType}> objects and no address balances of it were found, so there is no holder scan to report. That reads the same as a mistyped coin type or one that exists on another network. It is not evidence that the coin has no holders.`;
        } else if (holderResult.truncated) {
          result.sampled_holders = await sampledHolders(holderResult.holders, coinType);
          result.holder_scan_note =
            `INCOMPLETE: ${stoppedWalks(holderResult)} stopped before the end. Both walk in object-id order, which is unrelated to balance. ` +
            `These are the largest holders within that sample, not the largest holders of the coin, and they do not support a claim about supply concentration.`;
        } else {
          result.top_holders = holderResult.holders;
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result),
        }],
      };
    }
  );
}
