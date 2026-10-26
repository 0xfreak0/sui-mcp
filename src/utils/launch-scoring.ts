/** Pure, pairwise evidence scoring for one token launch. All coin amounts are raw units. */
import { isUnspendableAddress } from "./upgrade-cap.js";

export const LAUNCH_PAIR_THRESHOLD = 6;
export const LAUNCH_BURST_MS = 10 * 60_000;
const SUI_PAYMENT_FLOOR = 1_000_000_000n;

export interface LaunchPayment {
 to: string;
 asset: "sui" | "token";
 amount: bigint;
 digest: string;
 /** Chain timestamp of the payment, if the source query supplied it. */
 timestamp?: string;
 /** SuiPump referral fees are not direct payments, regardless of their size. */
 referral?: boolean;
}

export interface LaunchFunding {
 source: string;
 amountMist: bigint;
 digest: string;
 at: number;
 /** A narrow verdict must be measured and must exclude labelled hubs. */
 sourceStatus: "narrow" | "hub" | "unmeasured" | "provisional";
 transactionRecipientCount?: number;
 transactionStrength?: "targeted" | "other";
}

export interface LaunchTransfer {
 destination: string;
 asset: "sui" | "token";
 amount: bigint;
 digest: string;
 /** Result of the caller's coin-aware dust-floor check. */
 qualifies: boolean;
}

export interface LaunchBuyer {
 address: string;
 /** Launch-window incoming payments, never first-ever funding. */
 funding: LaunchFunding[];
 transfers: LaunchTransfer[];
 /** Buyer-to-buyer payments inside the direct-payment window. */
 payments: LaunchPayment[];
 /** Referral addresses named by buy events. */
 referrals: string[];
 suinsNames: string[];
}

export interface LaunchDestination {
 address: string;
 kind: "wallet" | "object" | "package" | "shared" | "other";
 popularity: "narrow" | "popular" | "unmeasured" | "provisional";
 depositVerdict?: "likely" | "unknown" | "not-deposit";
 labelCategory?: "cex" | "bridge" | "protocol" | "other" | null;
 /** A labelled exchange hot wallet never qualifies as a single-account deposit. */
 exchangeHotWallet?: boolean;
 /** Full-balance sweeps of this deposit address, for on-chain follow-up. */
 sweeps?: Array<{ digest: string }>;
}

export interface LaunchScoringInput {
 creator: { address: string; /** Direct payments discovered from destination history. */ payments: LaunchPayment[] };
 buyers: LaunchBuyer[];
 destinations: LaunchDestination[];
 totalSupplyRaw: bigint;
}

export type LaunchSignalType =
 | "shared_destination" | "shared_deposit_address" | "creator_linked_destination" | "direct"
 | "funding_burst" | "shared_funding_tx" | "referral" | "suins";

export interface LaunchSignal {
 type: LaunchSignalType;
 weight: number;
 via?: string;
 asset?: "sui" | "token" | "both";
 amount?: string;
 transactionRecipientCount?: number;
 transactionStrength?: "targeted" | "other";
 digests: string[];
 sweep_digests?: string[];
 basis?: string;
}

export interface LaunchPairScore {
 a: string;
 b: string;
 score: number;
 sharedDestination: boolean;
 signals: LaunchSignal[];
}

export interface LaunchCluster {
 id: string;
 members: string[];
 /** Weakest qualifying pair, not an additive component score. */
 score: number;
 edges: LaunchPairScore[];
 status: "core" | "micro_cluster";
 evidence_tier: "heuristic";
}

export interface LaunchObservation {
 type: "hub_mediated" | "funding_unmeasured" | "destination_ineligible" | "non_targeted_funding_tx" | "funding_below_floor";
 addresses: string[];
 via: string;
 digests: string[];
 reason: string;
}

export interface LaunchSubThresholdPayment {
 from: string;
 to: string;
 asset: "sui" | "token";
 amount: string;
 digests: string[];
}

export interface LaunchScoringResult {
 pairs: LaunchPairScore[];
 clusters: LaunchCluster[];
 /** Observed pairs that failed the pairwise threshold or shared-destination core condition. */
 below_threshold: LaunchPairScore[];
 buyers: { address: string; status: "core" | "micro_cluster" | "unclustered"; clusterId?: string }[];
 destinations: { address: string; eligible: boolean; affiliation: "creator_affiliated" | "buyer_shared" | "none" }[];
 observations: LaunchObservation[];
 sub_threshold_payments: LaunchSubThresholdPayment[];
}

function destinationEligible(d: LaunchDestination | undefined): boolean {
 // A burn address is nobody: two buyers burning coins there share no party.
 if (!d || isUnspendableAddress(d.address) || d.kind !== "wallet" || d.exchangeHotWallet
  || d.labelCategory === "bridge" || d.labelCategory === "protocol") return false;
 if (d.depositVerdict === "likely") return true;
 return d.popularity === "narrow" && d.labelCategory !== "cex";
}

function ordered(a: string, b: string): [string, string] {
 return a < b ? [a, b] : [b, a];
}

function paymentFloor(asset: "sui" | "token", supply: bigint): bigint {
 // At least 0.05% of supply, rounded UP in raw token units.
 return asset === "sui" ? SUI_PAYMENT_FLOOR : (supply + 1_999n) / 2_000n;
}

/**
 * Scores each pair independently, then connects only pairs scoring at least six.
 * A core component additionally needs a shared eligible destination on one of
 * its qualifying pairs. A creator can enter via a destination shared with two
 * buyers that the creator directly paid: +3 shared destination and +3 creator
 * linkage. This does not treat a payment to the destination as a payment to a buyer.
 */
export function scoreLaunch(input: LaunchScoringInput): LaunchScoringResult {
 const buyerAddresses = new Set(input.buyers.map((b) => b.address));
 const destinationByAddress = new Map(input.destinations.map((d) => [d.address, d]));
 const allAddresses = new Set([...buyerAddresses, input.creator.address]);
 const pairs = new Map<string, LaunchPairScore>();
 const observations: LaunchObservation[] = [];
 const subThreshold: LaunchSubThresholdPayment[] = [];
 const key = (a: string, b: string) => JSON.stringify(ordered(a, b));
 function add(a: string, b: string, signal: LaunchSignal): void {
  if (a === b) return;
  const [left, right] = ordered(a, b);
  const k = key(left, right);
  let pair = pairs.get(k);
  if (!pair) {
   pair = { a: left, b: right, score: 0, sharedDestination: false, signals: [] };
   pairs.set(k, pair);
  }
  pair.signals.push(signal);
  pair.score += signal.weight;
  if (signal.type === "shared_destination" || signal.type === "shared_deposit_address" || signal.type === "creator_linked_destination") {
   pair.sharedDestination = true;
  }
 }

 // A destination must be a measured narrow wallet or a likely single-account
 // deposit. Unknown and provisional classifications fail closed.
 const toDestination = new Map<string, Map<string, LaunchTransfer[]>>();
 for (const b of input.buyers) {
  for (const t of b.transfers) {
   if (!t.qualifies || t.amount <= 0n) continue;
   const byBuyer = toDestination.get(t.destination) ?? new Map<string, LaunchTransfer[]>();
   const transfers = byBuyer.get(b.address) ?? [];
   transfers.push(t);
   byBuyer.set(b.address, transfers);
   toDestination.set(t.destination, byBuyer);
  }
 }
 // The creator paying a destination links it only above the direct-payment
 // floor, summed per coin, and never when the destination is the creator.
 const creatorDestinations = new Map<string, LaunchPayment[]>();
 const creatorTotals = new Map<string, bigint>();
 for (const p of input.creator.payments) {
  if (p.referral || p.amount <= 0n || p.to === input.creator.address) continue;
  const k = JSON.stringify([p.to, p.asset]);
  creatorTotals.set(k, (creatorTotals.get(k) ?? 0n) + p.amount);
 }
 for (const p of input.creator.payments) {
  const total = creatorTotals.get(JSON.stringify([p.to, p.asset]));
  if (p.referral || p.amount <= 0n || total === undefined || total < paymentFloor(p.asset, input.totalSupplyRaw)) continue;
  const payments = creatorDestinations.get(p.to) ?? [];
  payments.push(p);
  creatorDestinations.set(p.to, payments);
 }
 const destinations: LaunchScoringResult["destinations"] = [];
 for (const address of new Set([...destinationByAddress.keys(), ...toDestination.keys()])) {
  const byBuyer = toDestination.get(address);
  const eligible = destinationEligible(destinationByAddress.get(address));
  const shared = !!byBuyer && byBuyer.size >= 2;
  const creatorPayments = creatorDestinations.get(address);
  destinations.push({
   address, eligible, affiliation: shared && eligible
    ? creatorPayments?.length ? "creator_affiliated" : "buyer_shared" : "none"
  });
  if (!byBuyer || !shared) continue;
  if (!eligible) {
   observations.push({
    type: "destination_ineligible", addresses: [...byBuyer.keys()].sort(), via: address,
    digests: [...new Set([...byBuyer.values()].flat().map((t) => t.digest))].sort(),
    reason: "Destination is not a measured narrow wallet or a likely deposit address."
   });
   continue;
  }
  const buyers = [...byBuyer.keys()].sort();
  for (let i = 0; i < buyers.length; i++) {
   for (let j = i + 1; j < buyers.length; j++) {
    const transfers = [...byBuyer.get(buyers[i])!, ...byBuyer.get(buyers[j])!];
    const assets = new Set(transfers.map((t) => t.asset));
    const deposit = destinationByAddress.get(address)?.depositVerdict === "likely";
    add(buyers[i], buyers[j], {
     type: deposit ? "shared_deposit_address" : "shared_destination",
     weight: deposit ? LAUNCH_PAIR_THRESHOLD : 3, via: address,
     asset: assets.size === 2 ? "both" : transfers[0].asset,
     amount: transfers.map((t) => `${t.amount} ${t.asset}`).join(", "),
     digests: [...new Set(transfers.map((t) => t.digest))].sort(),
     ...(deposit ? {
      basis: "Both buyers paid one likely single-account deposit address; anyone can pay an address, so shared control of the buyers remains heuristic.",
      sweep_digests: [...new Set(destinationByAddress.get(address)?.sweeps?.map(s => s.digest) ?? [])].sort(),
     } : {}),
    });
   }
   if (creatorPayments?.length && buyers[i] !== input.creator.address) {
    // Two independent facts: the buyer reached a jointly used destination,
    // and the creator paid that same destination directly.
    const buyerTransfers = byBuyer.get(buyers[i])!;
    const assets = new Set([...buyerTransfers.map((t) => t.asset), ...creatorPayments.map((p) => p.asset)]);
    add(buyers[i], input.creator.address, {
     type: "creator_linked_destination", weight: 6, via: address,
     asset: assets.size === 2 ? "both" : [...assets][0],
     amount: [...buyerTransfers.map((t) => `${t.amount} ${t.asset}`),
     ...creatorPayments.map((p) => `${p.amount} ${p.asset}`)].join(", "),
     digests: [...new Set([
      ...buyerTransfers.map((t) => t.digest), ...creatorPayments.map((p) => p.digest),
     ])].sort()
    });
   }
  }
 }

 // Direct buyer-to-buyer payments are aggregated by direction AND asset, so
 // several dust sends can meet a floor; opposite directions do not cancel.
 type PaymentGroup = { from: string; to: string; asset: "sui" | "token"; amount: bigint; digests: Set<string> };
 const grouped = new Map<string, PaymentGroup>();
 for (const b of input.buyers) {
  for (const p of b.payments) {
   if (p.referral || !allAddresses.has(p.to) || p.to === b.address || p.amount <= 0n) continue;
   const k = JSON.stringify([b.address, p.to, p.asset]);
   const group = grouped.get(k) ?? { from: b.address, to: p.to, asset: p.asset, amount: 0n, digests: new Set<string>() };
   group.amount += p.amount;
   group.digests.add(p.digest);
   grouped.set(k, group);
  }
 }
 for (const p of input.creator.payments) {
  if (p.referral || !buyerAddresses.has(p.to) || p.amount <= 0n) continue;
  const k = JSON.stringify([input.creator.address, p.to, p.asset]);
  const group = grouped.get(k) ?? { from: input.creator.address, to: p.to, asset: p.asset, amount: 0n, digests: new Set<string>() };
  group.amount += p.amount;
  group.digests.add(p.digest);
  grouped.set(k, group);
 }
 const qualifyingPayments = new Map<string, PaymentGroup[]>();
 for (const p of grouped.values()) {
  if (p.amount < paymentFloor(p.asset, input.totalSupplyRaw)) {
   subThreshold.push({ from: p.from, to: p.to, asset: p.asset, amount: p.amount.toString(), digests: [...p.digests].sort() });
   continue;
  }
  const k = key(p.from, p.to);
  const flows = qualifyingPayments.get(k) ?? [];
  flows.push(p);
  qualifyingPayments.set(k, flows);
 }
 for (const flows of qualifyingPayments.values()) {
  const p = flows[0];
  add(p.from, p.to, {
   type: "direct", weight: 3,
   amount: flows.map((f) => `${f.amount} ${f.asset}`).join(", "),
   digests: [...new Set(flows.flatMap((f) => [...f.digests]))].sort()
  });
 }

 const funding: { buyer: string; payment: LaunchFunding }[] = [];
 const byTx = new Map<string, { buyer: string; payment: LaunchFunding }[]>();
 for (const b of input.buyers) {
  for (const p of b.funding) {
   if (p.amountMist < 10_000_000n) {
    observations.push({
     type: "funding_below_floor", addresses: [b.address], via: p.source,
     digests: [p.digest], reason: "Funding below the 0.01 SUI dust floor scores zero."
    });
    continue;
   }
   if (p.sourceStatus !== "narrow") {
    observations.push({
     type: p.sourceStatus === "hub" ? "hub_mediated" : "funding_unmeasured",
     addresses: [b.address], via: p.source, digests: [p.digest],
     reason: `Funding source ${p.sourceStatus}; timing and shared transactions score zero.`
    });
    continue;
   }
   funding.push({ buyer: b.address, payment: p });
   const group = byTx.get(p.digest) ?? [];
   group.push({ buyer: b.address, payment: p });
   byTx.set(p.digest, group);
  }
 }
 funding.sort((a, b) => a.payment.at - b.payment.at || a.buyer.localeCompare(b.buyer));
 const burstPairs = new Map<string, Set<string>>();
 for (let start = 0; start < funding.length; start++) {
  let end = start;
  const buyers = new Map<string, string[]>();
  while (end < funding.length && funding[end].payment.at - funding[start].payment.at <= LAUNCH_BURST_MS) {
   const entry = funding[end++];
   const digests = buyers.get(entry.buyer) ?? [];
   digests.push(entry.payment.digest);
   buyers.set(entry.buyer, digests);
  }
  if (buyers.size < 3) continue;
  const addresses = [...buyers.keys()].sort();
  for (let i = 0; i < addresses.length; i++) {
   for (let j = i + 1; j < addresses.length; j++) {
    const k = key(addresses[i], addresses[j]);
    const digests = burstPairs.get(k) ?? new Set<string>();
    for (const digest of [...buyers.get(addresses[i])!, ...buyers.get(addresses[j])!]) digests.add(digest);
    burstPairs.set(k, digests);
   }
  }
 }
 for (const [k, digests] of burstPairs) {
  const [a, b] = JSON.parse(k) as [string, string];
  add(a, b, { type: "funding_burst", weight: 2, digests: [...digests].sort() });
 }
 const sharedTxPairs = new Map<string, LaunchSignal>();
 for (const [digest, entries] of byTx) {
  const buyers = [...new Set(entries.map((e) => e.buyer))].sort();
  if (buyers.length < 2) continue;
  if (!entries.every((e) => e.payment.transactionStrength === "targeted"
   || (e.payment.transactionRecipientCount != null && e.payment.transactionRecipientCount <= 5))) {
   observations.push({
    type: "non_targeted_funding_tx", addresses: buyers, via: entries[0].payment.source,
    digests: [digest], reason: "Shared funding transaction was not established as targeted (at most five recipients)."
   });
   continue;
  }
  for (let i = 0; i < buyers.length; i++) {
   for (let j = i + 1; j < buyers.length; j++) {
    const k = key(buyers[i], buyers[j]);
    const signal = sharedTxPairs.get(k) ?? {
     type: "shared_funding_tx", weight: 2, via: entries[0].payment.source,
     amount: "", transactionRecipientCount: entries[0].payment.transactionRecipientCount,
     transactionStrength: entries[0].payment.transactionStrength, digests: []
    };
    signal.digests.push(digest);
    const amounts = entries.filter((e) => e.buyer === buyers[i] || e.buyer === buyers[j])
     .map((e) => `${e.payment.amountMist} sui_mist`).join(", ");
    signal.amount = signal.amount ? `${signal.amount}; ${amounts}` : amounts;
    sharedTxPairs.set(k, signal);
   }
  }
 }
 for (const [k, signal] of sharedTxPairs) {
  const [a, b] = JSON.parse(k) as [string, string];
  signal.digests.sort();
  add(a, b, signal);
 }
 for (let i = 0; i < input.buyers.length; i++) {
  const a = input.buyers[i];
  const aNames = new Set(a.suinsNames);
  for (let j = i + 1; j < input.buyers.length; j++) {
   const b = input.buyers[j];
   const sharedNames = [...new Set(b.suinsNames.filter((name) => aNames.has(name)))];
   if (sharedNames.length) add(a.address, b.address, { type: "suins", weight: 1, via: sharedNames.sort().join(", "), digests: [] });
  }
 }
 const referralPairs = new Set<string>();
 for (const b of input.buyers) {
  for (const referral of b.referrals) {
   if (!allAddresses.has(referral) || b.address === referral) continue;
   const k = key(b.address, referral);
   if (referralPairs.has(k)) continue;
   referralPairs.add(k);
   add(b.address, referral, { type: "referral", weight: 1, digests: [] });
  }
 }

 const scoredPairs = [...pairs.values()].sort((a, b) => a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
 const qualified = scoredPairs.filter((p) => p.score >= LAUNCH_PAIR_THRESHOLD);
 const parent = new Map<string, string>([...allAddresses].map((a) => [a, a]));
 function root(address: string): string {
  const p = parent.get(address)!;
  if (p === address) return p;
  const r = root(p);
  parent.set(address, r);
  return r;
 }
 for (const p of qualified) parent.set(root(p.b), root(p.a));
 const groups = new Map<string, { members: string[]; edges: LaunchPairScore[] }>();
 for (const address of allAddresses) {
  const r = root(address);
  const group = groups.get(r) ?? { members: [], edges: [] };
  group.members.push(address);
  groups.set(r, group);
 }
 for (const p of qualified) groups.get(root(p.a))!.edges.push(p);
 const clusters: LaunchCluster[] = [...groups.values()]
  .filter((g) => g.members.length > 1)
  .map((g) => ({
   id: "", members: g.members.sort(), score: Math.min(...g.edges.map((e) => e.score)),
   edges: g.edges, status: g.members.includes(input.creator.address) && g.edges.some((e) => e.sharedDestination) ? "core" as const : "micro_cluster" as const,
   evidence_tier: "heuristic" as const
  }))
  .sort((a, b) => a.members[0].localeCompare(b.members[0]));
 let coreId = 0;
 let microId = 0;
 const membership = new Map<string, LaunchCluster>();
 for (const cluster of clusters) {
  cluster.id = cluster.status === "core" ? `core-${++coreId}` : `micro-${++microId}`;
  for (const member of cluster.members) membership.set(member, cluster);
 }
 return {
  pairs: scoredPairs, clusters,
  below_threshold: scoredPairs.filter((p) => p.score < LAUNCH_PAIR_THRESHOLD),
  buyers: input.buyers.map((b) => {
   const cluster = membership.get(b.address);
   return cluster ? { address: b.address, status: cluster.status, clusterId: cluster.id }
    : { address: b.address, status: "unclustered" as const };
  }),
  destinations: destinations.sort((a, b) => a.address.localeCompare(b.address)), observations,
  sub_threshold_payments: subThreshold.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.asset.localeCompare(b.asset)),
 };
}
