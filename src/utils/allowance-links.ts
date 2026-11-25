/**
 * Native allowances as links between addresses, for fund tracing and wallet
 * clustering.
 *
 * A spend under an allowance is sent and signed by the spender while the
 * funder's address balance pays. Two consequences:
 *
 * - **Tracing.** A forward trace looks for a holder's spends among the
 *   transactions it sent, and a funder's money leaving through an allowance
 *   is in a transaction the spender sent. Such a spend is found among the
 *   transactions in which the funder's balance fell while another address
 *   signed (`affectedAddress`), and confirmed by the transaction's own
 *   `FundsWithdrawal` input naming the funder (gRPC source 3).
 * - **Clustering.** An allowance is chain-derived control: the funder's key
 *   authorized this spender to draw on its balance. It is not evidence of
 *   shared ownership, since an app or an agent session holds spender keys for
 *   many users, so a spender named by many funders is a service.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork, type SuiNetwork } from "../config.js";
import { withArchiveFallback } from "./archive-fallback.js";
import { readFundsWithdrawals, type FundsWithdrawalInput, type GrpcFundsInput } from "./address-balance.js";

/** One withdrawal a transaction drew from `funder`'s balance under an allowance. */
export interface AllowanceDraw {
  funder: string;
  /** The transaction's sender, which a successful spend proves was the allowance's spender. */
  spender: string | null;
  allowance_id: string;
  coin_type: string | null;
  /** The most the withdrawal input reserved. */
  max_amount: string;
}

/**
 * The withdrawals in `withdrawals` that draw on `funder`'s balance under an
 * allowance. Pure. A funder that is the sender is not an allowance spend of
 * someone else's balance and is left out.
 */
export function allowanceDrawsFrom(
  withdrawals: readonly FundsWithdrawalInput[],
  funder: string,
  sender: string | null,
): AllowanceDraw[] {
  const f = normalizeSuiAddress(funder);
  const s = sender ? normalizeSuiAddress(sender) : null;
  if (s === f) return [];
  return withdrawals
    .filter((w) => w.source === "sender_allowance" && w.funder && w.allowance && normalizeSuiAddress(w.funder) === f)
    .map((w) => ({
      funder: f,
      spender: s,
      allowance_id: normalizeSuiAddress(w.allowance!),
      coin_type: w.coin_type,
      max_amount: w.amount,
    }));
}

/** Every allowance withdrawal in `withdrawals`, whoever funds it. Pure. */
export function allowanceDraws(withdrawals: readonly FundsWithdrawalInput[], sender: string | null): AllowanceDraw[] {
  const funders = new Set(
    withdrawals.filter((w) => w.source === "sender_allowance" && w.funder).map((w) => normalizeSuiAddress(w.funder!)),
  );
  return [...funders].flatMap((f) => allowanceDrawsFrom(withdrawals, f, sender));
}

/** `GetTransactionResponse`: an `ExecutedTransaction` whose `transaction` is the signed data. */
interface TxInputsResponse {
  transaction?: {
    transaction?: {
      sender?: string;
      kind?: { data: { oneofKind?: string; programmableTransaction?: { inputs?: GrpcFundsInput[] } } };
    };
  };
}

/**
 * Each digest's `FundsWithdrawal` inputs and sender, read over gRPC with
 * archive fallback (a point lookup, and GraphQL's input list is a page).
 * A digest whose read failed maps to `null`, never to an empty list: an
 * unread transaction has not been shown to draw on nobody.
 */
export async function readTxWithdrawals(
  digests: readonly string[],
): Promise<Map<string, { sender: string | null; withdrawals: FundsWithdrawalInput[] } | null>> {
  const out = new Map<string, { sender: string | null; withdrawals: FundsWithdrawalInput[] } | null>();
  await Promise.all(
    [...new Set(digests)].map(async (digest) => {
      try {
        const res = (await withArchiveFallback(
          (client) => client.ledgerService.getTransaction({ digest, readMask: { paths: ["digest", "transaction"] } }),
          (r) => !r.transaction?.transaction,
        )) as TxInputsResponse;
        const signed = res.transaction?.transaction;
        if (!signed) throw new Error("no transaction data");
        const kind = signed.kind;
        const inputs = kind?.data.oneofKind === "programmableTransaction" ? kind.data.programmableTransaction?.inputs ?? [] : [];
        out.set(digest, { sender: signed.sender ?? null, withdrawals: readFundsWithdrawals(inputs) });
      } catch {
        out.set(digest, null);
      }
    }),
  );
  return out;
}

/* Whether an address funds any allowance now: the forward trace's gate. */

const CAPS_TTL_MS = 5 * 60 * 1000;
const capsCache = new Map<string, { holds: boolean; readAt: number }>();

/** Test-only. */
export function resetAllowanceCapsCache(): void {
  capsCache.clear();
}

const HOLDS_CAP_QUERY = `query ($a: SuiAddress!) {
  address(address: $a) { objects(first: 1, filter: { type: "0x2::allowance::AllowanceCap" }) { nodes { address } } }
}`;

/**
 * Whether `address` holds an `AllowanceCap` now, so funds at least one live
 * allowance. One request, cached five minutes per network. `null` when the
 * read failed: unknown, never "funds none". An allowance revoked before the
 * read leaves no cap, so `false` says nothing about spends made under one.
 */
export async function holdsAllowanceCaps(address: string): Promise<boolean | null> {
  const network: SuiNetwork = getNetwork();
  const key = `${network}|${normalizeSuiAddress(address)}`;
  const hit = capsCache.get(key);
  if (hit && Date.now() - hit.readAt < CAPS_TTL_MS) return hit.holds;
  try {
    const d = await gqlQuery<{ address?: { objects?: { nodes?: Array<{ address?: string }> } | null } | null }>(
      HOLDS_CAP_QUERY,
      { a: address },
    );
    const holds = (d.address?.objects?.nodes?.length ?? 0) > 0;
    capsCache.set(key, { holds, readAt: Date.now() });
    return holds;
  } catch {
    return null;
  }
}

/** One line naming what an allowance spend means for the hop it is on. */
export function allowanceSpendNote(draw: AllowanceDraw): string {
  return (
    `${draw.spender ?? "The sender"} sent this transaction as the spender of allowance ${draw.allowance_id}, drawing on ` +
    `${draw.funder}'s address balance. ${draw.funder} authorized the spend when it created the allowance and did not sign ` +
    "this transaction, so the funds moved here are the funder's although the spender signed. list_allowances shows the allowance's limits and current state."
  );
}
