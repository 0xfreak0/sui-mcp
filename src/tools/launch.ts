import { z } from "zod";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { gqlQuery } from "../clients/graphql.js";
import { coinTypeArg, numArg } from "./args.js";
import { resolveWindow } from "../utils/checkpoint-time.js";
import { BALANCE_CHANGES_SELECTION, completeTxConnections, type GqlConnection } from "../utils/tx-connections.js";
import type { GqlBalanceChangeNode } from "../utils/gql-adapters.js";
import { lookupProtocol } from "../protocols/registry.js";
import { getLabel } from "../utils/labels.js";
import { classifyDepositAddress } from "../utils/deposit.js";
import { Budget, DEFAULT_POPULARITY_LIMIT, firstFunderOf, probeRecipients } from "../utils/edge-probe.js";
import { assessCoFunding } from "../utils/co-funding.js";
import { findSubjectPayments } from "../utils/subject-payments.js";
import { isSponsorGasChange } from "../utils/sponsor-gas.js";
import { clearsDustFloor } from "../utils/funding.js";
import { coinScale, prefetchCoinScale } from "../utils/valuation.js";
import { capPayload, pageAt } from "../utils/output-cap.js";
import { errorResult } from "../utils/errors.js";
import { readLaunchEvents, readLaunchHistory, readEarlyLaunchHistory, readLaunchOrigin, matchBuy, type LaunchTx, type LaunchScan } from "../utils/launch-read.js";
import { separateRebuys, sumRaw, decimalAmount, isSuiPumpReferralFee, reconcileLaunchWindow } from "../utils/launch-accounting.js";
import { fetchEventJson } from "../utils/event-json.js";
import { scoreLaunch, type LaunchBuyer, type LaunchDestination, type LaunchFunding, type LaunchPayment, type LaunchTransfer } from "../utils/launch-scoring.js";

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const MIST = 1_000_000_000n;
const DESTINATION_MIN_SUI = 100n * MIST;
const DESTINATION_MIN_TOKENS = 1_000_000n;
const FUNDING_RECIPIENTS = `query($digest:String!){transaction(digest:$digest){effects{balanceChanges(first:50){nodes{coinType{repr} amount owner{address}}pageInfo{hasNextPage}}}}}`;
const AFFILIATION_QUERY = `query($creator:SuiAddress!,$destination:SuiAddress!,$afterCp:UInt53!,$beforeCp:UInt53!,$after:String){transactions(filter:{sentAddress:$creator,affectedAddress:$destination,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},first:50,after:$after){nodes{digest effects{timestamp ${BALANCE_CHANGES_SELECTION}}}pageInfo{hasNextPage endCursor}}}`;
const KIND_QUERY = `query($id:SuiAddress!){object(address:$id){__typename asMovePackage{address} asMoveObject{contents{type{repr}}}}}`;
const DATA_PAGES = 20;

interface RecipientRead { transaction: { effects: { balanceChanges: { nodes: Array<{ coinType?: { repr: string }; amount: string; owner?: { address: string } }>; pageInfo: { hasNextPage: boolean } } } } | null }
interface AffiliationRead { transactions: { nodes: Array<{ digest: string; effects: { timestamp: string; balanceChanges: GqlConnection<GqlBalanceChangeNode> } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
interface KindRead { object: { __typename: string; asMovePackage?: unknown; asMoveObject?: unknown } | null }
interface BuyerLedger { address: string; first_buy_at: string; buys: ReturnType<typeof matchBuy>[]; first_funding_ever: Awaited<ReturnType<typeof firstFunderOf>>; launch_funding: LaunchFunding[]; launch_topup_present: boolean; transfers: LaunchTransfer[]; payments: LaunchPayment[]; referrals: string[]; history: LaunchTx[]; complete: boolean; history_reads: number; history_next_cursor: string | null; reconciliation_notes: string[] }

function namedKind(result: KindRead | null): LaunchDestination["kind"] {
 if (!result) return "other";
 if (result.object?.asMovePackage) return "package";
 if (result.object?.asMoveObject) return result.object.__typename === "Shared" ? "shared" : "object";
 return "wallet";
}
async function paymentCount(digest: string, cache: Map<string, number | null>): Promise<number | null> {
 if (cache.has(digest)) return cache.get(digest)!;
 try {
  const response = await gqlQuery<RecipientRead>(FUNDING_RECIPIENTS, { digest });
  const changes = response.transaction?.effects.balanceChanges;
  const count = changes && !changes.pageInfo.hasNextPage ? new Set(changes.nodes.filter(c => c.amount && BigInt(c.amount) > 0n && c.owner?.address).map(c => c.owner!.address)).size : null;
  cache.set(digest, count); return count;
 } catch { cache.set(digest, null); return null; }
}
async function creatorPayments(creator: string, destination: string, fromCheckpoint: number, toCheckpoint: number, coin: string): Promise<{ payments: LaunchPayment[]; complete: boolean; reads: number }> {
 const payments: LaunchPayment[] = [];
 let cursor: string | undefined;
 let complete = false;
 let balancesComplete = true;
 let reads = 0;
 for (; reads < DATA_PAGES; reads++) {
  const page = (await gqlQuery<AffiliationRead>(AFFILIATION_QUERY, { creator, destination, afterCp: fromCheckpoint, beforeCp: toCheckpoint, after: cursor })).transactions;
  const changes = await completeTxConnections(page.nodes.map(node => ({ digest: node.digest, balanceChanges: node.effects.balanceChanges })));
  for (const [index, node] of page.nodes.entries()) {
   if (changes[index].balanceChangesTruncated) { balancesComplete = false; continue; }
   for (const change of changes[index].balanceChanges) {
    if (change.owner?.address !== destination || !change.amount || BigInt(change.amount) <= 0n) continue;
    const asset = change.coinType?.repr === coin ? "token" : change.coinType?.repr === SUI ? "sui" : null;
    if (asset) payments.push({ to: destination, asset, amount: BigInt(change.amount), digest: node.digest, timestamp: node.effects.timestamp });
   }
  }
  if (!page.pageInfo.hasNextPage) { complete = true; break; }
  if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) break;
  cursor = page.pageInfo.endCursor;
 }
 return { payments, complete: complete && balancesComplete, reads: reads + 1 };
}

function amountOf(tx: LaunchTx, owner: string, coin: string): bigint {
 return tx.changes.filter(c => c.address === owner && c.coin_type === coin).reduce((sum, c) => sum + c.amount, 0n);
}

function cetusSwap(tx: LaunchTx, pool: unknown): Record<string, unknown> | null {
 if (typeof pool !== "string") return null;
 return tx.events.find(event =>
  event.data.pool === pool && event.type.endsWith("::pool::SwapEvent")
  && lookupProtocol(event.type.split("::")[0])?.name === "Cetus"
 )?.data ?? null;
}

function saleOnCurve(tx: LaunchTx, curve: string): boolean {
 return tx.events.some(event => event.type.endsWith("::bonding_curve::TokensSold") && event.data.curve_id === curve);
}

function eventAmount(value: unknown): bigint | null {
 return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

export function registerLaunchTools(server: McpServer) {
 server.tool("analyze_launch", "(Incident investigation) Discover every buyer of a SuiPump coin in its first launch window, then trace each buyer's launch funding, buys, sales and forwards across a bounded sell window. Event amounts exclude gas; later buys are separate. Reports pairwise coordination leads and qualified destination affiliation with evidence tiers, never an account-holder or misconduct verdict. A partial scan reports coverage and a complete next_call. Start with only the exact coin type; creation_tx is an optional diagnostic cross-check.", {
  coin_type: coinTypeArg().describe("Exact SuiPump coin type, not a symbol"),
  creation_tx: z.string().optional().describe("Optional creation digest to cross-check discovery from coin type"),
  window_minutes: numArg().int().min(1).max(1440).optional().describe("Minutes from creation for initial buyer discovery (default 10)"),
  sell_window_days: numArg().int().min(1).max(30).optional().describe("Days from creation to trace every buyer's sales and forwards (default 7)"),
  max_pages: numArg().int().min(1).max(1000).optional().describe("Max pages per discovery and buyer history walk (default 20); raise via next_call when incomplete"),
  detail: z.enum(["summary", "full"]).optional().describe("Full returns all data if small, otherwise lists consecutive pages by list_path and offset"),
  list_path: z.string().optional().describe("List path named in omitted.next_call or a full-view catalog, for example discovered_buyers.0.sales"),
  offset: numArg().int().min(0).optional().describe("Index of the first row in list_path (default 0)"),
 }, async ({ coin_type, creation_tx, window_minutes, sell_window_days, max_pages, detail, list_path, offset }) => {
  try {
   const coin = normalizeStructTag(coin_type);
   const args = { coin_type: coin, creation_tx, window_minutes, sell_window_days, max_pages, detail, list_path, offset };
   const origin = await readLaunchOrigin(coin);
   if (creation_tx && creation_tx !== origin.creation_tx) return errorResult(`Creation digest does not match the curve's creation transaction ${origin.creation_tx}.`);
   if (origin.token.decimals == null) throw new Error("Coin metadata decimals are unavailable; raw event amounts cannot be displayed safely.");
   await prefetchCoinScale([coin]);
   const scale = coinScale(coin).decimals;
   const created = Date.parse(origin.created_at);
   const buyingTo = new Date(created + (window_minutes ?? 10) * 60_000).toISOString();
   const sellingTo = new Date(created + (sell_window_days ?? 7) * 86_400_000).toISOString();
   const fundingFrom = new Date(created - 2 * 60 * 60_000).toISOString();
   const directFrom = new Date(created - 7 * 86_400_000).toISOString();
   const directWindow = await resolveWindow(directFrom, sellingTo);
   const directAfter = directWindow.after?.checkpoint;
   const directBefore = directWindow.before?.checkpoint;
   if (directAfter == null || directBefore == null) throw new Error("Direct-payment window could not be bounded to checkpoints.");
   const affiliationTo = new Date(Math.min(created + 30 * 86_400_000, Math.max(Date.now() - 300_000, created + 60_000))).toISOString();
   const affiliationWindow = await resolveWindow(origin.created_at, affiliationTo);
   const affiliationEnd = affiliationWindow.before?.checkpoint;
   if (origin.created_checkpoint === null || affiliationEnd == null) throw new Error("Creator affiliation could not be bounded to checkpoints.");
   const pages = max_pages ?? DATA_PAGES;
   const discovery = await readLaunchEvents("buy", origin.created_at, buyingTo, origin.curve_id, pages);
   const buys = discovery.rows.filter(e => e.buyer !== origin.creator && e.digest !== origin.creation_tx);
   const grouped = new Map<string, typeof buys>();
   for (const event of buys) { const group = grouped.get(event.buyer) ?? []; group.push(event); grouped.set(event.buyer, group); }
   if (grouped.size > 50) throw new Error("Over 50 buyers in the initial window; narrow window_minutes before drawing a complete buyer set.");
   const recipientCounts = new Map<string, number | null>();
   const popularity = new Map<string, LaunchFunding["sourceStatus"]>();
   const budget = new Budget(250);
   const ledgers: BuyerLedger[] = [];
   for (const [buyer, initialEvents] of grouped) {
    const history = await readLaunchHistory(buyer, fundingFrom, sellingTo, pages);
    const indexed = new Map(history.rows.map(tx => [tx.digest, tx]));
    const buyerEvents = initialEvents.map(e => { const tx = indexed.get(e.digest); return tx ? matchBuy(e, tx, coin) : null; }).filter((x): x is NonNullable<typeof x> => x !== null);
    const first = initialEvents[0].timestamp;
    const funding: LaunchFunding[] = [];
    const transfers: LaunchTransfer[] = [];
    const payments: LaunchPayment[] = [];
    const referrals = initialEvents.flatMap(e => e.referral ? [e.referral] : []);
    for (const tx of history.rows) {
     const ownSui = tx.changes.filter(c => c.address === buyer && c.coin_type === SUI).reduce((s, c) => s + c.amount, 0n);
     if (Date.parse(tx.timestamp) <= Date.parse(first) && Date.parse(tx.timestamp) >= Date.parse(fundingFrom) && ownSui > 0n && tx.sender !== buyer) {
      const source = tx.changes.filter(c => c.address !== buyer && c.coin_type === SUI && c.amount < 0n).sort((a, b) => a.amount < b.amount ? -1 : 1)[0]?.address ?? tx.sender;
      if (source) {
       if (!popularity.has(source)) {
        const label = getLabel(source);
        const probe = label?.category === "cex" ? null : await probeRecipients(source, DEFAULT_POPULARITY_LIMIT, budget);
        popularity.set(source, label?.category === "cex" || probe?.popular ? "hub" : probe?.unmeasured ? "unmeasured" : probe?.complete ? "narrow" : "provisional");
       }
       const recipients = await paymentCount(tx.digest, recipientCounts);
       const strength = assessCoFunding(2, recipients).strength;
       funding.push({ source, amountMist: ownSui, digest: tx.digest, at: Date.parse(tx.timestamp), sourceStatus: popularity.get(source)!, transactionRecipientCount: recipients ?? undefined, transactionStrength: strength === "targeted" ? "targeted" : "other" });
      }
     }
     if (tx.sender !== buyer) continue;
     for (const changed of tx.changes) {
      if (changed.address === buyer || changed.amount <= 0n || (changed.coin_type !== SUI && changed.coin_type !== coin)) continue;
      if (isSponsorGasChange(changed.address, changed.coin_type, tx.sender ?? undefined, tx.sponsor ?? undefined)) continue;
      const spent = tx.changes.filter(c => c.address === buyer && c.coin_type === changed.coin_type).reduce((s, c) => s + c.amount, 0n);
      if (spent >= 0n) continue;
      const asset = changed.coin_type === SUI ? "sui" : "token";
      const amount = changed.amount < -spent ? changed.amount : -spent;
      if (!isSuiPumpReferralFee(tx.events, changed.address)
       && Date.parse(tx.timestamp) >= created && Date.parse(tx.timestamp) <= Date.parse(sellingTo))
       transfers.push({ destination: changed.address, asset, amount, digest: tx.digest, qualifies: clearsDustFloor(changed.coin_type, amount) === true });
     }
    }
    const firstFunding = await firstFunderOf(buyer, budget);
    ledgers.push({ address: buyer, first_buy_at: first, buys: buyerEvents, first_funding_ever: firstFunding, launch_funding: funding, launch_topup_present: funding.length > 0, transfers, payments, referrals, history: history.rows, complete: history.complete && buyerEvents.length === initialEvents.length, history_reads: history.reads, history_next_cursor: history.next_cursor, reconciliation_notes: buyerEvents.some(b => b.reconciliation_failed) ? ["Buy event and buyer balance change differ by more than 0.01 SUI; its amount is withheld from totals."] : [] });
   }
   const direct = await findSubjectPayments([...grouped.keys()], { window: { afterCheckpoint: directAfter, beforeCheckpoint: directBefore }, maxPairPages: pages });
   const eventByDigest = new Map<string, { type: string; data: Record<string, unknown> }[] | null>(
    ledgers.flatMap(ledger => ledger.history.map(tx => [tx.digest, tx.events] as const))
   );
   const missingEvents = [...new Set(direct.payments.map(payment => payment.digest))].filter(digest => !eventByDigest.has(digest));
   await Promise.all(missingEvents.map(async digest => {
    const events = await fetchEventJson(digest);
    eventByDigest.set(digest, events?.flatMap(event => event.type && event.json && typeof event.json === "object"
     ? [{ type: event.type, data: event.json as Record<string, unknown> }] : []) ?? null);
   }));
   for (const ledger of ledgers) {
    ledger.payments = direct.payments.filter(payment => payment.payer === ledger.address).flatMap(payment =>
     payment.received.flatMap(credit => {
      const asset = credit.coinType === SUI ? "sui" : credit.coinType === coin ? "token" : null;
      if (!asset) return [];
      const events = eventByDigest.get(payment.digest);
      if (!events) {
       direct.incomplete_pairs.push({ payer: payment.payer, payee: payment.payee });
       return [];
      }
      return [{
       to: payment.payee, asset, amount: BigInt(credit.amount), digest: payment.digest, timestamp: payment.timestamp ?? undefined,
       referral: isSuiPumpReferralFee(events, payment.payee)
      }];
     })
    );
   }
   const outgoing = new Map<string, LaunchTransfer[]>();
   for (const ledger of ledgers) for (const transfer of ledger.transfers) { const old = outgoing.get(transfer.destination) ?? []; old.push(transfer); outgoing.set(transfer.destination, old); }
   const destinations: Array<LaunchDestination & { deposit_verdict: string; sweeps: Array<{ digest: string }>; sweep_to: string | null; classification_complete: boolean; creator_payments: LaunchPayment[]; creator_payment_complete: boolean }> = [];
   for (const [dest, flows] of outgoing) {
    const tokens = sumRaw(flows.filter(x => x.asset === "token").map(x => x.amount));
    const sui = sumRaw(flows.filter(x => x.asset === "sui").map(x => x.amount));
    const tokenThreshold = DESTINATION_MIN_TOKENS * BigInt(10 ** scale);
    const buyersAtDestination = new Set(ledgers.filter(l => l.transfers.some(x => x.destination === dest)).map(l => l.address)).size;
    if (sui < DESTINATION_MIN_SUI && tokens < tokenThreshold && buyersAtDestination < 2) continue;
    const [kindRead, classification, creatorPay] = await Promise.all([
     gqlQuery<KindRead>(KIND_QUERY, { id: dest }).catch(() => null),
     sui >= DESTINATION_MIN_SUI ? classifyDepositAddress(dest, { from: origin.created_at, to: sellingTo, last: 50, maxBalanceTransactions: 100, maxBalanceReads: 20 }).catch(() => null) : Promise.resolve(null),
     buyersAtDestination >= 2 ? creatorPayments(origin.creator, dest, origin.created_checkpoint - 1, affiliationEnd, coin).catch(() => ({ payments: [], complete: false, reads: 0 })) : Promise.resolve({ payments: [], complete: true, reads: 0 }),
    ]);
    const label = getLabel(dest);
    const kind = namedKind(kindRead);
    const measured = kind === "wallet" && !label?.category ? await probeRecipients(dest, DEFAULT_POPULARITY_LIMIT, budget).catch(() => null) : null;
    destinations.push({ address: dest, kind, popularity: measured?.popular ? "popular" : measured?.unmeasured ? "unmeasured" : measured?.complete ? "narrow" : "unmeasured", labelCategory: label?.category === "cex" || label?.category === "bridge" || label?.category === "protocol" ? label.category : label ? "other" : null, depositVerdict: classification?.verdict === "likely" ? "likely" : "unknown", deposit_verdict: classification?.verdict ?? "unknown", sweeps: classification?.sweeps ?? [], sweep_to: classification?.hot_wallet ?? null, classification_complete: sui < DESTINATION_MIN_SUI || classification?.window?.complete === true, creator_payments: creatorPay.payments, creator_payment_complete: creatorPay.complete });
   }
   const scores = scoreLaunch({ creator: { address: origin.creator, payments: destinations.flatMap(d => d.creator_payments) }, buyers: ledgers.map(l => ({ address: l.address, funding: l.launch_funding, transfers: l.transfers, payments: l.payments, referrals: l.referrals, suinsNames: [] } satisfies LaunchBuyer)), destinations, totalSupplyRaw: origin.token.total_supply_raw ? BigInt(origin.token.total_supply_raw) : 0n });
   const status = new Map(scores.buyers.map(b => [b.address, b]));
   const coreAddresses = new Set(scores.buyers.filter(b => b.status === "core").map(b => b.address));
   const fundingBounds = await resolveWindow(fundingFrom, sellingTo);
   const earlyBefore = fundingBounds.after?.checkpoint;
   if (earlyBefore == null) throw new Error("A closed early-history boundary is required to establish opening balances.");
   const earlyHistories = new Map<string, LaunchScan<LaunchTx> | null>();
   await Promise.all([...coreAddresses].map(async address => {
    const earlier = await readEarlyLaunchHistory(address, earlyBefore, pages).catch(() => null);
    earlyHistories.set(address, earlier);
   }));
   const resultBuyers = ledgers.map(l => {
    const ordered = l.history.filter(t => t.sender === l.address && t.status === "SUCCESS");
    const sold = (t: LaunchTx) => amountOf(t, l.address, coin) < 0n && amountOf(t, l.address, SUI) > 0n
     && (saleOnCurve(t, origin.curve_id) || cetusSwap(t, origin.pool_id) !== null);
    const firstSale = ordered.find(sold)?.timestamp;
    const trade = separateRebuys(l.buys, firstSale ? Date.parse(firstSale) : Number.POSITIVE_INFINITY);
    const initial = trade.initial.filter(b => !b.reconciliation_failed);
    const sales = ordered.filter(sold);
    const cetusSales = sales.filter(t => cetusSwap(t, origin.pool_id) !== null);
    const saleSui = cetusSales.map(t => amountOf(t, l.address, SUI));
    const laterBuys = ordered.filter(t => firstSale && Date.parse(t.timestamp) > Date.parse(firstSale)
     && amountOf(t, l.address, coin) > 0n && amountOf(t, l.address, SUI) < 0n && cetusSwap(t, origin.pool_id) !== null)
     .map(t => ({ tx: t, swap: cetusSwap(t, origin.pool_id)! }));
    const rebuySui = laterBuys.map(({ tx, swap }) => eventAmount(swap.amount_in) ?? -amountOf(tx, l.address, SUI));
    const rebuyTokens = laterBuys.map(({ tx, swap }) => eventAmount(swap.amount_out) ?? amountOf(tx, l.address, coin));
    const initialSui = sumRaw(initial.map(b => b.sui_in));
    const initialTokens = sumRaw(initial.map(b => b.tokens_out));
    const allBuys = l.buys.filter(b => !b.reconciliation_failed);
    const purchasesSui = sumRaw(allBuys.map(b => b.sui_in));
    const purchasesTokens = sumRaw(allBuys.map(b => b.tokens_out));
    const forwardedSui = sumRaw(l.transfers.filter(t => t.asset === "sui").map(t => t.amount));
    const forwardedTokens = sumRaw(l.transfers.filter(t => t.asset === "token").map(t => t.amount));
    const saleDigests = new Set(cetusSales.map(t => t.digest));
    const soldTokens = sumRaw(sales.map(tx => {
     const outgoing = l.transfers.filter(t => t.digest === tx.digest && t.asset === "token").reduce((sum, t) => sum + t.amount, 0n);
     const net = amountOf(tx, l.address, coin);
     return net < 0n && -net > outgoing ? -net - outgoing : 0n;
    }));
    const account = reconcileLaunchWindow({
     owner: l.address, suiType: SUI, tokenType: coin, transactions: l.history,
     fundingSui: sumRaw(l.launch_funding.map(f => f.amountMist)), purchasedSui: purchasesSui,
     rebuySui: sumRaw(rebuySui), cetusSuiNet: sumRaw(saleSui), cetusSaleDigests: saleDigests,
     forwardedSui, boughtTokens: sumRaw([purchasesTokens, ...rebuyTokens]), soldTokens, forwardedTokens
    });
    const abs = (n: bigint) => n < 0n ? -n : n;
    const reconciled = l.complete && account.complete && l.buys.every(b => !b.reconciliation_failed)
     && abs(account.suiResidual) <= MIST
     && (account.tokenExpectedDelta === 0n
      ? account.tokenResidual === 0n : abs(account.tokenResidual) * 1_000n <= sumRaw([purchasesTokens, ...rebuyTokens]));
    const earlier = earlyHistories.get(l.address);
    const opening = earlier?.complete ? sumRaw(earlier.rows.map(tx => amountOf(tx, l.address, SUI))) : null;
    const closing = reconciled && opening !== null ? opening + account.suiObservedDelta : null;
    return {
     address: l.address, status: status.get(l.address)?.status ?? "unclustered",
     cluster_id: status.get(l.address)?.clusterId ?? null, first_buy_at: l.first_buy_at,
     initial_buys: { sui: decimalAmount(initialSui, 9), tokens: decimalAmount(initialTokens, scale) },
     gross_buys: { sui: decimalAmount(sumRaw([...allBuys.map(b => b.sui_in), ...rebuySui]), 9), tokens: decimalAmount(sumRaw([...allBuys.map(b => b.tokens_out), ...rebuyTokens]), scale) },
     buy_sui_debit_incl_gas: decimalAmount(sumRaw(l.buys.map(b => b.buy_sui_debit_incl_gas)), 9),
     buy_events: l.buys.map(b => ({ digest: b.digest, timestamp: b.timestamp, sui_in: decimalAmount(b.sui_in, 9), tokens_out: decimalAmount(b.tokens_out, scale), referral: b.referral, reconciliation_failed: b.reconciliation_failed })),
     buys_after_first_sale: laterBuys.map(({ tx }, i) => ({ digest: tx.digest, sui: decimalAmount(rebuySui[i], 9), tokens: decimalAmount(rebuyTokens[i], scale) })),
     cetus_proceeds_gross: decimalAmount(sumRaw(saleSui), 9),
     sales: sales.map(t => ({ digest: t.digest, timestamp: t.timestamp, venue: cetusSwap(t, origin.pool_id) ? "Cetus" : "SuiPump", sui_gained: decimalAmount(amountOf(t, l.address, SUI), 9), event_sui_out: decimalAmount(eventAmount(cetusSwap(t, origin.pool_id)?.amount_out) ?? 0n, 9) })),
     forwarded: l.transfers.map(t => ({ destination: t.destination, asset: t.asset, amount: decimalAmount(t.amount, t.asset === "sui" ? 9 : scale), digest: t.digest })),
     launch_funding: l.launch_funding.map(f => ({ source: f.source, amount_sui: decimalAmount(f.amountMist, 9), digest: f.digest, timestamp: new Date(f.at).toISOString(), source_status: f.sourceStatus, transaction_recipient_count: f.transactionRecipientCount ?? null, transaction_strength: f.transactionStrength ?? null })),
     launch_topup_present: l.launch_topup_present, first_funding_ever: l.first_funding_ever,
     coverage: {
      complete: l.complete && (!coreAddresses.has(l.address) || earlier?.complete === true),
      transactions: l.history.length, reads: l.history_reads, next_cursor: l.history_next_cursor,
      opening_balance_complete: coreAddresses.has(l.address) ? earlier?.complete === true : null,
      opening_balance_reads: earlier?.reads ?? null, opening_balance_next_cursor: earlier?.next_cursor ?? null
     },
     reconciliation: {
      status: reconciled ? closing !== null && closing >= 0n ? "reconciled" : "window_reconciled" : "unreconciled",
      sui_residual: l.complete && account.complete ? decimalAmount(account.suiResidual, 9) : null,
      token_residual_pct: l.complete && account.complete && sumRaw([purchasesTokens, ...rebuyTokens]) > 0n
       ? Number(account.tokenResidual * 100_000n / sumRaw([purchasesTokens, ...rebuyTokens])) / 1_000 : null,
      sui_change_window: l.complete && account.complete ? decimalAmount(account.suiObservedDelta, 9) : null,
      token_change_window: l.complete && account.complete ? decimalAmount(account.tokenObservedDelta, scale) : null,
      sui_leftover: closing !== null && closing >= 0n ? decimalAmount(closing, 9) : null,
      gas_excluding_cetus_sale_net: l.complete && account.complete ? decimalAmount(account.gasNotAlreadyInProceeds, 9) : null,
      ...(l.reconciliation_notes.length ? { notes: l.reconciliation_notes } : {}),
     },
    };
   });
   const coreBuyers = resultBuyers.filter(b => b.status === "core");
   const sumBuyers = (buyers: typeof resultBuyers) => ({
    initial_buys: { sui: buyers.reduce((s, b) => s + b.initial_buys.sui, 0), tokens: buyers.reduce((s, b) => s + b.initial_buys.tokens, 0) },
    gross_buys: { sui: buyers.reduce((s, b) => s + b.gross_buys.sui, 0), tokens: buyers.reduce((s, b) => s + b.gross_buys.tokens, 0) },
    buy_sui_debit_incl_gas: buyers.reduce((s, b) => s + b.buy_sui_debit_incl_gas, 0),
    cetus_proceeds_gross: buyers.reduce((s, b) => s + b.cetus_proceeds_gross, 0),
   });
   const totals = { discovered: sumBuyers(resultBuyers), core: sumBuyers(coreBuyers) };
   const complete = discovery.complete && direct.incomplete_pairs.length === 0 && resultBuyers.every(b => b.coverage.complete) && destinations.every(d => d.classification_complete && d.creator_payment_complete);
   const nextCall = { tool: "analyze_launch", args: { coin_type: coin, ...(creation_tx ? { creation_tx } : {}), window_minutes: window_minutes ?? 10, sell_window_days: sell_window_days ?? 7, max_pages: Math.min(1000, pages * 2), detail: "full" } };
   const payload = { coin_type: coin, token: { symbol: origin.token.symbol, total_supply_raw: origin.token.total_supply_raw, decimals: scale }, creator: { address: origin.creator, creation_tx: origin.creation_tx, created_at: origin.created_at, curve_id: origin.curve_id, graduated: origin.graduated, pool_id: origin.pool_id }, discovered_buyers: resultBuyers, destinations: destinations.map(d => ({ address: d.address, deposit_verdict: d.deposit_verdict, sweep_to: d.sweep_to, sweeps: d.sweeps, eligible: scores.destinations.find(s => s.address === d.address)?.eligible ?? false, affiliation: scores.destinations.find(s => s.address === d.address)?.affiliation ?? "none", creator_payments: d.creator_payments.map(p => ({ digest: p.digest, asset: p.asset, amount: decimalAmount(p.amount, p.asset === "sui" ? 9 : scale) })), classification_complete: d.classification_complete, creator_payment_complete: d.creator_payment_complete })), clusters: scores.clusters, pairs: scores.pairs, below_threshold: scores.below_threshold, observations: scores.observations, totals, coverage: { complete, discovery: { complete: discovery.complete, events: discovery.rows.length, reads: discovery.reads, next_cursor: discovery.next_cursor }, defining_package: origin.defining_package, versions_scanned: origin.versions, buyers: resultBuyers.map(b => ({ address: b.address, ...b.coverage })), destinations: destinations.map(d => ({ address: d.address, classification_complete: d.classification_complete, creator_payment_complete: d.creator_payment_complete })), ...(!complete ? { next_call: nextCall } : {}) }, evidence_tiers: { flows: "chain-derived", deposit_classification: "heuristic", clusters: "heuristic" }, caveat: "SuiNS handles are self-chosen. A deposit address's exchange account holder cannot be named from chain data. Coordination is heuristic; this tool makes no allegation about anyone's intent." };
   const result = {
    ...payload, reconciliation_note: "Event-first trades and gas are checked against complete-window balance changes; sui_leftover is reported only when a complete closed prior-history read establishes the opening balance.", coverage: {
     ...payload.coverage, direct_payment_scan: {
      pairs_checked: direct.pairs_checked, reads: direct.requests, incomplete_pairs: direct.incomplete_pairs,
      from: directFrom, to: sellingTo,
     }
    }
   };
   const caps: Record<string, { budget: number; brief?: (row: never) => unknown; rank?: (a: never, b: never) => number; next_call?: { tool: string; args: Record<string, unknown> } }> = {
    pairs: { budget: 1_200, brief: (row) => { const pair = row as { a: string; b: string; score: number }; return { a: pair.a, b: pair.b, score: pair.score }; } },
    below_threshold: { budget: 500, brief: (row) => { const pair = row as { a: string; b: string; score: number }; return { a: pair.a, b: pair.b, score: pair.score }; } },
    observations: { budget: 700, brief: (row) => { const observation = row as { type: string; via?: string }; return { type: observation.type, via: observation.via }; } },
   };
   for (let i = 0; i < resultBuyers.length; i++) {
    for (const [field, budget] of [["forwarded", 750], ["sales", 500], ["launch_funding", 650], ["buy_events", 550]] as const) caps[`discovered_buyers.${i}.${field}`] = { budget, brief: (row) => { const item = row as { digest?: string; destination?: string }; return { digest: item.digest, ...(item.destination ? { destination: item.destination } : {}) }; } };
   }
   for (let i = 0; i < destinations.length; i++) {
    caps[`destinations.${i}.creator_payments`] = { budget: 800, brief: (row) => { const payment = row as { digest: string }; return { digest: payment.digest }; } };
    caps[`destinations.${i}.sweeps`] = { budget: 1_000, brief: (row) => { const sweep = row as { digest?: string }; return { digest: sweep.digest }; } };
   }
   caps.destinations = { budget: 6_500, rank: (a, b) => { const left = a as { affiliation: string; deposit_verdict: string; sweeps: unknown[] }; const right = b as typeof left; const priority = (d: typeof left) => (d.affiliation === "creator_affiliated" ? 4 : 0) + (d.deposit_verdict === "likely" ? 3 : 0) + (d.sweeps.length ? 2 : 0); return priority(right) - priority(left); }, brief: (row) => { const d = row as { address: string; affiliation: string; deposit_verdict: string }; return { address: d.address, affiliation: d.affiliation, deposit_verdict: d.deposit_verdict }; } };
   for (let i = 0; i < scores.clusters.length; i++) caps[`clusters.${i}.edges`] = { budget: 6_000, brief: (row) => { const edge = row as { a: string; b: string; score: number }; return { a: edge.a, b: edge.b, score: edge.score }; } };
   const listAt = (path: string): unknown => path.split(".").reduce<unknown>((node, part) =>
    node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined, result);
   const listCall = (path: string, at: number) => ({
    tool: "analyze_launch", args: { ...args, detail: "full", list_path: path, offset: at }
   });
   if (list_path) {
    if (detail !== "full" || !Object.hasOwn(caps, list_path) || !Array.isArray(listAt(list_path)))
     throw new Error("list_path must name a listed result path and requires detail: 'full'.");
    const rows = listAt(list_path) as unknown[];
    const start = offset ?? 0;
    if (start > rows.length) throw new Error(`offset exceeds the ${rows.length} rows in ${list_path}.`);
    const page = pageAt(rows, start, 40_000);
    if (JSON.stringify(page.rows).length > 45_000) throw new Error("One row exceeds the full-page budget; request one of its nested list paths.");
    const listed = {
     coin_type: coin, list_path, rows: page.rows,
     rows_page: { offset: start, total: rows.length, next_call: page.next === null ? null : listCall(list_path, page.next) },
     coverage: result.coverage, totals
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(listed) }] };
   }
   if (offset !== undefined) throw new Error("offset requires list_path.");
   if (detail === "full") {
    if (JSON.stringify(result).length <= 45_000) return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    const catalog = {
     coin_type: coin, creator: result.creator, totals, coverage: result.coverage,
     lists: Object.keys(caps).flatMap(path => {
      const rows = listAt(path);
      return Array.isArray(rows) && rows.length ? [{ path, count: rows.length, next_call: listCall(path, 0) }] : [];
     }),
     note: "The complete result exceeds one response. Follow each listed next_call to retrieve consecutive rows."
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(catalog) }] };
   }
   const capped = capPayload("analyze_launch", args, result as Record<string, unknown>, caps, { full: false, next_call: nextCall });
   return { content: [{ type: "text" as const, text: JSON.stringify(capped.payload) }] };
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
 });
}
