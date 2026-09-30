import { z } from "zod";
import { coinScale, displayCoin, prefetchCoinScale } from "../utils/valuation.js";
import "../utils/valuers/index.js";
import { normalizeCoinType } from "../utils/coin-registry.js";
import { registeredValuers, valuePositions, type ValuedPosition } from "../utils/position-value.js";
import { capPayload, capRows, type ListCap, type NextCall } from "../utils/output-cap.js";
import { healthLeads, positionRows, positionTotals, type PositionRow, type PositionTotals } from "./defi.js";
import { boolArg, addressArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { describeError, errorResult } from "../utils/errors.js";
import { fetchAftermathPrices } from "./prices.js";
import { countOwned } from "../utils/owned-objects.js";
import { discoverKiosks } from "../utils/nft-holdings.js";
import { heldWalk } from "../utils/valuers/held-balances.js";
import { ownedCoverage, type OwnedCoverage } from "../utils/owned-coverage.js";
import { operatedLeadRow, operatedSharedObjects } from "../utils/operated-objects.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** GraphQL's largest page of balances. */
const BALANCE_PAGE = 50;
/** Coin types read per wallet; past them `holdings_truncated` says the list is not whole. */
const MAX_BALANCE_PAGES = 20;
/** Coin types priced per request. */
const PRICE_BATCH = 100;
/** StakedSui objects counted per wallet; past them the count is a floor. */
const MAX_STAKES_COUNTED = 10_000;
const STAKED_SUI_TYPE = "0x3::staking_pool::StakedSui";

type BalanceNode = { coinType: { repr: string }; totalBalance: string; coinBalance: string | null; addressBalance: string | null };
type BalancePage = { nodes: BalanceNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

const FIRST_QUERY = `query($address: SuiAddress!, $first: Int, $txFirst: Int) {
  address(address: $address) {
    defaultNameRecord { domain }
    balances(first: $first) {
      nodes { coinType { repr } totalBalance coinBalance addressBalance }
      pageInfo { hasNextPage endCursor }
    }
  }
  transactions(filter: { affectedAddress: $address }, last: $txFirst) {
    nodes { digest sender { address } effects { status timestamp } }
  }
}`;

const BALANCES_QUERY = `query($address: SuiAddress!, $first: Int, $after: String) {
  address(address: $address) {
    balances(first: $first, after: $after) {
      nodes { coinType { repr } totalBalance coinBalance addressBalance }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export function registerWorkflowTools(server: McpServer) {
  server.tool(
    "get_wallet_overview",
    "(Recommended first tool for wallets) Get a comprehensive overview of a Sui wallet: every token balance, SuiNS name, staked SUI count, kiosk count, and recent transactions. Set include_prices=true for USD values: coins ranked by value, and DeFi positions (staked SUI with rewards, liquid staking, liquidity, lending, and balances held inside objects the wallet owns), each totalled apart. `coverage` says what the total covers of the objects the wallet owns and lists the ones no reader recognises by type and count; `leads` names lending positions near their borrow limit and shared vaults the wallet operates, with what they hold. Add include_nfts=true for NFT estimates, kept out of the total. Start here before drilling into specific tools.",
    {
      address: addressArg().describe("Wallet address (0x...)"),
      include_prices: boolArg()
        .optional()
        .describe("Include USD prices and portfolio value, with DeFi positions valued beside the coins, coverage of the objects owned, and leads (default: false)"),
      include_nfts: boolArg()
        .optional()
        .describe("With include_prices, also estimate the NFTs held (default: false). This walks every object and kiosk item the wallet holds and reads each collection's market, which on a wallet holding many objects takes many requests; list_nft_collections does the same on its own."),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default): the holdings and not-recognised object types that fit about 12k characters each, the rest stated in `omitted`. 'full': every row."),
    },
    async ({ address, include_prices, include_nfts, detail }) => {
      const [gqlResult, stakedResult, kioskResult] = await Promise.all([
        // A failed read is an error, never an empty wallet: `holdings: []`
        // and no transactions is exactly what a real unused address returns.
        gqlQuery<{
          address: { defaultNameRecord: { domain: string } | null; balances: BalancePage } | null;
          transactions: { nodes: Array<{ digest: string; sender?: { address: string }; effects?: { status: string; timestamp?: string } }> };
        }>(FIRST_QUERY, { address, first: BALANCE_PAGE, txFirst: 5 }).catch(asError),
        countOwned(address, STAKED_SUI_TYPE, MAX_STAKES_COUNTED).catch(asError),
        discoverKiosks(address).catch(asError),
      ]);

      if (gqlResult instanceof Error) {
        return errorResult(
          `Could not read the balances, name and recent transactions of ${address}: ${describeError(gqlResult, getNetwork())}. ` +
            "This is not evidence the wallet is empty.",
        );
      }
      const addrData = gqlResult.address;
      const nameResult = addrData?.defaultNameRecord?.domain ?? null;

      // Every coin type, page by page: one page is the first coin types in
      // type order, which leaves out whatever sorts later however large.
      const nodes = [...(addrData?.balances.nodes ?? [])];
      let pageInfo = addrData?.balances.pageInfo ?? { hasNextPage: false, endCursor: null };
      let pages = 1;
      let balancesUnread: string | null = null;
      while (pageInfo.hasNextPage && pageInfo.endCursor && pages < MAX_BALANCE_PAGES) {
        try {
          const next = await gqlQuery<{ address: { balances: BalancePage } | null }>(BALANCES_QUERY, { address, first: BALANCE_PAGE, after: pageInfo.endCursor });
          if (!next.address) break;
          nodes.push(...next.address.balances.nodes);
          pageInfo = next.address.balances.pageInfo;
          pages++;
        } catch (err) {
          balancesUnread = describeError(err, getNetwork());
          break;
        }
      }
      const hasNextPage = pageInfo.hasNextPage;
      const rawBalances = nodes
        .filter((b) => b.totalBalance !== "0")
        .map((b) => ({
          coinType: b.coinType.repr,
          balance: b.totalBalance,
          coinBalance: b.coinBalance ?? "0",
          addressBalance: b.addressBalance ?? "0",
        }));
      const coinTypes = rawBalances.map((b) => b.coinType);

      // What the wallet holds beyond coins, valued by every registered
      // reader alongside the coin prices, with one memo so the readers and
      // the coverage count share one walk of the owned objects. A reader
      // that fails is listed in `unread`, never counted as holding nothing.
      // NFTs only on request: their walk reads every object and kiosk item.
      const ctx = { owner: address, memo: new Map<string, Promise<unknown>>() };
      const valuing = include_prices
        ? valuePositions(ctx, include_nfts ? undefined : registeredValuers().filter((name) => name !== "nft"))
        : null;
      const operating = include_prices ? operatedSharedObjects(address, ctx).catch(asError) : null;

      let priceData: Record<string, { price: number; priceChange24HoursPercentage: number }> | null = null;
      if (include_prices && coinTypes.length > 0) {
        const batches: string[][] = [];
        for (let i = 0; i < coinTypes.length; i += PRICE_BATCH) batches.push(coinTypes.slice(i, i + PRICE_BATCH));
        const [prices] = await Promise.all([
          Promise.all(batches.map((b) => fetchAftermathPrices(b))),
          prefetchCoinScale(coinTypes).catch(() => undefined),
        ]);
        const answered = prices.filter((p): p is NonNullable<typeof p> => p !== null);
        priceData = answered.length > 0 ? Object.assign({}, ...answered) : null;
      }

      const valued = valuing ? await valuing : null;
      const valuedPositions = valued?.positions ?? [];
      // A position backed by a coin the wallet holds (a liquid-staking or LP
      // coin) values that coin; the coin is counted there, once.
      const coinsInPositions = new Set(
        valuedPositions
          .filter((p) => p.usd_net !== null)
          .flatMap((p) => (Array.isArray(p.detail?.receipt_coin_types) ? (p.detail.receipt_coin_types as string[]) : []))
          .map((t) => normalizeCoinType(t) ?? t),
      );

      const holdings = rawBalances.map((b) => {
        // Decimals from the coin's on-chain metadata when it has any, else
        // the registry's scale, the same scale traces render the coin at.
        const decimals = coinScale(b.coinType).decimals;
        const known = displayCoin(b.coinType);
        const base: Record<string, unknown> = {
          coin_type: b.coinType,
          symbol: known.symbol,
          // The symbol is whatever the minter chose; many coins share one with
          // another. Marked here for the same reason a trace marks it.
          verified: known.verified,
          balance: b.balance,
          // `balance` is the total. A holding with no Coin<T> objects sits
          // entirely in the address balance, so list_owned_objects shows no
          // coin for it while this shows the funds.
          coin_balance: b.coinBalance,
          address_balance: b.addressBalance,
        };
        if (include_prices) {
          const humanAmount = Number(BigInt(b.balance)) / 10 ** decimals;
          const afEntry = priceData?.[b.coinType];
          const priceUsd = afEntry && afEntry.price >= 0 ? afEntry.price : null;
          base.balance_human = humanAmount.toString();
          base.decimals = decimals;
          base.price_usd = priceUsd;
          base.value_usd = priceUsd != null ? Math.round(humanAmount * priceUsd * 100) / 100 : null;
          if (coinsInPositions.has(normalizeCoinType(b.coinType) ?? b.coinType)) base.value_counted_in = "positions";
        }
        return base;
      });
      // Most valuable first, unpriced last.
      if (include_prices) holdings.sort((a, b) => ((b.value_usd as number | null) ?? -1) - ((a.value_usd as number | null) ?? -1));

      // `last` returns the five newest in ascending order; reversed so the
      // first row is the most recent. `first` would return the address's
      // five OLDEST transactions under a field named "recent".
      const recentTransactions = [...(gqlResult.transactions?.nodes ?? [])].reverse().map((n) => ({
        digest: n.digest,
        sender: n.sender?.address,
        status: n.effects?.status,
        timestamp: n.effects?.timestamp,
      }));

      const result: Record<string, unknown> = {
        address,
        sui_name: nameResult,
        holdings_count: holdings.length,
        holdings_truncated: hasNextPage,
        ...(hasNextPage
          ? {
              holdings_truncated_reason: balancesUnread
                ? `The balance pages after the first ${pages} could not be read (${balancesUnread}).`
                : `Only the first ${nodes.length} coin types (${pages} page(s)) were read.`,
            }
          : {}),
        holdings,
        staked_sui_count: stakedResult instanceof Error ? null : stakedResult.count,
        ...(stakedResult instanceof Error || stakedResult.complete ? {} : { staked_sui_count_truncated: `Counted up to ${MAX_STAKES_COUNTED}; the count is a floor.` }),
        kiosk_count: kioskResult instanceof Error ? null : kioskResult.length,
        recent_transactions: recentTransactions,
      };
      // A failed read is reported as unknown, not as zero.
      if (stakedResult instanceof Error) {
        result.staked_sui_unavailable = `The StakedSui read failed (${describeError(stakedResult, getNetwork())}), so how much is staked is unknown. Try get_staking_summary.`;
      }
      if (kioskResult instanceof Error) {
        result.kiosk_unavailable = `The kiosk read failed (${describeError(kioskResult, getNetwork())}), so whether this wallet owns kiosks is unknown.`;
      }

      if (include_prices) {
        // A holding with no price contributes 0, so the total silently covers
        // only what could be priced. A wallet whose holdings are mostly
        // unpriced reports a small total that reads as a portfolio value
        // rather than as a few coins out of many.
        const priced = holdings.filter((h) => h.value_usd != null);
        const unpriced = holdings.length - priced.length;
        const coinsUsd = priced
          .filter((h) => h.value_counted_in !== "positions")
          .reduce((sum, h) => sum + ((h.value_usd as number) ?? 0), 0);
        // NFT values are estimates and stay out of the total; DeFi positions
        // rest on chain state and a provider's price, as coins do.
        const defi = valuedPositions.filter((p) => p.kind !== "nft");
        const nfts = valuedPositions.filter((p) => p.kind === "nft");
        const defiTotals = positionTotals(defi);
        result.coins_value_usd = Math.round(coinsUsd * 100) / 100;
        result.positions_value_usd = defiTotals.total_usd;
        result.total_value_usd = Math.round((coinsUsd + defiTotals.total_usd) * 100) / 100;
        result.priced_holdings = priced.length;
        result.unpriced_holdings = unpriced;
        result.verified_holdings = holdings.filter((h) => h.verified === true).length;
        result.positions = overviewList(defi, defiTotals, { tool: "get_defi_positions", args: { address, detail: "full" } });
        if (nfts.length > 0) {
          const nftTotals = positionTotals(nfts);
          result.nft_estimate_usd = nftTotals.total_usd;
          result.nfts = overviewList(nfts, nftTotals, { tool: "list_nft_collections", args: { address, detail: "full" } });
          result.nft_estimate_note =
            "NFT values are heuristic estimates from market evidence (floor listings and past sales), labelled per collection with their method; they are not in total_value_usd.";
        } else if (!include_nfts) {
          result.nfts_not_valued = { reason: "NFTs are estimated only with include_nfts: true.", next_call: { tool: "list_nft_collections", args: { address } } };
        }

        const unread = [...(valued?.unread ?? [])];
        const walk = heldWalk(ctx);
        const coverage: OwnedCoverage | null = walk ? ownedCoverage(await walk, valuedPositions, unread, include_nfts === true) : null;
        if (coverage) result.coverage = coverage;

        const operated = operating ? await operating : null;
        if (operated instanceof Error) unread.push({ what: "operated shared objects", reason: operated.message });
        const leads = [
          ...healthLeads(defi).map((l) => ({ kind: "near_borrow_limit", ...l })),
          ...(operated && !(operated instanceof Error) ? operated.leads.map(operatedLeadRow) : []),
        ];
        if (leads.length > 0) result.leads = leads;
        if (unread.length > 0) result.unread = unread;

        // Say what the total covers and what it leaves out, every time.
        const parts: string[] = ["total_value_usd sums the priced coins and the DeFi positions the readers valued."];
        if (unpriced > 0) {
          // Say what an absent price most likely MEANS rather than only that
          // it is absent. Nobody makes a market in a token minted to look
          // like another one, which is why `pickFundingTx` treats an unpriced
          // coin as spam at any size — but a newly listed asset is
          // indistinguishable here, so both readings are given.
          const unverifiedUnpriced = holdings.filter((h) => h.value_usd == null && h.verified === false).length;
          parts.push(
            `Of the ${holdings.length} coin holdings, ${priced.length} have a price; the other ${unpriced} contribute nothing.` +
              (unverifiedUnpriced > 0
                ? ` ${unverifiedUnpriced} of those are also unverified — no market price and nothing vouching for the coin is the usual shape of a spam or impersonation token, though a newly listed asset looks the same.`
                : " A coin with no market price usually has no market, though a newly listed asset looks the same here."),
          );
        }
        if (defiTotals.unpriced_positions > 0) {
          parts.push(`${defiTotals.unpriced_positions} DeFi position(s) have a leg with no price and contribute nothing; each states why.`);
        }
        if ((valued?.unread.length ?? 0) > 0) parts.push("Some positions could not be read (see `unread`) and are not in the total.");
        if (hasNextPage) parts.push("The holdings list was also truncated, so coin types past it are excluded entirely.");
        if (coverage) parts.push(coverage.note);
        const operatedLeads = operated && !(operated instanceof Error) ? operated.leads : [];
        if (operatedLeads.length > 0) {
          parts.push(
            `The address uses ${operatedLeads.length} shared object(s) whose fields name it in a control role, holding $${Math.round(operatedLeads.reduce((s, o) => s + o.priced_usd, 0)).toLocaleString("en-US")} at provider prices; they are in \`leads\`, not in the total.`,
          );
        }
        const leftOut =
          unpriced > 0 || hasNextPage || defiTotals.unpriced_positions > 0 || unread.length > 0 || (coverage !== null && (coverage.not_recognised > 0 || !coverage.complete)) || operatedLeads.length > 0;
        result.total_value_note = `${parts.join(" ")}${leftOut ? " Treat this as a floor, not a portfolio value." : ""}`;
      }

      const usdOf = (h: Record<string, unknown>) => (typeof h.value_usd === "number" ? h.value_usd : null);
      const { payload } = capPayload(
        "get_wallet_overview",
        { address, include_prices, include_nfts },
        result,
        {
          holdings: {
            budget: 12_000,
            ...(include_prices ? { usd: usdOf } : { keepOrder: true }),
            brief: (h: Record<string, unknown>) => ({ coin_type: h.coin_type, symbol: h.symbol, balance: h.balance, ...(include_prices ? { value_usd: h.value_usd } : {}) }),
          } satisfies ListCap<Record<string, unknown>>,
          leads: {
            budget: 8_000,
            brief: (l: { kind: string; object_id: string | null }) => ({ kind: l.kind, object_id: l.object_id }),
          } satisfies ListCap<{ kind: string; object_id: string | null }>,
          "coverage.not_recognised_types": {
            budget: 6_000,
            brief: (g: { type: string; count: number }) => ({ type: g.type, count: g.count }),
          } satisfies ListCap<{ type: string; count: number }>,
        },
        { full: detail === "full", next_call: { tool: "get_wallet_overview", repeat_with: { detail: "full" } } },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    },
  );
}

/** Overview row: what a position is and its value, without its legs. */
type OverviewRow = Pick<PositionRow, "protocol" | "kind" | "object_id" | "usd" | "tier" | "method" | "unpriced_reason">;

/**
 * A compact list of valued positions for the overview: totals over every
 * position, the most valuable rows within a budget, and the omitted rest.
 */
function overviewList(
  positions: ValuedPosition[],
  totals: PositionTotals,
  next_call: NextCall,
): Record<string, unknown> {
  const rows: OverviewRow[] = positionRows(positions).map(({ protocol, kind, object_id, usd, tier, method, unpriced_reason }) => ({
    protocol,
    kind,
    object_id,
    usd,
    tier,
    method,
    ...(unpriced_reason ? { unpriced_reason } : {}),
  }));
  const capped = capRows(rows, {
    budget: 8_000,
    usd: (r) => r.usd,
    brief: (r) => ({ protocol: r.protocol, kind: r.kind, object_id: r.object_id, usd: r.usd }),
    next_call,
  });
  return {
    count: positions.length,
    total_usd: totals.total_usd,
    priced: totals.priced_positions,
    unpriced: totals.unpriced_positions,
    by_protocol: totals.by_protocol,
    rows: capped.rows,
    ...(capped.omitted ? { omitted: capped.omitted } : {}),
  };
}
