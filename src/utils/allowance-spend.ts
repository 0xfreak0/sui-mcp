/**
 * What a transaction drew under native allowances, for `get_transaction`.
 *
 * A spend under an allowance debits the funder's address balance in a
 * transaction the funder never signed. Read without the allowance, that is
 * the shape of a theft, so every such withdrawal is reported with the
 * allowance that authorized it.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { FundsWithdrawalInput } from "./address-balance.js";
import { readAllowances, type AllowanceInfo } from "./allowance.js";
import { describeError } from "./errors.js";
import { getNetwork } from "../config.js";

export interface AllowanceSpendRow {
  allowance_id: string;
  funder: string;
  /** The transaction's sender, which the allowance must name as its spender. */
  spender: string | null;
  coin_type: string | null;
  /** The most the withdrawal input reserved. What moved is in balance_changes. */
  max_amount: string;
  /** The allowance as it stands now; null once revoked (the object is deleted). */
  allowance_now: AllowanceInfo | null;
}

const NOTE =
  "Each entry is a withdrawal from `funder`'s address balance under a native allowance (0x2::allowance) that names the sender as its spender. The funder authorized this kind of spend in advance, when it created the allowance, and did not sign this transaction, so the funder's loss in balance_changes is a delegated spend within the allowance's limits, not by itself evidence of a stolen key. Whether the funder meant the spender to have it is a separate question: list_allowances(funder) shows every allowance it has granted and the AllowanceCap that revokes each. `allowance_now` is the allowance's current state, not its state when this transaction ran; null means it has been revoked since.";

/**
 * `allowance_spends` and its note, or an empty object when no withdrawal
 * drew on an allowance. A failed allowance read leaves `allowance_now` null
 * and says so in `allowance_state_unavailable`.
 */
export async function allowanceSpends(
  withdrawals: FundsWithdrawalInput[],
  sender: string | null,
): Promise<Record<string, unknown>> {
  const under = withdrawals.filter((w) => w.source === "sender_allowance" && w.funder && w.allowance);
  if (under.length === 0) return {};
  let states: Map<string, AllowanceInfo> | null = null;
  let unavailable: string | null = null;
  try {
    states = await readAllowances(under.map((w) => w.allowance!));
  } catch (err) {
    unavailable = `The allowances could not be read (${describeError(err, getNetwork())}), so their limits and current state are unknown.`;
  }
  const rows: AllowanceSpendRow[] = under.map((w) => {
    const id = normalizeSuiAddress(w.allowance!);
    return {
      allowance_id: id,
      funder: normalizeSuiAddress(w.funder!),
      spender: sender ? normalizeSuiAddress(sender) : null,
      coin_type: w.coin_type,
      max_amount: w.amount,
      allowance_now: states?.get(id) ?? null,
    };
  });
  return {
    allowance_spends: rows,
    allowance_spends_note: NOTE,
    ...(unavailable ? { allowance_state_unavailable: unavailable } : {}),
  };
}
