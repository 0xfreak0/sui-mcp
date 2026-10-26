import { normalizeSuiAddress } from "@mysten/sui/utils";
import { isSponsorGasChange } from "./sponsor-gas.js";

export interface LaunchEvent {
 digest: string;
 timestamp: string;
 buyer: string;
 curve_id: string;
 sui_in: string;
 tokens_out: string;
 referral?: string | null;
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

/**
 * Read the owner's trades of one launch from a transaction's events. Curve
 * events name their buyer or seller; a pool swap event names no trader, so it
 * counts only when `sentByOwner`. A swap's direction comes from `atob` and
 * whether the launch coin is the pool's coin A; with that order unknown, the
 * swap is left out rather than guessed.
 */
export function tradeLegs(
 events: Array<{ type: string; data: Record<string, unknown> }>,
 owner: string,
 curve: string,
 pool: LaunchPool | null,
 sentByOwner: boolean,
): OwnerTrades {
 const curveLegs = { ...ZERO_LEGS };
 const poolLegs = { ...ZERO_LEGS };
 for (const { type, data } of events) {
  if (data.curve_id === curve && type.endsWith("::bonding_curve::TokensPurchased") && typeof data.buyer === "string" && normalizeSuiAddress(data.buyer) === owner) {
   curveLegs.suiIn += digits(data.sui_in);
   curveLegs.tokensIn += digits(data.tokens_out);
  } else if (data.curve_id === curve && type.endsWith("::bonding_curve::TokensSold") && typeof data.seller === "string" && normalizeSuiAddress(data.seller) === owner) {
   curveLegs.tokensOut += digits(data.tokens_in);
   curveLegs.suiOut += digits(data.sui_out);
  } else if (sentByOwner && pool && pool.coinIsA !== null && data.pool === pool.id && pool.isPoolSwap(type) && typeof data.atob === "boolean") {
   const sale = data.atob === pool.coinIsA;
   if (sale) { poolLegs.tokensOut += digits(data.amount_in); poolLegs.suiOut += digits(data.amount_out); }
   else { poolLegs.suiIn += digits(data.amount_in); poolLegs.tokensIn += digits(data.amount_out); }
  }
 }
 return { curve: curveLegs, pool: poolLegs };
}

export interface OwnerTrades { curve: TradeLegs; pool: TradeLegs }

/** The graduated pool, with whether the launch coin is its coin A (null when unread). */
export interface LaunchPool { id: string; coinIsA: boolean | null; isPoolSwap: (type: string) => boolean }

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

export interface LaterBuy { digest: string; timestamp: string; venue: "SuiPump" | "Cetus"; sui: bigint; tokens: bigint; after_first_sale: boolean }

export interface BuyerAccount {
 /** Launch-window curve buys before the owner's first sale. */
 initial: LaunchBuy[];
 /** Every other buy of the coin in the history, curve or pool, by event. */
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
}

/**
 * One buyer's launch accounting from its window history. `windowBuys` are the
 * discovery events; any other curve buy, a pool buy, or a window buy after the
 * first sale is a later buy and counts only gross. Proceeds are event amounts.
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
 const rows = input.history.filter((tx) => tx.status === "SUCCESS").map((tx) => ({ tx, trades: tradeLegs(tx.events, owner, curve, input.pool, tx.sender === owner) }));
 const sales = rows.filter(({ trades }) => trades.curve.tokensOut + trades.pool.tokensOut > 0n);
 const firstSaleAt = sales.length ? Math.min(...sales.map(({ tx }) => Date.parse(tx.timestamp))) : Number.POSITIVE_INFINITY;
 const windowDigests = new Set(input.windowBuys.map((b) => b.digest));
 const split = separateRebuys(input.windowBuys, firstSaleAt);
 const laterCurve = [...split.after_first_sale, ...rows.flatMap(({ tx }) => windowDigests.has(tx.digest) ? [] : tx.events
  .filter((e) => e.data.curve_id === curve && e.type.endsWith("::bonding_curve::TokensPurchased")
   && typeof e.data.buyer === "string" && normalizeSuiAddress(e.data.buyer) === owner)
  .map((e) => accountBuy({
   digest: tx.digest, timestamp: tx.timestamp, buyer: owner, curve_id: curve,
   sui_in: String(e.data.sui_in), tokens_out: String(e.data.tokens_out),
   referral: typeof e.data.referral === "string" ? e.data.referral : null,
  }, tx.changes, tx.gas)))];
 const later: LaterBuy[] = [
  ...laterCurve.map((b) => ({ digest: b.digest, timestamp: b.timestamp, venue: "SuiPump" as const, sui: b.sui_in, tokens: b.tokens_out, after_first_sale: Date.parse(b.timestamp) > firstSaleAt })),
  ...rows.filter(({ trades }) => trades.pool.tokensIn > 0n).map(({ tx, trades }) => ({ digest: tx.digest, timestamp: tx.timestamp, venue: "Cetus" as const, sui: trades.pool.suiIn, tokens: trades.pool.tokensIn, after_first_sale: Date.parse(tx.timestamp) > firstSaleAt })),
 ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
 const trades: TradeLegs = { suiIn: 0n, suiOut: 0n, tokensIn: 0n, tokensOut: 0n };
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
  account: reconcileLaunchWindow({
   owner, suiType: input.suiType, tokenType: input.coinType, transactions: input.history,
   trades, forwardedSui: input.forwardedSui, forwardedTokens: input.forwardedTokens,
  }),
 };
}
export const decimalAmount = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;
