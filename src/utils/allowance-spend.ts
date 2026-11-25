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
  /** The transaction's sender, which the allowance must name as its spender for the spend to succeed. */
  sender: string | null;
  coin_type: string | null;
  /** The most the withdrawal input reserved. What moved is in balance_changes. */
  max_amount: string;
  /**
   * `read`: `allowance_now` is the allowance as it stands now. `absent`: a
   * successful read found no Allowance at that id, which is what revoking
   * leaves. `read_failed`: the state is unknown.
   */
  allowance_state: "read" | "absent" | "read_failed";
  allowance_now: AllowanceInfo | null;
  /** False when the allowance now names someone other than the sender (an app can rotate its spender). */
  sender_is_spender_now?: boolean;
}

const NOTE =
  "Each entry is a withdrawal from `funder`'s address balance under a native allowance (0x2::allowance). The funder authorized this kind of spend in advance, when it created the allowance, and did not sign this transaction, so the funder's loss in balance_changes is a delegated spend within the allowance's limits, not by itself evidence of a stolen key. Whether the funder meant the spender to have it is a separate question: list_allowances(funder) shows every allowance it has granted and the AllowanceCap that revokes each. `allowance_now` is the allowance's current state, not its state when this transaction ran; `allowance_state: absent` means no allowance exists at that id now, which is what revoking leaves.";

const FAILED_NOTE =
  "This transaction failed, so none of these withdrawals happened: a failed transaction moves nothing but gas, and an allowance charges nothing unless its checks pass (the sender must be the spender, inside the time window and the limits). Each entry names an allowance the sender tried to draw on, which is a lead about the sender, not a spend from the funder.";

/**
 * `allowance_spends` and its note, or an empty object when no withdrawal
 * drew on an allowance. A failed allowance read is `read_failed`, never
 * read as revoked.
 */
export async function allowanceSpends(
  withdrawals: FundsWithdrawalInput[],
  sender: string | null,
  succeeded: boolean,
): Promise<Record<string, unknown>> {
  const under = withdrawals.filter((w) => w.source === "sender_allowance" && w.funder && w.allowance);
  if (under.length === 0) return {};
  let states: Map<string, AllowanceInfo> | null = null;
  let unavailable: string | null = null;
  try {
    states = await readAllowances(under.map((w) => w.allowance!));
  } catch (err) {
    unavailable = `The allowances could not be read (${describeError(err, getNetwork())}), so their limits and current state are unknown, not revoked.`;
  }
  const senderNorm = sender ? normalizeSuiAddress(sender) : null;
  const rows: AllowanceSpendRow[] = under.map((w) => {
    const id = normalizeSuiAddress(w.allowance!);
    const now = states?.get(id) ?? null;
    return {
      allowance_id: id,
      funder: normalizeSuiAddress(w.funder!),
      sender: senderNorm,
      coin_type: w.coin_type,
      max_amount: w.amount,
      allowance_state: states === null ? "read_failed" : now ? "read" : "absent",
      allowance_now: now,
      ...(now && senderNorm && now.spender ? { sender_is_spender_now: now.spender === senderNorm } : {}),
    };
  });
  const mismatch = rows.some((r) => r.sender_is_spender_now === false);
  return {
    allowance_spends: rows,
    allowance_spends_note: succeeded ? NOTE : FAILED_NOTE,
    ...(succeeded ? {} : { allowance_spends_executed: false }),
    ...(mismatch
      ? {
          allowance_spender_note:
            "An allowance listed here now names a spender other than this transaction's sender. A successful spend proves the sender was the spender when it ran; an app-bound allowance's app can rotate the spender since, so the current spender is not who signed this.",
        }
      : {}),
    ...(unavailable ? { allowance_state_unavailable: unavailable } : {}),
  };
}
