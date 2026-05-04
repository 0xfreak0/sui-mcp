import { z } from "zod";
import { deepbookClient, deepbookPools } from "../clients/deepbook.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function requireClient() {
  if (!deepbookClient || !deepbookPools) {
    throw new Error("DeepBook tools are only supported on mainnet and testnet (current network has no DeepBook deployment).");
  }
  return { client: deepbookClient, pools: deepbookPools };
}

function poolKeysSorted(): string[] {
  return Object.keys(deepbookPools ?? {}).sort();
}

function resolvePoolKey(input: string): string {
  if (!deepbookPools) throw new Error("DeepBook is not available on this network.");
  if (input in deepbookPools) return input;
  // Allow lookup by raw address: case-insensitive match against known pool addresses.
  const normalized = input.toLowerCase();
  for (const [key, pool] of Object.entries(deepbookPools)) {
    if (pool.address.toLowerCase() === normalized) return key;
  }
  throw new Error(`Unknown DeepBook pool '${input}'. Available pools: ${poolKeysSorted().join(", ")}`);
}

export function registerDeepBookTools(server: McpServer) {
  server.tool(
    "deepbook_get_pool_info",
    "Get comprehensive info for a DeepBook v3 pool: pool ID, base/quote coin types, mid price, vault balances (base/quote/DEEP), trade params (taker/maker fees, stake required), book params, DEEP price for fee calculation, and whitelisted/stable flags. Call with no `pool` arg to list all available pool keys.",
    {
      pool: z
        .string()
        .optional()
        .describe(
          "Pool key (e.g. 'SUI_USDC', 'DEEP_USDC') or pool object address. Omit to list available pools.",
        ),
    },
    async ({ pool }) => {
      try {
        const { client, pools } = requireClient();
        if (!pool) {
          const list = Object.entries(pools).map(([key, p]) => ({
            key,
            address: p.address,
            base: p.baseCoin,
            quote: p.quoteCoin,
          }));
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ pools: list, count: list.length }, null, 2),
              },
            ],
          };
        }
        const key = resolvePoolKey(pool);
        const [mid, vault, tradeParams, bookParams, deepPrice, whitelisted, stable] = await Promise.all([
          client.deepbook.midPrice(key),
          client.deepbook.vaultBalances(key),
          client.deepbook.poolTradeParams(key),
          client.deepbook.poolBookParams(key),
          client.deepbook.getPoolDeepPrice(key),
          client.deepbook.whitelisted(key),
          client.deepbook.stablePool(key),
        ]);
        const meta = pools[key];
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  key,
                  address: meta.address,
                  base_coin: meta.baseCoin,
                  quote_coin: meta.quoteCoin,
                  mid_price: mid,
                  vault: { base: vault.base, quote: vault.quote, deep: vault.deep },
                  trade_params: tradeParams,
                  book_params: bookParams,
                  deep_price: deepPrice,
                  whitelisted,
                  stable,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );

  server.tool(
    "deepbook_orderbook",
    "Get the L2 order book for a DeepBook v3 pool: mid price plus bid/ask price levels and quantities for N ticks above and below mid. DeepBook is a real on-chain CLOB, so this gives true depth (unlike AMM-style spot prices).",
    {
      pool: z.string().describe("Pool key (e.g. 'SUI_USDC') or pool object address."),
      ticks: z.number().int().min(1).max(50).optional().describe("Number of price ticks from mid (default 10, max 50)."),
    },
    async ({ pool, ticks }) => {
      try {
        const { client } = requireClient();
        const key = resolvePoolKey(pool);
        const n = ticks ?? 10;
        const [mid, level2] = await Promise.all([
          client.deepbook.midPrice(key),
          client.deepbook.getLevel2TicksFromMid(key, n),
        ]);
        const bids = level2.bid_prices.map((p, i) => ({ price: p, quantity: level2.bid_quantities[i] }));
        const asks = level2.ask_prices.map((p, i) => ({ price: p, quantity: level2.ask_quantities[i] }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  pool: key,
                  mid_price: mid,
                  ticks_requested: n,
                  bids,
                  asks,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );

  server.tool(
    "deepbook_quote",
    "Get a price-impact-aware swap quote on DeepBook v3. Specify whether you're selling the base coin (`base_to_quote`) or the quote coin (`quote_to_base`) and the input amount. Returns the output amount, DEEP fee required (zero on whitelisted pools), and effective price. Compare against mid_price to gauge slippage.",
    {
      pool: z.string().describe("Pool key (e.g. 'SUI_USDC') or pool object address."),
      side: z
        .enum(["base_to_quote", "quote_to_base"])
        .describe("'base_to_quote' = sell base for quote (e.g. SUI -> USDC). 'quote_to_base' = sell quote for base."),
      amount: z.number().positive().describe("Input amount in human units (e.g. 10 for 10 SUI, not raw mist)."),
    },
    async ({ pool, side, amount }) => {
      try {
        const { client } = requireClient();
        const key = resolvePoolKey(pool);
        const mid = await client.deepbook.midPrice(key);
        if (side === "base_to_quote") {
          const out = await client.deepbook.getQuoteQuantityOut(key, amount);
          const effective = out.quoteOut > 0 ? out.quoteOut / amount : null;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    pool: key,
                    side,
                    amount_in: amount,
                    amount_out: out.quoteOut,
                    deep_required: out.deepRequired,
                    mid_price: mid,
                    effective_price: effective,
                    slippage_pct: effective != null ? ((effective - mid) / mid) * 100 : null,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } else {
          const out = await client.deepbook.getBaseQuantityOut(key, amount);
          const effective = out.baseOut > 0 ? amount / out.baseOut : null;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    pool: key,
                    side,
                    amount_in: amount,
                    amount_out: out.baseOut,
                    deep_required: out.deepRequired,
                    mid_price: mid,
                    effective_price: effective,
                    slippage_pct: effective != null ? ((effective - mid) / mid) * 100 : null,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );

  server.tool(
    "deepbook_get_wallet_positions",
    "Find a wallet's DeepBook v3 footprint: every BalanceManager (DeepBook account) and MarginManager owned by the wallet, plus per-coin balances (DEEP, SUI, USDC, and others) for each BalanceManager. Returns empty arrays if the wallet has no DeepBook activity. Use this to extend get_defi_positions for active DeepBook traders.",
    {
      owner: z.string().describe("Owner wallet address (0x...)."),
      coins: z
        .array(z.string())
        .optional()
        .describe(
          "Coin keys to check balances for, e.g. ['DEEP','SUI','USDC']. Defaults to a common set if omitted.",
        ),
    },
    async ({ owner, coins }) => {
      try {
        const { client } = requireClient();
        const coinKeys = coins ?? [
          "DEEP",
          "SUI",
          "USDC",
          "WUSDC",
          "WUSDT",
          "USDT",
          "WAL",
          "NS",
          "DRF",
          "BETH",
        ];
        const [balanceManagerIds, marginManagerIds] = await Promise.all([
          client.deepbook.getBalanceManagerIds(owner),
          client.deepbook.getMarginManagerIdsForOwner(owner),
        ]);
        let balances: Record<string, Record<string, number>> = {};
        if (balanceManagerIds.length > 0) {
          balances = await client.deepbook.checkManagerBalancesWithAddress(balanceManagerIds, coinKeys);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  owner,
                  balance_managers: balanceManagerIds.map((id) => ({
                    id,
                    balances: balances[id] ?? {},
                  })),
                  margin_managers: marginManagerIds,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );
}
