import { z } from "zod";
import { addressArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { fetchAftermathPrices } from "./prices.js";
import { lookupProtocol, prefetchProtocolNames } from "../protocols/registry.js";
import { describeError, errorResult } from "../utils/errors.js";
import { getNetwork } from "../config.js";
import { resolveTokenType } from "../discovery.js";
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
            text: JSON.stringify(
              {
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
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "find_pools",
    "Find DeFi liquidity pools by token pair. Searches every Cetus pool, DeepBook v3 and v2 pool, and Turbos pool (across every fee tier in Turbos's pool config) for the pair, in either order. token_a and token_b on each pool are the pool's own order, read from its type. Use get_pool_stats on a returned pool_id for detailed stats.",
    {
      token_a: z.string().describe("First token: symbol (e.g. 'SUI') or full coin type"),
      token_b: z.string().describe("Second token: symbol (e.g. 'USDC') or full coin type"),
      protocol: z
        .string()
        .optional()
        .describe("Filter by protocol: 'cetus', 'deepbook', or 'turbos'. Searches all if omitted."),
    },
    async ({ token_a, token_b, protocol: protocolFilter }) => {
      const [typeA, typeB] = await Promise.all([
        resolveTokenType(token_a),
        resolveTokenType(token_b),
      ]);

      if (!typeA) return errorResult(`Could not resolve token: ${token_a}. Provide the full coin type (0x...::module::TYPE).`);
      if (!typeB) return errorResult(`Could not resolve token: ${token_b}. Provide the full coin type (0x...::module::TYPE).`);

      const wanted = protocolFilter?.toLowerCase();
      if (wanted && !POOL_PROTOCOLS.includes(wanted as PoolProtocol)) {
        return errorResult(`Unsupported protocol: ${protocolFilter}. Supported: ${POOL_PROTOCOLS.join(", ")}.`);
      }
      const protocols = wanted ? [wanted as PoolProtocol] : [...POOL_PROTOCOLS];

      const failures: Array<{ protocol: string; error: string }> = [];
      const searches: Array<{ protocol: PoolProtocol; type: string }> = [];
      for (const protocol of protocols) {
        let templates: string[];
        try {
          templates = await poolTemplates(protocol);
        } catch (err) {
          failures.push({ protocol, error: describeError(err, getNetwork()) });
          continue;
        }
        for (const t of templates) {
          searches.push({ protocol, type: t.replace("{A}", typeA).replace("{B}", typeB) });
          searches.push({ protocol, type: t.replace("{A}", typeB).replace("{B}", typeA) });
        }
      }

      const found = await Promise.all(
        searches.map(async ({ protocol, type }) => {
          try {
            return await allObjectsOfType(type);
          } catch (err) {
            failures.push({ protocol, error: describeError(err, getNetwork()) });
            return [];
          }
        }),
      );
      if (searches.length === 0 || failures.length === searches.length) {
        return errorResult(`Could not search for pools: ${failures.map((f) => `${f.protocol}: ${f.error}`).join("; ")}`);
      }

      const pools = found.flatMap((nodes, i) =>
        nodes.map((n) => {
          const objectType = n.asMoveObject?.contents?.type?.repr ?? searches[i].type;
          const [poolA, poolB] = extractTypeParams(objectType);
          return {
            pool_id: n.address,
            protocol: searches[i].protocol,
            object_type: objectType,
            // The pool's own order. Reserves and prices from get_pool_stats
            // are keyed a/b in this order, whichever way round the query was.
            token_a: poolA ?? null,
            token_b: poolB ?? null,
          };
        }),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query: { token_a: typeA, token_b: typeB, protocol: protocolFilter ?? "all" },
                pools,
                total: pools.length,
                ...(failures.length
                  ? {
                      incomplete: true,
                      failed_searches: failures,
                      incomplete_note: "Some pool types could not be read, so pools of those protocols may be missing from this list.",
                    }
                  : {}),
                hint: pools.length > 0
                  ? "Use get_pool_stats with a pool_id for detailed reserves, fees, and prices."
                  : "No pools found. Try different token pairs or check that the coin types are correct.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

const POOL_PROTOCOLS = ["cetus", "deepbook", "turbos"] as const;
type PoolProtocol = (typeof POOL_PROTOCOLS)[number];

/**
 * Turbos's PoolConfig. Its `fee_map` lists every fee tier a pool can be
 * created with, and a Turbos pool's type is `Pool<A, B, FeeTier>`: a filter
 * on `Pool<A, B>` matches none of them.
 */
const TURBOS_POOL_CONFIG = "0xc294552b2765353bcafa7c359cd28fd6bc237662e5db8f09877558d81669170c";
const TURBOS_POOL = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::Pool";

/** Pool type templates per protocol, `{A}` and `{B}` standing for the coin types. */
async function poolTemplates(protocol: PoolProtocol): Promise<string[]> {
  switch (protocol) {
    case "cetus":
      return ["0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool<{A}, {B}>"];
    case "deepbook":
      return [
        // v3, where DeepBook trades today, and the retired v2 order books.
        "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::pool::Pool<{A}, {B}>",
        "0x158f2027f60c89bb91526d9bf08831d27f5a0fcb0f74e6698b9f0e1fb2be5d05::clob_v2::Pool<{A}, {B}>",
      ];
    case "turbos": {
      const data = await gqlQuery<{
        object: { asMoveObject?: { contents?: { json?: { fee_map?: { contents?: Array<{ key: string }> } } } } } | null;
      }>(`query($id: SuiAddress!) { object(address: $id) { asMoveObject { contents { json } } } }`, { id: TURBOS_POOL_CONFIG });
      const tiers = data.object?.asMoveObject?.contents?.json?.fee_map?.contents?.map((e) => e.key) ?? [];
      if (tiers.length === 0) throw new Error("Turbos's pool config listed no fee tiers");
      return tiers.map((fee) => `${TURBOS_POOL}<{A}, {B}, ${fee.startsWith("0x") ? fee : `0x${fee}`}>`);
    }
  }
}

/** Pages a type filter holds, at 50 objects each, before it is reported as failed rather than cut short. */
const MAX_POOL_PAGES = 20;

interface PoolNode {
  address: string;
  asMoveObject?: { contents?: { type?: { repr?: string } } };
}

/** Every object of one exact type, paged to the end. */
async function allObjectsOfType(type: string): Promise<PoolNode[]> {
  const out: PoolNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_POOL_PAGES; page++) {
    const data: {
      objects: { nodes: PoolNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } = await gqlQuery(
      `query($type: String!, $after: String) {
        objects(filter: { type: $type }, first: 50, after: $after) {
          nodes { address asMoveObject { contents { type { repr } } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { type, after },
    );
    out.push(...data.objects.nodes);
    if (!data.objects.pageInfo.hasNextPage) return out;
    after = data.objects.pageInfo.endCursor;
    if (!after) break;
  }
  throw new Error(`more than ${out.length} objects of ${type}; the list was not read to the end`);
}
