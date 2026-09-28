/**
 * Shares or a position redeemed for more than the sender paid for them a
 * short while before.
 *
 * A vault prices its shares by what it holds over how many shares exist. An
 * ordinary deposit and withdrawal a day apart, both valued at the same coin
 * prices, come back within the yield of a day. When a deposit is priced
 * against holdings the vault understates (a superseded version that leaves a
 * market out of its accounting, a price feed set far below market), it mints
 * more shares than the deposit is worth, and redeeming them later, through
 * any version, takes the difference from the other holders. The withdrawal
 * then looks ordinary on its own; the vault's history over the window shows
 * the shares were bought for a fraction of what they redeem for.
 *
 * Two kinds of unit are followed: a coin whose `Supply<T>` the transaction
 * burned from the sender's balance (vault shares), priced per unit against
 * each earlier mint of it to the sender within the window; and an object the
 * sender brought to the transaction, priced against what the sender paid in
 * the transaction that created it within the window, when no transaction
 * changed the object in between.
 *
 * A like-for-like trip (the entry only paid, the exit only received, and
 * every coin the entry paid comes back in the exit) is valued at this
 * transaction's provider prices, so a market move between the legs changes
 * nothing. Any other trip (a zap from one coin into another, a leg that also
 * borrows or repays) would measure the move of one coin against another at a
 * single set of prices, so each leg is valued at its own time's prices and
 * the trip counts only at {@link HIGH_FACTOR}: a leveraged day trade can gain
 * a tenth, and cannot double what it paid on an ordinary day.
 */

import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import type { AttackTx } from "./attack-analysis.js";
import type { CheckRun, PtbAnomaly } from "./ptb-anomalies.js";
import { mintedTotals, type StateSnapshot } from "./state-delta.js";
import { BALANCE_CHANGES_SELECTION } from "./tx-connections.js";
import { formatUsd, prefetchCoinScale, pricingScale, priceUsdAtTime, toHumanAmount, type PricePoint } from "./valuation.js";

/** How far back an entry leg is looked for: one day. */
export const ROUND_TRIP_WINDOW_MS = 24 * 3600 * 1000;
/** A redemption worth this many times what the units cost, at one set of prices, is flagged: 1.1x. */
export const ROUND_TRIP_FACTOR = 1.1;
/** At this factor or more it reads high. */
const HIGH_FACTOR = 2;
/** What the exit must pay the sender, in USD, for the check to run: a gas-sized payout says nothing. */
export const ROUND_TRIP_MIN_USD = 0.1;
/** Objects the sender brought whose creating transaction is looked up, per transaction. */
const MAX_POSITIONS = 4;
/** The sender's earlier transactions on a vault read for mints, per burned coin. */
const MAX_ENTRIES = 50;
/** Entries that are not like-for-like priced again at their own time, per transaction. */
const MAX_REPRICED = 8;

const SUI = normalizeStructTag("0x2::sui::SUI");
const COIN = /^0x0*2::coin::(Coin|TreasuryCap)</;

/** One transaction's coin changes for one address, gas taken out when that address paid it. */
export interface Leg {
  digest: string;
  timestampMs: number;
  /** Per coin type, the address's net change; SUI excludes the gas it paid. */
  deltas: Map<string, bigint>;
}

/**
 * USD an address received on net in a leg, leaving out `unit`: null when a
 * coin it paid has no price (what it paid is then unknown), else the sum of
 * every priced coin, gains positive.
 */
export function legUsd(leg: Leg, prices: Map<string, PricePoint>, unit: string | null): number | null {
  let usd = 0;
  for (const [coin, raw] of leg.deltas) {
    if (coin === unit || raw === 0n) continue;
    const p = prices.get(coin);
    if (!p) {
      if (raw < 0n) return null;
      continue;
    }
    const human = toHumanAmount(raw < 0n ? -raw : raw, pricingScale(coin, p).decimals) * p.price;
    usd += raw < 0n ? -human : human;
  }
  return usd;
}

export interface RoundTrip {
  kind: "share" | "position";
  /** The share coin type, or the position object's id. */
  unit: string;
  /** For a share, the object holding its supply. */
  vault: string | null;
  entry_digest: string;
  entry_time: string;
  /** USD the sender paid for the units it redeemed, pro rata for shares. */
  paid_usd: number;
  received_usd: number;
  /** Received over paid. */
  factor: number;
  /** `same-coins`: both legs at this transaction's prices. `own-time`: each leg at its own time's prices, counted from {@link HIGH_FACTOR}. */
  basis: "same-coins" | "own-time";
}

/**
 * Whether an entry and an exit trade the same coins one way each: the entry
 * only paid and the exit only received (the unit aside), and every coin the
 * entry paid comes back in the exit.
 */
export function likeForLike(entry: Leg, exit: Leg, unit: string | null): boolean {
  const paid = [...entry.deltas].filter(([c, v]) => c !== unit && v !== 0n);
  const got = [...exit.deltas].filter(([c, v]) => c !== unit && v !== 0n);
  if (paid.some(([, v]) => v > 0n) || got.some(([, v]) => v < 0n)) return false;
  const back = new Set(got.map(([c]) => c));
  return paid.every(([c]) => back.has(c));
}

/**
 * Score an exit against its entry legs. A share entry is priced per unit
 * minted to the sender, and the exit per unit it burned; a position entry is
 * the whole creating transaction. An entry whose payment includes an
 * unpriced coin, or that paid nothing priced, is not scored. An entry that is
 * not like-for-like with the exit is valued at `ownPrices` (its own time's
 * prices) and counts from {@link HIGH_FACTOR}; without them it is not scored.
 */
export function scoreRoundTrip(
  kind: RoundTrip["kind"],
  unit: string,
  vault: string | null,
  exit: { leg: Leg; units: bigint | null },
  entries: Array<{ leg: Leg; units: bigint | null; ownPrices?: Map<string, PricePoint> }>,
  prices: Map<string, PricePoint>,
): RoundTrip | null {
  const skip = kind === "share" ? unit : null;
  const received = legUsd(exit.leg, prices, skip);
  if (received === null || received < ROUND_TRIP_MIN_USD) return null;
  let best: RoundTrip | null = null;
  for (const e of entries) {
    const same = likeForLike(e.leg, exit.leg, skip);
    if (!same && !e.ownPrices) continue;
    const net = legUsd(e.leg, same ? prices : e.ownPrices!, skip);
    if (net === null || net >= 0) continue;
    // Per unit for shares: what the redeemed units cost at the entry's rate.
    const paid = kind === "share" && e.units && exit.units ? (-net * Number(exit.units)) / Number(e.units) : -net;
    if (!(paid > 0)) continue;
    const factor = received / paid;
    if (factor < (same ? ROUND_TRIP_FACTOR : HIGH_FACTOR) || (best && best.factor >= factor)) continue;
    best = {
      kind,
      unit,
      vault,
      entry_digest: e.leg.digest,
      entry_time: new Date(e.leg.timestampMs).toISOString(),
      paid_usd: Number(paid.toPrecision(6)),
      received_usd: Number(received.toPrecision(6)),
      factor: Number(factor.toPrecision(4)),
      basis: same ? "same-coins" : "own-time",
    };
  }
  return best;
}

/** The exit leg: the sender's coin changes in this transaction, gas taken out when it paid. */
export function exitLeg(tx: Pick<AttackTx, "digest" | "timestampMs" | "balanceChanges" | "gas">, sender: string): Leg {
  const deltas = new Map<string, bigint>();
  for (const c of tx.balanceChanges) {
    if (normalizeSuiAddress(c.address) !== sender || !/^-?\d+$/.test(c.amount)) continue;
    const coin = normalizeStructTag(c.coinType);
    deltas.set(coin, (deltas.get(coin) ?? 0n) + BigInt(c.amount));
  }
  if (tx.gas && tx.gas.payer && normalizeSuiAddress(tx.gas.payer) === sender) deltas.set(SUI, (deltas.get(SUI) ?? 0n) + tx.gas.net);
  return { digest: tx.digest, timestampMs: tx.timestampMs ?? 0, deltas };
}

const LEG_SELECTION = `digest sender { address } gasInput { gasSponsor { address } }
  effects { status timestamp gasEffects { gasSummary { computationCost storageCost storageRebate } } ${BALANCE_CHANGES_SELECTION} }`;

interface LegNode {
  digest: string;
  sender?: { address?: string } | null;
  gasInput?: { gasSponsor?: { address?: string } | null } | null;
  effects?: {
    status?: string | null;
    timestamp?: string | null;
    gasEffects?: { gasSummary?: { computationCost?: string; storageCost?: string; storageRebate?: string } | null } | null;
    balanceChanges?: { nodes: Array<{ coinType?: { repr: string }; amount?: string; owner?: { address: string } }> } | null;
  } | null;
}

function legOf(n: LegNode, address: string): Leg | null {
  if (n.effects?.status && n.effects.status.toUpperCase() !== "SUCCESS") return null;
  const ts = n.effects?.timestamp ? Date.parse(n.effects.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  const deltas = new Map<string, bigint>();
  for (const b of n.effects?.balanceChanges?.nodes ?? []) {
    if (!b.owner?.address || normalizeSuiAddress(b.owner.address) !== address || !b.coinType?.repr || !b.amount) continue;
    const coin = normalizeStructTag(b.coinType.repr);
    deltas.set(coin, (deltas.get(coin) ?? 0n) + BigInt(b.amount));
  }
  const payer = n.gasInput?.gasSponsor?.address ?? n.sender?.address;
  const g = n.effects?.gasEffects?.gasSummary;
  if (payer && normalizeSuiAddress(payer) === address && g?.computationCost != null && g.storageCost != null && g.storageRebate != null) {
    deltas.set(SUI, (deltas.get(SUI) ?? 0n) + BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate));
  }
  return { digest: n.digest, timestampMs: ts, deltas };
}

const SENDER_ON_OBJECT = `query ($sender: SuiAddress!, $object: SuiAddress!, $before: UInt53, $last: Int) {
  transactions(filter: { sentAddress: $sender, affectedObject: $object, beforeCheckpoint: $before }, last: $last) { nodes { ${LEG_SELECTION} } }
}`;

/** The first two transactions that changed an object: the one that created it, and the next. */
const FIRST_ON_OBJECT = `query ($object: SuiAddress!) {
  transactions(filter: { affectedObject: $object }, first: 2) { nodes { ${LEG_SELECTION} } }
}`;

export interface RoundTripRead {
  trips: RoundTrip[];
  /** Units whose earlier legs could not be read. */
  unread: string[];
}

/**
 * Find the round trips a transaction completes for its sender. Only a
 * successful transaction that pays the sender at least
 * {@link ROUND_TRIP_MIN_USD} is looked at.
 */
export async function roundTripsOf(
  tx: Pick<AttackTx, "digest" | "sender" | "success" | "timestampMs" | "checkpoint" | "balanceChanges" | "gas" | "objects">,
  state: StateSnapshot | undefined,
  prices: Map<string, PricePoint>,
): Promise<RoundTripRead> {
  const none: RoundTripRead = { trips: [], unread: [] };
  if (!tx.success || !tx.sender || tx.timestampMs === null || tx.checkpoint === null) return none;
  const sender = normalizeSuiAddress(tx.sender);
  const exit = exitLeg(tx, sender);
  // Nothing priced reached the sender beyond gas: no exit to score.
  const gained = [...exit.deltas].reduce((sum, [coin, raw]) => {
    const p = prices.get(coin);
    return raw > 0n && p ? sum + toHumanAmount(raw, pricingScale(coin, p).decimals) * p.price : sum;
  }, 0);
  if (gained < ROUND_TRIP_MIN_USD) return none;
  const since = tx.timestampMs - ROUND_TRIP_WINDOW_MS;
  const before = Number(tx.checkpoint);

  // Shares: a coin the sender's balance lost and whose supply fell.
  const burned = state ? [...mintedTotals(state)].filter(([coin, d]) => d < 0n && (exit.deltas.get(coin) ?? 0n) < 0n) : [];
  const shares = burned.flatMap(([coin]) => {
    const holder = state!.objects.find((o) => Object.values(o.supplies).some((t) => normalizeStructTag(t) === coin));
    return holder ? [{ coin, vault: holder.role === "holding" && holder.parent ? holder.parent : holder.objectId }] : [];
  });
  // Positions: objects the transaction took as owned inputs, neither coins nor children.
  const positions = tx.objects
    .filter((o) => !o.shared && !o.parent && o.inputVersion && o.objectType && !COIN.test(o.objectType) && !/^0x0{60}/.test(normalizeSuiAddress(o.objectId)))
    .slice(0, MAX_POSITIONS);
  if (!shares.length && !positions.length) return none;

  const out: RoundTripRead = { trips: [], unread: [] };
  const found: Array<{
    kind: RoundTrip["kind"];
    unit: string;
    vault: string | null;
    exitUnits: bigint | null;
    entries: Array<{ leg: Leg; units: bigint | null; ownPrices?: Map<string, PricePoint> }>;
  }> = [];
  for (const s of shares) {
    try {
      const r = await gqlQuery<{ transactions: { nodes: LegNode[] } }>(SENDER_ON_OBJECT, { sender, object: s.vault, before, last: MAX_ENTRIES });
      const entries = r.transactions.nodes
        .map((n) => legOf(n, sender))
        .filter((l): l is Leg => l !== null && l.timestampMs >= since && (l.deltas.get(s.coin) ?? 0n) > 0n)
        .map((leg) => ({ leg, units: leg.deltas.get(s.coin)! }));
      found.push({ kind: "share", unit: s.coin, vault: s.vault, exitUnits: -(exit.deltas.get(s.coin) ?? 0n), entries });
    } catch {
      out.unread.push(s.coin);
    }
  }
  for (const p of positions) {
    try {
      const r = await gqlQuery<{ transactions: { nodes: LegNode[] } }>(FIRST_ON_OBJECT, { object: p.objectId });
      // Only a position this transaction is the first to change since the
      // sender created it: a deposit in between would make the creating
      // transaction's payment less than what the position holds.
      const [first, next] = r.transactions.nodes;
      if (!first || next?.digest !== tx.digest || !first.sender?.address || normalizeSuiAddress(first.sender.address) !== sender) continue;
      const leg = legOf(first, sender);
      if (leg && leg.timestampMs >= since) found.push({ kind: "position", unit: p.objectId, vault: null, exitUnits: null, entries: [{ leg, units: null }] });
    } catch {
      out.unread.push(p.objectId);
    }
  }
  if (!found.some((f) => f.entries.length)) return out;
  // Every coin the entries moved, priced at this transaction's time.
  const missing = [...new Set(found.flatMap((f) => f.entries.flatMap((e) => [...e.leg.deltas.keys()])))].filter((c) => !prices.has(c));
  const all = new Map(prices);
  if (missing.length) {
    const [priced] = await Promise.all([priceUsdAtTime(missing, Math.floor(tx.timestampMs / 1000)), prefetchCoinScale(missing)]);
    for (const [c, p] of priced.points) all.set(c, p);
  }
  // Entries that are not like-for-like with the exit, the latest first, at their own time's prices.
  const cross = found
    .flatMap((f) => f.entries.filter((e) => !likeForLike(e.leg, exit, f.kind === "share" ? f.unit : null)))
    .sort((a, b) => b.leg.timestampMs - a.leg.timestampMs)
    .slice(0, MAX_REPRICED);
  await Promise.all(
    cross.map(async (e) => {
      e.ownPrices = (await priceUsdAtTime([...e.leg.deltas.keys()], Math.floor(e.leg.timestampMs / 1000))).points;
    }),
  );
  for (const f of found) {
    const trip = scoreRoundTrip(f.kind, f.unit, f.vault, { leg: exit, units: f.exitUnits }, f.entries, all);
    if (trip) out.trips.push(trip);
  }
  return out;
}

export const ROUND_TRIP_CHECK: CheckRun = {
  code: "share-round-trip",
  rule: `the sender redeems shares or a position for ${ROUND_TRIP_FACTOR}x what it paid within 24 h (${HIGH_FACTOR}x, each leg at its own prices, when the legs trade other coins or borrow); high at ${HIGH_FACTOR}x`,
};

/** The `share-round-trip` anomaly: high at {@link HIGH_FACTOR}x or more, medium from {@link ROUND_TRIP_FACTOR}x. */
export function roundTripAnomaly(trips: RoundTrip[]): PtbAnomaly | null {
  if (!trips.length) return null;
  const top = Math.max(...trips.map((t) => t.factor));
  return {
    severity: top >= HIGH_FACTOR ? "high" : "medium",
    code: "share-round-trip",
    title: `Redeems shares or a position for ${top.toPrecision(3)}x what the sender paid for them within the last day`,
    detail: `Valued at this transaction's provider prices, what the sender receives here is ${ROUND_TRIP_FACTOR}x or more what it paid, within the previous 24 hours, for the vault shares it burns (per share, against each mint of that coin to it on the same vault) or for the position object it brings (against the transaction that created it, when nothing changed the object in between). A vault's share price moves by its yield in a day; a larger gain means the shares were issued against holdings the vault understated, through any version or price, and the redemption takes the difference from the other holders. High at ${HIGH_FACTOR}x or more. When the entry paid a coin the exit does not return, or a leg both paid and received (a zap, a borrow or a repayment), each leg is valued at its own time's prices instead, since one set of prices would measure one coin's move against another, and the trip counts only from ${HIGH_FACTOR}x (basis own-time). A reward claimed in the same transaction also counts as received; check the entry transaction with analyze_attack_tx.`,
    evidence: trips.map(
      (t) =>
        `${t.kind === "share" ? `${t.unit} shares of ${t.vault}` : `position ${t.unit}`}: received ${formatUsd(t.received_usd)} for what cost ${formatUsd(t.paid_usd)} in ${t.entry_digest} at ${t.entry_time} (${t.factor}x${t.basis === "own-time" ? ", each leg at its own time's prices" : ""})`,
    ),
  };
}
