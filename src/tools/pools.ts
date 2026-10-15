import { z } from "zod";
import { addressArg, coinTypeArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { fetchAftermathPrices } from "./prices.js";
import { lookupProtocol, prefetchProtocolNames } from "../protocols/registry.js";
import { describeError, errorResult } from "../utils/errors.js";
import { getNetwork } from "../config.js";
import { resolveTokenType } from "../discovery.js";
import { normalizeStructTag } from "@mysten/sui/utils";
import {
 AFTERMATH_AMM_PACKAGE, FLOWX_V2_CONTAINER, FLOWX_V2_PACKAGE, KRIYA_V2_PACKAGE, flowxPairFieldId,
} from "../utils/valuers/amm-lp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Extract generic type parameters from a Move type string
function extractTypeParams(typeStr: string): string[] {
  const match = typeStr.match(/<(.+)>/);
  if (!match) return [];
  const params: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of match[1]) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      params.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) params.push(current.trim());
  return params;
}

function extractPackageId(typeStr: string): string | null {
  const match = typeStr.match(/^(0x[a-fA-F0-9]+)::/);
  return match ? match[1] : null;
}

interface PoolInfo {
  protocol: string | null;
  protocol_type: string | null;
  token_a: string | null;
  token_b: string | null;
  /** Null for order-book protocols, which have no reserves to report. */
  reserves: Record<string, unknown> | null;
  fee_info: Record<string, unknown>;
  extra: Record<string, unknown>;
}

function parseCetusPool(json: Record<string, unknown>, typeParams: string[]): PoolInfo {
  return {
    protocol: "Cetus",
    protocol_type: "dex",
    token_a: typeParams[0] ?? null,
    token_b: typeParams[1] ?? null,
    reserves: {
      coin_a: json.coin_a ?? json.balance_a,
      coin_b: json.coin_b ?? json.balance_b,
    },
    fee_info: { fee_rate: json.fee_rate },
    extra: {
      current_sqrt_price: json.current_sqrt_price,
      tick_spacing: json.tick_spacing,
      is_pause: json.is_pause,
    },
  };
}

/**
 * DeepBook is a central limit order book, not an AMM.
 *
 * The other parsers here report `reserves` because for an AMM the pool balances
 * *are* the liquidity, and price follows from their ratio. DeepBook's vaults are
 * custody for resting orders and settled balances — they say nothing about
 * price or about how much can actually be filled. Reporting them under
 * `reserves` invited exactly the wrong reading, so they are labelled as what
 * they are and the caller is pointed at the book itself.
 */
function parseDeepBookPool(json: Record<string, unknown>, typeParams: string[]): PoolInfo {
  return {
    protocol: "DeepBook",
    protocol_type: "clob",
    token_a: typeParams[0] ?? null,
    token_b: typeParams[1] ?? null,
    // No `reserves` key: an order book has none.
    reserves: null,
    fee_info: { taker_fee: json.taker_fee, maker_fee: json.maker_fee },
    extra: {
      lot_size: json.lot_size,
      tick_size: json.tick_size,
      // Custody totals, not tradable depth.
      base_vault_balance: json.base_vault,
      quote_vault_balance: json.quote_vault,
      liquidity_note:
        "DeepBook is a central limit order book; vault balances are custody, not tradable depth. " +
        "Use deepbook_orderbook for real bid/ask depth, spread and mid price.",
    },
  };
}

function parseTurbosPool(json: Record<string, unknown>, typeParams: string[]): PoolInfo {
  return {
    protocol: "Turbos",
    protocol_type: "dex",
    token_a: typeParams[0] ?? null,
    token_b: typeParams[1] ?? null,
    reserves: {
      coin_a: json.coin_a ?? json.balance_a,
      coin_b: json.coin_b ?? json.balance_b,
    },
    fee_info: { fee: json.fee, fee_rate: json.fee_rate },
    extra: { sqrt_price: json.sqrt_price, tick_spacing: json.tick_spacing },
  };
}

function parseGenericPool(json: Record<string, unknown>, typeParams: string[], protocol: string | null): PoolInfo {
  return {
    protocol,
    protocol_type: "dex",
    token_a: typeParams[0] ?? null,
    token_b: typeParams[1] ?? null,
    reserves: json,
    fee_info: {},
    extra: {},
  };
}

export function registerPoolTools(server: McpServer) {
  server.tool(
    "get_pool_stats",
    "Get stats for a DeFi liquidity pool on Sui given its object ID. Auto-detects the protocol (Cetus, DeepBook, Turbos, etc.) and returns token pair, reserves, fees, and current prices.",
    {
      pool_id: addressArg().describe("Pool object ID (0x...)"),
      protocol: z
        .string()
        .optional()
        .describe("Protocol hint (e.g. 'cetus', 'deepbook', 'turbos'). Auto-detected if omitted."),
    },
    async ({ pool_id, protocol: protocolHint }) => {
      // Use high-level SDK to get object with JSON content
      const res = await sui.getObject({
        objectId: pool_id,
        include: { json: true },
      });
      const obj = res.object;
      if (!obj) return errorResult(`Object ${pool_id} not found`);

      const objectType = obj.type ?? "";
      if (!objectType.includes("::")) {
        return errorResult(`${pool_id} is a ${objectType || "non-Move object"}, not a pool.`);
      }
      const typeParams = extractTypeParams(objectType);
      const packageId = extractPackageId(objectType);

      // Determine protocol from the chain first. The hint only fills in when
      // detection fails: taken first, protocol: "nonsense" relabelled a Cetus
      // pool as "nonsense".
      let detectedProtocol: string | null = null;
      if (packageId) {
        // The ID here comes from the pool's *type*, so it is the package version
        // that declared the type — the lineage root for anything declared in v1,
        // but a later version for a type a protocol added on upgrade. Resolving
        // the lineage first is what keeps parser selection working in the second
        // case; without it an upgraded pool falls through to name-substring
        // guessing below.
        await prefetchProtocolNames([packageId]);
        const info = lookupProtocol(packageId);
        if (info) detectedProtocol = info.name.toLowerCase();
      }
      if (!detectedProtocol) {
        const typeLower = objectType.toLowerCase();
        if (typeLower.includes("cetus")) detectedProtocol = "cetus";
        else if (typeLower.includes("deepbook") || typeLower.includes("clob")) detectedProtocol = "deepbook";
        else if (typeLower.includes("turbos")) detectedProtocol = "turbos";
      }
      const hint = protocolHint?.trim().toLowerCase();
      if (hint && detectedProtocol && !detectedProtocol.includes(hint)) {
        return errorResult(
          `${pool_id} belongs to ${detectedProtocol}, not ${JSON.stringify(hint.slice(0, 80))}. Omit protocol to use the detected one.`,
        );
      }
      detectedProtocol ??= hint ?? null;
      // Every pool type is generic over the coins it holds; the Clock is not,
      // and 0x2 is a registered "protocol", so detection alone let it through.
      if (typeParams.length === 0) {
        return errorResult(`${pool_id} is a ${objectType}, which is not a pool this tool can read.`);
      }

      const json = (obj.json ?? {}) as Record<string, unknown>;

      let poolInfo: PoolInfo;
      switch (detectedProtocol) {
        case "cetus":
          poolInfo = parseCetusPool(json, typeParams);
          break;
        case "deepbook":
          poolInfo = parseDeepBookPool(json, typeParams);
          break;
        case "turbos":
          poolInfo = parseTurbosPool(json, typeParams);
          break;
        default:
          poolInfo = parseGenericPool(json, typeParams, detectedProtocol);
      }

      // Fetch prices for the token pair
      const tokenTypes = [poolInfo.token_a, poolInfo.token_b].filter(
        (t): t is string => t != null
      );
      const prices = tokenTypes.length > 0
        ? await fetchAftermathPrices(tokenTypes)
        : null;

      const tokenPrices: Record<string, number | null> = {};
      for (const t of tokenTypes) {
        const entry = prices?.[t];
        tokenPrices[t] = entry && entry.price >= 0 ? entry.price : null;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              pool_id,
              object_type: objectType,
              protocol: poolInfo.protocol,
              protocol_type: poolInfo.protocol_type,
              token_a: poolInfo.token_a,
              token_b: poolInfo.token_b,
              reserves: poolInfo.reserves,
              fee_info: poolInfo.fee_info,
              extra: poolInfo.extra,
              prices: tokenPrices,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "find_pools",
  "Find pools for an exact token pair across Cetus, DeepBook v2/v3, Turbos, BlueMove v1, Bluefin, Momentum, FlowX CLMM/v2, Magma, Aftermath AMM and Kriya v2. Both token orders are searched. Venue statuses distinguish complete searches from failed or capped reads. The response includes pool IDs and coin types.",
    {
   token_a: z.string().describe("First token: verified symbol (e.g. 'SUI') or full coin type"),
   token_b: z.string().describe("Second token: verified symbol (e.g. 'USDC') or full coin type"),
   protocol: z.string().optional().describe(`Filter by venue: ${POOL_PROTOCOLS.join(", ")}. Searches all if omitted.`),
    },
    async ({ token_a, token_b, protocol: protocolFilter }) => {
   const [resolvedA, resolvedB] = await Promise.all([resolveTokenType(token_a), resolveTokenType(token_b)]);
   if (!resolvedA) return errorResult(`Could not resolve token: ${token_a}. Only curated verified symbols resolve by name; provide the full coin type or use search_token.`);
   if (!resolvedB) return errorResult(`Could not resolve token: ${token_b}. Only curated verified symbols resolve by name; provide the full coin type or use search_token.`);
   const typeA = canonicalPoolCoinType(resolvedA);
   const typeB = canonicalPoolCoinType(resolvedB);
   if (!typeA || !typeB) return errorResult("Both tokens must be valid Move coin types.");
   const wanted = protocolFilter?.trim().toLowerCase();
      if (wanted && !POOL_PROTOCOLS.includes(wanted as PoolProtocol)) {
        return errorResult(`Unsupported protocol: ${protocolFilter}. Supported: ${POOL_PROTOCOLS.join(", ")}.`);
      }
   const result = await searchPoolPairs([[typeA, typeB]], wanted ? [wanted as PoolProtocol] : [...POOL_PROTOCOLS]);
          return {
    isError: result.pools.length === 0 && result.venues.every((venue) => venue.status === "failed" || venue.status === "unsupported"),
    content: [{
            type: "text" as const,
            text: JSON.stringify({
      query: { token_a: typeA, token_b: typeB, protocol: wanted ?? "all" },
      ...result,
      total: result.pools.length,
      ...(result.venues.some((venue) => venue.status !== "complete")
                ? {
                    incomplete: true,
        failed_searches: result.venues.filter((venue) => venue.status === "failed").map(({ venue, error }) => ({ protocol: venue, error })),
        incomplete_note: "Only venues marked complete finished their search. A missing pool in any other venue is not evidence of absence.",
                  }
                : {}),
      hint: result.pools.length > 0
       ? "Pool IDs and coin types come from verified Move pool objects or the FlowX v2 factory. get_pool_stats does not decode every venue's reserve layout."
       : "No pools were found in the completed venue searches; inspect venue statuses before concluding that none exist.",
            }),
    }],
      };
  },
  );
}

const POOL_PROTOCOLS = [
 "cetus", "deepbook", "turbos", "bluemove", "bluefin", "momentum",
 "flowx_clmm", "flowx_v2", "magma", "aftermath", "kriya_v2",
] as const;
type PoolProtocol = (typeof POOL_PROTOCOLS)[number];

export interface PoolCandidate {
 pool_id: string;
 protocol: PoolProtocol;
 object_type: string;
 token_a: string | null;
 token_b: string | null;
 /** Present when the pool deterministically names the fungible LP type. */
 lp_type?: string;
 /** Aftermath pools can contain more than two coins. */
 coin_types?: string[];
}

export interface PoolVenueStatus {
 venue: PoolProtocol;
 status: "complete" | "incomplete" | "failed" | "unsupported";
 searched: number;
 pages: number;
 error?: string;
}

export interface PoolDiscovery {
 pools: PoolCandidate[];
 venues: PoolVenueStatus[];
 /** This search covers only these exact coin pairs, not every pool containing the coin. */
 pairs_searched: Array<{ token_a: string; token_b: string }>;
}

const SUI_COIN = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC_COIN = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const TURBOS_POOL_CONFIG = "0xc294552b2765353bcafa7c359cd28fd6bc237662e5db8f09877558d81669170c";
const TURBOS_POOL = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::Pool";
const AFTERMATH_POOL = `${AFTERMATH_AMM_PACKAGE}::pool::Pool`;

const POOL_COIN_ARG = coinTypeArg();

function canonicalPoolCoinType(value: string): string | null {
 const parsed = POOL_COIN_ARG.safeParse(value.startsWith("0x") ? value : `0x${value}`);
 if (!parsed.success) return null;
 try {
  return normalizeStructTag(parsed.data);
 } catch {
  return null;
 }
}

/** Defining versions, not the currently-called package versions: Move object types retain these addresses. */
const EXACT_POOL_TYPES: Partial<Record<PoolProtocol, string[]>> = {
 cetus: ["0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool"],
 deepbook: [
  "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::pool::Pool",
  "0x158f2027f60c89bb91526d9bf08831d27f5a0fcb0f74e6698b9f0e1fb2be5d05::clob_v2::Pool",
 ],
 bluemove: ["0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9::swap::Pool"],
 bluefin: ["0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool"],
 momentum: ["0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::pool::Pool"],
 flowx_clmm: ["0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d::pool::Pool"],
 magma: ["0x4a35d3dfef55ed3631b7158544c6322a23bc434fe4fca1234cb680ce0505f82d::pool::Pool"],
 kriya_v2: [`${KRIYA_V2_PACKAGE}::spot_dex::Pool`],
};

/** Turbos's config names every fee marker used as Pool<A, B, FeeTier>. */
async function poolBases(protocol: PoolProtocol): Promise<string[]> {
 if (protocol !== "turbos") return EXACT_POOL_TYPES[protocol] ?? [];
      const data = await gqlQuery<{
        object: { asMoveObject?: { contents?: { json?: { fee_map?: { contents?: Array<{ key: string }> } } } } } | null;
      }>(`query($id: SuiAddress!) { object(address: $id) { asMoveObject { contents { json } } } }`, { id: TURBOS_POOL_CONFIG });
 const tiers = data.object?.asMoveObject?.contents?.json?.fee_map?.contents?.map((entry) => entry.key) ?? [];
 if (!tiers.length) throw new Error("Turbos pool config listed no fee tiers");
 if (tiers.some((fee) => !/^(?:0x)?[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z_0-9]*::[A-Za-z_][A-Za-z_0-9]*$/.test(fee))) {
  throw new Error("Turbos pool config contains an invalid fee type");
  }
 return [...new Set(tiers.map((fee) => `${TURBOS_POOL}<{A}, {B}, ${fee.startsWith("0x") ? fee : `0x${fee}`}>`))];
}

const MAX_POOL_PAGES = 20;
interface PoolNode {
  address: string;
 asMoveObject?: { contents?: { type?: { repr?: string }; json?: Record<string, unknown> } };
}
interface PoolPageRead {
 nodes: PoolNode[];
 pages: number;
 complete: boolean;
 error?: string;
}

/** A capped scan keeps its matching rows but cannot certify absence beyond its last cursor. */
async function readPoolPages(type: string, withJson: boolean): Promise<PoolPageRead> {
  const out: PoolNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_POOL_PAGES; page++) {
  let data: { objects: { nodes: PoolNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
  try {
   data = await gqlQuery(
      `query($type: String!, $after: String) {
        objects(filter: { type: $type }, first: 50, after: $after) {
       nodes { address asMoveObject { contents { type { repr } ${withJson ? "json" : ""} } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { type, after },
    );
   if (!data.objects?.pageInfo || !Array.isArray(data.objects.nodes)) throw new Error("Pool list response was incomplete");
  } catch (err) {
   return { nodes: out, pages: page + 1, complete: false, error: describeError(err, getNetwork()) };
  }
    out.push(...data.objects.nodes);
  if (!data.objects.pageInfo.hasNextPage) return { nodes: out, pages: page + 1, complete: true };
    after = data.objects.pageInfo.endCursor;
  if (!after) return { nodes: out, pages: page + 1, complete: false, error: "Pool list has more rows but no continuation cursor" };
  }
 return { nodes: out, pages: MAX_POOL_PAGES, complete: false, error: `Stopped after ${MAX_POOL_PAGES} pages (${out.length} objects); more pools remain` };
}

function matchesPair(a: string, b: string, pairs: Array<[string, string]>): boolean {
 return pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

function candidateOf(node: PoolNode, protocol: PoolProtocol, base: string, pairs: Array<[string, string]>): PoolCandidate | null {
 const objectType = node.asMoveObject?.contents?.type?.repr;
 if (!objectType?.startsWith(`${base}<`)) return null;
 const args = extractTypeParams(objectType);
 if (args.length !== (protocol === "turbos" ? 3 : 2)) return null;
 const a = canonicalPoolCoinType(args[0]);
 const b = canonicalPoolCoinType(args[1]);
 if (!a || !b || !matchesPair(a, b, pairs)) return null;
 return { pool_id: node.address, protocol, object_type: objectType, token_a: a, token_b: b };
}

function aftermathCandidates(read: PoolPageRead, pairs: Array<[string, string]>): { pools: PoolCandidate[]; unread: number } {
 const pools: PoolCandidate[] = [];
 let unread = 0;
 for (const node of read.nodes) {
  const objectType = node.asMoveObject?.contents?.type?.repr;
  const args = objectType?.startsWith(`${AFTERMATH_POOL}<`) ? extractTypeParams(objectType) : [];
  const names = node.asMoveObject?.contents?.json?.type_names;
  if (args.length !== 1 || !Array.isArray(names) || names.length < 2) { unread++; continue; }
  const coins = names.map((name) => typeof name === "string" ? canonicalPoolCoinType(name) : null);
  if (coins.some((coin) => !coin)) { unread++; continue; }
  const types = coins as string[];
  if (!pairs.some(([a, b]) => types.includes(a) && types.includes(b))) continue;
  pools.push({
   pool_id: node.address, protocol: "aftermath", object_type: objectType!,
   token_a: types[0], token_b: types[1], coin_types: types, lp_type: args[0],
  });
 }
 return { pools, unread };
}

/** The FlowX v2 factory bag stores PairMetadata<X,Y> under the exact LP-X-Y string. */
async function flowxPairs(pairs: Array<[string, string]>): Promise<{ pools: PoolCandidate[]; status: PoolVenueStatus }> {
 const status: PoolVenueStatus = { venue: "flowx_v2", status: "complete", searched: 0, pages: 0 };
 const pools: PoolCandidate[] = [];
 try {
  const factory = await gqlQuery<{
   object: { asMoveObject?: { contents?: { type?: { repr?: string }; json?: { pairs?: { id?: string } } } } } | null;
  }>(`query($id: SuiAddress!) { object(address: $id) { asMoveObject { contents { type { repr } json } } } }`, { id: FLOWX_V2_CONTAINER });
  status.pages++;
  const body = factory.object?.asMoveObject?.contents;
  const bag = body?.type?.repr === `${FLOWX_V2_PACKAGE}::factory::Container` ? body.json?.pairs?.id : undefined;
  if (!bag || !/^0x[0-9a-fA-F]{64}$/.test(bag)) throw new Error("FlowX v2 factory pair bag could not be read");
  const orders = new Map<string, readonly [string, string]>();
  for (const [a, b] of pairs) {
   orders.set(`${a}|${b}`, [a, b]);
   orders.set(`${b}|${a}`, [b, a]);
  }
  const results = await Promise.all([...orders.values()].map(async ([a, b]) => {
   status.searched++;
   const id = flowxPairFieldId(bag, a, b);
   try {
    const data = await gqlQuery<{ object: { asMoveObject?: { contents?: { type?: { repr?: string }; json?: Record<string, unknown> } } } | null }>(
     `query($id: SuiAddress!) { object(address: $id) { asMoveObject { contents { type { repr } json } } } }`,
     { id },
    );
    const contents = data.object?.asMoveObject?.contents;
    if (!data.object) return null;
    const fieldType = contents?.type?.repr;
    const metadata = fieldType && extractTypeParams(fieldType)[1];
    const coins = metadata?.startsWith(`${FLOWX_V2_PACKAGE}::pair::PairMetadata<`) ? extractTypeParams(metadata) : [];
    const name = `LP-${a.replace(/0x([0-9a-f]{64})/g, "$1")}-${b.replace(/0x([0-9a-f]{64})/g, "$1")}`;
    const value = contents?.json?.value;
    if (!fieldType?.startsWith("0x0000000000000000000000000000000000000000000000000000000000000002::dynamic_field::Field<") ||
     coins.length !== 2 || canonicalPoolCoinType(coins[0]) !== a || canonicalPoolCoinType(coins[1]) !== b ||
     contents?.json?.name !== name || !value || typeof value !== "object") {
     throw new Error(`FlowX pair field ${id} did not match its requested coin types`);
    }
    return {
     pool_id: id, protocol: "flowx_v2" as const, object_type: fieldType, token_a: a, token_b: b,
     lp_type: `${FLOWX_V2_PACKAGE}::pair::LP<${a}, ${b}>`
    };
   } catch (err) {
    status.status = "failed";
    status.error = [status.error, describeError(err, getNetwork())].filter(Boolean).join("; ");
    return null;
   }
  }));
  status.pages += orders.size;
  pools.push(...results.filter((result): result is NonNullable<typeof result> => result !== null));
 } catch (err) {
  status.status = "failed";
  status.error = describeError(err, getNetwork());
 }
 return { pools, status };
}

async function searchVenue(protocol: PoolProtocol, pairs: Array<[string, string]>): Promise<{ pools: PoolCandidate[]; status: PoolVenueStatus }> {
 if (protocol === "flowx_v2") return flowxPairs(pairs);
 const status: PoolVenueStatus = { venue: protocol, status: "complete", searched: 0, pages: 0 };
 if (protocol === "turbos") status.pages = 1; // PoolConfig fee-tier read.
 const pools: PoolCandidate[] = [];
 let bases: string[];
 try {
  bases = protocol === "aftermath" ? [AFTERMATH_POOL] : await poolBases(protocol);
  if (!bases.length) throw new Error("No verified pool type for venue");
 } catch (err) {
  return { pools, status: { ...status, status: "failed", error: describeError(err, getNetwork()) } };
 }
 const selectors = protocol === "aftermath" ? bases.map((type) => ({ type, base: type })) :
  bases.flatMap((base) => {
   const orders = pairs.flatMap(([a, b]) => a === b ? [[a, b]] : [[a, b], [b, a]]);
   return orders.map(([a, b]) => ({
    base,
    type: base.includes("{A}") ? base.replace("{A}", a).replace("{B}", b) : `${base}<${a}, ${b}>`,
   }));
  });
 const unique = new Map<string, (typeof selectors)[number]>();
 for (const selector of selectors) unique.set(selector.type, selector);
 const reads = await Promise.all([...unique.values()].map(async ({ type, base }) => ({ type, base, read: await readPoolPages(type, protocol === "aftermath") })));
 status.searched = unique.size;
 for (const { type, base, read } of reads) {
  status.pages += read.pages;
  if (!read.complete) {
   const capped = read.error?.startsWith("Stopped after") || read.error?.includes("no continuation cursor");
   if (!capped || status.status !== "failed") status.status = capped ? "incomplete" : "failed";
   status.error = [status.error, `${type}: ${read.error}`].filter(Boolean).join("; ");
  }
  if (protocol === "aftermath") {
   const parsed = aftermathCandidates(read, pairs);
   pools.push(...parsed.pools);
   if (parsed.unread) {
    if (status.status === "complete") status.status = "incomplete";
    status.error = [status.error, `${parsed.unread} Aftermath pool objects lacked readable coin types`].filter(Boolean).join("; ");
   }
  } else {
   let unread = 0;
   let firstUnread: string | undefined;
   for (const node of read.nodes) {
    const candidate = candidateOf(node, protocol, base.split("<")[0], pairs);
    if (candidate) pools.push(candidate);
    else {
     unread++;
     firstUnread ??= node.address;
    }
   }
   if (unread) {
    if (status.status === "complete") status.status = "incomplete";
    status.error = [status.error, `${unread} pool objects lacked matching types (first: ${firstUnread})`].filter(Boolean).join("; ");
   }
  }
 }
 return { pools, status };
}

async function searchPoolPairs(pairs: Array<[string, string]>, protocols: PoolProtocol[]): Promise<PoolDiscovery> {
 const unique = new Map<string, [string, string]>();
 for (const [a, b] of pairs) unique.set(a < b ? `${a}|${b}` : `${b}|${a}`, [a, b]);
 const distinct = [...unique.values()];
 const pairs_searched = distinct.map(([token_a, token_b]) => ({ token_a, token_b }));
 if (getNetwork() !== "mainnet") return {
  pools: [], pairs_searched,
  venues: protocols.map((venue) => ({
   venue, status: "unsupported", searched: 0, pages: 0,
   error: "Verified pool packages and registry IDs are mainnet-only"
  })),
 };
 const outcomes = await Promise.all(protocols.map((protocol) => searchVenue(protocol, distinct)));
 const byId = new Map<string, PoolCandidate>();
 for (const outcome of outcomes) for (const pool of outcome.pools) byId.set(pool.pool_id, pool);
 return { pools: [...byId.values()], venues: outcomes.map((outcome) => outcome.status), pairs_searched };
}

/** Exact SUI/USDC counterpart discovery; other pairs are intentionally outside this call's scope. */
export async function discoverCoinPools(coinType: string): Promise<PoolDiscovery> {
 const coin = canonicalPoolCoinType(coinType);
 if (!coin) throw new Error(`Invalid coin type: ${coinType}`);
 const counterparts = [SUI_COIN, USDC_COIN].filter((type) => type !== coin);
 return searchPoolPairs(counterparts.map((other) => [coin, other]), [...POOL_PROTOCOLS]);
}
