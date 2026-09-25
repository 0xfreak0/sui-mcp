import { z } from "zod";
import {
  currentEpoch,
  findCoinConfig,
  readCoinRestrictions,
} from "../utils/deny-list-probe.js";
import { boolArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { fetchAftermathPrices } from "./prices.js";
import { scanTokenTopHolders, stoppedWalks } from "./holders.js";
import { fetchRegistryCurrency } from "../utils/onchain-coin-registry.js";

import { errorResult } from "../utils/errors.js";
import { resolveSymbolDetailed } from "../discovery.js";
import { vouchFor } from "../utils/coin-registry.js";
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
 * Exported so the tests exercise THIS rather than a copy. The guard for the
 * defect below was first written as a re-implementation inside the test file,
 * and reintroducing the defect left all 1,214 tests green while the live tool
 * went back to mislabelling the guess.
 *
 * Decimals set the magnitude of every amount derived from them, and a guess has
 * to say it is one: 47 of 289 sampled impostors declare a different scale from
 * the coin they imitate, so the coins most likely to reach the fallback are the
 * ones it is most dangerous for.
 *
 * **Test against null, not undefined.** `discoveredDecimals` is `number | null`,
 * so `!== undefined` is always true and made `assumed` unreachable while the
 * value chain's `??` still fell through to 9. The guess then shipped labelled
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

export function registerAnalyzeTokenTools(server: McpServer) {
  server.tool(
    "analyze_token",
    "(Recommended for token research) Get a comprehensive analysis of a Sui token in one call: metadata, current price, 24h change, total supply, and top 5 holders. Accepts either a coin type (e.g. '0x2::sui::SUI') or a name/symbol (e.g. 'DEEP', 'cetus').",
    {
      query: z
        .string()
        .describe("Token name, symbol (e.g. 'USDC', 'deep'), or full coin type (e.g. '0x2::sui::SUI')"),
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

      if (query.includes("::")) {
        coinType = query;
      } else {
        // A symbol is not an identifier here: 8,008 mainnet coins share one with
        // another, and the impostors are named to be mistaken. Ambiguity is
        // reported rather than resolved.
        const detailed = await resolveSymbolDetailed(query);
        if (detailed.status === "ambiguous") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                query,
                status: "ambiguous_symbol",
                message: `${detailed.candidates.length} verified coins use the symbol "${query}". A symbol does not identify a coin on Sui — pass one of these coin_type values instead.`,
                candidates: detailed.candidates.map((c) => ({
                  coin_type: c.coin_type, symbol: c.symbol, name: c.name, decimals: c.decimals,
                })),
              }, null, 2),
            }],
          };
        }
        const match = detailed.status === "resolved" ? detailed.token : detailed.token;
        symbolVerified = detailed.status === "resolved";
        if (!match) {
          return errorResult(
            `Token "${query}" not found. Try using the full coin type string (e.g. '0x...::module::TOKEN'), or use search_token for fuzzy search.`
          );
        }
        coinType = match.coin_type;
        discoveredName = match.name;
        discoveredSymbol = match.symbol;
        discoveredDecimals = match.decimals;
      }

      // Fetch metadata, price, holders and the on-chain registry in parallel
      const [metaResult, priceResult, holderResult, registry] = await Promise.all([
        sui.stateService
          .getCoinInfo({ coinType })
          .then(({ response }) => response)
          .catch(() => null),

        fetchAftermathPrices([coinType]),

        wantHolders
          ? scanTokenTopHolders(coinType, 5, 2000).catch(() => null)
          : Promise.resolve(null),

        fetchRegistryCurrency(coinType),
      ]);

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
      const change24h = priceEntry && priceEntry.price >= 0 ? priceEntry.priceChange24HoursPercentage : null;

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
                "No curated list vouches for this coin. 8,008 mainnet coins share a symbol with another and impostors are named to be mistaken for the real asset, so treat the symbol and name here as claims made by whoever minted it, not as identification." +
                (symbolVerified
                  ? ""
                  : " It was reached by scanning on-chain metadata for the symbol, which is the weakest way to arrive at a coin."),
            }
          : { verified_by: vouchFor(coinType) }),
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
                "These decimals came from scanning on-chain metadata for the symbol, which is the weakest way to arrive at a coin. Nothing curated vouches for the scale.",
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
          result.sampled_holders = holderResult.holders.map(
            ({ rank: _rank, ...rest }) => rest,
          );
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
