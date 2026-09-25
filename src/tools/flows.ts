import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addressArg, numArg, coinTypeArg, timePointArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { errorResult } from "../utils/errors.js";
import { describeWindow, resolveWindow } from "../utils/checkpoint-time.js";
import { BALANCE_CHANGES_SELECTION, COMMANDS_SELECTION, completeTxConnections, type GqlConnection } from "../utils/tx-connections.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "../utils/gql-adapters.js";
import { fetchEventJson } from "../utils/event-json.js";
import { readBridgeEvents } from "../utils/bridge/exits.js";
import { EVIDENCE_TIER_MEANING, type SuiEventNode } from "../utils/bridge/wormhole.js";
import { describeAddresses, identityNote, type AddressIdentity } from "../utils/identity.js";
import { getLabel, labelProvenance } from "../utils/labels.js";
import { displayCoin, priceUsdAtTime, PRICE_STALE_THRESHOLD_SEC } from "../utils/valuation.js";
import { coinKey } from "../utils/trace-hop.js";
import {
  coinValuer,
  roundUsd as round,
  entryCandidates,
  exitCandidates,
  groupExits,
  readExit,
  summarizeFlows,
  type Counterparty,
  type ExitRecord,
  type FlowTx,
} from "../utils/address-flows.js";

/**
 * Everything one scan needs: balance changes and commands (both completed past
 * their first page), the gas charge, and event types for bridge detection.
 * Event JSON is read afterwards, for bridge transactions only.
 */
const SCAN_QUERY = `query ($filter: TransactionFilter!, $last: Int!, $before: String) {
  transactions(filter: $filter, last: $last, before: $before) {
    nodes {
      digest
      sender { address }
      gasInput { gasSponsor { address } }
      kind { ... on ProgrammableTransaction { ${COMMANDS_SELECTION} } }
      effects {
        timestamp
        checkpoint { sequenceNumber }
        gasEffects { gasSummary { computationCost storageCost storageRebate } }
        ${BALANCE_CHANGES_SELECTION}
        events(first: 50) { pageInfo { hasNextPage } nodes { contents { type { repr } } } }
      }
    }
    pageInfo { hasPreviousPage startCursor }
  }
}`;

interface ScanNode {
  digest: string;
  sender?: { address?: string } | null;
  gasInput?: { gasSponsor?: { address?: string } | null } | null;
  kind?: { commands?: GqlConnection<GqlCommandNode> | null } | null;
  effects?: {
    timestamp?: string | null;
    checkpoint?: { sequenceNumber?: number } | null;
    gasEffects?: { gasSummary?: { computationCost?: string; storageCost?: string; storageRebate?: string } | null } | null;
    balanceChanges?: GqlConnection<GqlBalanceChangeNode> | null;
    events?: { pageInfo?: { hasNextPage?: boolean }; nodes?: SuiEventNode[] } | null;
  } | null;
}

interface ScanPage {
  transactions: { nodes: ScanNode[]; pageInfo: { hasPreviousPage: boolean; startCursor?: string | null } };
}

const PAGE = 50;
const DEFAULT_MAX_TRANSACTIONS = 1000;
const DEFAULT_TOP = 10;
/** Digests listed per row. The row says how many more there are. */
const DIGESTS_PER_ROW = 5;
/** Aliased connections per request; the service refuses more than 21. */
const EVENT_BATCH = 20;

/** Event JSON for many transactions, 20 per request, paging any with more than 50 events. */
async function readEvents(digests: string[]): Promise<Map<string, SuiEventNode[] | null>> {
  const out = new Map<string, SuiEventNode[] | null>();
  for (let i = 0; i < digests.length; i += EVENT_BATCH) {
    const chunk = digests.slice(i, i + EVENT_BATCH);
    const decls = chunk.map((_, k) => `$d${k}: String!`).join(", ");
    const fields = chunk.map((_, k) => `t${k}: transaction(digest: $d${k}) { ...E }`).join(" ");
    const vars = Object.fromEntries(chunk.map((d, k) => [`d${k}`, d]));
    type Conn = { effects?: { events?: { pageInfo?: { hasNextPage?: boolean }; nodes?: SuiEventNode[] } } } | null;
    let r: Record<string, Conn> | null = null;
    try {
      r = await gqlQuery<Record<string, Conn>>(
        `query (${decls}) { ${fields} } fragment E on Transaction { effects { events(first: 50) { pageInfo { hasNextPage } nodes { contents { type { repr } json } } } } }`,
        vars,
      );
    } catch {
      r = null;
    }
    for (const [k, d] of chunk.entries()) {
      const conn = r?.[`t${k}`]?.effects?.events;
      if (conn?.nodes && !conn.pageInfo?.hasNextPage) {
        out.set(d, conn.nodes);
        continue;
      }
      const all = await fetchEventJson(d);
      out.set(d, all ? all.map((e) => ({ contents: { type: e.type ? { repr: e.type } : undefined, json: e.json } })) : null);
    }
  }
  return out;
}

function toFlowTx(n: ScanNode, balanceChanges: GqlBalanceChangeNode[], commands: GqlCommandNode[]): FlowTx {
  const g = n.effects?.gasEffects?.gasSummary;
  const netGas =
    g?.computationCost != null && g.storageCost != null && g.storageRebate != null
      ? BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate)
      : null;
  return {
    digest: n.digest,
    timestamp: n.effects?.timestamp ?? null,
    checkpoint: n.effects?.checkpoint?.sequenceNumber ?? null,
    sender: n.sender?.address ?? null,
    gasSponsor: n.gasInput?.gasSponsor?.address ?? null,
    netGas,
    changes: balanceChanges
      .filter((c) => c.owner?.address && c.coinType?.repr && c.amount != null)
      .map((c) => ({ owner: c.owner!.address!, coinType: c.coinType!.repr, amount: BigInt(c.amount!) })),
    calls: commands
      .filter((c) => c.function)
      .map((c) => ({
        packageId: c.function!.module.package.address,
        module: c.function!.module.name,
        function: c.function!.name,
      })),
    eventTypes: (n.effects?.events?.nodes ?? [])
      .map((e) => e?.contents?.type?.repr)
      .filter((t): t is string => typeof t === "string"),
    ...(n.effects?.events?.pageInfo?.hasNextPage ? { eventsTruncated: true } : {}),
  };
}


function digestList(digests: string[]) {
  return {
    digests: digests.slice(0, DIGESTS_PER_ROW),
    ...(digests.length > DIGESTS_PER_ROW ? { more_digests: digests.length - DIGESTS_PER_ROW } : {}),
  };
}

function who(address: string, identity: AddressIdentity | undefined) {
  const label = getLabel(address);
  const provenance = label ? labelProvenance(label) : undefined;
  const note = identity ? identityNote(identity) : undefined;
  return {
    address,
    ...(identity && identity.kind !== "wallet" ? { kind: identity.kind } : {}),
    ...(identity?.name ? { name: identity.name } : {}),
    ...(label ? { label: label.label, label_category: label.category } : {}),
    ...(provenance ? { label_provenance: provenance } : {}),
    ...(identity?.protocol ? { protocol: identity.protocol } : {}),
    ...(note ? { note } : {}),
  };
}

export function registerFlowTools(server: McpServer) {
  server.tool(
    "summarize_address_flows",
    "(Incident investigation) What one address took in and paid out over a window, in one call: per coin in/out/net (raw, human, coin_verified, USD at the window's time), every address that paid it with amounts and digests, the top recipients by value with identity and labels, the parties that paid its gas and those it paid gas for, and every bridge exit it sent with the far-side beneficiary read from chain data (CCTP, Sui Bridge, Wormhole Token Bridge and NTT payloads, Mayan). Gas is reported apart from the coin totals; value that arrived or left with no counterparty address (a swap, a withdrawal, an exploit) is `unattributed`. Scans the address's transactions newest first inside the window; check `coverage.complete`, and when the budget stops it, `coverage.continue_with` is the next call.",
    {
      address: addressArg().describe("Address to summarise (0x... or a SuiNS name)."),
      from: timePointArg()
        .optional()
        .describe("Window start: ISO 8601 time (2025-09-07T00:00:00Z) or a checkpoint number. Omit for the address's whole history back to the scan budget."),
      to: timePointArg().optional().describe("Window end: ISO 8601 time, 'now', or a checkpoint number."),
      coin_type: coinTypeArg()
        .optional()
        .describe("Only this coin in the totals and counterparties (e.g. 0x2::sui::SUI). Bridge exits and gas are always reported in full."),
      max_transactions: numArg()
        .int()
        .min(50)
        .max(5000)
        .optional()
        .describe(`Transactions to scan, newest first (default ${DEFAULT_MAX_TRANSACTIONS}).`),
      top: numArg()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(`Recipients to list, and counterparties to identify in each direction (default ${DEFAULT_TOP}).`),
    },
    async ({ address, from, to, coin_type, max_transactions, top }) => {
      try {
        const window = await resolveWindow(from, to);
        const budget = max_transactions ?? DEFAULT_MAX_TRANSACTIONS;
        const topN = top ?? DEFAULT_TOP;
        const filter: Record<string, unknown> = { affectedAddress: address };
        if (window.after?.checkpoint != null) filter.afterCheckpoint = window.after.checkpoint;
        if (window.before?.checkpoint != null) filter.beforeCheckpoint = window.before.checkpoint;

        const txs: FlowTx[] = [];
        const incomplete: string[] = [];
        let before: string | undefined;
        let more = true;
        while (more && txs.length < budget) {
          const page: ScanPage = await gqlQuery(SCAN_QUERY, { filter, last: Math.min(PAGE, budget - txs.length), before });
          const nodes = page.transactions.nodes;
          const completed = await completeTxConnections(
            nodes.map((n) => ({ digest: n.digest, balanceChanges: n.effects?.balanceChanges, commands: n.kind?.commands })),
          );
          // A `last` page arrives oldest first; the scan reports newest first.
          for (let i = nodes.length - 1; i >= 0; i--) {
            const c = completed[i];
            if (c.balanceChangesTruncated || c.commandsTruncated) incomplete.push(nodes[i].digest);
            txs.push(toFlowTx(nodes[i], c.balanceChanges, c.commands));
          }
          more = page.transactions.pageInfo.hasPreviousPage;
          const cursor = page.transactions.pageInfo.startCursor;
          if (!cursor) break;
          before = cursor;
        }
        const truncated = more;

        const summary = summarizeFlows(address, txs, coin_type ?? null);

        // Bridge transactions get their event JSON read; everything else was
        // settled by the scan.
        const qualify = getNetwork() === "mainnet";
        const candidates = exitCandidates(address, txs);
        const entries = entryCandidates(txs);
        const events = await readEvents([...new Set([...candidates, ...entries].map((t) => t.digest))]);
        const exits = candidates
          .map((tx) => readExit(address, tx, events.get(tx.digest) ?? null, qualify))
          .filter((e): e is ExitRecord => e !== null);
        const inbound = entries.flatMap((tx) => {
          const ev = events.get(tx.digest);
          const claims = ev ? readBridgeEvents(ev, qualify).nativeInboundClaims : [];
          return claims.map((cl) => ({
            digest: tx.digest,
            timestamp: tx.timestamp,
            transfer_id: cl.transferId,
            origin_chain: cl.sourceChainId,
            origin_chain_label: cl.sourceChainLabel,
          }));
        });

        // One price per coin, at the median transaction time: activity
        // clusters, and the midpoint of a window can fall where nothing
        // happened.
        const times = txs
          .map((t) => (t.timestamp ? Date.parse(t.timestamp) : NaN))
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        const oldestMs = times.length ? times[0] : null;
        const newestMs = times.length ? times[times.length - 1] : null;
        const atSec = times.length ? Math.floor(times[Math.floor(times.length / 2)] / 1000) : null;
        const coinSet = new Set<string>(summary.coins.keys());
        for (const e of exits) for (const c of e.sent.keys()) coinSet.add(c);
        const sui = coinKey("0x2::sui::SUI");
        coinSet.add(sui);
        const prices = await priceUsdAtTime([...coinSet], atSec ?? undefined);
        const v = coinValuer(prices);

        const rank = (m: Map<string, Counterparty>) =>
          [...m.values()]
            .map((c) => ({ c, usd: v.totalUsd(c.coins) }))
            .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.c.digests.length - a.c.digests.length);
        const sources = rank(summary.sources);
        const recipients = rank(summary.recipients);
        const sponsoredBy = [...summary.sponsoredBy.values()].sort((a, b) => b.digests.length - a.digests.length);
        const sponsored = [...summary.sponsored.values()].sort((a, b) => b.digests.length - a.digests.length);

        const identities = await describeAddresses([
          ...sources.slice(0, topN).map((s) => s.c.address),
          ...recipients.slice(0, topN).map((s) => s.c.address),
          ...sponsoredBy.slice(0, topN).map((s) => s.address),
        ]);

        const counterpartyRow = ({ c, usd }: { c: Counterparty; usd: number | null }, identify: boolean) => ({
          ...who(c.address, identify ? identities.get(c.address) : undefined),
          usd: usd === null ? null : round(usd),
          coins: v.amounts(c.coins),
          transactions: c.digests.length,
          first_at: c.firstAt,
          last_at: c.lastAt,
          ...digestList(c.digests),
        });

        const coins = [...summary.coins.values()]
          .map((f) => {
            const d = displayCoin(f.coinType);
            const p = prices.points.get(f.coinType);
            const unpriced = prices.unpriced.find((u) => u.coin_type === f.coinType);
            const net = f.in - f.out;
            const offset = p && atSec !== null ? p.publishTime - atSec : null;
            return {
              coin_type: f.coinType,
              symbol: d.symbol,
              coin_verified: d.verified,
              in: v.human(f.coinType, f.in),
              out: v.human(f.coinType, f.out),
              net: v.human(f.coinType, net),
              raw: { in: f.in.toString(), out: f.out.toString(), net: net.toString() },
              transactions_in: f.txIn,
              transactions_out: f.txOut,
              ...(p
                ? {
                    price_usd: p.price,
                    price_source: p.source,
                    ...(offset !== null ? { price_offset_sec: offset } : {}),
                    ...(offset !== null && Math.abs(offset) > PRICE_STALE_THRESHOLD_SEC ? { price_stale: true } : {}),
                    usd: {
                      in: round(v.usd(f.coinType, f.in)!),
                      out: round(v.usd(f.coinType, f.out)!),
                      net: round(v.usd(f.coinType, net)!),
                    },
                  }
                : { usd: null, ...(unpriced ? { unpriced: { code: unpriced.code, reason: unpriced.reason } } : {}) }),
            };
          })
          .sort((a, b) => Math.abs(b.usd?.net ?? 0) - Math.abs(a.usd?.net ?? 0) || b.transactions_in + b.transactions_out - (a.transactions_in + a.transactions_out));
        const pricedCoins = coins.filter((c) => c.usd !== null);

        const unattributedRows = (m: typeof summary.unattributedIn) =>
          [...m.values()]
            .map((u) => {
              const usd = v.usd(u.coinType, u.amount);
              return {
                symbol: displayCoin(u.coinType).symbol,
                coin_type: u.coinType,
                amount: v.human(u.coinType, u.amount),
                usd: usd === null ? null : round(usd),
                transactions: u.digests.length,
                ...digestList(u.digests),
              };
            })
            .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

        const oldest = txs.at(-1);
        const newest = txs[0];
        const point = (t: FlowTx | undefined) => (t ? { checkpoint: t.checkpoint, timestamp: t.timestamp, digest: t.digest } : null);
        const spanDays = oldestMs !== null && newestMs !== null ? (newestMs - oldestMs) / 86_400_000 : 0;
        const bridgeGroups = groupExits(exits);
        const unresolvedVaas = exits.flatMap((e) => e.unresolvedVaas);

        const payload = {
          address,
          window: describeWindow(from, to, window),
          ...(coin_type ? { coin_filter: coinKey(coin_type) } : {}),
          coverage: {
            scanned_transactions: txs.length,
            complete: !truncated,
            newest: point(newest),
            oldest: point(oldest),
            ...(truncated && oldest?.checkpoint != null
              ? {
                  continue_with: { to: String(oldest.checkpoint + 1) },
                  truncation_note: `Stopped at the ${budget}-transaction budget with older transactions left in the window. Everything below covers ${point(oldest)?.timestamp} onwards only. continue_with re-reads checkpoint ${oldest.checkpoint}, so drop digests already counted; or raise max_transactions or narrow from.`,
                }
              : {}),
            ...(incomplete.length
              ? {
                  incomplete_transactions: incomplete,
                  incomplete_note: "These transactions' balance changes or commands could not be read whole, so their flows may be understated.",
                }
              : {}),
          },
          usd_basis:
            atSec !== null
              ? {
                  kind: "historical",
                  at: new Date(atSec * 1000).toISOString(),
                  meaning: `Every coin is priced once, at the median time of the transactions scanned (DefiLlama, or Pyth for verified coins when PYTH_API_KEY is set). A third-party price, not chain data.${spanDays > 1 ? ` The scan spans ${spanDays.toFixed(1)} days, so a coin whose price moved in that time is valued at one point of it.` : ""}`,
                }
              : { kind: "none", meaning: "No transaction in the window, so nothing was priced." },
          coins,
          totals_usd: {
            in: round(pricedCoins.reduce((s, c) => s + (c.usd?.in ?? 0), 0)),
            out: round(pricedCoins.reduce((s, c) => s + (c.usd?.out ?? 0), 0)),
            net: round(pricedCoins.reduce((s, c) => s + (c.usd?.net ?? 0), 0)),
            priced_coins: pricedCoins.length,
            unpriced_coins: coins.length - pricedCoins.length,
          },
          gas: {
            paid_sui: v.human(sui, summary.gasPaid),
            transactions: summary.gasTransactions,
            ...(summary.gasUnread ? { transactions_gas_unread: summary.gasUnread } : {}),
            note: "Net gas this address paid as gas payer (computation + storage - rebate). It is excluded from the SUI totals above.",
          },
          inflow_sources: sources.map((s, i) => counterpartyRow(s, i < topN)),
          unattributed_inflows: unattributedRows(summary.unattributedIn),
          recipient_count: recipients.length,
          top_recipients: recipients.slice(0, topN).map((s) => counterpartyRow(s, true)),
          ...(recipients.length > topN
            ? {
                other_recipients: {
                  count: recipients.length - topN,
                  usd: round(recipients.slice(topN).reduce((s, r) => s + (r.usd ?? 0), 0)),
                },
              }
            : {}),
          unattributed_outflows: unattributedRows(summary.unattributedOut),
          unattributed_meaning:
            "Value that arrived or left without another address's balance moving the other way: swap proceeds and inputs, protocol deposits and withdrawals, exploits, mints, burns and bridge exits. The digests say which.",
          gas_sponsorship: {
            sponsored_by: sponsoredBy.map((s, i) => ({
              ...who(s.address, i < topN ? identities.get(s.address) : undefined),
              transactions: s.digests.length,
              ...digestList(s.digests),
            })),
            sponsored: sponsored.map((s) => ({ address: s.address, transactions: s.digests.length, ...digestList(s.digests) })),
          },
          bridge_exits: {
            transaction_count: exits.length,
            scope: "Transactions this address sent that carry a bridge marker, read from their events.",
            evidence: EVIDENCE_TIER_MEANING["chain-derived"],
            by_bridge: bridgeGroups.map((g) => ({
              bridge: g.bridge,
              transactions: g.digests.length,
              sent: v.amounts(g.sent),
              destinations: g.destinations.map((d) => ({
                chain: d.beneficiary.chain,
                chain_label: d.beneficiary.chain_label,
                address: d.beneficiary.address,
                account: d.beneficiary.account,
                protocol: d.beneficiary.protocol,
                transactions: d.digests.length,
                sent: v.amounts(d.sent),
                ...(d.sharedDigests.length
                  ? {
                      shared_transactions: d.sharedDigests,
                      shared_note: "These transactions paid more than one destination, so their value is in the bridge total and not split here.",
                    }
                  : {}),
                ...digestList(d.digests),
              })),
              ...(g.unresolvedDigests.length ? { no_recipient_read: g.unresolvedDigests } : {}),
            })),
            transactions: exits.map((e) => ({
              digest: e.digest,
              timestamp: e.timestamp,
              bridge: e.bridge,
              protocols: e.protocols,
              sent: v.amounts(e.sent),
              beneficiaries: e.beneficiaries,
              ...(e.unresolvedVaas.length ? { unresolved_vaas: e.unresolvedVaas } : {}),
              ...(e.eventsIncomplete ? { events_incomplete: true } : {}),
              ...(e.beneficiaries.length === 0
                ? { next_step: e.hits.find((h) => h.resolution === "identifier") ? "resolve_bridge_transfer" : e.hits[0]?.note }
                : {}),
            })),
            ...(unresolvedVaas.length
              ? {
                  next_step: `resolve_bridge_transfer on the transactions listed with unresolved_vaas asks Wormholescan where ${unresolvedVaas.length} Wormhole message(s) were redeemed (indexer-attested).`,
                }
              : {}),
          },
          ...(inbound.length ? { bridge_entries: inbound } : {}),
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
