import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getLabel, labelProvenance } from "./labels.js";
import { measureFanout, type FanoutResult } from "./fanout.js";
import { decimalsForCoinType, displayCoin, toHumanAmount } from "./valuation.js";

/**
 * Is this address an exchange deposit address?
 *
 * An exchange gives each customer a deposit address, then sweeps everything
 * that lands there into a hot wallet. The deposit address is what ties a
 * customer to an account, so it is the identifier a subpoena names. Three
 * observations make the pattern, and each one alone has innocent explanations:
 *
 *   1. Every outflow goes to one destination D, and each outflow is a
 *      full-balance sweep: the coin's balance is zero right after it.
 *   2. The sweep's gas is paid by a sponsor that pays for many unrelated
 *      senders (relayer-shaped). Exchanges sponsor sweeps so deposit addresses
 *      never need SUI of their own.
 *   3. D is a disclosed exchange wallet, or at least hub-shaped.
 *
 * The verdict is `heuristic`: it names a pattern, not a disclosure.
 */

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
  full_balance: boolean | null;
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

const SUI_TYPE = /^0x0*2::sui::SUI$/;

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
 */
export function readDepositPattern(scan: DepositScan): DepositPattern {
  const { address } = scan;
  const sweeps: Sweep[] = [];
  const otherOutflows: OtherOutflow[] = [];
  const deposits: Deposit[] = [];

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
    const own = netFor(tx, address);
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
        if (c.owner === sponsor && SUI_TYPE.test(c.coinType)) continue;
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
      sweeps.push({
        digest: tx.digest,
        timestamp: tx.timestamp,
        destination,
        coins,
        full_balance: after[i] ? coins.every((c) => c.balance_after_raw === "0") : null,
        sponsor,
      });
      return;
    }

    if (gained.length > 0) {
      const from = new Set<string>();
      for (const c of tx.changes) {
        if (c.owner === address || c.amount >= 0n) continue;
        if (c.owner !== tx.sender && c.owner === tx.gasSponsor && SUI_TYPE.test(c.coinType)) continue;
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

  return {
    sweeps,
    otherOutflows,
    deposits,
    destinations: [...new Set(sweeps.map((s) => s.destination))],
    sponsors: [...new Set(sweeps.map((s) => s.sponsor).filter((s): s is string => !!s))],
  };
}

export type DepositVerdict = "likely" | "no" | "unknown";

export interface DestinationEvidence {
  /** The destination carries a disclosed or investigator-added `cex` label. */
  cexLabel: boolean;
  /** Fan-out classification of the destination, or null when not measured. */
  hub: boolean | null;
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
  reasons: string[];
}

/**
 * Combine the pattern with what is known about the destination and the sweep
 * sponsor.
 *
 * `likely` needs every outflow to be a full-balance sweep to one destination
 * that is an exchange, AND either a relayer-shaped sponsor or a disclosed
 * exchange label on the destination. A hub-shaped destination with self-paid
 * sweeps stays `unknown`: a person consolidating into their own exchange
 * account produces the same outflows.
 */
export function decideDepositVerdict(
  pattern: DepositPattern,
  destination: DestinationEvidence | null,
  sponsorShape: FanoutResult["sponsor_shape"] | null,
): VerdictResult {
  const reasons: string[] = [];
  const checks: VerdictResult["checks"] = {
    single_destination: null,
    full_balance_sweeps: null,
    sponsored_sweeps: null,
    sponsor_relayer_shaped: null,
    destination_is_exchange: null,
  };

  if (pattern.sweeps.length === 0 && pattern.otherOutflows.length === 0) {
    reasons.push(
      "No outflows in the window. An exchange deposit address that has not been swept yet looks like any receive-only wallet.",
    );
    return { verdict: "unknown", checks, reasons };
  }

  if (pattern.otherOutflows.length > 0) {
    checks.single_destination = false;
    reasons.push(
      `${pattern.otherOutflows.length} outflow(s) are not a transfer to a single recipient (e.g. ${pattern.otherOutflows[0]!.digest}: ${pattern.otherOutflows[0]!.reason}). Deposit addresses only sweep.`,
    );
    return { verdict: "no", checks, reasons };
  }

  checks.single_destination = pattern.destinations.length === 1;
  if (!checks.single_destination) {
    reasons.push(`Outflows went to ${pattern.destinations.length} different destinations; a deposit address sweeps to one.`);
    return { verdict: "no", checks, reasons };
  }

  const fullness = pattern.sweeps.map((s) => s.full_balance);
  checks.full_balance_sweeps = fullness.includes(false) ? false : fullness.includes(null) ? null : true;
  if (checks.full_balance_sweeps === false) {
    const partial = pattern.sweeps.find((s) => s.full_balance === false)!;
    reasons.push(`Outflow ${partial.digest} left a balance behind, so it was a payment rather than a sweep.`);
    return { verdict: "no", checks, reasons };
  }
  if (checks.full_balance_sweeps === null) {
    reasons.push("The balance after each outflow could not be reconstructed, so full-balance sweeps are unconfirmed.");
  } else {
    reasons.push(`All ${pattern.sweeps.length} outflow(s) emptied the swept coin into ${pattern.destinations[0]}.`);
  }

  checks.sponsored_sweeps = pattern.sweeps.every((s) => s.sponsor !== null);
  if (checks.sponsored_sweeps) {
    checks.sponsor_relayer_shaped = sponsorShape === null ? null : sponsorShape === "relayer";
    reasons.push(
      sponsorShape === null
        ? `Sweep gas was paid by ${pattern.sponsors.join(", ")}; its sponsorship breadth was not measured.`
        : sponsorShape === "relayer"
          ? `Sweep gas was paid by ${pattern.sponsors.join(", ")}, which sponsors many unrelated senders (relayer-shaped).`
          : `Sweep gas was paid by ${pattern.sponsors.join(", ")}, which sponsors few senders; that fits a private payer better than an exchange relayer.`,
    );
  } else {
    checks.sponsor_relayer_shaped = false;
    reasons.push("At least one sweep paid its own gas.");
  }

  if (destination) {
    checks.destination_is_exchange = destination.cexLabel || destination.hub === true ? true : destination.hub === null ? null : false;
    reasons.push(
      destination.cexLabel
        ? "The destination carries a cex label."
        : destination.hub === true
          ? "The destination is hub-shaped but carries no exchange label."
          : destination.hub === false
            ? "The destination is neither labelled as an exchange nor hub-shaped."
            : "The destination is not labelled and its fan-out was not measured.",
    );
  }

  const exchange = checks.destination_is_exchange === true;
  const strongSponsor = checks.sponsor_relayer_shaped === true;
  const labelled = destination?.cexLabel === true;
  if (checks.full_balance_sweeps === true && exchange && (strongSponsor || labelled)) {
    return { verdict: "likely", checks, reasons };
  }
  if (checks.destination_is_exchange === false) {
    reasons.push("Without an exchange-shaped destination this reads as a wallet forwarding to one place, which is not specific to exchanges.");
  }
  return { verdict: "unknown", checks, reasons };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const DEPOSIT_QUERY = `query ($addr: SuiAddress!, $last: Int!) {
  address(address: $addr) {
    balances(first: 50) { nodes { coinType { repr } totalBalance } pageInfo { hasNextPage } }
  }
  transactions(filter: { affectedAddress: $addr }, last: $last) {
    nodes {
      digest
      sender { address }
      gasInput { gasSponsor { address } }
      effects {
        timestamp
        balanceChanges(first: 50) { nodes { amount owner { address } coinType { repr } } }
      }
    }
    pageInfo { hasPreviousPage }
  }
}`;

interface DepositQueryResult {
  address: {
    balances?: {
      nodes: Array<{ coinType?: { repr: string }; totalBalance?: string }>;
      pageInfo?: { hasNextPage?: boolean };
    } | null;
  } | null;
  transactions: {
    nodes: Array<{
      digest: string;
      sender?: { address?: string } | null;
      gasInput?: { gasSponsor?: { address?: string } | null } | null;
      effects?: {
        timestamp?: string | null;
        balanceChanges?: { nodes: Array<{ amount?: string; owner?: { address?: string } | null; coinType?: { repr: string } }> };
      } | null;
    }>;
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

/** One request: the address's latest transactions and its balances right now. */
export async function scanForDeposit(address: string, last = 50): Promise<DepositScan> {
  const addr = normalizeSuiAddress(address);
  const res = await gqlQuery<DepositQueryResult>(DEPOSIT_QUERY, { addr, last: Math.min(50, last) });
  const txs: ScannedTx[] = res.transactions.nodes.map((n) => ({
    digest: n.digest,
    timestamp: n.effects?.timestamp ?? null,
    sender: n.sender?.address ?? null,
    gasSponsor: n.gasInput?.gasSponsor?.address ?? null,
    changes: (n.effects?.balanceChanges?.nodes ?? [])
      .filter((c) => c.owner?.address && c.coinType?.repr && c.amount !== undefined)
      .map((c) => ({ owner: c.owner!.address!, coinType: tag(c.coinType!.repr), amount: BigInt(c.amount!) })),
  }));
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
  const pattern = readDepositPattern(scan);

  const hotWallet = pattern.destinations.length === 1 ? pattern.destinations[0]! : null;
  const hotLabel = hotWallet ? getLabel(hotWallet) : null;
  let destination: DestinationEvidence | null = null;
  let destinationFanout: FanoutResult | null = null;
  if (hotWallet) {
    const cexLabel = hotLabel?.category === "cex";
    if (!cexLabel && measureDestination) {
      destinationFanout = await measureFanout(hotWallet, 300).catch(() => null);
    }
    destination = { cexLabel, hub: destinationFanout ? destinationFanout.classification === "hub" : null };
  }

  const sponsor = pattern.sponsors.length === 1 ? pattern.sponsors[0]! : null;
  const sponsorFanout = sponsor && measureSponsor ? await measureFanout(sponsor, 300).catch(() => null) : null;

  const decided = decideDepositVerdict(pattern, destination, sponsorFanout?.sponsor_shape ?? null);
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
