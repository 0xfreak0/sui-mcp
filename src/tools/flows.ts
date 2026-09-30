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
import { CROSS_CHAIN_LEAD_MEANING, crossChainLeads } from "../utils/bridge/cross-chain.js";
import { EVIDENCE_TIER_MEANING, type SuiEventNode } from "../utils/bridge/wormhole.js";
import { describeAddresses, fetchKinds, identityNote, type AddressIdentity } from "../utils/identity.js";
import { getLabel, labelProvenance } from "../utils/labels.js";
import { displayCoin, prefetchCoinScale, pricingScale, toHumanAmount } from "../utils/valuation.js";
import { WindowAmounts, windowPrices } from "../utils/window-prices.js";
import { coinKey } from "../utils/trace-hop.js";
import { ActivityLedger, lookalikeReport } from "../utils/address-lookalike.js";
import type { Appearance } from "../utils/address-lookalike.js";
import {
  destinationKey,
  roundUsd as round,
  entryCandidates,
  exitCandidates,
  leadCandidates,
  groupExits,
  readExit,
  summarizeFlows,
  type Counterparty,
  type ExitRecord,
  type FlowTx,
} from "../utils/address-flows.js";
import { capPayload, type ListCap } from "../utils/output-cap.js";
import { readMovedObjects, SCAN_OBJECT_BUDGET, valueTransactionObjects } from "../utils/moved-value.js";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { depositRole } from "../utils/deposit-role.js";

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
        status
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
    status?: string | null;
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
/**
 * Transactions read for the objects they moved, newest successful ones
 * first. Each 25 cost one request, plus the reads that value what moved.
 */
const MAX_OBJECT_TXS = 300;

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
    status: n.effects?.status ? n.effects.status.toLowerCase() : null,
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
    deposit_address: depositRole(address),
    ...(identity?.protocol ? { protocol: identity.protocol } : {}),
    ...(note ? { note } : {}),
  };
}

export function registerFlowTools(server: McpServer) {
  server.tool(
    "summarize_address_flows",
    "(Incident investigation) Summarize an address's coin and object inflows, outflows, counterparties, gas sponsorship and bridge exits over a window. Coin USD uses hourly historical quotes; check usd_basis for coarsening and coverage. Scans newest first: check coverage.complete and follow coverage.continue_with when capped. address_poisoning and cross_chain_leads cover only scanned activity, not clearance.",
    {
      address: addressArg().describe("Address to summarise (0x... or a SuiNS name)."),
      from: timePointArg()
        .optional()
        .describe("Window start as ISO 8601 time or checkpoint. Omit to scan the whole history, subject to the scan budget."),
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
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe(
          "'summary' (default) keeps ~20k chars of counterparties, coins and unattributed rows by value, retaining all labelled, non-wallet and lookalike addresses. Totals/counts cover all rows; omitted reports the rest. 'full': every row.",
        ),
    },
    async ({ address, from, to, coin_type, max_transactions, top, detail }) => {
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

        // Address poisoning across the whole scan, not per counterparty row:
        // a lookalike is dust the subject received, or a payment it sent, and
        // either shape must land beside the address it imitates for the
        // comparison to see them together. Oldest first, so a counterparty
        // the subject has dealt with longer keeps the larger footprint here
        // when the transaction-count margin cannot separate them outright.
        const ledger = new ActivityLedger();
        for (const tx of [...txs].reverse()) {
          const appearances: Appearance[] = tx.sender ? [{ address: tx.sender }] : [];
          for (const c of tx.changes) appearances.push({ address: c.owner, amount: c.amount });
          ledger.observe(appearances);
        }
        const poisoning = lookalikeReport(ledger.addressesLedBy(address), ledger.activity, address);

        const summary = summarizeFlows(address, txs, coin_type ?? null);

        // Bridge transactions get their event JSON read; everything else was
        // settled by the scan.
        const qualify = getNetwork() === "mainnet";
        const candidates = exitCandidates(address, txs);
        const entries = entryCandidates(txs);
        const leadTxs = leadCandidates(address, txs, summary, candidates);
        const events = await readEvents([...new Set([...candidates, ...entries, ...leadTxs.txs].map((t) => t.digest))]);
        const leads = leadTxs.txs.flatMap((tx) =>
          crossChainLeads(events.get(tx.digest) ?? []).map((l) => ({ digest: tx.digest, timestamp: tx.timestamp, ...l })),
        );
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

        const timed = txs.map((tx) => ({
          tx,
          at: tx.timestamp ? Date.parse(tx.timestamp) / 1000 : null,
          summary: summarizeFlows(address, [tx], coin_type ?? null),
        }));
        const coinSet = new Set<string>(summary.coins.keys());
        for (const e of exits) for (const c of [...e.sent.keys(), ...e.retained.keys()]) coinSet.add(c);
        const sui = coinKey("0x2::sui::SUI");
        coinSet.add(sui);
        // Valued objects (staked SUI, LP positions, lending caps, vault
        // receipts, NFT estimates) that entered or left the address, each
        // read and valued at its transaction's checkpoint and time.
        // A coin filter narrows the summary to coins only.
        const subject = normalizeSuiAddress(address);
        const objectCandidates = coin_type
          ? []
          : // Any successful transaction that affected the address: a Move call
            // in a transaction someone else signed can hand it an object with
            // no TransferObjects command at all.
            txs.filter((t) => t.status === "success").map((t) => t.digest);
        const objectRead = objectCandidates.slice(0, MAX_OBJECT_TXS);
        const [prices, , objectValues] = await Promise.all([
          windowPrices(timed.map(({ at, summary: s, tx }) => ({
            at, coins: new Set([...s.coins.keys(), ...exits.filter((e) => e.digest === tx.digest).flatMap((e) => [...e.sent.keys(), ...e.retained.keys()])]),
          }))),
          prefetchCoinScale(coinSet),
          // Specific readers only: an NFT estimate stays out of the totals,
          // and its market reads cost far more per object than the rest.
          readMovedObjects(objectRead, true).then(async (r) => ({
            ...(await valueTransactionObjects(
              // An object whose previous holder went unrecorded is kept until
              // that holder is read, since it may have left this address.
              r.txs.map((t) => ({ ...t, moved: t.moved.filter((m) => m.from === subject || m.to === subject || m.prior_version) })),
              { maxTxs: MAX_OBJECT_TXS, maxObjects: SCAN_OBJECT_BUDGET },
            )),
            unreadTxs: r.unread,
          })),
        ]);
        const scales = new Map<string, number>();
        const human = (coin: string, raw: bigint) =>
          (raw < 0n ? -1 : 1) * toHumanAmount(raw, scales.get(coin) ?? pricingScale(coin).decimals);
        const incoming = new WindowAmounts(prices);
        const outgoing = new WindowAmounts(prices);
        const valued = new Map<Map<string, bigint>, WindowAmounts>();
        const add = (target: Map<string, bigint>, amounts: Map<string, bigint>, at: number | null) => {
          const value = valued.get(target) ?? new WindowAmounts(prices);
          value.addMap(amounts, at);
          valued.set(target, value);
        };
        for (const { at, summary: s } of timed) {
          for (const [coin, flow] of s.coins) {
            const point = prices.point(coin, at);
            if (point && !scales.has(coin)) scales.set(coin, pricingScale(coin, point).decimals);
            if (flow.in) incoming.add(coin, flow.in, at);
            if (flow.out) outgoing.add(coin, flow.out, at);
          }
          for (const direction of ["sources", "recipients"] as const) for (const [addr, c] of s[direction]) {
            add(summary[direction].get(addr)!.coins, c.coins, at);
          }
        }
        const amounts = (m: Map<string, bigint>) => valued.get(m)?.amounts() ??
          [...m].map(([coin, raw]) => ({ coin_type: coin, symbol: displayCoin(coin).symbol, amount: human(coin, raw), usd: null }));
        const txTime = new Map(txs.map((t) => [t.digest, t.timestamp]));
        // A kept object the transaction changed counts its signed change,
        // in or out by its sign, with no counterparty. An object wrapped,
        // unwrapped or from a holder that could not be read is listed as
        // "custody" and not counted: the address holds it in another form.
        const objectRows = objectValues.rows.filter((r) => r.from === subject || r.to === subject).map((r) => {
          const inbound = r.changed_in_place ? (r.usd ?? 0) >= 0 : r.to === subject;
          return {
            digest: r.digest,
            timestamp: txTime.get(r.digest) ?? null,
            direction: r.custody ? ("custody" as const) : inbound ? ("in" as const) : ("out" as const),
            ...(r.custody ? { custody: r.custody } : {}),
            counterparty: r.changed_in_place ? null : inbound ? r.from : r.to,
            ...(r.changed_in_place ? { changed_in_place: true } : {}),
            object_id: r.object_id,
            object_type: r.type,
            kind: r.kind,
            protocol: r.protocol,
            usd: r.usd === null ? null : Math.abs(r.usd),
            tier: r.tier,
            ...(r.estimate ? { estimate: true } : {}),
            method: r.method,
            ...(r.unpriced_reason ? { unpriced_reason: r.unpriced_reason } : {}),
          };
        });
        // Objects count with the counterparty they came from or went to, as
        // coins do; one created or deleted has no counterparty.
        const objectUsdBy = (dir: "in" | "out") => {
          const m = new Map<string, { usd: number; rows: typeof objectRows }>();
          for (const r of objectRows) {
            if (r.direction !== dir || !r.counterparty) continue;
            const e = m.get(r.counterparty) ?? { usd: 0, rows: [] };
            if (r.usd !== null && !r.estimate) e.usd += r.usd;
            e.rows.push(r);
            m.set(r.counterparty, e);
          }
          return m;
        };
        const objectsFrom = objectUsdBy("in");
        const objectsTo = objectUsdBy("out");
        const addObjectCounterparties = (m: Map<string, Counterparty>, by: typeof objectsFrom) => {
          for (const [address, e] of by) {
            const c = m.get(address) ?? { address, coins: new Map<string, bigint>(), digests: [], firstAt: null, lastAt: null };
            for (const r of e.rows) {
              if (!c.digests.includes(r.digest)) c.digests.push(r.digest);
              if (r.timestamp && (!c.firstAt || r.timestamp < c.firstAt)) c.firstAt = r.timestamp;
              if (r.timestamp && (!c.lastAt || r.timestamp > c.lastAt)) c.lastAt = r.timestamp;
            }
            m.set(address, c);
          }
        };
        addObjectCounterparties(summary.sources, objectsFrom);
        addObjectCounterparties(summary.recipients, objectsTo);
        const objectTotal = (dir: "in" | "out") =>
          objectRows.filter((r) => r.direction === dir && r.usd !== null && !r.estimate).reduce((s, r) => s + r.usd!, 0);
        const objectsIn = objectTotal("in");
        const objectsOut = objectTotal("out");
        // Objects the totals leave out: older candidates not read,
        // transactions or objects that could not be read, and objects past
        // the scan's budget.
        const objectsPartial =
          objectCandidates.length > objectRead.length || objectValues.unreadTxs.length > 0 || objectValues.unread.length > 0 || objectValues.skipped.length > 0;

        const rank = (m: Map<string, Counterparty>, objects: typeof objectsFrom) =>
          [...m.values()]
            .map((c) => {
              const coinUsd = valued.get(c.coins)?.totalUsd() ?? null;
              const o = objects.get(c.address);
              return { c, usd: o ? (coinUsd ?? 0) + o.usd : coinUsd, objects: o?.rows };
            })
            .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.c.digests.length - a.c.digests.length);
        const sources = rank(summary.sources, objectsFrom);
        const recipients = rank(summary.recipients, objectsTo);
        const sponsoredBy = [...summary.sponsoredBy.values()].sort((a, b) => b.digests.length - a.digests.length);
        const sponsored = [...summary.sponsored.values()].sort((a, b) => b.digests.length - a.digests.length);

        const identified = [
          ...sources.slice(0, topN).map((s) => s.c.address),
          ...recipients.slice(0, topN).map((s) => s.c.address),
          ...sponsoredBy.slice(0, topN).map((s) => s.address),
        ];
        // Every other counterparty is classified too, so a package or object
        // ranked below `top` is flagged and survives the cap. An address whose
        // read failed carries kind_unread and is kept as well.
        const shown = new Set(identified);
        const rest = [
          ...new Set([...sources.map((s) => s.c.address), ...recipients.map((s) => s.c.address), ...sponsoredBy.map((s) => s.address)]),
        ].filter((a) => !shown.has(a));
        const [identities, kinds] = await Promise.all([describeAddresses(identified), fetchKinds(rest)]);
        const kindOf = (addr: string) => {
          if (shown.has(addr)) return {};
          const k = kinds.get(addr);
          if (!k) return { kind_unread: true };
          return k.kind === "wallet" ? {} : { kind: k.kind, ...(k.type ? { object_type: k.type } : {}) };
        };

        const counterpartyRow = ({ c, usd, objects }: { c: Counterparty; usd: number | null; objects?: typeof objectRows }, identify: boolean) => ({
          ...who(c.address, identify ? identities.get(c.address) : undefined),
          ...(identify ? {} : kindOf(c.address)),
          usd: usd === null ? null : round(usd),
          coins: amounts(c.coins),
          ...(objects?.length
            ? { objects: objects.map((r) => ({ object_id: r.object_id, kind: r.kind, protocol: r.protocol, usd: r.usd, ...(r.estimate ? { estimate: true } : {}) })) }
            : {}),
          transactions: c.digests.length,
          first_at: c.firstAt,
          last_at: c.lastAt,
          ...digestList(c.digests),
        });

        const coins = [...summary.coins.values()]
          .map((f) => {
            const d = displayCoin(f.coinType);
            const inUsd = incoming.usd(f.coinType);
            const outUsd = outgoing.usd(f.coinType);
            const net = f.in - f.out;
            return {
              coin_type: f.coinType,
              symbol: d.symbol,
              coin_verified: d.verified,
              in: human(f.coinType, f.in),
              out: human(f.coinType, f.out),
              net: human(f.coinType, net),
              raw: { in: f.in.toString(), out: f.out.toString(), net: net.toString() },
              transactions_in: f.txIn,
              transactions_out: f.txOut,
              usd: inUsd === null && outUsd === null ? null : {
                in: round(inUsd ?? 0), out: round(outUsd ?? 0), net: round((inUsd ?? 0) - (outUsd ?? 0)),
              },
              ...(incoming.values.get(f.coinType)?.unpricedIn || outgoing.values.get(f.coinType)?.unpricedIn ? {
                priced_raw: { in: incoming.values.get(f.coinType)?.pricedIn.toString() ?? "0", out: outgoing.values.get(f.coinType)?.pricedIn.toString() ?? "0" },
                unpriced_raw: { in: incoming.values.get(f.coinType)?.unpricedIn.toString() ?? "0", out: outgoing.values.get(f.coinType)?.unpricedIn.toString() ?? "0" },
              } : {}),
              ...(incoming.values.get(f.coinType)?.staleIn || outgoing.values.get(f.coinType)?.staleIn ? {
                stale_priced_raw: { in: incoming.values.get(f.coinType)?.staleIn.toString() ?? "0", out: outgoing.values.get(f.coinType)?.staleIn.toString() ?? "0" },
              } : {}),
            };
          })
          .sort((a, b) => Math.abs(b.usd?.net ?? 0) - Math.abs(a.usd?.net ?? 0) || b.transactions_in + b.transactions_out - (a.transactions_in + a.transactions_out));
        const pricedCoins = coins.filter((c) => c.usd !== null);

        const unattributedRows = (m: typeof summary.unattributedIn) =>
          [...m.values()]
            .map((u) => {
              const legs = new WindowAmounts(prices);
              for (const { at, summary: s } of timed) {
                const row = (m === summary.unattributedIn ? s.unattributedIn : s.unattributedOut).get(u.coinType);
                if (row) legs.add(u.coinType, row.amount, at);
              }
              const usd = legs.usd(u.coinType);
              return {
                symbol: displayCoin(u.coinType).symbol,
                coin_type: u.coinType,
                amount: human(u.coinType, u.amount),
                usd: usd === null ? null : round(usd),
                ...legs.coverage(u.coinType),
                transactions: u.digests.length,
                ...digestList(u.digests),
              };
            })
            .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

        const oldest = txs.at(-1);
        const newest = txs[0];
        const point = (t: FlowTx | undefined) => (t ? { checkpoint: t.checkpoint, timestamp: t.timestamp, digest: t.digest } : null);
        const bridgeGroups = groupExits(exits);
        for (const e of exits) {
          const at = e.timestamp ? Date.parse(e.timestamp) / 1000 : null;
          add(e.sent, e.sent, at);
          add(e.retained, e.retained, at);
          const group = bridgeGroups.find((g) => g.bridge === e.bridge)!;
          add(group.sent, e.sent, at);
          add(group.retained, e.retained, at);
          const keys = [...new Set(e.beneficiaries.map(destinationKey))];
          if (keys.length === 1) add(group.destinations.find((d) => d.key === keys[0])!.sent, e.sent, at);
        }
        const unresolvedVaas = exits.flatMap((e) => e.unresolvedVaas);
        // An exit's beneficiary drops what the output already says once: its
        // evidence tier (bridge_exits.evidence), an account that is
        // chain:address, raw bytes that are the address zero-padded, its
        // amount note, named per source in amount_notes, the Wormhole chain
        // id its CAIP-2 `chain` names, and the chain label and protocol its
        // destination row in by_bridge states.
        const amountNotes: Record<string, string> = {};
        const destinationRows = new Map(
          bridgeGroups.flatMap((g) => g.destinations.map((d) => [`${g.bridge}|${d.key}`, d.beneficiary] as const)),
        );
        const exitBeneficiaries = exits.map((e) =>
          e.beneficiaries.map((full) => {
            const { evidence: _tier, amount_note, address_raw, account, wormhole_chain_id, chain_label, protocol, ...b } = full;
            if (amount_note) amountNotes[b.source] = amount_note;
            const padded = b.address?.startsWith("0x") ? `0x${b.address.slice(2).toLowerCase().padStart(64, "0")}` : null;
            const row = destinationRows.get(`${e.bridge}|${destinationKey(full)}`);
            return {
              ...(row?.protocol === protocol ? {} : { protocol }),
              ...b,
              ...(row?.chain_label === chain_label ? {} : { chain_label }),
              ...(wormhole_chain_id !== undefined && !b.chain ? { wormhole_chain_id } : {}),
              ...(address_raw !== padded ? { address_raw } : {}),
              ...(account && account !== `${b.chain}:${b.address}` ? { account } : {}),
            };
          }),
        );

        const payload = {
          address,
          window: describeWindow(from, to, window),
          deposit_address: depositRole(address, { from, to, resolved: window }),
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
          address_poisoning: poisoning,
          usd_basis: prices.basis,
          coins,
          totals_usd: {
            approximate: true,
            partial: prices.basis.partial || objectsPartial,
            ...(objectsPartial ? { objects_partial: true } : {}),
            in: round(pricedCoins.reduce((s, c) => s + (c.usd?.in ?? 0), 0) + objectsIn),
            out: round(pricedCoins.reduce((s, c) => s + (c.usd?.out ?? 0), 0) + objectsOut),
            net: round(pricedCoins.reduce((s, c) => s + (c.usd?.net ?? 0), 0) + objectsIn - objectsOut),
            priced_coins: pricedCoins.length,
            unpriced_coins: coins.length - pricedCoins.length,
            ...(objectRows.length
              ? {
                  objects_in: round(objectsIn),
                  objects_out: round(objectsOut),
                  priced_objects: objectRows.filter((r) => r.direction !== "custody" && r.usd !== null && !r.estimate).length,
                  unpriced_objects: objectRows.filter((r) => r.direction !== "custody" && r.usd === null).length,
                }
              : {}),
          },
          ...(objectRows.length || objectValues.unread.length || objectValues.unreadTxs.length || objectValues.skipped.length || objectCandidates.length > objectRead.length
            ? {
                objects: objectRows,
                ...(objectValues.unread.length ? { objects_unread: objectValues.unread } : {}),
                ...(objectValues.unreadTxs.length ? { objects_transactions_unread: objectValues.unreadTxs } : {}),
                ...(objectValues.skipped.length ? { objects_skipped_transactions: objectValues.skipped } : {}),
                objects_scope:
                  `Non-coin objects a reader values (staked SUI, LP positions, lending caps, vault receipts; NFTs are not valued here) that entered ("in") or left ("out") this address, or that it kept while a transaction raised ("in") or lowered ("out") their value (changed_in_place, usd the size of the change), in the ${objectRead.length} newest successful transaction(s) of the scan` +
                  (objectCandidates.length > objectRead.length ? `; ${objectCandidates.length - objectRead.length} older such transaction(s) were not read` : "") +
                  (objectValues.skipped.length
                    ? `; the objects of ${objectValues.skipped.length} older transaction(s) past the first ${SCAN_OBJECT_BUDGET} objects were not valued (objects_skipped_transactions), so totals_usd leaves them out (objects_partial); narrow the window to value them`
                    : "") +
                  `. Each is read and valued at its transaction's checkpoint and time; each row states its method. totals_usd counts them, estimates (tier heuristic, NFTs) and "custody" rows (wrapped into or unwrapped from another object, or from a holder that could not be read) excepted, and inflow_sources and top_recipients rank counterparties with them. totals_usd.objects_partial says objects were left out: older transactions not read (above), objects_transactions_unread, objects_unread or objects_skipped_transactions.`,
              }
            : {}),
          gas: {
            paid_sui: human(sui, summary.gasPaid),
            transactions: summary.gasTransactions,
            ...(summary.gasUnread ? { transactions_gas_unread: summary.gasUnread } : {}),
            note: "Net gas this address paid as gas payer (computation + storage - rebate). It is excluded from the SUI totals above.",
          },
          inflow_source_count: sources.length,
          inflow_sources: sources.map((s, i) => counterpartyRow(s, i < topN)),
          unattributed_inflows: unattributedRows(summary.unattributedIn),
          recipient_count: recipients.length,
          top_recipients: recipients.map((s, i) => counterpartyRow(s, i < topN)),
          unattributed_outflows: unattributedRows(summary.unattributedOut),
          unattributed_meaning:
            "Value that arrived or left without another address's balance moving the other way: swap proceeds and inputs, protocol deposits and withdrawals, exploits, mints, burns and bridge exits. The digests say which.",
          gas_sponsorship: {
            sponsored_by: sponsoredBy.map((s, i) => ({
              ...who(s.address, i < topN ? identities.get(s.address) : undefined),
              ...(i < topN ? {} : kindOf(s.address)),
              transactions: s.digests.length,
              ...digestList(s.digests),
            })),
            sponsored: sponsored.map((s) => ({ address: s.address, transactions: s.digests.length, ...digestList(s.digests) })),
          },
          bridge_exits: {
            transaction_count: exits.length,
            scope:
              `Transactions this address sent that carry a bridge marker, read from their events. ${leadTxs.txs.length} other ` +
              "transaction(s) it sent in which value left with no address receiving it were read for the shape of a cross-chain " +
              "message from a bridge with no marker here (cross_chain_leads)" +
              (leadTxs.skipped ? `; ${leadTxs.skipped} more such transaction(s) were not read.` : "."),
            evidence: EVIDENCE_TIER_MEANING["chain-derived"],
            sent_meaning:
              "What actually crossed the bridge: the subject's own outflow minus whatever another Sui address was credited in the same coin in the same transaction (a bridge fee, a relayer payment, a referrer cut). Those legs are reported separately, in retained_on_sui, wherever they are non-zero.",
            ...(Object.keys(amountNotes).length ? { amount_notes: amountNotes } : {}),
            by_bridge: bridgeGroups.map((g) => ({
              bridge: g.bridge,
              transactions: g.digests.length,
              sent: amounts(g.sent),
              ...(g.retained.size ? { retained_on_sui: amounts(g.retained) } : {}),
              destinations: g.destinations.map((d) => ({
                chain: d.beneficiary.chain,
                chain_label: d.beneficiary.chain_label,
                address: d.beneficiary.address,
                account: d.beneficiary.account,
                protocol: d.beneficiary.protocol,
                transactions: d.digests.length,
                sent: amounts(d.sent),
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
            transactions: exits.map((e, i) => ({
              digest: e.digest,
              timestamp: e.timestamp,
              bridge: e.bridge,
              // Named only when the transaction used more than its bridge.
              ...(e.protocols.length === 1 && e.protocols[0] === e.bridge ? {} : { protocols: e.protocols }),
              sent: amounts(e.sent),
              ...(e.retained.size ? { retained_on_sui: amounts(e.retained) } : {}),
              beneficiaries: exitBeneficiaries[i],
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
          ...(leads.length ? { cross_chain_leads: leads, cross_chain_leads_meaning: CROSS_CHAIN_LEAD_MEANING } : {}),
        };

        // Every list is ranked above; the cap keeps the identified top rows,
        // flagged rows and whatever else fits, and states the rest.
        const topSources = new Set(sources.slice(0, topN).map((s) => s.c.address));
        const topRecipients = new Set(recipients.slice(0, topN).map((s) => s.c.address));
        const lookalikes = new Set(poisoning.pairs.flatMap((p) => [p.suspect, p.established]));
        type Row = { address: string; label?: string; kind?: string; kind_unread?: boolean; usd: number | null };
        type CoinRow = (typeof coins)[number];
        type Unattributed = { usd: number | null; transactions: number };
        type ObjRow = (typeof objectRows)[number];
        const flagged = (r: Row) => Boolean(r.label || r.kind || r.kind_unread) || lookalikes.has(r.address);
        // Priced rows worth $1 or more first, then unpriced rows, then priced
        // dust: an unpriced coin can be the loot, and $0.01 of a priced one
        // cannot.
        const tier = (usd: number | null) => (usd === null ? 1 : usd >= 1 ? 0 : 2);
        const coinUsd = (c: CoinRow) => (c.usd === null ? null : c.usd.in + c.usd.out);
        const coinTx = (c: CoinRow) => c.transactions_in + c.transactions_out;
        const brief = (r: Row & { transactions?: number }) => ({ address: r.address, usd: r.usd, transactions: r.transactions });
        const args = { address, from, to, coin_type, max_transactions, top };
        const { payload: out } = capPayload(
          "summarize_address_flows",
          args,
          payload,
          {
            "usd_basis.missing_coin_samples": { budget: 2_000, keepOrder: true },
            "usd_basis.stale_quotes": { budget: 2_000, keepOrder: true },
            "bridge_exits.transactions": {
              budget: 8_000,
              keepOrder: true,
              usd: (row) => row.sent.some((coin) => coin.usd !== null) ? row.sent.reduce((sum, coin) => sum + (coin.usd ?? 0), 0) : null,
              brief: (row) => ({ digest: row.digest, bridge: row.bridge }),
            } satisfies ListCap<(typeof payload.bridge_exits.transactions)[number]>,
            inflow_sources: {
              budget: 8_000,
              keep: (r: Row) => flagged(r) || topSources.has(r.address),
              usd: (r: Row) => r.usd,
              brief,
            } satisfies ListCap<Row>,
            top_recipients: {
              budget: Infinity,
              limit: 0,
              keep: (r: Row) => flagged(r) || topRecipients.has(r.address),
              usd: (r: Row) => r.usd,
              brief,
            } satisfies ListCap<Row>,
            coins: {
              budget: 5_000,
              keepOrder: true,
              keep: (c: CoinRow) => c.coin_type === sui || c.coin_verified === true || (coinUsd(c) ?? 0) >= 1,
              rank: (a: CoinRow, b: CoinRow) => tier(coinUsd(a)) - tier(coinUsd(b)) || coinTx(b) - coinTx(a),
              usd: coinUsd,
              brief: (c: CoinRow) => ({ coin_type: c.coin_type, symbol: c.symbol, in: c.in, out: c.out, transactions: coinTx(c) }),
            } satisfies ListCap<CoinRow>,
            unattributed_inflows: {
              budget: 2_500,
              keepOrder: true,
              rank: (a: Unattributed, b: Unattributed) => tier(a.usd) - tier(b.usd) || (b.usd ?? 0) - (a.usd ?? 0) || b.transactions - a.transactions,
              usd: (u: Unattributed) => u.usd,
            } satisfies ListCap<Unattributed>,
            unattributed_outflows: {
              budget: 2_500,
              keepOrder: true,
              rank: (a: Unattributed, b: Unattributed) => tier(a.usd) - tier(b.usd) || (b.usd ?? 0) - (a.usd ?? 0) || b.transactions - a.transactions,
              usd: (u: Unattributed) => u.usd,
            } satisfies ListCap<Unattributed>,
            "gas_sponsorship.sponsored_by": { budget: 1_500, keep: (r: Row) => Boolean(r.label || r.kind || r.kind_unread) },
            "gas_sponsorship.sponsored": { budget: 1_500 },
            objects_skipped_transactions: { budget: 1_000, keepOrder: true },
            objects_unread: { budget: 2_000, keepOrder: true, brief: (u: { what: string }) => u.what } satisfies ListCap<{ what: string }>,
            objects: {
              budget: 5_000,
              usd: (r: ObjRow) => (r.usd === null ? null : Math.abs(r.usd)),
              brief: (r: ObjRow) => ({ digest: r.digest, direction: r.direction, object_id: r.object_id, usd: r.usd }),
            } satisfies ListCap<ObjRow>,
          },
          { full: detail === "full", next_call: { tool: "summarize_address_flows", repeat_with: { detail: "full" } } },
        );

        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
