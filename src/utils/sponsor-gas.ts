/**
 * A gas sponsor's SUI change is gas, never a payment.
 *
 * The gas payer's SUI change nets computation and storage against the storage
 * rebate, and the rebate goes to whoever paid gas. A sweep deletes coin
 * objects, so the sponsor of a sweep ends with a positive SUI change nobody
 * sent it: in G9ygnUnq… a deposit address moved 879,484 SUI to an exchange
 * and the sponsor `0x85c81a4f…` shows +0.0057 SUI. Read as a balance change,
 * that is a second recipient.
 *
 * Only a sponsor who is not the sender is gas-only. A self-paid transaction
 * reports the sender as its own sponsor, and the sender's SUI change carries
 * its real payments as well as its gas.
 */

const SUI_COIN = /^0x0*2::sui::SUI$/;

export function isSuiCoinType(coinType: string | null | undefined): boolean {
  return typeof coinType === "string" && SUI_COIN.test(coinType);
}

/** The party that paid gas for someone else's transaction, or null. */
export function gasOnlySponsor(sender: string | null | undefined, sponsor: string | null | undefined): string | null {
  return sponsor && sponsor !== sender ? sponsor : null;
}

/** True when this balance change is the gas-only sponsor's SUI change. */
export function isSponsorGasChange(
  owner: string | null | undefined,
  coinType: string | null | undefined,
  sender: string | null | undefined,
  sponsor: string | null | undefined,
): boolean {
  const gasOnly = gasOnlySponsor(sender, sponsor);
  return gasOnly !== null && owner === gasOnly && isSuiCoinType(coinType);
}
