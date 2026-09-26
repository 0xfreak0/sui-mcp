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
import type { IndexedCoin } from "../utils/coin-symbols.js";
import { vouchFor } from "../utils/coin-registry.js";
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

/** Index candidates ranked by supply at most; each costs one getCoinInfo. */
const SUPPLY_RANKED_MAX = 50;
const SUPPLY_CONCURRENCY = 8;

interface SymbolCandidate {
  coin_type: string;
  symbol: string;
  name: string;
  decimals: number;
  verified: boolean;
  total_supply: string | null;
}

/**
 * Candidates for a symbol several coins use: verified first, then by total
 * supply in whole coins, largest first. Supply is read only for up to
 * `SUPPLY_RANKED_MAX` coins; past that the order is verified, then coin type.
 */
async function rankSymbolCandidates(coins: IndexedCoin[]): Promise<{ candidates: SymbolCandidate[]; by_supply: boolean }> {
  const candidates: SymbolCandidate[] = coins.map((c) => ({ ...c, verified: vouchFor(c.coin_type) !== null, total_supply: null }));
  const bySupply = candidates.length <= SUPPLY_RANKED_MAX;
  if (bySupply) {
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const c = candidates[next++];
        try {
          const { response } = await sui.stateService.getCoinInfo({ coinType: c.coin_type });
          c.total_supply = response.treasury?.totalSupply?.toString() ?? null;
          if (response.metadata?.decimals != null) c.decimals = response.metadata.decimals;
        } catch {
          // Left null and ranked last: a failed read says nothing about the coin.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SUPPLY_CONCURRENCY, candidates.length) }, worker));
  }
  const whole = (c: SymbolCandidate) => (c.total_supply === null ? -1 : Number(BigInt(c.total_supply)) / 10 ** c.decimals);
  candidates.sort(
    (a, b) =>
      Number(b.verified) - Number(a.verified) ||
      (bySupply ? whole(b) - whole(a) : 0) ||
      (a.coin_type < b.coin_type ? -1 : a.coin_type > b.coin_type ? 1 : 0),
  );
  return { candidates, by_supply: bySupply };
}

async function ambiguousFromIndex(
  query: string,
  detailed: Extract<SymbolDetail, { status: "ambiguous"; source: "symbol_index" }>,
) {
  const { candidates, by_supply } = await rankSymbolCandidates(detailed.candidates);
  const verifiedCount = candidates.filter((c) => c.verified).length;
  const message =
    candidates.length === 0
      ? `${detailed.count} coins on mainnet use the symbol "${query}". The symbol index lists no candidates for a symbol more than ${detailed.index.max_rows_per_symbol} coins use, since no list that long identifies a coin. Pass the full coin type (0x...::module::TOKEN) that the transaction or balance you are investigating names.`
      : `${detailed.count} coins on mainnet use the symbol "${query}", ${verifiedCount === 0 ? "and no curated list vouches for any of them" : `${verifiedCount} of them verified`}. A symbol does not identify a coin on Sui: pass one of these coin_type values instead.`;
  return {
    query,
    status: "ambiguous_symbol",
    message,
    coin_count: detailed.count,
    candidates,
    ...(candidates.length > 0
      ? {
          candidate_order: by_supply
            ? "Verified coins first, then by total supply in whole coins, largest first. Supply is not evidence that a coin is the one you meant: an impostor can mint more than the real asset."
            : `Verified coins first, then by coin type. Not ranked by supply: that costs one request per coin, and ${candidates.length} is more than ${SUPPLY_RANKED_MAX}.`,
        }
      : {}),
    symbol_index: {
      synced_at: detailed.index.synced_at,
      checkpoint: detailed.index.checkpoint,
      note: `Coins published after ${detailed.index.synced_at} (checkpoint ${detailed.index.checkpoint}) are not in the symbol index, so a newer coin using this symbol is not listed.`,
    },
  };
}

function notFoundMessage(query: string, detailed: Extract<SymbolDetail, { status: "not_found" }>): string {
  const index = detailed.index
    ? `the symbol index (every mainnet coin up to ${detailed.index.synced_at}, checkpoint ${detailed.index.checkpoint}) has no coin with this symbol, and `
    : "";
  if (detailed.scan.failed) {
    return `Token "${query}" could not be looked up: ${index}the live scan of CoinMetadata failed after ${detailed.scan.scanned} objects (${detailed.scan.failed}). A failed read says nothing about the objects after it, so the symbol may still exist: retry, or pass its full coin type (e.g. '0x...::module::TOKEN').`;
  }
  const scan = `a live scan of ${detailed.scan.scanned} CoinMetadata objects in object-ID order ${detailed.scan.truncated ? "stopped before the end without finding one" : "found none"}`;
  if (detailed.index) {
    return `Token "${query}" not found: ${index}${scan}. A coin published after ${detailed.index.synced_at} is reachable only by that scan: pass its full coin type (e.g. '0x...::module::TOKEN'), or use search_token for a name or part of a symbol.`;
  }
  return `Token "${query}" not found: ${scan}. Try using the full coin type string (e.g. '0x...::module::TOKEN'), or use search_token for fuzzy search.`;
}

/** How an unverified symbol reached its coin, and what that route cannot see. */
interface SymbolResolutionNote {
  via: "symbol_index" | "live_scan";
  synced_at?: string;
  checkpoint?: number;
  note: string;
}

function symbolResolution(detailed: Extract<SymbolDetail, { status: "unverified" }>): SymbolResolutionNote {
  if (detailed.source === "symbol_index") {
    return {
      via: "symbol_index",
      synced_at: detailed.index.synced_at,
      checkpoint: detailed.index.checkpoint,
      note: `The only coin using this symbol in the symbol index. A coin published after ${detailed.index.synced_at} (checkpoint ${detailed.index.checkpoint}) with the same symbol is not counted, so check coin_type against the transaction or balance you are investigating.`,
    };
  }
  return {
    via: "live_scan",
    note: detailed.index
      ? `The symbol index (synced ${detailed.index.synced_at}) has no coin with this symbol, so it was found by a live scan of CoinMetadata in object-ID order, which stops at the first match. It was probably published after ${detailed.index.synced_at}, and other coins using the symbol may exist outside the scanned window.`
      : "Found by a live scan of CoinMetadata in object-ID order, which stops at the first match. Other coins using the symbol may exist outside the scanned window.",
  };
}

export function registerAnalyzeTokenTools(server: McpServer) {
  server.tool(
    "analyze_token",
    "(Recommended for token research) Get a comprehensive analysis of a Sui token in one call: metadata, current price, 24h change, total supply, and top 5 holders. Accepts either a coin type (e.g. '0x2::sui::SUI') or a symbol (e.g. 'DEEP', 'cetus'). A symbol several coins use returns status ambiguous_symbol with candidates (verified first, then by supply) from a symbol index of every mainnet coin up to its sync date. A symbol more than 100 coins use returns its count and no candidates, since the index keeps only the count; a coin published after the sync date is found only by a bounded live scan.",
    {
      query: z
        .string()
        .describe("Symbol (e.g. 'USDC', 'deep') or full coin type (e.g. '0x2::sui::SUI'). A symbol is matched exactly; for a name or part of a symbol use search_token."),
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

      if (query.includes("::")) {
        coinType = query;
      } else {
        // A symbol does not identify a coin here: many coins share one with
        // another, and the impostors are named to be mistaken. Ambiguity is
        // reported rather than resolved.
        const detailed = await resolveSymbolDetailed(query);
        if (detailed.status === "ambiguous") {
          const body =
            detailed.source === "symbol_index"
              ? await ambiguousFromIndex(query, detailed)
              : {
                  query,
                  status: "ambiguous_symbol",
                  message: `${detailed.candidates.length} verified coins use the symbol "${query}". A symbol does not identify a coin on Sui — pass one of these coin_type values instead.`,
                  candidates: detailed.candidates.map((c) => ({
                    coin_type: c.coin_type, symbol: c.symbol, name: c.name, decimals: c.decimals,
                  })),
                };
          return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
        }
        if (detailed.status === "not_found") return errorResult(notFoundMessage(query, detailed));
        symbolVerified = detailed.status === "resolved";
        if (detailed.status === "unverified") resolvedBySymbol = symbolResolution(detailed);
        const match = detailed.token;
        coinType = match.coin_type;
        discoveredName = match.name;
        discoveredSymbol = match.symbol;
        discoveredDecimals = match.decimals;
      }

      // Fetch metadata, price, holders and the on-chain registry in parallel
      let coinInfoError: unknown = null;
      const [metaResult, priceResult, change24hByCoin, holderResult, registry] = await Promise.all([
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
                "No curated list vouches for this coin. 142,152 mainnet coins share a symbol with another and impostors are named to be mistaken for the real asset, so treat the symbol and name here as claims made by whoever minted it, not as identification." +
                (symbolVerified
                  ? ""
                  : " It was reached through its symbol, from metadata anyone can write, which is the weakest way to arrive at a coin."),
            }
          : { verified_by: vouchFor(coinType) }),
        ...(resolvedBySymbol ? { symbol_resolution: resolvedBySymbol } : {}),
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
                "These decimals came from the metadata found when the symbol was resolved (the synced symbol index or a live scan), because this coin's own metadata could not be read now. Nothing curated vouches for the scale.",
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
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
