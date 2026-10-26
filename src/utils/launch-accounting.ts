import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { poolOfEvent, readSwap } from "./attack-analysis.js";
import { readPoolSwap } from "./pool-swap-events.js";
import { lookupProtocol } from "../protocols/registry.js";
import { isSponsorGasChange } from "./sponsor-gas.js";

export interface LaunchEvent {
 digest: string;
 timestamp: string;
 buyer: string;
 curve_id: string;
 sui_in: string;
 tokens_out: string;
 referral?: string | null;
 /** Curve session and pool events name a signing key, not necessarily the token owner. */
 buyer_basis?: "event_signer_unverified" | "transaction_signer_unverified";
 venue?: string;
}

export interface LaunchChange {
 address: string;
 coin_type: string;
 amount: bigint;
}

export interface LaunchBuy {
 digest: string;
 timestamp: string;
 sui_in: bigint;
 tokens_out: bigint;
 referral: string | null;
 /** The whole transaction's SUI debit for the buyer, gas included. */
 buy_sui_debit_incl_gas: bigint;
 /**
  * SUI the buyer moved in the same transaction outside this trade and its gas:
  * a bot or frontend fee (positive), or SUI swapped in from another coin
  * (negative). Null when the transaction's gas is unknown.
  */
 sui_outside_trade: bigint | null;
 /** The debit differs from the event's `sui_in` plus gas. The event amount still counts. */
 debit_differs: boolean;
 buyer_basis?: LaunchEvent["buyer_basis"];
 venue?: string;
}
/** Referral credits are paid by the curve during buys AND sells, not by the PTB sender. */
export function isSuiPumpReferralFee(
 events: Array<{ type: string; data: Record<string, unknown> }>,
 recipient: string,
): boolean {
 return events.some(({ type, data }) =>
  /::bonding_curve::Tokens(?:Purchased|Sold)$/.test(type)
  && typeof data.referral === "string"
  && normalizeSuiAddress(data.referral) === recipient);
}


/**
 * The event is the trade's own account and always counts. The transaction's
 * debit can also carry gas, fee legs paid to other addresses, or SUI swapped in
 * from another coin; those are reported beside it, never subtracted from it.
 */
export function accountBuy(event: LaunchEvent, changes: LaunchChange[], gas: bigint | null = null): LaunchBuy {
 const buyer = normalizeSuiAddress(event.buyer);
 const sui = BigInt(event.sui_in);
 const tokens = BigInt(event.tokens_out);
 const debit = -changes.filter((c) => c.address === buyer && c.coin_type.endsWith("::sui::SUI"))
  .reduce((sum, c) => sum + c.amount, 0n);
 const outside = gas === null ? null : debit - sui - gas;
 return {
  digest: event.digest,
  timestamp: event.timestamp,
  sui_in: sui,
  tokens_out: tokens,
  buyer_basis: event.buyer_basis,
  venue: event.venue,
  referral: event.referral ? normalizeSuiAddress(event.referral) : null,
  buy_sui_debit_incl_gas: debit,
  sui_outside_trade: outside,
  debit_differs: outside === null ? debit < sui - 10_000_000n || debit - sui > 10_000_000n : outside !== 0n,
 };
}

/** A later buy is known to follow a sale, not proven to spend that sale's fungible SUI. */
export function separateRebuys(buys: LaunchBuy[], firstSaleAt: number): { initial: LaunchBuy[]; after_first_sale: LaunchBuy[] } {
 const initial: LaunchBuy[] = [];
 const after_first_sale: LaunchBuy[] = [];
 for (const buy of buys) (Date.parse(buy.timestamp) > firstSaleAt ? after_first_sale : initial).push(buy);
 return { initial, after_first_sale };
}

export const sumRaw = (values: bigint[]): bigint => values.reduce((sum, value) => sum + value, 0n);

/** What one transaction's trades of the launch coin moved for one owner, by venue, from events. */
export interface TradeLegs {
 /** SUI paid into trades: curve `sui_in`, pool swap `amount_in`. */
 suiIn: bigint;
 /** SUI received from trades: curve `sui_out`, pool swap `amount_out`. */
 suiOut: bigint;
 tokensIn: bigint;
 tokensOut: bigint;
}

const ZERO_LEGS: TradeLegs = { suiIn: 0n, suiOut: 0n, tokensIn: 0n, tokensOut: 0n };
const digits = (value: unknown): bigint => typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;

/** Only a swap type defined by this pool's venue can establish its trade. */
export function isLaunchPoolEvent(type: string, pool: LaunchPool): boolean {
 if (!/::\w*swap\w*/i.test(type)) return false;
 const eventPackage = normalizeSuiAddress(type.split("::")[0]);
 if (pool.eventPackages) return pool.eventPackages.includes(eventPackage);
 const poolPackage = normalizeSuiAddress(pool.type.split("::")[0]);
 return eventPackage === poolPackage || lookupProtocol(eventPackage)?.name === pool.venue;
}

/** A pool swap names a pool and a direction, not a trader. */
export function launchPoolSwap(event: { type: string; data: Record<string, unknown> }, pool: LaunchPool, coinType: string): { side: "buy" | "sell"; sui: bigint; tokens: bigint } | null {
 if (!isLaunchPoolEvent(event.type, pool)) return null;
 const targets = { shared: new Map<string, string | null>([[pool.id, pool.type]]), others: new Map<string, string | null>() };
 const swap = readPoolSwap({ type: event.type, json: event.data }, 0, targets);
 if (!swap || swap.pool !== pool.id) return null;
 const parsed = readSwap({ index: 0, type: event.type, json: event.data }, targets, { flash: true });
 const amountIn = parsed?.amount_in ?? (Array.isArray(event.data.amounts_in) && event.data.amounts_in.length === 1 ? event.data.amounts_in[0] : null);
 const amountOut = parsed?.amount_out ?? (Array.isArray(event.data.amounts_out) && event.data.amounts_out.length === 1 ? event.data.amounts_out[0] : null);
 if (typeof amountIn !== "string" || typeof amountOut !== "string" || !/^[1-9]\d*$/.test(amountIn) || !/^[1-9]\d*$/.test(amountOut)) return null;
 const coin = normalizeStructTag(coinType);
 const sui = normalizeStructTag("0x2::sui::SUI");
 if (swap.coinIn === sui && swap.coinOut === coin) return { side: "buy", sui: BigInt(amountIn), tokens: BigInt(amountOut) };
 if (swap.coinIn === coin && swap.coinOut === sui) return { side: "sell", sui: BigInt(amountOut), tokens: BigInt(amountIn) };
 return null;
}

/** Curve events name their trader; pool swaps count for a signing owner only. */
export function tradeLegs(
 events: Array<{ type: string; data: Record<string, unknown> }>,
 owner: string,
 curve: string,
 pool: LaunchPool | null,
 sentByOwner: boolean,
 coinType: string,
): OwnerTrades {
 const curveLegs = { ...ZERO_LEGS };
 const poolLegs = { ...ZERO_LEGS };
 let unreadPoolSwaps = 0;
 for (const event of events) {
  const { type, data } = event;
  if (data.curve_id === curve && type.endsWith("::bonding_curve::TokensPurchased") && typeof data.buyer === "string" && normalizeSuiAddress(data.buyer) === owner) {
   curveLegs.suiIn += digits(data.sui_in);
   curveLegs.tokensIn += digits(data.tokens_out);
  } else if (data.curve_id === curve && type.endsWith("::bonding_curve::TokensSold") && typeof data.seller === "string" && normalizeSuiAddress(data.seller) === owner) {
   curveLegs.tokensOut += digits(data.tokens_in);
   curveLegs.suiOut += digits(data.sui_out);
  } else if (sentByOwner && pool && type.toLowerCase().includes("swap") && poolOfEvent(data, new Map<string, string | null>([[pool.id, pool.type]])) === pool.id) {
   if (!isLaunchPoolEvent(type, pool)) { if (!pool.eventPackages) unreadPoolSwaps++; continue; }
   const parsed = launchPoolSwap(event, pool, coinType);
   if (!parsed) { unreadPoolSwaps++; continue; }
   if (parsed.side === "sell") { poolLegs.tokensOut += parsed.tokens; poolLegs.suiOut += parsed.sui; }
   else { poolLegs.suiIn += parsed.sui; poolLegs.tokensIn += parsed.tokens; }
  }
 }
 return { curve: curveLegs, pool: poolLegs, unreadPoolSwaps };
}

export interface OwnerTrades { curve: TradeLegs; pool: TradeLegs; unreadPoolSwaps: number }

/** Venue and coin order come from the graduated pool's on-chain type. */
export interface LaunchPool {
 id: string;
 type: string;
 venue: string;
 coinIsA: boolean;
 /** Defining packages of pool swap events across this pool's upgrade lineage. */
 eventPackages?: readonly string[];
 /** Other defining versions may be missed; do not treat zero swaps as absence. */
 pool_lineage_unverified?: boolean;
}

export interface LaunchReconciliationTx {
 digest: string;
 sender: string | null;
 sponsor: string | null;
 gas: bigint | null;
 changes: LaunchChange[];
}

export interface LaunchLedgerTx extends LaunchReconciliationTx {
 timestamp: string;
 status: string | null;
 events: Array<{ type: string; data: Record<string, unknown> }>;
}

/**
 * What an owner paid other addresses in SUI or the launch coin in a
 * transaction it sent. Each coin is capped at what the owner moved out of its
 * own balance: its debit, less gas it paid, plus what its trades of the launch
 * coin returned, less what they took. A stranger's leg in the same PTB stays
 * off the owner's forwards, while a forward beside a sale, or a fee beside a
 * buy, counts in full. Referral fees the curve paid and a sponsor's gas
 * rebate are not the owner's payments.
 */
export function ownerForwards(tx: LaunchLedgerTx, owner: string, suiType: string, coinType: string, trades: OwnerTrades): Array<{ destination: string; coin_type: string; amount: bigint }> {
 const net = (coin: string) => tx.changes.filter((c) => c.address === owner && c.coin_type === coin).reduce((sum, c) => sum + c.amount, 0n);
 const gasPaid = (tx.sponsor ?? tx.sender) === owner ? tx.gas ?? 0n : 0n;
 const suiCap = -net(suiType) - gasPaid + trades.curve.suiOut + trades.pool.suiOut - trades.curve.suiIn - trades.pool.suiIn;
 const tokenCap = -net(coinType) + trades.curve.tokensIn + trades.pool.tokensIn - trades.curve.tokensOut - trades.pool.tokensOut;
 const remaining = new Map<string, bigint>([[suiType, suiCap], [coinType, tokenCap]]);
 const forwards: Array<{ destination: string; coin_type: string; amount: bigint }> = [];
 for (const changed of tx.changes) {
  const cap = remaining.get(changed.coin_type);
  if (cap === undefined || cap <= 0n || changed.address === owner || changed.amount <= 0n) continue;
  if (isSponsorGasChange(changed.address, changed.coin_type, tx.sender, tx.sponsor)) continue;
  if (isSuiPumpReferralFee(tx.events, changed.address)) continue;
  const amount = changed.amount < cap ? changed.amount : cap;
  remaining.set(changed.coin_type, cap - amount);
  forwards.push({ destination: changed.address, coin_type: changed.coin_type, amount });
 }
 return forwards;
}

export interface LaunchReconciliation {
 complete: boolean;
 gas: bigint;
 inflowSui: bigint;
 suiExpectedDelta: bigint;
 suiObservedDelta: bigint;
 suiResidual: bigint;
 tokenExpectedDelta: bigint;
 tokenObservedDelta: bigint;
 tokenResidual: bigint;
}

/**
 * Cross-check the event ledger against the owner's on-chain balance-change
 * deltas over exactly the same closed transaction window. Inflows are what
 * transactions the owner did not send moved for it; trades are event amounts;
 * gas is every transaction the owner paid for. The balance at the start is
 * unknown unless a separate historical balance read establishes it; a window
 * delta must never be labelled a closing balance.
 */
export function reconcileLaunchWindow(input: {
 owner: string;
 suiType: string;
 tokenType: string;
 transactions: LaunchReconciliationTx[];
 trades: TradeLegs;
 forwardedSui: bigint;
 forwardedTokens: bigint;
}): LaunchReconciliation {
 const owner = normalizeSuiAddress(input.owner);
 const delta = (coin: string, txs: LaunchReconciliationTx[]) => sumRaw(txs.flatMap((tx) =>
  tx.changes.filter((change) => change.address === owner && change.coin_type === coin).map((change) => change.amount)
 ));
 const others = input.transactions.filter((tx) => tx.sender !== owner);
 const gas = sumRaw(input.transactions.filter((tx) => (tx.sponsor ?? tx.sender) === owner).map((tx) => tx.gas ?? 0n));
 const inflowSui = delta(input.suiType, others);
 const expectedSui = inflowSui + input.trades.suiOut - input.trades.suiIn - input.forwardedSui - gas;
 const expectedTokens = delta(input.tokenType, others) + input.trades.tokensIn - input.trades.tokensOut - input.forwardedTokens;
 const observedSui = delta(input.suiType, input.transactions);
 const observedTokens = delta(input.tokenType, input.transactions);
 return {
  complete: input.transactions.every((tx) => tx.gas !== null),
  gas,
  inflowSui,
  suiExpectedDelta: expectedSui,
  suiObservedDelta: observedSui,
  suiResidual: expectedSui - observedSui,
  tokenExpectedDelta: expectedTokens,
  tokenObservedDelta: observedTokens,
  tokenResidual: expectedTokens - observedTokens,
 };
}

export interface LaterBuy { digest: string; timestamp: string; venue: string; sui: bigint; tokens: bigint; after_first_sale: boolean }

export interface BuyerAccount {
 /** Launch-window curve or pool buys before the first sale. */
 initial: LaunchBuy[];
 /** Other buys within the sell window, including all buys after the first sale. */
 later: LaterBuy[];
 sales: Array<{ tx: LaunchLedgerTx; trades: OwnerTrades }>;
 initialSui: bigint;
 initialTokens: bigint;
 grossSui: bigint;
 grossTokens: bigint;
 /** Debit of the initial buys' transactions, each transaction once. */
 debit: bigint;
 curveProceeds: bigint;
 poolProceeds: bigint;
 trades: TradeLegs;
 account: LaunchReconciliation;
 /** An event names a signing key; it does not establish the token owner. */
 buyer_attribution_unverified: string[];
 unread_pool_events: number;
 pool_lineage_unverified: boolean;
 sale_order_unverified: string[];
}

/**
 * `windowBuys` includes both curve and pool discovery. Match occurrences by
 * digest, venue and amount, rather than discarding an entire transaction when
 * it has another buy. All trades in the sell window contribute to proceeds.
 */
export function accountBuyer(input: {
 owner: string;
 suiType: string;
 coinType: string;
 curve: string;
 pool: LaunchPool | null;
 history: LaunchLedgerTx[];
 windowBuys: LaunchBuy[];
 forwardedSui: bigint;
 forwardedTokens: bigint;
}): BuyerAccount {
 const { owner, curve } = input;
 const rows = input.history.filter((tx) => tx.status === "SUCCESS").map((tx) => ({ tx, trades: tradeLegs(tx.events, owner, curve, input.pool, tx.sender === owner, input.coinType) }));
 const sales = rows.filter(({ trades }) => trades.curve.tokensOut + trades.pool.tokensOut > 0n);
 const firstSaleAt = sales.length ? Math.min(...sales.map(({ tx }) => Date.parse(tx.timestamp))) : Number.POSITIVE_INFINITY;
 const split = separateRebuys(input.windowBuys, firstSaleAt);
 const key = (digest: string, venue: string, sui: bigint, tokens: bigint) => `${digest}|${venue}|${sui}|${tokens}`;
 const discovered = new Map<string, number>();
 for (const buy of input.windowBuys) {
  const k = key(buy.digest, buy.venue ?? "SuiPump", buy.sui_in, buy.tokens_out);
  discovered.set(k, (discovered.get(k) ?? 0) + 1);
 }
 const later: LaterBuy[] = split.after_first_sale.map((b) => ({ digest: b.digest, timestamp: b.timestamp, venue: b.venue ?? "SuiPump", sui: b.sui_in, tokens: b.tokens_out, after_first_sale: true }));
 const uncertain = new Set(input.windowBuys.filter((b) => b.buyer_basis).map((b) => b.digest));
 for (const { tx } of rows) for (const event of tx.events) {
  const { type, data } = event;
  let venue: string;
  let sui: bigint;
  let tokens: bigint;
  if (data.curve_id === curve && type.endsWith("::bonding_curve::TokensPurchased")) {
   if (typeof data.buyer !== "string" || normalizeSuiAddress(data.buyer) !== owner) {
    if (tx.sender === owner) uncertain.add(tx.digest);
    continue;
   }
   venue = "SuiPump";
   sui = digits(data.sui_in);
   tokens = digits(data.tokens_out);
   uncertain.add(tx.digest);
  } else if (tx.sender === owner && input.pool && type.toLowerCase().includes("swap")) {
   const swap = launchPoolSwap(event, input.pool, input.coinType);
   if (!swap || swap.side !== "buy") continue;
   venue = input.pool.venue;
   sui = swap.sui;
   tokens = swap.tokens;
   uncertain.add(tx.digest);
  } else continue;
  if (!sui || !tokens) continue;
  const k = key(tx.digest, venue, sui, tokens);
  const remaining = discovered.get(k) ?? 0;
  if (remaining) { discovered.set(k, remaining - 1); continue; }
  later.push({ digest: tx.digest, timestamp: tx.timestamp, venue, sui, tokens, after_first_sale: Date.parse(tx.timestamp) > firstSaleAt });
 }
 later.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
 const trades: TradeLegs = { ...ZERO_LEGS };
 for (const row of rows) for (const venue of [row.trades.curve, row.trades.pool]) {
  trades.suiIn += venue.suiIn; trades.suiOut += venue.suiOut; trades.tokensIn += venue.tokensIn; trades.tokensOut += venue.tokensOut;
 }
 const initialSui = sumRaw(split.initial.map((b) => b.sui_in));
 const initialTokens = sumRaw(split.initial.map((b) => b.tokens_out));
 return {
  initial: split.initial, later, sales,
  initialSui, initialTokens,
  grossSui: initialSui + sumRaw(later.map((b) => b.sui)),
  grossTokens: initialTokens + sumRaw(later.map((b) => b.tokens)),
  debit: sumRaw([...new Map(split.initial.map((b) => [b.digest, b.buy_sui_debit_incl_gas])).values()]),
  curveProceeds: sumRaw(sales.map(({ trades: sale }) => sale.curve.suiOut)),
  poolProceeds: sumRaw(sales.map(({ trades: sale }) => sale.pool.suiOut)),
  trades,
  buyer_attribution_unverified: [...uncertain],
  unread_pool_events: rows.reduce((sum, row) => sum + row.trades.unreadPoolSwaps, 0),
  pool_lineage_unverified: input.pool !== null && !input.pool.eventPackages,
  sale_order_unverified: [...new Set([...input.windowBuys, ...later].filter((buy) => Date.parse(buy.timestamp) === firstSaleAt).map((buy) => buy.digest))],
  account: reconcileLaunchWindow({
   owner, suiType: input.suiType, tokenType: input.coinType, transactions: input.history,
   trades, forwardedSui: input.forwardedSui, forwardedTokens: input.forwardedTokens,
  }),
 };
}
export const decimalAmount = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;
