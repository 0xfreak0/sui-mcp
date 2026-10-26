import { normalizeSuiAddress } from "@mysten/sui/utils";

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
 buy_sui_debit_incl_gas: bigint;
 reconciliation_failed: boolean;
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


/** The event is the trade's own account; the transaction's net includes gas and other calls. */
export function accountBuy(event: LaunchEvent, changes: LaunchChange[], coinType: string): LaunchBuy {
 const buyer = normalizeSuiAddress(event.buyer);
 const sui = BigInt(event.sui_in);
 const tokens = BigInt(event.tokens_out);
 const debit = -changes.filter((c) => c.address === buyer && c.coin_type.endsWith("::sui::SUI"))
  .reduce((sum, c) => sum + c.amount, 0n);
 const received = changes.filter((c) => c.address === buyer && c.coin_type === coinType)
  .reduce((sum, c) => sum + c.amount, 0n);
 // The event's token amount can differ from the buyer's net if the same PTB
 // forwards the freshly bought coins. Do not infer an error from that shape.
 const differentToken = received > tokens;
 return {
  digest: event.digest,
  timestamp: event.timestamp,
  sui_in: sui,
  tokens_out: tokens,
  referral: event.referral ? normalizeSuiAddress(event.referral) : null,
  buy_sui_debit_incl_gas: debit,
  reconciliation_failed: debit < sui - 10_000_000n || debit - sui > 10_000_000n || differentToken,
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

export interface LaunchReconciliationTx {
 digest: string;
 sender: string | null;
 sponsor: string | null;
 gas: bigint | null;
 changes: LaunchChange[];
}

/**
 * Cross-check the event ledger against the owner's on-chain balance-change
 * deltas over exactly the same closed transaction window. The balance at the
 * start is unknown unless a separate historical balance read establishes it;
 * a window delta must never be labelled a closing balance.
 */
export function reconcileLaunchWindow(input: {
 owner: string;
 suiType: string;
 tokenType: string;
 transactions: LaunchReconciliationTx[];
 fundingSui: bigint;
 purchasedSui: bigint;
 rebuySui: bigint;
 cetusSuiNet: bigint;
 cetusSaleDigests: ReadonlySet<string>;
 forwardedSui: bigint;
 boughtTokens: bigint;
 soldTokens: bigint;
 forwardedTokens: bigint;
}): {
 complete: boolean;
 gasNotAlreadyInProceeds: bigint;
 suiExpectedDelta: bigint;
 suiObservedDelta: bigint;
 suiResidual: bigint;
 tokenExpectedDelta: bigint;
 tokenObservedDelta: bigint;
 tokenResidual: bigint;
} {
 const owner = normalizeSuiAddress(input.owner);
 const delta = (coin: string) => sumRaw(input.transactions.flatMap((tx) =>
  tx.changes.filter((change) => change.address === owner && change.coin_type === coin).map((change) => change.amount)
 ));
 const gas = sumRaw(input.transactions.filter((tx) =>
  (tx.sponsor ?? tx.sender) === owner && !input.cetusSaleDigests.has(tx.digest)
 ).map((tx) => tx.gas ?? 0n));
 const expectedSui = input.fundingSui + input.cetusSuiNet - input.purchasedSui
  - input.rebuySui - input.forwardedSui - gas;
 const expectedTokens = input.boughtTokens - input.soldTokens - input.forwardedTokens;
 const observedSui = delta(input.suiType);
 const observedTokens = delta(input.tokenType);
 return {
  complete: input.transactions.every((tx) => tx.gas !== null),
  gasNotAlreadyInProceeds: gas,
  suiExpectedDelta: expectedSui,
  suiObservedDelta: observedSui,
  suiResidual: expectedSui - observedSui,
  tokenExpectedDelta: expectedTokens,
  tokenObservedDelta: observedTokens,
  tokenResidual: expectedTokens - observedTokens,
 };
}
export const decimalAmount = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;
