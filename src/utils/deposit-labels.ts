import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { isSponsorGasChange } from "./sponsor-gas.js";
import { ActivityLedger, lookalikeReport } from "./address-lookalike.js";
import type { FanoutResult } from "./fanout.js";
import {
  decideDepositVerdict,
  readDepositPattern,
  scannedTxOf,
  SCANNED_TX_FIELDS,
  type DepositPattern,
  type DepositScan,
  type ScannedTx,
  type ScannedTxNode,
} from "./deposit.js";

/**
 * Inferring exchange deposit addresses from the exchanges' own disclosed
 * wallets, for `npm run sync:labels` (scripts/sync-deposit-labels.mjs).
 *
 * The senders into a disclosed exchange wallet are the candidates. A candidate
 * is kept only when its own latest transactions read as a deposit address of
 * that exchange: every outflow a full-balance sweep into ONE disclosed wallet,
 * which is `classify_deposit_address`'s `likely` verdict with a disclosed
 * destination ({@link readDepositPattern}, {@link decideDepositVerdict}), and
 * at least {@link MIN_SWEEPS} such sweeps. The sweep rule, its gas reserve and
 * the verdict are deposit.ts's; nothing here redefines them.
 *
 * Sweeping whole balances into an exchange wallet is also what an address
 * poisoner's lookalike does with its dust, and what an exchange's own
 * operational addresses do. So a candidate is also dropped when it is one side
 * of a lookalike pair among the wallet's counterparties, when some address
 * other than a customer paid everything it received (its own sweep sponsor, a
 * disclosed wallet of the same exchange, or where the swept-to wallet itself
 * sweeps), and when a sweep sponsor is not a relayer or the exchange's own
 * wallet ({@link sponsorRejection}).
 */

/** Sweeps a candidate needs before it is labelled. One sweep is one payment. */
export const MIN_SWEEPS = 2;

/** Sweep digests an inferred label keeps as evidence, the latest ones. */
export const EVIDENCE_TXS = 3;

/** What an inferred deposit label rests on. */
export interface InferredDeposit {
  address: string;
  /** The exchange whose disclosed wallets the sweeps went into. */
  entity: string;
  /** The disclosed wallet every sweep went into. */
  swept_to: string;
  /** Sweeps in the window read. */
  sweep_count: number;
  /** The latest {@link EVIDENCE_TXS} sweeps, oldest first. */
  evidence_txs: string[];
  first_sweep_at: string | null;
  last_sweep_at: string | null;
  /** Gas payers of the sweeps other than the address itself, for {@link sponsorRejection}. */
  sponsors: string[];
}

export type RejectReason =
  | "labelled"
  | "lookalike"
  | "several-exchanges"
  | "target-deposit-shaped"
  | "sweeps-elsewhere"
  | "other-outflow"
  | "several-wallets"
  | "partial-sweep"
  | "balance-unknown"
  | "few-sweeps"
  | "not-likely"
  | "sponsor-funded"
  | "exchange-funded"
  | "round-trip"
  | "not-customer-funded"
  | "sponsor-operator"
  | "sponsor-not-relayer"
  | "sponsor-unmeasured";

export type CandidateResult = { kind: "deposit"; deposit: InferredDeposit } | { kind: "rejected"; reason: RejectReason };

export interface InferenceContext {
  /** Every disclosed exchange wallet and its exchange. */
  exchangeWallets: ReadonlyMap<string, string>;
  /** Every address a disclosed or curated label names; never relabelled. */
  labelled: ReadonlySet<string>;
  /**
   * Disclosed wallets that are deposit-shaped themselves ({@link isDepositShaped}):
   * a sender into one pays a deposit address, so it is never a sweep target.
   */
  depositShaped?: ReadonlySet<string>;
  /** One side of a lookalike pair among an exchange wallet's counterparties ({@link lookalikeSuspects}). */
  lookalikes?: ReadonlySet<string>;
  /** Where each disclosed wallet itself sweeps its whole balance. */
  walletSweepsInto?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Decide one candidate from its scan. A `deposit` result still needs its
 * sweep sponsors checked with {@link sponsorRejection}.
 */
export function inferDepositLabel(scan: DepositScan, ctx: InferenceContext): CandidateResult {
  const { exchangeWallets } = ctx;
  const rejected = (reason: RejectReason): CandidateResult => ({ kind: "rejected", reason });
  if (ctx.labelled.has(scan.address)) return rejected("labelled");
  if (ctx.lookalikes?.has(scan.address)) return rejected("lookalike");
  const pattern = readDepositPattern(scan);
  const entities = new Set(pattern.destinations.flatMap((d) => (exchangeWallets.has(d) ? [exchangeWallets.get(d)!] : [])));
  if (entities.size > 1) return rejected("several-exchanges");
  if (pattern.destinations.some((d) => ctx.depositShaped?.has(d))) return rejected("target-deposit-shaped");
  if (pattern.destinations.some((d) => !exchangeWallets.has(d))) return rejected("sweeps-elsewhere");
  const decided = decideDepositVerdict(pattern, { cexLabel: true, hub: null }, null);
  if (decided.verdict !== "likely") {
    const { single_destination, full_balance_sweeps } = decided.checks;
    return rejected(
      pattern.otherOutflows.length > 0
        ? "other-outflow"
        : single_destination === false
          ? "several-wallets"
          : full_balance_sweeps === false
            ? "partial-sweep"
            : pattern.sweeps.length === 0
              ? "few-sweeps"
              : full_balance_sweeps === null
                ? "balance-unknown"
                : "not-likely",
    );
  }
  const sweeps = pattern.sweeps;
  if (sweeps.length < MIN_SWEEPS) return rejected("few-sweeps");
  const entity = [...entities][0]!;
  const sweptTo = pattern.destinations[0]!;

  // Who paid in. A customer's deposit address is paid by customers; one paid
  // only by whoever runs its sweeps, by the exchange itself, or by the address
  // the exchange wallet forwards to is someone else's operational address.
  // Only payments in a coin the address later swept count: a gas top-up in SUI
  // it never swept is not what was deposited.
  const swept = new Set(sweeps.flatMap((s) => s.coins.map((c) => c.coin_type)));
  const funders = new Set(
    pattern.deposits.filter((d) => d.coins.some((c) => swept.has(c.coin_type))).flatMap((d) => d.from),
  );
  if (funders.size > 0) {
    const sponsors = new Set(pattern.sponsors);
    const sameExchange = (a: string) => exchangeWallets.get(a) === entity;
    const forwarded = new Set(ctx.walletSweepsInto?.get(sweptTo) ?? []);
    const all = (test: (a: string) => boolean) => [...funders].every(test);
    if (all((a) => sponsors.has(a))) return rejected("sponsor-funded");
    if (all(sameExchange)) return rejected("exchange-funded");
    if (all((a) => forwarded.has(a))) return rejected("round-trip");
    if (all((a) => sponsors.has(a) || sameExchange(a) || forwarded.has(a))) return rejected("not-customer-funded");
  }
  return {
    kind: "deposit",
    deposit: {
      address: scan.address,
      entity,
      swept_to: sweptTo,
      sweep_count: sweeps.length,
      evidence_txs: sweeps.slice(-EVIDENCE_TXS).map((s) => s.digest),
      first_sweep_at: sweeps[0]!.timestamp,
      last_sweep_at: sweeps.at(-1)!.timestamp,
      sponsors: [...pattern.sponsors].sort(),
    },
  };
}

export type SponsorShape = FanoutResult["sponsor_shape"];

/**
 * Why a deposit's sweep sponsors disqualify it, or null when none does.
 *
 * Exchanges sponsor sweeps through a relayer that pays gas for many unrelated
 * senders, or pay it from their own wallets. A sponsor that funds the
 * addresses it sponsors (`operator`) runs them, which is how a poisoner runs
 * its lookalikes, and a sponsor paying for only a few addresses is a private
 * payer. An unmeasured sponsor proves neither, so it disqualifies too.
 * `shapes` holds each measured sponsor's shape.
 */
export function sponsorRejection(
  deposit: InferredDeposit,
  shapes: ReadonlyMap<string, SponsorShape>,
  exchangeWallets: ReadonlyMap<string, string>,
): RejectReason | null {
  for (const sponsor of deposit.sponsors) {
    if (exchangeWallets.get(sponsor) === deposit.entity) continue;
    const shape = shapes.get(sponsor);
    if (shape === undefined) return "sponsor-unmeasured";
    if (shape === "operator") return "sponsor-operator";
    if (shape !== "relayer") return "sponsor-not-relayer";
  }
  return null;
}

/**
 * A disclosed wallet that is itself deposit-shaped: every outflow in the
 * window is a full-balance sweep, all into one destination.
 */
export function isDepositShaped(pattern: DepositPattern): boolean {
  return (
    pattern.sweeps.length > 0 &&
    pattern.otherOutflows.length === 0 &&
    pattern.destinations.length === 1 &&
    pattern.sweeps.every((s) => s.full_balance === true)
  );
}

/**
 * Addresses among a wallet's counterparties that render like another one:
 * the suspect of every lookalike pair, and both sides of a pair whose roles
 * could not be told apart ({@link lookalikeReport}).
 */
export function lookalikeSuspects(txs: readonly ScannedTx[], wallet: string): Set<string> {
  const ledger = new ActivityLedger(wallet);
  for (const tx of txs) {
    const byOwner = new Map<string, bigint>();
    for (const c of tx.changes) byOwner.set(c.owner, (byOwner.get(c.owner) ?? 0n) + c.amount);
    const appearances = [...byOwner].map(([address, amount]) => ({ address, amount }));
    if (tx.sender && !byOwner.has(tx.sender)) appearances.push({ address: tx.sender, amount: 0n });
    ledger.observe(appearances, tx.timestamp);
  }
  const out = new Set<string>();
  for (const p of lookalikeReport(ledger.addressesLedBy(wallet), ledger.activity, wallet).pairs) {
    out.add(p.suspect);
    if (!p.direction_known) out.add(p.established);
  }
  return out;
}

/**
 * Who paid into `wallet` in these transactions: the sender, when it lost a
 * coin the wallet gained. A sponsor's SUI change is gas, never a payment.
 * First appearance order, each address once.
 */
export function inboundSenders(txs: readonly ScannedTx[], wallet: string): string[] {
  const out = new Set<string>();
  for (const tx of txs) {
    const sender = tx.sender;
    if (!sender || sender === wallet) continue;
    const net = (owner: string, coin: string) =>
      tx.changes
        .filter((c) => c.owner === owner && c.coinType === coin && !isSponsorGasChange(c.owner, c.coinType, tx.sender, tx.gasSponsor))
        .reduce((sum, c) => sum + c.amount, 0n);
    const gained = new Set(tx.changes.filter((c) => c.owner === wallet && c.amount > 0n).map((c) => c.coinType));
    if ([...gained].some((coin) => net(wallet, coin) > 0n && net(sender, coin) < 0n)) out.add(sender);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const WINDOW_QUERY = `query ($addr: SuiAddress!, $last: Int!, $before: String) {
  transactions(filter: { affectedAddress: $addr }, last: $last, before: $before) {
    nodes {
      ${SCANNED_TX_FIELDS}
    }
    pageInfo { hasPreviousPage startCursor }
  }
}`;

interface WindowResult {
  transactions: { nodes: ScannedTxNode[]; pageInfo: { hasPreviousPage: boolean; startCursor: string | null } };
}

/** One page of a wallet's transactions, newest page first; `before` continues an earlier page. */
export async function readWalletPage(
  wallet: string,
  before: string | null,
  last = 50,
): Promise<{ txs: ScannedTx[]; before: string | null }> {
  const res = await gqlQuery<WindowResult>(WINDOW_QUERY, { addr: normalizeSuiAddress(wallet), last: Math.min(50, last), before });
  const { hasPreviousPage, startCursor } = res.transactions.pageInfo;
  return { txs: res.transactions.nodes.map(scannedTxOf), before: hasPreviousPage && startCursor ? startCursor : null };
}

const SUI_HEX = /^0x[0-9a-f]{64}$/;

/**
 * The addresses among these that are objects or packages on chain. Every
 * address is checked for the canonical shape before it goes into the query.
 */
export async function objectsAmong(addresses: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const list = addresses.filter((a) => SUI_HEX.test(a));
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    const fields = chunk.map((a, j) => `o${j}: object(address: "${a}") { address }`).join("\n");
    const res = await gqlQuery<Record<string, { address?: string } | null>>(`{ ${fields} }`);
    chunk.forEach((a, j) => {
      if (res[`o${j}`]?.address) found.add(a);
    });
  }
  return found;
}
