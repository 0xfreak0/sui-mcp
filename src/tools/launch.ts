import { z } from "zod";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { gqlQuery } from "../clients/graphql.js";
import { coinTypeArg, numArg } from "./args.js";
import { resolveWindow } from "../utils/checkpoint-time.js";
import { BALANCE_CHANGES_SELECTION, EVENTS_SELECTION, completeTxConnections, type GqlConnection, type GqlEventNode } from "../utils/tx-connections.js";
import type { GqlBalanceChangeNode } from "../utils/gql-adapters.js";
import { getLabel } from "../utils/labels.js";
import { classifyDepositAddress } from "../utils/deposit.js";
import { Budget, DEFAULT_POPULARITY_LIMIT, firstFunderOf, probeRecipients, type FirstFunderLookup } from "../utils/edge-probe.js";
import { assessCoFunding } from "../utils/co-funding.js";
import { findSubjectPayments } from "../utils/subject-payments.js";
import { clearsDustFloor } from "../utils/funding.js";
import { coinScale, prefetchCoinScale } from "../utils/valuation.js";
import { capPayload, pageAt } from "../utils/output-cap.js";
import { errorResult } from "../utils/errors.js";
import { readLaunchEvents, readLaunchPoolBuys, readLaunchPool, readLaunchHistory, readEarlyLaunchHistory, readLaunchOrigin, probeLaunchPayers, matchBuy, type LaunchTx, type LaunchScan } from "../utils/launch-read.js";
import { sumRaw, decimalAmount, isSuiPumpReferralFee, tradeLegs, ownerForwards, accountBuyer, type BuyerAccount, type LaunchBuy, type LaunchPool } from "../utils/launch-accounting.js";
import { fetchEventJson } from "../utils/event-json.js";
import { scoreLaunch, type LaunchBuyer, type LaunchDestination, type LaunchFunding, type LaunchPayment, type LaunchTransfer } from "../utils/launch-scoring.js";
import { netGas, type GqlGasSummary } from "../utils/trace-read.js";
import { buyerReceivedLaunchCoin, creatorPaid, launchAccountingComplete, launchTopup, launchTotalsPartial, uniqueCreatorPayments, SUI_LAUNCH_TYPE } from "../utils/launch-evidence.js";
import { DEFAULT_NETWORK, getNetwork } from "../config.js";
import { LAUNCH_PARENT_LISTS, launchCatalogLists, launchListRows, launchPaymentReadsCanAdvance, nextLaunchPageBudget } from "../utils/launch-pages.js";
import { launchTokenUsd } from "../utils/launch-price.js";

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const MIST = 1_000_000_000n;
const DESTINATION_MIN_SUI = 100n * MIST;
const DESTINATION_MIN_TOKENS = 1_000_000n;
const FUNDING_RECIPIENTS = `query($digest:String!){transaction(digest:$digest){effects{balanceChanges(first:50){nodes{coinType{repr} amount owner{address}}pageInfo{hasNextPage}}}}}`;
const AFFILIATION_QUERY = `query($creator:SuiAddress!,$destination:SuiAddress!,$afterCp:UInt53!,$beforeCp:UInt53!,$after:String){transactions(filter:{sentAddress:$creator,affectedAddress:$destination,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},first:50,after:$after){nodes{digest sender{address} gasInput{gasSponsor{address}} effects{timestamp gasEffects{gasSummary{computationCost storageCost storageRebate}} ${BALANCE_CHANGES_SELECTION} ${EVENTS_SELECTION}}}pageInfo{hasNextPage endCursor}}}`;
const KIND_QUERY = `query($id:SuiAddress!){object(address:$id){__typename asMovePackage{address} asMoveObject{contents{type{repr}}}}}`;
const DATA_PAGES = 20;

interface RecipientRead { transaction: { effects: { balanceChanges: { nodes: Array<{ coinType?: { repr: string }; amount: string; owner?: { address: string } }>; pageInfo: { hasNextPage: boolean } } } } | null }
interface AffiliationRead { transactions: { nodes: Array<{ digest: string; sender?: { address: string }; gasInput?: { gasSponsor?: { address: string } }; effects: { timestamp: string; gasEffects?: { gasSummary?: GqlGasSummary | null } | null; balanceChanges: GqlConnection<GqlBalanceChangeNode>; events?: GqlConnection<GqlEventNode> } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
interface KindRead { object: { __typename: string; asMovePackage?: unknown; asMoveObject?: unknown } | null }
interface BuyerLedger { address: string; first_buy_at: string; buys: LaunchBuy[]; first_funding_ever: FirstFunderLookup | null; launch_funding: LaunchFunding[]; launch_topup_present: boolean; transfers: LaunchTransfer[]; payments: LaunchPayment[]; referrals: string[]; history: LaunchTx[]; complete: boolean; buyer_ownership_unverified: string[]; history_reads: number; history_next_cursor: string | null }

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
async function creatorPayments(creator: string, destination: string, fromCheckpoint: number, toCheckpoint: number, coin: string, maxPages: number): Promise<{ payments: LaunchPayment[]; complete: boolean; reads: number; canAdvance: boolean }> {
 const payments: LaunchPayment[] = [];
 let cursor: string | undefined;
 let complete = false;
 let balancesComplete = true;
 let reads = 0;
 let stalled = false;
 for (; reads < maxPages; reads++) {
  const page = (await gqlQuery<AffiliationRead>(AFFILIATION_QUERY, { creator, destination, afterCp: fromCheckpoint, beforeCp: toCheckpoint, after: cursor })).transactions;
  const changes = await completeTxConnections(page.nodes.map(node => ({ digest: node.digest, balanceChanges: node.effects.balanceChanges })));
  const events = await Promise.all(page.nodes.map(async node => node.effects.events?.pageInfo?.hasNextPage
   ? await fetchEventJson(node.digest)
   : node.effects.events?.nodes.map(e => ({ type: e.contents?.type?.repr, json: e.contents?.json })) ?? []));
  for (const [index, node] of page.nodes.entries()) {
   const read = events[index];
   if (changes[index].balanceChangesTruncated || !read) { balancesComplete = false; continue; }
   const decoded = read.flatMap(e => e.type && e.json && typeof e.json === "object" ? [{ type: e.type, data: e.json as Record<string, unknown> }] : []);
   const gasText = netGas(node.effects.gasEffects?.gasSummary);
   const changeRows = changes[index].balanceChanges.flatMap(change => change.owner?.address && change.coinType?.repr && change.amount != null
    ? [{ address: change.owner.address, coin_type: change.coinType.repr, amount: BigInt(change.amount) }] : []);
   const tx = { sender: node.sender?.address ?? null, sponsor: node.gasInput?.gasSponsor?.address ?? null, gas: gasText === null ? null : BigInt(gasText), changes: changeRows };
   for (const asset of ["sui", "token"] as const) {
    const paid = creatorPaid(tx, creator, destination, asset === "sui" ? SUI_LAUNCH_TYPE : coin);
    if (paid > 0n) payments.push({ to: destination, asset, amount: paid, digest: node.digest, timestamp: node.effects.timestamp, referral: isSuiPumpReferralFee(decoded, destination) });
   }
  }
  if (!page.pageInfo.hasNextPage) { complete = true; break; }
  if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) { stalled = true; break; }
  cursor = page.pageInfo.endCursor;
 }
 return { payments, complete: complete && balancesComplete, reads: reads + 1, canAdvance: !stalled && !complete && balancesComplete && !!cursor && reads >= maxPages };
}

function amountOf(tx: Pick<LaunchTx, "changes">, owner: string, coin: string): bigint {
 return tx.changes.filter(c => c.address === owner && c.coin_type === coin).reduce((sum, c) => sum + c.amount, 0n);
}

export function registerLaunchTools(server: McpServer) {
 server.tool("analyze_launch", "(Incident investigation) Discover SuiPump buy-event signers from the coin type alone, including graduated-pool trades, and account for their launch funding, initial and later buys, sales and forwards. Buyers are ranked by initial tokens and percentage of supply, each with status and reconciliation. Scores each pair, including the creator, with evidence tiers; a shared likely deposit qualifies by itself only with a complete scan and at most 50 distinct depositors. A signer whose purchase did not credit its own token balance is unverified and not scored. Event amounts exclude gas; gas-inclusive debits are separate. A partial scan reports coverage, with next_call only when its read bound can advance. Full results page parent buyer/cluster/destination records and child evidence via path and offset arguments. No account-holder or misconduct verdict. Start with the exact coin type; creation_tx optionally cross-checks it.", {
  coin_type: coinTypeArg().describe("Exact SuiPump coin type, not a symbol"),
  creation_tx: z.string().optional().describe("Optional creation digest to cross-check discovery from coin type"),
  window_minutes: numArg().int().min(1).max(1440).optional().describe("Minutes from creation for initial buyer discovery (default 10)"),
  sell_window_days: numArg().int().min(1).max(30).optional().describe("Days from creation to trace every buyer's sales and forwards (default 7)"),
  max_pages: numArg().int().min(1).max(1000).optional().describe("Discovery, buyer, destination and creator-payment page budget (default 20); coverage.next_call raises it only when an unfinished bound can advance"),
  detail: z.enum(["summary", "full"]).optional().describe("Full returns all data if small, otherwise lists consecutive pages by path and offset"),
  list_path: z.string().optional().describe("Full-view list path from the catalog (including parent lists and the catalog itself), for example discovered_buyers.0.sales"),
  offset: numArg().int().min(0).optional().describe("Index of the first row in the selected list (default 0)"),
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
   const poolId = typeof origin.pool_id === "string" ? origin.pool_id : null;
   const pool: LaunchPool | null = poolId ? await readLaunchPool(poolId, coin) : null;
   const [curveDiscovery, poolDiscovery] = await Promise.all([
    readLaunchEvents("buy", origin.created_at, buyingTo, origin.curve_id, pages),
    pool ? readLaunchPoolBuys(pool, coin, origin.created_at, buyingTo, pages) : Promise.resolve(null),
   ]);
   const discovery = {
    rows: [...curveDiscovery.rows, ...(poolDiscovery?.rows ?? [])].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.digest.localeCompare(b.digest)),
    complete: curveDiscovery.complete && (!poolId || poolDiscovery?.complete === true),
    reads: curveDiscovery.reads + (poolDiscovery?.reads ?? 0),
    next_cursor: curveDiscovery.next_cursor ?? poolDiscovery?.next_cursor ?? null,
   };
   const buys = discovery.rows.filter(e => e.buyer !== origin.creator && e.digest !== origin.creation_tx);
   const grouped = new Map<string, typeof buys>();
   for (const event of buys) { const group = grouped.get(event.buyer) ?? []; group.push(event); grouped.set(event.buyer, group); }
   if (grouped.size > 50) throw new Error("Over 50 buyers in the initial window; narrow window_minutes before drawing a complete buyer set.");
   const recipientCounts = new Map<string, number | null>();
   const popularity = new Map<string, LaunchFunding["sourceStatus"]>();
   const budget = new Budget(250);
   const ledgers: BuyerLedger[] = [];
   const tokenStates = new Map<string, Record<string, unknown> | null>();
   const suiPriceByHour = new Map<number, number | null>();
   for (const [buyer, initialEvents] of grouped) {
    const history = await readLaunchHistory(buyer, fundingFrom, sellingTo, pages);
    const indexed = new Map(history.rows.map(tx => [tx.digest, tx]));
    const buyerEvents = initialEvents.map(e => { const tx = indexed.get(e.digest); return tx ? matchBuy(e, tx) : null; }).filter((x): x is NonNullable<typeof x> => x !== null);
    const buyerOwnershipUnverified = initialEvents.flatMap(e => {
     const tx = indexed.get(e.digest);
     return tx && !buyerReceivedLaunchCoin(tx, buyer, coin) ? [e.digest] : [];
    });
    const first = initialEvents[0].timestamp;
    const funding: LaunchFunding[] = [];
    const transfers: LaunchTransfer[] = [];
    const payments: LaunchPayment[] = [];
    const referrals = initialEvents.flatMap(e => e.referral ? [e.referral] : []);
    for (const tx of history.rows) {
     const topup = Date.parse(tx.timestamp) <= Date.parse(first) && Date.parse(tx.timestamp) >= Date.parse(fundingFrom)
      && !isSuiPumpReferralFee(tx.events, buyer) ? launchTopup(tx, buyer) : null;
     if (topup) {
      const source = topup.source;
       if (!popularity.has(source)) {
        const label = getLabel(source);
        const probe = label?.category === "cex" ? null : await probeRecipients(source, DEFAULT_POPULARITY_LIMIT, budget);
        popularity.set(source, label?.category === "cex" || probe?.popular ? "hub" : probe?.unmeasured ? "unmeasured" : probe?.complete ? "narrow" : "provisional");
       }
       const recipients = await paymentCount(tx.digest, recipientCounts);
       const strength = assessCoFunding(2, recipients).strength;
      funding.push({ source, amountMist: topup.amountMist, digest: tx.digest, at: Date.parse(tx.timestamp), sourceStatus: popularity.get(source)!, transactionRecipientCount: recipients ?? undefined, transactionStrength: strength === "targeted" ? "targeted" : "other" });
     }
     if (tx.sender !== buyer || Date.parse(tx.timestamp) < created || Date.parse(tx.timestamp) > Date.parse(sellingTo)) continue;
     const trades = tradeLegs(tx.events, buyer, origin.curve_id, pool, true, coin);
     for (const forward of ownerForwards(tx, buyer, SUI, coin, trades)) {
      const usd = forward.coin_type === coin ? await launchTokenUsd(forward.amount, tx.timestamp, tx.checkpoint, origin.curve_id, pool, tokenStates, suiPriceByHour) : null;
      const floor = clearsDustFloor(forward.coin_type, forward.amount, forward.coin_type === coin ? () => usd : undefined);
      transfers.push({ destination: forward.destination, asset: forward.coin_type === SUI ? "sui" : "token", amount: forward.amount, digest: tx.digest, qualifies: floor ?? "unpriced" });
     }
    }
    const firstFunding = await firstFunderOf(buyer, budget);
    ledgers.push({ address: buyer, first_buy_at: first, buys: buyerEvents, first_funding_ever: firstFunding, launch_funding: funding, launch_topup_present: funding.length > 0, transfers, payments, referrals, history: history.rows, complete: history.complete && buyerEvents.length === initialEvents.length && buyerOwnershipUnverified.length === 0, buyer_ownership_unverified: buyerOwnershipUnverified, history_reads: history.reads, history_next_cursor: history.next_cursor });
   }
   // The creator is a subject too: a payment between it and a buyer is direct.
   const direct = await findSubjectPayments([...grouped.keys(), origin.creator], { window: { afterCheckpoint: directAfter, beforeCheckpoint: directBefore }, maxPairPages: pages });
   const eventByDigest = new Map<string, { type: string; data: Record<string, unknown> }[] | null>(
    ledgers.flatMap(ledger => ledger.history.map(tx => [tx.digest, tx.events] as const))
   );
   const missingEvents = [...new Set(direct.payments.map(payment => payment.digest))].filter(digest => !eventByDigest.has(digest));
   await Promise.all(missingEvents.map(async digest => {
    const events = await fetchEventJson(digest);
    eventByDigest.set(digest, events?.flatMap(event => event.type && event.json && typeof event.json === "object"
     ? [{ type: event.type, data: event.json as Record<string, unknown> }] : []) ?? null);
   }));
   const paymentsBy = (payer: string): LaunchPayment[] => direct.payments.filter(payment => payment.payer === payer).flatMap(payment =>
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
   for (const ledger of ledgers) ledger.payments = paymentsBy(ledger.address);
   const creatorRecipientReads = await Promise.all([...new Set(direct.payments.filter(p => p.payer === origin.creator && grouped.has(p.payee)).map(p => p.payee))]
    .map(payee => creatorPayments(origin.creator, payee, directAfter, directBefore, coin, pages).catch(() => ({ payments: [] as LaunchPayment[], complete: false, reads: 0, canAdvance: false }))));
   const creatorDirect = creatorRecipientReads.flatMap(read => read.payments);
   const creatorRecipientComplete = creatorRecipientReads.every(read => read.complete);
   const outgoing = new Map<string, LaunchTransfer[]>();
   for (const ledger of ledgers) for (const transfer of ledger.transfers) { const old = outgoing.get(transfer.destination) ?? []; old.push(transfer); outgoing.set(transfer.destination, old); }
   const destinations: Array<LaunchDestination & { deposit_verdict: string; sweeps: Array<{ digest: string }>; sweep_to: string | null; classification_complete: boolean; classification_can_advance: boolean; creator_payments: LaunchPayment[]; creator_payment_complete: boolean; creator_payment_can_advance: boolean; inflow_payers: number | null }> = [];
   const inflowBudget = new Budget(200);
   for (const [dest, flows] of outgoing) {
    const tokens = sumRaw(flows.filter(x => x.asset === "token").map(x => x.amount));
    const sui = sumRaw(flows.filter(x => x.asset === "sui").map(x => x.amount));
    const tokenThreshold = DESTINATION_MIN_TOKENS * BigInt(10 ** scale);
    const buyersAtDestination = new Set(ledgers.filter(l => l.transfers.some(x => x.destination === dest)).map(l => l.address)).size;
    if (sui < DESTINATION_MIN_SUI && tokens < tokenThreshold && buyersAtDestination < 2) continue;
    const depositPages = Math.ceil(pages / DATA_PAGES);
    const [kindRead, classification, creatorPay] = await Promise.all([
     gqlQuery<KindRead>(KIND_QUERY, { id: dest }).catch(() => null),
     sui >= DESTINATION_MIN_SUI ? classifyDepositAddress(dest, { from: origin.created_at, to: sellingTo, last: 50 * depositPages, maxBalanceTransactions: 100 * depositPages, maxBalanceReads: 20 * depositPages }).catch(() => null) : Promise.resolve(null),
     buyersAtDestination >= 2 && dest !== origin.creator ? creatorPayments(origin.creator, dest, origin.created_checkpoint - 1, affiliationEnd, coin, pages).catch(() => ({ payments: [], complete: false, reads: 0, canAdvance: false })) : Promise.resolve({ payments: [], complete: true, reads: 0, canAdvance: false }),
    ]);
    const label = getLabel(dest);
    const kind = namedKind(kindRead);
    const measured = kind === "wallet" && (!label?.category || label.source === "inferred") ? await probeRecipients(dest, DEFAULT_POPULARITY_LIMIT, budget).catch(() => null) : null;
    const outflow = measured?.popular ? "popular" as const : measured?.complete && !measured.unmeasured ? "narrow" as const : "unmeasured" as const;
    // Narrow on what it pays is half the test: a collector many unrelated
    // traders pay (a bot's fee wallet) pays few. Read who pays it as well.
    const inflow = outflow === "narrow" ? await probeLaunchPayers(dest, coin, DEFAULT_POPULARITY_LIMIT, () => inflowBudget.take()) : null;
    const windowComplete = classification?.window?.complete === true;
    const reconstruction = classification?.balance_reconstruction;
    const classificationComplete = sui < DESTINATION_MIN_SUI || windowComplete && reconstruction?.complete !== false;
    const classificationCanAdvance = !!classification && !classification.window.anchor_limited
     && (classification.window.older_transactions_remaining && classification.window.scanned_transactions >= classification.window.max_transactions
      || !!reconstruction && !reconstruction.complete && !reconstruction.unavailable
      && (reconstruction.reads >= reconstruction.max_reads || reconstruction.scanned_transactions >= reconstruction.max_transactions));
    destinations.push({
     address: dest, kind, popularity: inflow ? inflow.verdict : outflow, inflow_payers: inflow?.payers ?? null,
     labelCategory: label?.category === "cex" || label?.category === "bridge" || label?.category === "protocol" ? label.category : label ? "other" : null,
     exchangeHotWallet: label?.category === "cex" && label.source !== "inferred",
     depositVerdict: classification?.verdict === "likely" ? "likely" : "unknown",
     classificationComplete: windowComplete && reconstruction?.complete !== false,
     distinctDepositors: windowComplete && reconstruction?.complete !== false ? new Set(classification.deposits.flatMap(row => row.from)).size : null,
     deposit_verdict: classification?.verdict ?? "unknown", sweeps: classification?.sweeps ?? [], sweep_to: classification?.hot_wallet ?? null,
     classification_complete: classificationComplete, classification_can_advance: classificationCanAdvance,
     creator_payments: creatorPay.payments, creator_payment_complete: creatorPay.complete, creator_payment_can_advance: creatorPay.canAdvance,
    });
   }
   const scores = scoreLaunch({ creator: { address: origin.creator, payments: uniqueCreatorPayments([...destinations.map(d => d.creator_payments), creatorDirect]) }, buyers: ledgers.map(l => ({ address: l.address, funding: l.buyer_ownership_unverified.length ? [] : l.launch_funding, transfers: l.buyer_ownership_unverified.length ? [] : l.transfers, payments: l.buyer_ownership_unverified.length ? [] : l.payments, referrals: l.buyer_ownership_unverified.length ? [] : l.referrals, suinsNames: [] } satisfies LaunchBuyer)), destinations, totalSupplyRaw: origin.token.total_supply_raw ? BigInt(origin.token.total_supply_raw) : 0n });
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
   const supplyRaw = origin.token.total_supply_raw ? BigInt(origin.token.total_supply_raw) : 0n;
   const ledgerRows = ledgers.map(l => {
    const a = accountBuyer({
     owner: l.address, suiType: SUI, coinType: coin, curve: origin.curve_id, pool, history: l.history, windowBuys: l.buys,
     forwardedSui: sumRaw(l.transfers.filter(t => t.asset === "sui").map(t => t.amount)),
     forwardedTokens: sumRaw(l.transfers.filter(t => t.asset === "token").map(t => t.amount)),
    });
    const account = a.account;
    const abs = (n: bigint) => n < 0n ? -n : n;
    const reconciled = l.complete && account.complete && a.unread_pool_events === 0
     && abs(account.suiResidual) <= MIST
     && (account.tokenExpectedDelta === 0n
      ? account.tokenResidual === 0n : abs(account.tokenResidual) * 1_000n <= a.trades.tokensIn);
    const earlier = earlyHistories.get(l.address);
    const opening = earlier?.complete ? sumRaw(earlier.rows.map(tx => amountOf(tx, l.address, SUI))) : null;
    const closing = reconciled && opening !== null ? opening + account.suiObservedDelta : null;
    const windowRead = l.complete && account.complete;
    return {
     raw: a, row: {
     address: l.address, status: status.get(l.address)?.status ?? "unclustered",
     cluster_id: status.get(l.address)?.clusterId ?? null, first_buy_at: l.first_buy_at,
      initial_supply_pct: supplyRaw > 0n ? Number(a.initialTokens * 100_000_000n / supplyRaw) / 1_000_000 : null,
      initial_buys: { sui: decimalAmount(a.initialSui, 9), tokens: decimalAmount(a.initialTokens, scale) },
      gross_buys: { sui: decimalAmount(a.grossSui, 9), tokens: decimalAmount(a.grossTokens, scale) },
      buy_sui_debit_incl_gas: decimalAmount(a.debit, 9),
      buy_events: l.buys.map(b => ({ digest: b.digest, timestamp: b.timestamp, sui_in: decimalAmount(b.sui_in, 9), tokens_out: decimalAmount(b.tokens_out, scale), referral: b.referral, sui_outside_trade: b.sui_outside_trade === null ? null : decimalAmount(b.sui_outside_trade, 9) })),
      later_buys: a.later.map(b => ({ digest: b.digest, timestamp: b.timestamp, venue: b.venue, sui: decimalAmount(b.sui, 9), tokens: decimalAmount(b.tokens, scale), after_first_sale: b.after_first_sale })),
      curve_proceeds_gross: decimalAmount(a.curveProceeds, 9),
      pool_proceeds_gross: { venue: pool?.venue ?? null, sui: decimalAmount(a.poolProceeds, 9) },
      ...(pool?.venue === "Cetus" ? { cetus_proceeds_gross: decimalAmount(a.poolProceeds, 9) } : {}),
      sales: a.sales.map(({ tx, trades: sale }) => ({
       digest: tx.digest, timestamp: tx.timestamp,
       venue: sale.pool.tokensOut > 0n
        ? sale.curve.tokensOut > 0n ? `SuiPump+${pool?.venue ?? "pool"}` : pool?.venue ?? "pool"
        : "SuiPump",
       tokens_in: decimalAmount(sale.curve.tokensOut + sale.pool.tokensOut, scale),
       event_sui_out: decimalAmount(sale.curve.suiOut + sale.pool.suiOut, 9),
       sui_gained: decimalAmount(amountOf(tx, l.address, SUI), 9),
      })),
     forwarded: l.transfers.map(t => ({ destination: t.destination, asset: t.asset, amount: decimalAmount(t.amount, t.asset === "sui" ? 9 : scale), digest: t.digest })),
     launch_funding: l.launch_funding.map(f => ({ source: f.source, amount_sui: decimalAmount(f.amountMist, 9), digest: f.digest, timestamp: new Date(f.at).toISOString(), source_status: f.sourceStatus, transaction_recipient_count: f.transactionRecipientCount ?? null, transaction_strength: f.transactionStrength ?? null })),
     launch_topup_present: l.launch_topup_present, first_funding_ever: l.first_funding_ever,
     coverage: {
       complete: launchAccountingComplete(l.complete, !coreAddresses.has(l.address) || earlier?.complete === true, a.unread_pool_events),
      transactions: l.history.length, reads: l.history_reads, next_cursor: l.history_next_cursor,
       buyer_ownership_unverified: l.buyer_ownership_unverified,
      opening_balance_complete: coreAddresses.has(l.address) ? earlier?.complete === true : null,
       opening_balance_reads: earlier?.reads ?? null, opening_balance_next_cursor: earlier?.next_cursor ?? null,
       ...(a.unread_pool_events ? { pool_swaps_unread: a.unread_pool_events } : {}),
     },
     reconciliation: {
      status: reconciled ? closing !== null && closing >= 0n ? "reconciled" : "window_reconciled" : "unreconciled",
       sui_residual: windowRead ? decimalAmount(account.suiResidual, 9) : null,
       token_residual_pct: windowRead && a.trades.tokensIn > 0n ? Number(account.tokenResidual * 100_000n / a.trades.tokensIn) / 1_000 : null,
       sui_received_from_others: windowRead ? decimalAmount(account.inflowSui, 9) : null,
       sui_change_window: windowRead ? decimalAmount(account.suiObservedDelta, 9) : null,
       token_change_window: windowRead ? decimalAmount(account.tokenObservedDelta, scale) : null,
      sui_leftover: closing !== null && closing >= 0n ? decimalAmount(closing, 9) : null,
       gas_paid: windowRead ? decimalAmount(account.gas, 9) : null,
     },
     }
    };
   }).sort((left, right) => left.raw.initialTokens > right.raw.initialTokens ? -1
    : left.raw.initialTokens < right.raw.initialTokens ? 1 : left.row.address.localeCompare(right.row.address));
   const resultBuyers = ledgerRows.map((item, index) => ({ ...item.row, initial_buy_rank: index + 1 }));
   const sumBuyers = (rows: typeof ledgerRows) => {
    const total = (pick: (raw: BuyerAccount) => bigint) => sumRaw(rows.map(r => pick(r.raw)));
    return {
     initial_buys: { sui: decimalAmount(total(r => r.initialSui), 9), tokens: decimalAmount(total(r => r.initialTokens), scale) },
     gross_buys: { sui: decimalAmount(total(r => r.grossSui), 9), tokens: decimalAmount(total(r => r.grossTokens), scale) },
     buy_sui_debit_incl_gas: decimalAmount(total(r => r.debit), 9),
     curve_proceeds_gross: decimalAmount(total(r => r.curveProceeds), 9),
     pool_proceeds_gross: { venue: pool?.venue ?? null, sui: decimalAmount(total(r => r.poolProceeds), 9) },
     ...(pool?.venue === "Cetus" ? { cetus_proceeds_gross: decimalAmount(total(r => r.poolProceeds), 9) } : {}),
     partial: launchTotalsPartial(rows, discovery.complete),
    };
   };
   const totals = {
    discovered: sumBuyers(ledgerRows), core: sumBuyers(ledgerRows.filter(r => r.row.status === "core")),
    basis: "discovered sums every buyer found in the launch window; core sums only buyers in a core cluster. initial_buys are launch-window curve buys before the buyer's first sale, by event; gross_buys add every later buy of the coin in the sell window, curve or pool, by event, including buys after a sale that may recycle its proceeds. Proceeds are event amounts; buy_sui_debit_incl_gas is the launch-window buy transactions' debit, gas and any fee legs included.",
   };
   const complete = discovery.complete && (!poolId || poolDiscovery?.complete === true)
    && direct.incomplete_pairs.length === 0 && creatorRecipientComplete
    && resultBuyers.every(b => b.coverage.complete) && destinations.every(d => d.classification_complete && d.creator_payment_complete);
   const advancePages = nextLaunchPageBudget(pages, !discovery.complete && discovery.next_cursor !== null
    || !!poolDiscovery && !poolDiscovery.complete && poolDiscovery.next_cursor !== null
    || ledgers.some(l => !l.complete && l.history_next_cursor !== null)
    || [...earlyHistories.values()].some(read => read && !read.complete && read.next_cursor !== null)
    || launchPaymentReadsCanAdvance(direct.can_advance, creatorRecipientReads)
    || destinations.some(d => d.classification_can_advance || d.creator_payment_can_advance));
   const nextCall = advancePages !== null ? {
    tool: "analyze_launch", args: {
     coin_type: coin, ...(creation_tx ? { creation_tx } : {}),
     window_minutes: window_minutes ?? 10, sell_window_days: sell_window_days ?? 7,
     max_pages: advancePages, detail: "full",
     ...(getNetwork() !== DEFAULT_NETWORK ? { network: getNetwork() } : {}),
    }
   } : null;
   const payload = {
    coin_type: coin,
    token: { symbol: origin.token.symbol, total_supply_raw: origin.token.total_supply_raw, decimals: scale },
    creator: {
     address: origin.creator, creation_tx: origin.creation_tx, created_at: origin.created_at,
     curve_id: origin.curve_id, graduation_target: origin.graduation_target,
     graduated: origin.graduated, pool_id: origin.pool_id, pool_venue: pool?.venue ?? null,
    },
    discovered_buyers: resultBuyers,
    destinations: destinations.map(d => ({
     address: d.address, deposit_verdict: d.deposit_verdict, sweep_to: d.sweep_to, sweeps: d.sweeps,
     eligible: scores.destinations.find(s => s.address === d.address)?.eligible ?? false,
     affiliation: scores.destinations.find(s => s.address === d.address)?.affiliation ?? "none",
     creator_payments: d.creator_payments.map(p => ({
      digest: p.digest, asset: p.asset, amount: decimalAmount(p.amount, p.asset === "sui" ? 9 : scale),
     })),
     classification_complete: d.classification_complete, classification_can_advance: d.classification_can_advance,
     creator_payment_complete: d.creator_payment_complete, creator_payment_can_advance: d.creator_payment_can_advance,
     distinct_depositors: d.distinctDepositors, inflow_payers: d.inflow_payers,
    })),
    clusters: scores.clusters, pairs: scores.pairs, below_threshold: scores.below_threshold,
    sub_threshold_payments: scores.sub_threshold_payments, observations: scores.observations, totals,
    coverage: {
     complete,
     discovery: { complete: discovery.complete, events: discovery.rows.length, reads: discovery.reads, next_cursor: discovery.next_cursor },
     pool_discovery: poolId ? poolDiscovery
      ? {
       complete: poolDiscovery.complete, reads: poolDiscovery.reads, next_cursor: poolDiscovery.next_cursor,
       unread_swap_events: poolDiscovery.unread_swap_events,
       buyer_attribution: poolDiscovery.buyer_attribution,
       pool_lineage_unverified: poolDiscovery.pool_lineage_unverified,
      }
      : { complete: false, pool_unread: poolId } : null,
     defining_package: origin.defining_package, versions_scanned: origin.versions,
     buyers: resultBuyers.map(b => ({ address: b.address, ...b.coverage })),
     destinations: destinations.map(d => ({
      address: d.address, classification_complete: d.classification_complete,
      classification_can_advance: d.classification_can_advance,
      creator_payment_complete: d.creator_payment_complete, creator_payment_can_advance: d.creator_payment_can_advance,
     })),
     creator_recipient_payments_complete: creatorRecipientComplete,
     subject_payments_complete: direct.incomplete_pairs.length === 0,
     subject_payments_can_advance: direct.can_advance,
     creator_recipient_payments_can_advance: creatorRecipientReads.some(read => read.canAdvance),
     ...(!complete && nextCall ? { next_call: nextCall } : {}),
    },
    evidence_tiers: { flows: "chain-derived", deposit_classification: "heuristic", clusters: "heuristic" },
    caveat: "SuiNS handles are self-chosen. A deposit address's exchange account holder cannot be named from chain data. Coordination is heuristic; this tool makes no allegation about anyone's intent.",
   };
   const result = {
    ...payload, reconciliation_note: "Event-first trades, inflows from others, forwards and gas are checked against complete-window balance changes; sui_leftover is reported only when a complete closed prior-history read establishes the opening balance.", coverage: {
     ...payload.coverage, direct_payment_scan: {
      pairs_checked: direct.pairs_checked, reads: direct.requests, incomplete_pairs: direct.incomplete_pairs,
      from: directFrom, to: sellingTo,
     }
    }
   };
   const caps: Record<string, { budget: number; brief?: (row: never) => unknown; rank?: (a: never, b: never) => number; next_call?: { tool: string; args: Record<string, unknown> } }> = {
    pairs: { budget: 1_200, brief: (row) => { const pair = row as { a: string; b: string; score: number }; return { a: pair.a, b: pair.b, score: pair.score }; } },
    below_threshold: { budget: 500, brief: (row) => { const pair = row as { a: string; b: string; score: number }; return { a: pair.a, b: pair.b, score: pair.score }; } },
    sub_threshold_payments: { budget: 500, brief: (row) => { const payment = row as { from: string; to: string; asset: string }; return { from: payment.from, to: payment.to, asset: payment.asset }; } },
    observations: { budget: 700, brief: (row) => { const observation = row as { type: string; via?: string }; return { type: observation.type, via: observation.via }; } },
   };
   for (let i = 0; i < resultBuyers.length; i++) {
    for (const [field, budget] of [["forwarded", 750], ["sales", 500], ["launch_funding", 650], ["buy_events", 550], ["later_buys", 550]] as const) caps[`discovered_buyers.${i}.${field}`] = { budget, brief: (row) => { const item = row as { digest?: string; destination?: string }; return { digest: item.digest, ...(item.destination ? { destination: item.destination } : {}) }; } };
   }
   for (let i = 0; i < destinations.length; i++) {
    caps[`destinations.${i}.creator_payments`] = { budget: 800, brief: (row) => { const payment = row as { digest: string }; return { digest: payment.digest }; } };
    caps[`destinations.${i}.sweeps`] = { budget: 1_000, brief: (row) => { const sweep = row as { digest?: string }; return { digest: sweep.digest }; } };
   }
   caps.destinations = { budget: 6_500, rank: (a, b) => { const left = a as { affiliation: string; deposit_verdict: string; sweeps: unknown[] }; const right = b as typeof left; const priority = (d: typeof left) => (d.affiliation === "creator_affiliated" ? 4 : 0) + (d.deposit_verdict === "likely" ? 3 : 0) + (d.sweeps.length ? 2 : 0); return priority(right) - priority(left); }, brief: (row) => { const d = row as { address: string; affiliation: string; deposit_verdict: string }; return { address: d.address, affiliation: d.affiliation, deposit_verdict: d.deposit_verdict }; } };
   for (let i = 0; i < scores.clusters.length; i++) caps[`clusters.${i}.edges`] = { budget: 6_000, brief: (row) => { const edge = row as { a: string; b: string; score: number }; return { a: edge.a, b: edge.b, score: edge.score }; } };
   const childPaths = new Set(Object.keys(caps));
   const pagePaths = new Set([...childPaths, ...LAUNCH_PARENT_LISTS, "lists"]);
   const listCall = (path: string, at: number) => ({
    tool: "analyze_launch", args: { ...args, ...(getNetwork() !== DEFAULT_NETWORK ? { network: getNetwork() } : {}), detail: "full", list_path: path, offset: at }
   });
   const catalogLists = launchCatalogLists(result as Record<string, unknown>,
    [...pagePaths].filter(path => path !== "lists"), childPaths)
    .map(({ path, count }) => ({ path, count, next_call: listCall(path, 0) }));
   const listedRows = (path: string): unknown[] | null => path === "lists"
    ? catalogLists : launchListRows(result as Record<string, unknown>, path, childPaths);
   if (list_path) {
    if (detail !== "full" || !pagePaths.has(list_path) || !listedRows(list_path))
     throw new Error("list_path must name a listed result path and requires detail: 'full'.");
    const rows = listedRows(list_path)!;
    const start = offset ?? 0;
    if (start > rows.length) throw new Error(`offset exceeds the ${rows.length} rows in ${list_path}.`);
    const page = pageAt(rows, start, 18_000);
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
    const catalogCoverage = {
     ...result.coverage, buyers: "See discovered_buyers rows.",
     destinations: "See destinations rows."
    };
    const descriptorPage = pageAt(catalogLists, 0, 18_000);
    const catalog = {
     coin_type: coin, token: result.token, creator: result.creator, totals, coverage: catalogCoverage,
     evidence_tiers: result.evidence_tiers, caveat: result.caveat, reconciliation_note: result.reconciliation_note,
     lists: descriptorPage.rows,
     rows_page: { offset: 0, total: catalogLists.length, next_call: descriptorPage.next === null ? null : listCall("lists", descriptorPage.next) },
     note: "Follow the list calls for consecutive full records; follow rows_page.next_call for further list descriptors."
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(catalog) }] };
   }
   const fullCall = {
    tool: "analyze_launch", args: {
     ...args, ...(getNetwork() !== DEFAULT_NETWORK ? { network: getNetwork() } : {}), detail: "full"
    }
   };
   const capped = capPayload("analyze_launch", args, result as Record<string, unknown>, caps, { full: false, next_call: fullCall });
   return { content: [{ type: "text" as const, text: JSON.stringify(capped.payload) }] };
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
 });
}
