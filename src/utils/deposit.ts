import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getLabel, labelProvenance } from "./labels.js";
import { measureFanout, type FanoutResult } from "./fanout.js";
import { decimalsForCoinType, displayCoin, prefetchCoinScale, toHumanAmount } from "./valuation.js";
import { isSponsorGasChange, isSuiCoinType } from "./sponsor-gas.js";
import { BALANCE_CHANGES_SELECTION, completeTxConnections } from "./tx-connections.js";
import type { GqlConnection } from "./tx-connections.js";
import type { GqlBalanceChangeNode } from "./gql-adapters.js";
import { describeWindow, resolveWindow } from "./checkpoint-time.js";
import { anchorCheckpoint, readBalanceRange } from "./historical-balance.js";
import { rememberDepositVerdict } from "./deposit-role.js";

/**
 * Is this address an exchange deposit address?
 *
 * An exchange gives each customer a deposit address, then sweeps everything
 * that lands there into a hot wallet. The deposit address is what ties a
 * customer to an account, so it is the identifier a subpoena names. Three
 * observations make the pattern, and each one alone has innocent explanations:
 *
 *   1. Every outflow goes to one destination D, and each outflow is a
 *      full-balance sweep: the coin's balance is zero right after it, apart
 *      from a small SUI gas reserve on a sweep the address paid gas for, or a
 *      deposit that arrived while the sweep was pending and is swept next.
 *   2. The sweep's gas is paid by a sponsor that pays for many unrelated
 *      senders (relayer-shaped). Exchanges sponsor sweeps so deposit addresses
 *      never need SUI of their own.
 *   3. D is a disclosed exchange wallet, or at least hub-shaped.
 *
 * The verdict is `heuristic`: it names a pattern, not a disclosure. Every
 * check runs whatever an earlier one found, and a check that cannot run says
 * why in `checks_not_run`, so a verdict never rests on a check that was skipped.
 */

/**
 * SUI a self-paid sweep may leave behind and still count as a full-balance
 * sweep. An address that pays its own gas has to keep SUI for the next sweep's
 * gas, so its SUI never reaches zero. A Sui transfer costs a few thousandths of
 * a SUI, so this bound is a reserve for hundreds of sweeps, while a transfer
 * that leaves more than it did not empty the address. A sponsored sweep needs
 * no reserve, and other coins pay no gas, so both must be swept whole.
 */
export const SWEEP_GAS_RESERVE_MIST = 1_000_000_000n;

export interface BalanceChange {
  owner: string;
  coinType: string;
  amount: bigint;
}

export interface ScannedTx {
  digest: string;
  timestamp: string | null;
  checkpoint?: number | null;
  sender: string | null;
  gasSponsor: string | null;
  changes: BalanceChange[];
}

export interface DepositScan {
  address: string;
  /** Oldest first. */
  txs: ScannedTx[];
  /** True when every transaction in the requested window was read. */
  complete: boolean;
  /** Balance per coin at the window's upper end. Null when reconstruction is incomplete. */
  currentBalances: Map<string, bigint> | null;
}

export interface SweepCoin {
  coin_type: string;
  symbol: string;
  amount: string;
  /** Raw balance of this coin right after the sweep, or null when unknown. */
  balance_after_raw: string | null;
}

export interface Sweep {
  digest: string;
  timestamp: string | null;
  destination: string;
  coins: SweepCoin[];
  /**
   * True when every swept coin is at zero right after the transfer, or when
   * the only thing left is SUI within the gas reserve on a self-paid sweep.
   * Null when the balance after is unknown.
   */
  full_balance: boolean | null;
  /** SUI left behind as the gas reserve, when full_balance holds only because of it. */
  kept_for_gas?: string;
  /**
   * A balance left behind that counts as the next sweep's deposit, when
   * full_balance holds only because of it. `arrived_in` are the latest
   * deposits it equals; `swept_by` is the next transfer of the coin, to the
   * same destination, that took this balance (the coin reached zero then or
   * in a later sweep), absent while no later outflow of the coin is in the
   * window.
   */
  left_for_next_sweep?: { left: string; arrived_in: string[]; swept_by?: string };
  /** Gas payer when it is not the address itself. */
  sponsor: string | null;
}

export interface OtherOutflow {
  digest: string;
  timestamp: string | null;
  recipients: string[];
  reason: string;
}

export interface Deposit {
  digest: string;
  timestamp: string | null;
  from: string[];
  coins: Array<{ coin_type: string; symbol: string; amount: string }>;
}

export interface DepositPattern {
  sweeps: Sweep[];
  otherOutflows: OtherOutflow[];
  deposits: Deposit[];
  destinations: string[];
  sponsors: string[];
}

const human = (raw: bigint, coinType: string) =>
  `${toHumanAmount(raw, decimalsForCoinType(coinType))} ${displayCoin(coinType).symbol}`;

/** Per-coin net change for one owner in one transaction. */
function netFor(tx: ScannedTx, owner: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const c of tx.changes) {
    if (c.owner !== owner) continue;
    out.set(c.coinType, (out.get(c.coinType) ?? 0n) + c.amount);
  }
  return out;
}

/**
 * Read the window into sweeps, other outflows and deposits.
 *
 * Balance after each transaction is reconstructed backwards from the balance
 * at the window's upper end. Historical scans first undo later changes from
 * a checkpoint-pinned balance anchor.
 *
 * A sweep that leaves a balance is still full when that balance equals the
 * latest deposits of the coin since its previous outflow, and the next
 * outflow of the coin is a transfer to the same destination that empties it
 * or is not in the window yet. An exchange sweeps credited deposits, so one
 * that arrives while a sweep is pending stays behind until the next one.
 */
export function readDepositPattern(scan: DepositScan): DepositPattern {
  const { address } = scan;
  const drafts: Array<{ index: number; tx: ScannedTx; destination: string; coins: SweepCoin[]; sponsor: string | null }> = [];
  const otherOutflows: OtherOutflow[] = [];
  const deposits: Deposit[] = [];
  const nets = scan.txs.map((tx) => netFor(tx, address));

  // balanceAfter[i] for each coin: current minus every later change.
  const after: Array<Map<string, bigint> | null> = new Array(scan.txs.length).fill(null);
  if (scan.currentBalances) {
    const running = new Map(scan.currentBalances);
    for (let i = scan.txs.length - 1; i >= 0; i--) {
      after[i] = new Map(running);
      for (const [coin, delta] of netFor(scan.txs[i]!, address)) {
        running.set(coin, (running.get(coin) ?? 0n) - delta);
      }
    }
  }

  scan.txs.forEach((tx, i) => {
    const own = nets[i]!;
    const sponsor = tx.gasSponsor && tx.gasSponsor !== address ? tx.gasSponsor : null;
    const lost = [...own].filter(([, d]) => d < 0n);
    const gained = [...own].filter(([, d]) => d > 0n);

    if (lost.length > 0) {
      // Who gained what this address lost. A gas sponsor's SUI change is gas
      // or a storage rebate (sweeping deletes coin objects, and the rebate goes
      // to whoever paid gas), never a payment, so it is not a recipient.
      const recipients = new Set<string>();
      for (const c of tx.changes) {
        if (c.owner === address || c.amount <= 0n) continue;
        if (isSponsorGasChange(c.owner, c.coinType, tx.sender, tx.gasSponsor)) continue;
        if (lost.some(([coin]) => coin === c.coinType)) recipients.add(c.owner);
      }
      if (recipients.size !== 1) {
        otherOutflows.push({
          digest: tx.digest,
          timestamp: tx.timestamp,
          recipients: [...recipients],
          reason:
            recipients.size === 0
              ? "Value left without a recipient gaining it (gas, a swap, or a protocol call)."
              : `Value went to ${recipients.size} recipients in one transaction.`,
        });
        return;
      }
      const destination = [...recipients][0]!;
      // Only coins the destination received were swept. A SUI loss it did not
      // receive is the address paying its own gas, and gas never zeroes a balance.
      const received = new Set(
        tx.changes.filter((c) => c.owner === destination && c.amount > 0n).map((c) => c.coinType),
      );
      const coins: SweepCoin[] = lost
        .filter(([coin]) => received.has(coin))
        .map(([coin, delta]) => {
          const bal = after[i]?.get(coin);
          return {
            coin_type: coin,
            symbol: displayCoin(coin).symbol,
            amount: human(-delta, coin),
            balance_after_raw: after[i] ? String(bal ?? 0n) : null,
          };
        });
      drafts.push({ index: i, tx, destination, coins, sponsor });
      return;
    }

    if (gained.length > 0) {
      const from = new Set<string>();
      for (const c of tx.changes) {
        if (c.owner === address || c.amount >= 0n) continue;
        if (isSponsorGasChange(c.owner, c.coinType, tx.sender, tx.gasSponsor)) continue;
        if (gained.some(([coin]) => coin === c.coinType)) from.add(c.owner);
      }
      deposits.push({
        digest: tx.digest,
        timestamp: tx.timestamp,
        from: [...from],
        coins: gained.map(([coin, delta]) => ({
          coin_type: coin,
          symbol: displayCoin(coin).symbol,
          amount: human(delta, coin),
        })),
      });
    }
  });

  // Walk back so each sweep knows the next outflow of every coin it swept:
  // that outflow's digest and destination, and the sweep that finally
  // emptied the coin, null when nothing did.
  const nextOutflow = new Map<string, { digest: string; destination: string | null; emptiedBy: string | null }>();
  const built = new Map<number, Sweep>();
  let d = drafts.length - 1;
  for (let i = scan.txs.length - 1; i >= 0; i--) {
    const draft = drafts[d]?.index === i ? drafts[d--]! : null;
    if (!draft) {
      for (const [coin, delta] of nets[i]!) if (delta < 0n) nextOutflow.set(coin, { digest: scan.txs[i]!.digest, destination: null, emptiedBy: null });
      continue;
    }
    const { tx, destination, coins, sponsor } = draft;
    // A self-paid sweep keeps its gas reserve; see SWEEP_GAS_RESERVE_MIST.
    const selfPaid = sponsor === null && tx.sender === address;
    let full: boolean | null = after[i] ? true : null;
    let reserve: string | undefined;
    const carried: string[] = [];
    let sweptBy: string | undefined;
    const arrivedIn: string[] = [];
    for (const c of coins) {
      const left = BigInt(c.balance_after_raw ?? "0");
      let emptiedBy: string | null = full === null ? null : tx.digest;
      if (left !== 0n) {
        // Only a balance of zero empties the coin: a gas reserve is still there.
        emptiedBy = null;
        const next = nextOutflow.get(c.coin_type);
        const isReserve = selfPaid && isSuiCoinType(c.coin_type) && left <= SWEEP_GAS_RESERVE_MIST;
        const sweptNext = next ? (next.destination === destination ? next.emptiedBy : null) : undefined;
        const pending = !isReserve && sweptNext !== null ? depositsEqualTo(scan.txs, nets, i, c.coin_type, left) : null;
        if (isReserve) {
          reserve = human(left, c.coin_type);
        } else if (pending) {
          carried.push(human(left, c.coin_type));
          arrivedIn.push(...pending);
          if (sweptNext) {
            sweptBy ??= next!.digest;
            emptiedBy = sweptNext;
          }
        } else if (full) {
          full = false;
        }
      }
      nextOutflow.set(c.coin_type, { digest: tx.digest, destination, emptiedBy });
    }
    built.set(i, {
      digest: tx.digest,
      timestamp: tx.timestamp,
      destination,
      coins,
      full_balance: full,
      ...(full && reserve ? { kept_for_gas: reserve } : {}),
      ...(full && carried.length
        ? {
            left_for_next_sweep: {
              left: carried.join(", "),
              arrived_in: arrivedIn,
              ...(sweptBy ? { swept_by: sweptBy } : {}),
            },
          }
        : {}),
      sponsor,
    });
  }
  const sweeps = drafts.map((s) => built.get(s.index)!);

  return {
    sweeps,
    otherOutflows,
    deposits,
    destinations: [...new Set(sweeps.map((s) => s.destination))],
    sponsors: [...new Set(sweeps.map((s) => s.sponsor).filter((s): s is string => !!s))],
  };
}

/**
 * Digests of the latest deposits of `coin` before transaction `index`, back
 * to its previous outflow, whose amounts add up to exactly `amount`; null
 * when no run of them does.
 */
function depositsEqualTo(txs: readonly ScannedTx[], nets: ReadonlyArray<Map<string, bigint>>, index: number, coin: string, amount: bigint): string[] | null {
  const digests: string[] = [];
  let sum = 0n;
  for (let j = index - 1; j >= 0 && sum < amount; j--) {
    const delta = nets[j]!.get(coin) ?? 0n;
    if (delta < 0n) return null;
    if (delta === 0n) continue;
    sum += delta;
    digests.push(txs[j]!.digest);
  }
  return sum === amount ? digests.reverse() : null;
}

export type DepositVerdict = "likely" | "no" | "unknown";

export interface DestinationEvidence {
  /** The destination carries a disclosed or investigator-added `cex` label. */
  cexLabel: boolean;
  /** Fan-out classification of the destination, or null when not measured. */
  hub: boolean | null;
  /** The destination's own label is an inferred exchange deposit address, which never counts as `cexLabel`. */
  inferredDeposit?: boolean;
}

export interface VerdictResult {
  verdict: DepositVerdict;
  checks: {
    single_destination: boolean | null;
    full_balance_sweeps: boolean | null;
    sponsored_sweeps: boolean | null;
    sponsor_relayer_shaped: boolean | null;
    destination_is_exchange: boolean | null;
  };
  /** Why each null check could not run. Every null check has an entry. */
  checks_not_run: Partial<Record<keyof VerdictResult["checks"], string>>;
  reasons: string[];
}

/** Why a measurement the verdict uses was not taken, when the caller knows. */
export interface Unmeasured {
  sponsor?: string;
  destination?: string;
}

/** SUI has 9 decimals on every network. */
const RESERVE_TEXT = `${toHumanAmount(SWEEP_GAS_RESERVE_MIST, 9)} SUI`;

/**
 * Combine the pattern with what is known about the destination and the sweep
 * sponsor.
 *
 * `likely` needs every outflow to be a full-balance sweep to one destination
 * that is an exchange, AND either a relayer-shaped sponsor on the sweeps or a
 * disclosed exchange label on the destination. A hub-shaped destination with
 * self-paid sweeps stays `unknown`: a person consolidating into their own
 * exchange account produces the same outflows. `no` needs an outflow that is
 * observed not to be a sweep; a check that could not run never decides it.
 */
export function decideDepositVerdict(
  pattern: DepositPattern,
  destination: DestinationEvidence | null,
  sponsorShape: FanoutResult["sponsor_shape"] | null,
  unmeasured: Unmeasured = {},
): VerdictResult {
  const { sweeps, otherOutflows, destinations, sponsors } = pattern;
  const reasons: string[] = [];
  const checks: VerdictResult["checks"] = {
    single_destination: null,
    full_balance_sweeps: null,
    sponsored_sweeps: null,
    sponsor_relayer_shaped: null,
    destination_is_exchange: null,
  };
  const notRun: VerdictResult["checks_not_run"] = {};

  if (sweeps.length === 0 && otherOutflows.length === 0) {
    for (const key of Object.keys(checks) as Array<keyof typeof checks>) notRun[key] = "No outflow in the window to test.";
    reasons.push(
      "No outflows in the window. An exchange deposit address that has not been swept yet looks like any receive-only wallet.",
    );
    return { verdict: "unknown", checks, checks_not_run: notRun, reasons };
  }

  checks.single_destination = otherOutflows.length === 0 && destinations.length === 1;
  if (otherOutflows.length > 0) {
    const first = otherOutflows[0]!;
    reasons.push(
      `${otherOutflows.length} outflow(s) were not a transfer to a single recipient (e.g. ${first.digest}: ${first.reason}). A deposit address only sweeps, so this reads as a wallet that also spends or trades.`,
    );
  }
  if (destinations.length > 1) {
    reasons.push(`Transfers went to ${destinations.length} different destinations; a deposit address sweeps to one.`);
  }

  if (sweeps.length === 0) {
    const why = "No outflow was a transfer to a single recipient.";
    notRun.full_balance_sweeps = why;
    notRun.sponsored_sweeps = why;
    notRun.sponsor_relayer_shaped = why;
  } else {
    const into = destinations.length === 1 ? ` into ${destinations[0]}` : "";
    const partial = sweeps.filter((s) => s.full_balance === false);
    checks.full_balance_sweeps =
      partial.length > 0 ? false : sweeps.some((s) => s.full_balance === null) ? null : true;
    if (checks.full_balance_sweeps === false) {
      const first = partial[0]!;
      const residue = first.coins.filter((c) => c.balance_after_raw !== "0");
      const rule = residue.some((c) => !isSuiCoinType(c.coin_type))
        ? "a coin other than SUI pays no gas and is swept whole"
        : first.sponsor
          ? "a sponsored sweep needs no gas reserve"
          : `more than the ${RESERVE_TEXT} a self-paid sweep may keep for gas`;
      const left = residue.map((c) => human(BigInt(c.balance_after_raw!), c.coin_type)).join(", ");
      reasons.push(
        `${partial.length} of ${sweeps.length} transfer(s)${into} left a balance behind (e.g. ${first.digest} left ${left}; ${rule}). A deposit address is swept whole, so this reads as a payment rather than a sweep.`,
      );
    } else if (checks.full_balance_sweeps === null) {
      notRun.full_balance_sweeps =
        "The balance after each transfer could not be reconstructed; see balance_reconstruction and window for unread balances or limits.";
    } else {
      const reserved = sweeps.filter((s) => s.kept_for_gas).length;
      const carried = sweeps.filter((s) => s.left_for_next_sweep);
      const next = carried[0]?.left_for_next_sweep;
      const carriedText = next
        ? ` ${carried.length} of them left a balance that is a deposit the next sweep takes (left_for_next_sweep; e.g. ${carried[0]!.digest} left ${next.left}, which arrived in ${next.arrived_in.join(", ")} just before it and ${
            next.swept_by ? `was swept into the same destination by ${next.swept_by}` : "is not swept yet in the window"
          }). An exchange sweeps credited deposits, so a deposit that arrives while a sweep is pending waits for the next one.`
        : "";
      reasons.push(
        `All ${sweeps.length} transfer(s)${into} ${next ? "were full-balance sweeps" : `emptied the swept coin`}` +
          (reserved
            ? `; ${reserved} of them paid their own gas and left only SUI within the ${RESERVE_TEXT} gas reserve (kept_for_gas), which reads as gas for the next sweep.`
            : ".") +
          carriedText,
      );
    }

    const sponsored = sweeps.filter((s) => s.sponsor !== null).length;
    checks.sponsored_sweeps = sponsored === sweeps.length;
    const selfPaid = sponsored < sweeps.length ? ` The other ${sweeps.length - sponsored} paid their own gas.` : "";
    const paidBy = `${sponsored} of ${sweeps.length} transfer(s) had gas paid by ${sponsors.join(", ")}`;
    if (sponsored === 0) {
      checks.sponsor_relayer_shaped = false;
      reasons.push("Every transfer paid its own gas, so no sponsor points to an exchange relayer.");
    } else if (sponsorShape === null) {
      notRun.sponsor_relayer_shaped = unmeasured.sponsor ?? "The sponsor's sponsorship breadth was not measured.";
      reasons.push(`${paidBy}; its sponsorship breadth was not measured.${selfPaid}`);
    } else {
      checks.sponsor_relayer_shaped = sponsorShape === "relayer";
      reasons.push(
        (sponsorShape === "relayer"
          ? `${paidBy}, which sponsors many unrelated senders (relayer-shaped).`
          : sponsorShape === "operator"
            ? `${paidBy}, which also sent a coin to most of the addresses it sponsors; that fits an operator running its own wallets better than an exchange relayer.`
            : `${paidBy}, which sponsors few senders; that fits a private payer better than an exchange relayer.`) + selfPaid,
      );
    }
  }

  if (!destination) {
    notRun.destination_is_exchange =
      destinations.length > 1
        ? `Transfers went to ${destinations.length} destinations, so there is no single hot wallet to check.`
        : destinations.length === 0
          ? "No transfer to a single recipient, so there is no hot wallet to check."
          : (unmeasured.destination ?? "The destination was not looked up.");
  } else {
    checks.destination_is_exchange = destination.cexLabel || destination.hub === true ? true : destination.hub === null ? null : false;
    if (checks.destination_is_exchange === null) {
      notRun.destination_is_exchange =
        unmeasured.destination ?? "The destination carries no exchange label and its fan-out was not measured.";
    }
    reasons.push(
      destination.cexLabel
        ? "The destination carries a cex label."
        : destination.inferredDeposit
          ? "The destination is itself an inferred exchange deposit address, not a disclosed exchange wallet, so its label does not count as an exchange destination."
          : destination.hub === true
            ? "The destination is hub-shaped but carries no exchange label."
            : destination.hub === false
              ? "The destination is neither labelled as an exchange nor hub-shaped."
              : "The destination is not labelled and its fan-out was not measured.",
    );
  }

  const result = (verdict: DepositVerdict): VerdictResult => ({ verdict, checks, checks_not_run: notRun, reasons });
  if (checks.single_destination === false || checks.full_balance_sweeps === false) return result("no");
  const exchange = checks.destination_is_exchange === true;
  const strongSponsor = checks.sponsor_relayer_shaped === true;
  const labelled = destination?.cexLabel === true;
  if (checks.full_balance_sweeps === true && exchange && (strongSponsor || labelled)) return result("likely");
  if (checks.destination_is_exchange === false) {
    reasons.push("Without an exchange-shaped destination this reads as a wallet forwarding to one place, which is not specific to exchanges.");
  }
  return result("unknown");
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** Fields of each transaction node that {@link scannedTxsOf} reads. */
export const SCANNED_TX_FIELDS = `digest
      sender { address }
      gasInput { gasSponsor { address } }
      effects {
        timestamp
        checkpoint { sequenceNumber }
        ${BALANCE_CHANGES_SELECTION}
      }`;

const DEPOSIT_QUERY = `query ($addr: SuiAddress!, $last: Int!, $filter: TransactionFilter!, $before: String, $anchor: UInt53, $balances: Boolean!) {
  address(address: $addr, atCheckpoint: $anchor) @include(if: $balances) {
    balances(first: 50) { nodes { coinType { repr } totalBalance } pageInfo { hasNextPage } }
  }
  transactions(filter: $filter, last: $last, before: $before) {
    nodes {
      ${SCANNED_TX_FIELDS}
    }
    pageInfo { hasPreviousPage startCursor }
  }
}`;

export interface ScannedTxNode {
  digest: string;
  sender?: { address?: string } | null;
  gasInput?: { gasSponsor?: { address?: string } | null } | null;
  effects?: {
    timestamp?: string | null;
    checkpoint?: { sequenceNumber: number } | null;
    balanceChanges?: GqlConnection<GqlBalanceChangeNode> | null;
  } | null;
}

interface DepositQueryResult {
  address: {
    balances?: {
      nodes: Array<{ coinType?: { repr: string }; totalBalance?: string }>;
      pageInfo?: { hasNextPage?: boolean };
    } | null;
  } | null;
  transactions: {
    nodes: ScannedTxNode[];
    pageInfo: { hasPreviousPage: boolean; startCursor?: string | null };
  };
}

const tag = (t: string) => {
  try {
    return normalizeStructTag(t);
  } catch {
    return t;
  }
};

class IncompleteDepositScan extends Error {
  window?: DepositWindow;
  constructor(readonly digests: string[], readonly transactions: number) {
    super(`Incomplete balance changes for transaction(s): ${digests.join(", ")}. Deposit-address checks were not run.`);
  }
}

/**
 * Complete a page before exposing any changes to the pattern or label readers.
 * Throw on an unread connection so label synchronization leaves it unread,
 * rather than recording a rejection or inferring from part of a transaction.
 */
export async function scannedTxsOf(nodes: ScannedTxNode[]): Promise<ScannedTx[]> {
  const completed = await completeTxConnections(nodes.map((n) => ({ digest: n.digest, balanceChanges: n.effects?.balanceChanges })));
  const incomplete = nodes.filter((n, i) => !n.effects?.balanceChanges || completed[i]!.balanceChangesTruncated);
  if (incomplete.length) throw new IncompleteDepositScan(incomplete.map((n) => n.digest), nodes.length);
  return nodes.map((n, i) => ({
    digest: n.digest,
    timestamp: n.effects?.timestamp ?? null,
    checkpoint: n.effects?.checkpoint?.sequenceNumber ?? null,
    sender: n.sender?.address ?? null,
    gasSponsor: n.gasInput?.gasSponsor?.address ?? null,
    changes: completed[i]!.balanceChanges
      .filter((c) => c.owner?.address && c.coinType?.repr && c.amount !== undefined)
      .map((c) => ({ owner: c.owner!.address, coinType: tag(c.coinType!.repr), amount: BigInt(c.amount!) })),
  }));
}

export interface DepositWindow {
  from: string | number | null;
  to: string | number | null;
  after_checkpoint: number | null;
  before_checkpoint: number | null;
  requested_before_checkpoint?: number;
  anchor_limited?: boolean;
  oldest: { checkpoint: number | null; timestamp: string | null; digest: string } | null;
  newest: { checkpoint: number | null; timestamp: string | null; digest: string } | null;
  max_transactions: number;
  scanned_transactions: number;
  reads: number;
  max_reads: number;
  older_transactions_remaining: boolean;
  complete: boolean;
  continue_with?: { to: string };
  note: string;
}

export interface BalanceReconstruction {
  anchor_checkpoint: number | null;
  through_checkpoint: number | null;
  scanned_transactions: number;
  max_transactions: number;
  reads: number;
  max_reads: number;
  complete: boolean;
  reached_checkpoint?: number | null;
  unavailable?: string;
}

interface DepositRead extends DepositScan {
  window: DepositWindow;
  balance_reconstruction: BalanceReconstruction | null;
}

/** Newest-first reads, returned oldest first for the sweep reconstruction. */
export async function scanForDeposit(address: string, last = 50, options: ClassifyOptions = {}): Promise<DepositRead> {
  const addr = normalizeSuiAddress(address);
  const resolved = await resolveWindow(options.from, options.to);
  const filter: Record<string, string | number> = { affectedAddress: addr };
  if (resolved.after?.checkpoint != null) filter.afterCheckpoint = resolved.after.checkpoint;
  if (resolved.before?.checkpoint != null) filter.beforeCheckpoint = resolved.before.checkpoint;
  const historical = resolved.before?.checkpoint != null;
  const range = historical ? await readBalanceRange() : null;
  const anchor = range ? anchorCheckpoint(range) : null;
  // The anchor bounds the scan too: a newer sweep cannot be reconstructed
  // from an older balance.
  if (anchor !== null) filter.beforeCheckpoint = Math.min(Number(filter.beforeCheckpoint), anchor + 1);
  const window: DepositWindow = {
    ...describeWindow(options.from, options.to, resolved),
    before_checkpoint: typeof filter.beforeCheckpoint === "number" ? filter.beforeCheckpoint : null,
    oldest: null, newest: null, max_transactions: last, scanned_transactions: 0, complete: false,
    reads: 0, max_reads: 100, older_transactions_remaining: false,
    note: "Verdict covers only the transactions read, newest first, not the address's lifetime. Older sweeps can support a different verdict; choose from/to for the period in question.",
  };
  if (resolved.before?.checkpoint != null && filter.beforeCheckpoint !== resolved.before.checkpoint) {
    window.requested_before_checkpoint = resolved.before.checkpoint;
    window.anchor_limited = true;
    window.note += ` The balance anchor caps the read before checkpoint ${filter.beforeCheckpoint}; the newer part of the requested period was not read. Retry later to include it.`;
  }
  const nodes: ScannedTxNode[] = [];
  let before: string | undefined;
  let balances: DepositQueryResult["address"] = null;
  // Empty filtered pages may still have a continuation.
  for (let reads = 0; reads < window.max_reads && nodes.length < last; reads++) {
    const res = await gqlQuery<DepositQueryResult>(DEPOSIT_QUERY, {
      addr, last: Math.min(50, last - nodes.length), filter, before, anchor, balances: reads === 0,
    });
    if (reads === 0) balances = res.address;
    window.reads++;
    nodes.unshift(...res.transactions.nodes);
    const page = res.transactions.pageInfo;
    window.older_transactions_remaining = page.hasPreviousPage;
    if (!page.hasPreviousPage) { window.complete = !window.anchor_limited; break; }
    if (!page.startCursor || page.startCursor === before) {
      window.note += " The service reported older transactions without a usable continuation cursor.";
      break;
    }
    before = page.startCursor;
  }
  const point = (n: ScannedTxNode | undefined) => n ? {
    checkpoint: n.effects?.checkpoint?.sequenceNumber ?? null, timestamp: n.effects?.timestamp ?? null, digest: n.digest,
  } : null;
  window.oldest = point(nodes[0]);
  window.newest = point(nodes.at(-1));
  window.scanned_transactions = nodes.length;
  if (window.older_transactions_remaining && window.oldest?.checkpoint != null) {
    window.continue_with = { to: String(window.oldest.checkpoint + 1) };
    window.note += " continue_with re-reads the boundary checkpoint; verdicts for separate windows are not a combined classification. Raise max_transactions if that checkpoint fills the scan.";
  }
  let txs: ScannedTx[];
  try { txs = await scannedTxsOf(nodes); }
  catch (err) {
    if (err instanceof IncompleteDepositScan) err.window = { ...window, complete: false };
    throw err;
  }
  const list = balances?.balances;
  let currentBalances = list && !list.pageInfo?.hasNextPage
    ? new Map(list.nodes.filter((b) => b.coinType?.repr && b.totalBalance !== undefined)
      .map((b) => [tag(b.coinType!.repr), BigInt(b.totalBalance!)] as const))
    : null;
  let reconstruction: BalanceReconstruction | null = null;
  if (historical) {
    const through = Number(filter.beforeCheckpoint) - 1;
    reconstruction = {
      anchor_checkpoint: anchor, through_checkpoint: through,
      scanned_transactions: 0, max_transactions: options.maxBalanceTransactions ?? 1000,
      reads: 0, max_reads: 200,
      complete: false,
    };
    if (through < 0) {
      currentBalances = new Map();
      reconstruction.complete = true;
    } else if (anchor === null || !currentBalances) {
      currentBalances = null;
      reconstruction.unavailable = "The checkpoint-pinned balance anchor was unreadable or its coin list was incomplete.";
    } else if (through === anchor) {
      reconstruction.complete = true;
    } else {
      let cursor: string | undefined;
      try {
        for (let reads = 0; reads < reconstruction.max_reads && reconstruction.scanned_transactions < reconstruction.max_transactions; reads++) {
          const later = await gqlQuery<DepositQueryResult>(DEPOSIT_QUERY, {
            addr, anchor, balances: false, last: Math.min(50, reconstruction.max_transactions - reconstruction.scanned_transactions),
            filter: { affectedAddress: addr, afterCheckpoint: through, beforeCheckpoint: anchor + 1 }, before: cursor,
          });
          reconstruction.reads++;
          reconstruction.scanned_transactions += later.transactions.nodes.length;
          reconstruction.reached_checkpoint = later.transactions.nodes[0]?.effects?.checkpoint?.sequenceNumber ?? reconstruction.reached_checkpoint ?? null;
          for (const tx of await scannedTxsOf(later.transactions.nodes)) {
            for (const [coin, delta] of netFor(tx, addr)) currentBalances.set(coin, (currentBalances.get(coin) ?? 0n) - delta);
          }
          const page = later.transactions.pageInfo;
          if (!page.hasPreviousPage) { reconstruction.complete = true; break; }
          if (!page.startCursor || page.startCursor === cursor) break;
          cursor = page.startCursor;
        }
        if (!reconstruction.complete) reconstruction.unavailable =
          "Later transactions remain unread within the transaction/read budgets, or their continuation cursor is unavailable. Raise max_balance_transactions, choose a later to, or retry an unavailable read; full-balance sweep checks are withheld.";
        if ([...currentBalances.values()].some((v) => v < 0n)) {
          reconstruction.complete = false;
          reconstruction.unavailable = "Reconstruction produced a negative balance; full-balance sweep checks are withheld.";
        }
      } catch (err) {
        reconstruction.unavailable = err instanceof Error ? err.message : String(err);
      }
      if (!reconstruction.complete) currentBalances = null;
    }
  }
  return { address: addr, txs, complete: window.complete, currentBalances, window, balance_reconstruction: reconstruction };
}

export interface ClassifyOptions {
  /** Measure the sweep sponsor's sponsorship breadth (up to ~6 requests). */
  measureSponsor?: boolean;
  /** Measure an unlabelled destination's fan-out (up to ~6 requests). */
  measureDestination?: boolean;
  last?: number;
  from?: string | number;
  to?: string | number;
  maxBalanceTransactions?: number;
}

export async function classifyDepositAddress(address: string, options: ClassifyOptions = {}) {
  const { measureSponsor = true, measureDestination = true, last = 50 } = options;
  let scan: DepositRead;
  try {
    scan = await scanForDeposit(address, last, options);
  } catch (err) {
    if (!(err instanceof IncompleteDepositScan)) throw err;
    const checks: VerdictResult["checks"] = {
      single_destination: null,
      full_balance_sweeps: null,
      sponsored_sweeps: null,
      sponsor_relayer_shaped: null,
      destination_is_exchange: null,
    };
    return rememberDepositVerdict({
      address: normalizeSuiAddress(address),
      verdict: "unknown" as const,
      tier: "heuristic" as const,
      hot_wallet: null,
      exchange: null,
      sweep_sponsor: null,
      checks,
      checks_not_run: Object.fromEntries(Object.keys(checks).map((key) => [key, err.message])),
      reasons: [err.message],
      sweeps: [],
      sweep_count: null,
      deposits: [],
      deposit_count: null,
      scanned_transactions: err.transactions,
      window_complete: false,
      window: err.window!,
      balance_reconstruction: null,
      incomplete_transactions: err.digests,
    });
  }
  // Sweep and deposit amounts are formatted as the pattern is read.
  await prefetchCoinScale(scan.txs.flatMap((t) => t.changes.map((c) => c.coinType)));
  const pattern = readDepositPattern(scan);

  const hotWallet = pattern.destinations.length === 1 ? pattern.destinations[0]! : null;
  const hotLabel = hotWallet ? getLabel(hotWallet) : null;
  let destination: DestinationEvidence | null = null;
  let destinationFanout: FanoutResult | null = null;
  const unmeasured: Unmeasured = {};
  if (hotWallet) {
    // An inferred deposit label is not an exchange wallet: counting it would
    // call a wallet that pays into a deposit address a deposit address itself.
    const inferredDeposit = hotLabel?.inferred_from !== undefined;
    const cexLabel = hotLabel?.category === "cex" && !inferredDeposit;
    if (!cexLabel && measureDestination) {
      destinationFanout = await measureFanout(hotWallet, 300).catch((err: unknown) => {
        unmeasured.destination = `The destination's fan-out could not be read: ${err instanceof Error ? err.message : String(err)}`;
        return null;
      });
    } else if (!cexLabel) {
      unmeasured.destination = "The destination carries no exchange label and its fan-out is not measured in this call; classify_deposit_address measures it.";
    }
    destination = { cexLabel, hub: destinationFanout ? destinationFanout.classification === "hub" : null, inferredDeposit };
  }

  const sponsor = pattern.sponsors.length === 1 ? pattern.sponsors[0]! : null;
  let sponsorFanout: FanoutResult | null = null;
  if (pattern.sponsors.length > 1) {
    unmeasured.sponsor = `The sweeps had ${pattern.sponsors.length} different sponsors; sponsorship breadth is measured for a single sponsor only.`;
  } else if (sponsor && !measureSponsor) {
    unmeasured.sponsor = "The sponsor's breadth is not measured in this call; classify_deposit_address measures it.";
  } else if (sponsor) {
    sponsorFanout = await measureFanout(sponsor, 300).catch((err: unknown) => {
      unmeasured.sponsor = `The sponsor's fan-out could not be read: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    });
  }

  const decided = decideDepositVerdict(pattern, destination, sponsorFanout?.sponsor_shape ?? null, unmeasured);
  return rememberDepositVerdict({
    address: scan.address,
    verdict: decided.verdict,
    tier: "heuristic" as const,
    supporting_checks_scope: "Sponsor and destination fan-out describe their recent activity, not the candidate's chosen period.",
    hot_wallet: hotWallet,
    exchange: hotLabel
      ? { label: hotLabel.label, category: hotLabel.category, ...labelProvenance(hotLabel) }
      : null,
    ...(destinationFanout
      ? { hot_wallet_fanout: { classification: destinationFanout.classification, counterparty_count: destinationFanout.counterparty_count, truncated: destinationFanout.truncated } }
      : {}),
    sweep_sponsor: sponsor
      ? {
          address: sponsor,
          ...(sponsorFanout
            ? {
                sponsor_shape: sponsorFanout.sponsor_shape,
                sponsored_address_count: sponsorFanout.sponsored_address_count,
                truncated: sponsorFanout.truncated,
              }
            : { sponsor_shape: null }),
        }
      : null,
    checks: decided.checks,
    checks_not_run: decided.checks_not_run,
    reasons: decided.reasons,
    sweeps: [...pattern.sweeps].reverse(),
    sweep_count: pattern.sweeps.length,
    deposits: [...pattern.deposits].reverse(),
    deposit_count: pattern.deposits.length,
    ...(pattern.otherOutflows.length ? { other_outflows: [...pattern.otherOutflows].reverse() } : {}),
    scanned_transactions: scan.txs.length,
    window_complete: scan.complete,
    window: scan.window,
    balance_reconstruction: scan.balance_reconstruction,
  });
}
