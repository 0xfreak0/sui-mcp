import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getLabel, labelProvenance } from "./labels.js";
import { measureFanout, type FanoutResult } from "./fanout.js";
import { decimalsForCoinType, displayCoin, prefetchCoinScale, toHumanAmount } from "./valuation.js";
import { isSponsorGasChange, isSuiCoinType } from "./sponsor-gas.js";

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
  sender: string | null;
  gasSponsor: string | null;
  changes: BalanceChange[];
}

export interface DepositScan {
  address: string;
  /** Oldest first. */
  txs: ScannedTx[];
  /** True when the window reaches the address's first transaction. */
  complete: boolean;
  /** Current balance per coin type, read in the same request as the window. Null when unreadable. */
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
   * deposits it equals; `swept_by` is the later transfer to the same
   * destination that emptied the coin, absent while no later outflow of the
   * coin is in the window.
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
 * Balance after each transaction is reconstructed backwards from the current
 * balance, so it does not need the address's whole history, only a window
 * that runs up to now.
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
  // its destination and the sweep that emptied the coin, or null for either.
  const nextOutflow = new Map<string, { destination: string | null; emptiedBy: string | null }>();
  const built = new Map<number, Sweep>();
  let d = drafts.length - 1;
  for (let i = scan.txs.length - 1; i >= 0; i--) {
    const draft = drafts[d]?.index === i ? drafts[d--]! : null;
    if (!draft) {
      for (const [coin, delta] of nets[i]!) if (delta < 0n) nextOutflow.set(coin, { destination: null, emptiedBy: null });
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
            sweptBy ??= sweptNext;
            emptiedBy = sweptNext;
          }
        } else if (full) {
          full = false;
        }
      }
      nextOutflow.set(c.coin_type, { destination, emptiedBy });
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
        "The balance after each transfer could not be reconstructed (the current balance list was unreadable or did not fit one page).";
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

/** Fields of one transaction node that {@link scannedTxOf} reads. */
export const SCANNED_TX_FIELDS = `digest
      sender { address }
      gasInput { gasSponsor { address } }
      effects {
        timestamp
        balanceChanges(first: 50) { nodes { amount owner { address } coinType { repr } } }
      }`;

const DEPOSIT_QUERY = `query ($addr: SuiAddress!, $last: Int!) {
  address(address: $addr) {
    balances(first: 50) { nodes { coinType { repr } totalBalance } pageInfo { hasNextPage } }
  }
  transactions(filter: { affectedAddress: $addr }, last: $last) {
    nodes {
      ${SCANNED_TX_FIELDS}
    }
    pageInfo { hasPreviousPage }
  }
}`;

export interface ScannedTxNode {
  digest: string;
  sender?: { address?: string } | null;
  gasInput?: { gasSponsor?: { address?: string } | null } | null;
  effects?: {
    timestamp?: string | null;
    balanceChanges?: { nodes: Array<{ amount?: string; owner?: { address?: string } | null; coinType?: { repr: string } }> };
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
    pageInfo: { hasPreviousPage: boolean };
  };
}

const tag = (t: string) => {
  try {
    return normalizeStructTag(t);
  } catch {
    return t;
  }
};

/** A transaction node read with {@link SCANNED_TX_FIELDS}, as the pattern reader takes it. */
export function scannedTxOf(n: ScannedTxNode): ScannedTx {
  return {
    digest: n.digest,
    timestamp: n.effects?.timestamp ?? null,
    sender: n.sender?.address ?? null,
    gasSponsor: n.gasInput?.gasSponsor?.address ?? null,
    changes: (n.effects?.balanceChanges?.nodes ?? [])
      .filter((c) => c.owner?.address && c.coinType?.repr && c.amount !== undefined)
      .map((c) => ({ owner: c.owner!.address!, coinType: tag(c.coinType!.repr), amount: BigInt(c.amount!) })),
  };
}

/** One request: the address's latest transactions and its balances right now. */
export async function scanForDeposit(address: string, last = 50): Promise<DepositScan> {
  const addr = normalizeSuiAddress(address);
  const res = await gqlQuery<DepositQueryResult>(DEPOSIT_QUERY, { addr, last: Math.min(50, last) });
  const txs = res.transactions.nodes.map(scannedTxOf);
  const balances = res.address?.balances;
  // A balance list that did not fit one page cannot anchor the reconstruction.
  const currentBalances =
    balances && !balances.pageInfo?.hasNextPage
      ? new Map(
          balances.nodes
            .filter((b) => b.coinType?.repr && b.totalBalance !== undefined)
            .map((b) => [tag(b.coinType!.repr), BigInt(b.totalBalance!)] as const),
        )
      : null;
  return { address: addr, txs, complete: !res.transactions.pageInfo.hasPreviousPage, currentBalances };
}

export interface ClassifyOptions {
  /** Measure the sweep sponsor's sponsorship breadth (up to ~6 requests). */
  measureSponsor?: boolean;
  /** Measure an unlabelled destination's fan-out (up to ~6 requests). */
  measureDestination?: boolean;
  last?: number;
}

export async function classifyDepositAddress(address: string, options: ClassifyOptions = {}) {
  const { measureSponsor = true, measureDestination = true, last = 50 } = options;
  const scan = await scanForDeposit(address, last);
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
  return {
    address: scan.address,
    verdict: decided.verdict,
    tier: "heuristic" as const,
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
    sweeps: pattern.sweeps.slice(-10).reverse(),
    sweep_count: pattern.sweeps.length,
    deposits: pattern.deposits.slice(-10).reverse(),
    deposit_count: pattern.deposits.length,
    ...(pattern.otherOutflows.length ? { other_outflows: pattern.otherOutflows.slice(-5).reverse() } : {}),
    scanned_transactions: scan.txs.length,
    window_complete: scan.complete,
  };
}
