/**
 * What one address took in and paid out over a window, per coin, per
 * counterparty and per bridge. Pure: `summarize_address_flows`
 * (`src/tools/flows.ts`) reads the transactions and prices them.
 *
 * Four rules a change is likely to break:
 *
 * - **Gas is removed before any SUI total.** The payer's SUI change includes
 *   gas, so without this every transaction the address sent reads as a SUI
 *   outflow. Gas the address paid is reported on its own.
 * - **A gas sponsor's SUI change is never a flow** (`isSponsorGasChange`).
 * - **Counterparty amounts never exceed the subject's own change.** A
 *   transaction where the subject pays 100 and a stranger also pays someone
 *   50 would otherwise credit the stranger's payee to the subject. When the
 *   other side of a coin adds up to more than the subject moved, the subject's
 *   amount is split in proportion.
 * - **Value with no counterparty is reported, not dropped.** A swap, a
 *   withdrawal or an exploit pays the subject from an object, which has no
 *   balance change of its own; the part of a change no address accounts for is
 *   `unattributed`.
 */

import { detectBridges, type BridgeHit, type CallSite } from "./bridge/detect.js";
import type { Beneficiary } from "./bridge/beneficiary.js";
import { readBridgeEvents } from "./bridge/exits.js";
import { CLAIM_EVENT_SUFFIX } from "./bridge/sui-native.js";
import type { SuiEventNode } from "./bridge/wormhole.js";
import { isSponsorGasChange } from "./sponsor-gas.js";
import { coinKey, withoutGas } from "./trace-hop.js";
import { displayCoin, pricingScale, toHumanAmount, type HistoricalPrices } from "./valuation.js";

export interface FlowChange {
  owner: string;
  coinType: string;
  amount: bigint;
}

export interface FlowTx {
  digest: string;
  timestamp: string | null;
  checkpoint: number | null;
  sender: string | null;
  gasSponsor: string | null;
  /** Computation + storage - rebate, charged to the gas payer. Null when not read. */
  netGas: bigint | null;
  changes: FlowChange[];
  calls: CallSite[];
  eventTypes: string[];
  /** More events exist than the scan read, so detection saw a partial list. */
  eventsTruncated?: boolean;
}

export interface CoinFlow {
  coinType: string;
  in: bigint;
  out: bigint;
  txIn: number;
  txOut: number;
}

export interface Counterparty {
  address: string;
  coins: Map<string, bigint>;
  digests: string[];
  firstAt: string | null;
  lastAt: string | null;
}

export interface Unattributed {
  coinType: string;
  amount: bigint;
  digests: string[];
}

export interface SponsorLink {
  address: string;
  digests: string[];
}

export interface FlowSummary {
  coins: Map<string, CoinFlow>;
  /** Net gas the subject paid as gas payer, in MIST. Negative when rebates exceeded costs. */
  gasPaid: bigint;
  gasTransactions: number;
  /** Transactions the subject paid gas for whose gas summary was not read. */
  gasUnread: number;
  sources: Map<string, Counterparty>;
  recipients: Map<string, Counterparty>;
  unattributedIn: Map<string, Unattributed>;
  unattributedOut: Map<string, Unattributed>;
  /** Parties that paid gas for transactions the subject sent. */
  sponsoredBy: Map<string, SponsorLink>;
  /** Senders the subject paid gas for. */
  sponsored: Map<string, SponsorLink>;
}

function credit(map: Map<string, Counterparty>, address: string, coin: string, amount: bigint, tx: FlowTx) {
  let c = map.get(address);
  if (!c) {
    c = { address, coins: new Map(), digests: [], firstAt: null, lastAt: null };
    map.set(address, c);
  }
  c.coins.set(coin, (c.coins.get(coin) ?? 0n) + amount);
  if (!c.digests.includes(tx.digest)) c.digests.push(tx.digest);
  if (tx.timestamp) {
    if (!c.firstAt || tx.timestamp < c.firstAt) c.firstAt = tx.timestamp;
    if (!c.lastAt || tx.timestamp > c.lastAt) c.lastAt = tx.timestamp;
  }
}

function unattributed(map: Map<string, Unattributed>, coin: string, amount: bigint, digest: string) {
  const u = map.get(coin) ?? { coinType: coin, amount: 0n, digests: [] };
  u.amount += amount;
  if (!u.digests.includes(digest)) u.digests.push(digest);
  map.set(coin, u);
}

function link(map: Map<string, SponsorLink>, address: string, digest: string) {
  const l = map.get(address) ?? { address, digests: [] };
  l.digests.push(digest);
  map.set(address, l);
}

/**
 * The subject's own change per coin with gas removed, and every other party's
 * change in the same terms. A gas-only sponsor's SUI row is dropped.
 */
export function netOfGas(subject: string, tx: FlowTx): { own: Map<string, bigint>; others: FlowChange[] } {
  const payer = tx.gasSponsor ?? tx.sender;
  const hop = withoutGas(
    tx.changes.map((c) => ({ address: c.owner, coin_type: c.coinType, amount: c.amount.toString() })),
    { payer, net: tx.netGas },
  );
  const own = new Map<string, bigint>();
  const others: FlowChange[] = [];
  for (const c of hop) {
    if (isSponsorGasChange(c.address, c.coin_type, tx.sender, tx.gasSponsor)) continue;
    const coin = coinKey(c.coin_type);
    const amount = BigInt(c.amount);
    if (c.address === subject) own.set(coin, (own.get(coin) ?? 0n) + amount);
    else others.push({ owner: c.address, coinType: coin, amount });
  }
  return { own, others };
}

/**
 * Split `total` across `parts` in proportion when they add up to more than it,
 * so no counterparty is credited with value the subject did not move.
 */
export function allocate(total: bigint, parts: bigint[]): { shares: bigint[]; rest: bigint } {
  const sum = parts.reduce((a, b) => a + b, 0n);
  if (sum <= total) return { shares: parts, rest: total - sum };
  return { shares: parts.map((p) => (total * p) / sum), rest: 0n };
}

export function summarizeFlows(subject: string, txs: FlowTx[], coinFilter?: string | null): FlowSummary {
  const only = coinFilter ? coinKey(coinFilter) : null;
  const s: FlowSummary = {
    coins: new Map(),
    gasPaid: 0n,
    gasTransactions: 0,
    gasUnread: 0,
    sources: new Map(),
    recipients: new Map(),
    unattributedIn: new Map(),
    unattributedOut: new Map(),
    sponsoredBy: new Map(),
    sponsored: new Map(),
  };

  for (const tx of txs) {
    const sponsor = tx.gasSponsor && tx.gasSponsor !== tx.sender ? tx.gasSponsor : null;
    if (tx.sender === subject && sponsor) link(s.sponsoredBy, sponsor, tx.digest);
    if (sponsor === subject && tx.sender) link(s.sponsored, tx.sender, tx.digest);
    if ((tx.gasSponsor ?? tx.sender) === subject) {
      if (tx.netGas === null) s.gasUnread++;
      else {
        s.gasPaid += tx.netGas;
        s.gasTransactions++;
      }
    }

    const { own, others } = netOfGas(subject, tx);
    for (const [coin, delta] of own) {
      if (delta === 0n || (only && coin !== only)) continue;
      const flow = s.coins.get(coin) ?? { coinType: coin, in: 0n, out: 0n, txIn: 0, txOut: 0 };
      s.coins.set(coin, flow);
      const incoming = delta > 0n;
      const magnitude = incoming ? delta : -delta;
      if (incoming) {
        flow.in += magnitude;
        flow.txIn++;
      } else {
        flow.out += magnitude;
        flow.txOut++;
      }
      // The other side of this coin: payers when it came in, payees when it
      // went out.
      const side = others.filter((c) => c.coinType === coin && (incoming ? c.amount < 0n : c.amount > 0n));
      const { shares, rest } = allocate(
        magnitude,
        side.map((c) => (c.amount < 0n ? -c.amount : c.amount)),
      );
      side.forEach((c, i) => {
        if (shares[i] > 0n) credit(incoming ? s.sources : s.recipients, c.owner, coin, shares[i], tx);
      });
      if (rest > 0n) unattributed(incoming ? s.unattributedIn : s.unattributedOut, coin, rest, tx.digest);
    }
  }
  return s;
}

/**
 * Transactions the subject sent that may carry a bridge exit: a curated marker
 * or a bridge-typed package in the calls or event types, or an event list the
 * scan could not read whole.
 */
export function exitCandidates(subject: string, txs: FlowTx[]): FlowTx[] {
  return txs.filter(
    (tx) => tx.sender === subject && (tx.eventsTruncated || detectBridges(tx.calls, tx.eventTypes).length > 0),
  );
}

/** Transactions that claimed value arriving on Sui through the native bridge. */
export function entryCandidates(txs: FlowTx[]): FlowTx[] {
  return txs.filter((tx) => tx.eventTypes.some((t) => t.endsWith(CLAIM_EVENT_SUFFIX)));
}

export interface ExitRecord {
  digest: string;
  timestamp: string | null;
  /** The bridge the report files this exit under. */
  bridge: string;
  protocols: string[];
  hits: BridgeHit[];
  /** What left the subject in this transaction, per coin, gas removed. */
  sent: Map<string, bigint>;
  beneficiaries: Beneficiary[];
  /** Wormhole messages whose recipient is not in the payload this server reads. */
  unresolvedVaas: string[];
  eventsIncomplete: boolean;
}

/**
 * Read one exit from its transaction and full event list.
 *
 * Null when the full events show no bridge after all: the scan's event list
 * was a first page, and a candidate taken for that reason alone may be
 * nothing.
 */
export function readExit(
  subject: string,
  tx: FlowTx,
  events: SuiEventNode[] | null,
  qualify: boolean,
): ExitRecord | null {
  const types = events
    ? events.map((e) => e?.contents?.type?.repr).filter((t): t is string => typeof t === "string")
    : tx.eventTypes;
  const hits = detectBridges(tx.calls, types);
  if (hits.length === 0) return null;
  const reading = events ? readBridgeEvents(events, qualify) : null;
  const sent = new Map<string, bigint>();
  for (const [coin, delta] of netOfGas(subject, tx).own) if (delta < 0n) sent.set(coin, -delta);
  const beneficiaries = reading?.beneficiaries ?? [];
  const protocols = hits.map((h) => h.protocol);
  // Mayan settles over CCTP and Wormhole in the same transaction, so its
  // order is the transfer and the legs are how it was paid.
  const bridge = protocols.find((p) => p.startsWith("Mayan")) ?? beneficiaries[0]?.protocol ?? protocols[0];
  return {
    digest: tx.digest,
    timestamp: tx.timestamp,
    bridge,
    protocols,
    hits,
    sent,
    beneficiaries,
    // A Wormhole leg of a Mayan order pays Mayan's own contract; the order
    // already named the beneficiary.
    unresolvedVaas:
      reading && reading.mayan.length === 0
        ? reading.messages.filter((_, i) => !reading.decodedMessages[i]?.beneficiary).map((m) => m.vaaId)
        : [],
    eventsIncomplete: events === null,
  };
}

export interface DestinationTotal {
  key: string;
  beneficiary: Beneficiary;
  digests: string[];
  /** Value sent in transactions whose only destination is this one. */
  sent: Map<string, bigint>;
  /** Transactions that also paid another destination, whose value is not split. */
  sharedDigests: string[];
}

export interface BridgeTotal {
  bridge: string;
  digests: string[];
  sent: Map<string, bigint>;
  destinations: DestinationTotal[];
  /** Exits with no recipient read from chain data. */
  unresolvedDigests: string[];
}

/** One destination's identity: its CAIP-10 account, or the address as the chain holds it. */
function destinationKey(b: Beneficiary): string {
  return b.account ?? `${b.chain_label}:${b.address ?? b.address_raw}`;
}

/** Exits grouped by bridge, and within a bridge by destination. */
export function groupExits(exits: ExitRecord[]): BridgeTotal[] {
  const byBridge = new Map<string, BridgeTotal>();
  for (const e of exits) {
    const g: BridgeTotal = byBridge.get(e.bridge) ?? {
      bridge: e.bridge,
      digests: [],
      sent: new Map(),
      destinations: [],
      unresolvedDigests: [],
    };
    byBridge.set(e.bridge, g);
    g.digests.push(e.digest);
    for (const [coin, v] of e.sent) g.sent.set(coin, (g.sent.get(coin) ?? 0n) + v);
    const keys = [...new Set(e.beneficiaries.map(destinationKey))];
    if (keys.length === 0) g.unresolvedDigests.push(e.digest);
    for (const key of keys) {
      let d = g.destinations.find((x) => x.key === key);
      if (!d) {
        d = { key, beneficiary: e.beneficiaries.find((b) => destinationKey(b) === key)!, digests: [], sent: new Map(), sharedDigests: [] };
        g.destinations.push(d);
      }
      d.digests.push(e.digest);
      if (keys.length === 1) for (const [coin, v] of e.sent) d.sent.set(coin, (d.sent.get(coin) ?? 0n) + v);
      else d.sharedDigests.push(e.digest);
    }
  }
  return [...byBridge.values()];
}

/** Prices and scales for rendering amounts, all from one historical lookup. */
export function coinValuer(prices: HistoricalPrices) {
  const scale = (coin: string) => pricingScale(coin, prices.points.get(coin)).decimals;
  const human = (coin: string, raw: bigint) => (raw < 0n ? -1 : 1) * toHumanAmount(raw, scale(coin));
  const usd = (coin: string, raw: bigint): number | null => {
    const p = prices.points.get(coin);
    return p ? human(coin, raw) * p.price : null;
  };
  const amounts = (m: Map<string, bigint>) =>
    [...m]
      .map(([coin, raw]) => {
        const v = usd(coin, raw);
        return {
          symbol: displayCoin(coin).symbol,
          coin_type: coin,
          amount: human(coin, raw),
          ...(v !== null ? { usd: roundUsd(v) } : {}),
        };
      })
      .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const totalUsd = (m: Map<string, bigint>) => {
    let sum = 0;
    let priced = false;
    for (const [coin, raw] of m) {
      const v = usd(coin, raw);
      if (v !== null) {
        sum += v;
        priced = true;
      }
    }
    return priced ? sum : null;
  };
  return { human, usd, amounts, totalUsd };
}

/** USD to the cent, for display. */
export const roundUsd = (v: number) => Math.round(v * 100) / 100;
