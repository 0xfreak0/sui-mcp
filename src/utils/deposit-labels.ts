import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { isSponsorGasChange } from "./sponsor-gas.js";
import {
  decideDepositVerdict,
  readDepositPattern,
  scannedTxOf,
  SCANNED_TX_FIELDS,
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
}

export type RejectReason =
  | "labelled"
  | "several-exchanges"
  | "sweeps-elsewhere"
  | "other-outflow"
  | "several-wallets"
  | "partial-sweep"
  | "balance-unknown"
  | "few-sweeps"
  | "not-likely";

export type CandidateResult = { kind: "deposit"; deposit: InferredDeposit } | { kind: "rejected"; reason: RejectReason };

/**
 * Decide one candidate from its scan.
 *
 * `exchangeWallets` maps each disclosed exchange wallet to its exchange;
 * `labelled` holds every address a disclosed or curated label names, which is
 * never relabelled.
 */
export function inferDepositLabel(
  scan: DepositScan,
  exchangeWallets: ReadonlyMap<string, string>,
  labelled: ReadonlySet<string>,
): CandidateResult {
  const rejected = (reason: RejectReason): CandidateResult => ({ kind: "rejected", reason });
  if (labelled.has(scan.address)) return rejected("labelled");
  const pattern = readDepositPattern(scan);
  const entities = new Set(pattern.destinations.flatMap((d) => (exchangeWallets.has(d) ? [exchangeWallets.get(d)!] : [])));
  if (entities.size > 1) return rejected("several-exchanges");
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
  return {
    kind: "deposit",
    deposit: {
      address: scan.address,
      entity: [...entities][0]!,
      swept_to: pattern.destinations[0]!,
      sweep_count: sweeps.length,
      evidence_txs: sweeps.slice(-EVIDENCE_TXS).map((s) => s.digest),
      first_sweep_at: sweeps[0]!.timestamp,
      last_sweep_at: sweeps.at(-1)!.timestamp,
    },
  };
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
