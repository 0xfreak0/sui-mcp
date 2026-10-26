/** Pure, pairwise evidence scoring for one token launch. All coin amounts are raw units. */
import { isUnspendableAddress } from "./upgrade-cap.js";

export const LAUNCH_PAIR_THRESHOLD = 6;
export const LAUNCH_BURST_MS = 10 * 60_000;
const SUI_PAYMENT_FLOOR = 1_000_000_000n;

export interface LaunchPayment {
 to: string;
 asset: string;
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
 /** Explicitly distinguish an unpriced/unknown dust floor from a known failed floor. */
 qualifies: boolean | "unpriced";
}
export interface LaunchFirstFunding {
 funder: string | null;
 digest: string | null;
 /** A known funder can still be provisional when an earlier unpriced inflow could qualify. */
 lookupComplete: boolean;
 status: "narrow" | "hub" | "unmeasured" | "provisional" | "no_qualifying_inflow";
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
 /** First qualifying inflow, separate from launch-window top-ups. */
 firstFunding?: LaunchFirstFunding;
}

export interface LaunchDestination {
 address: string;
 kind: "wallet" | "object" | "package" | "shared" | "other";
 popularity: "narrow" | "popular" | "unmeasured" | "provisional";
 depositVerdict?: "likely" | "unknown" | "not-deposit";
 /** The classified window must cover the requested period before a likely deposit can score six. */
 classificationComplete?: boolean;
 /** Distinct senders of deposits in that classified window; null means unread. */
 distinctDepositors?: number | null;
 labelCategory?: "cex" | "bridge" | "protocol" | "other" | null;
 /** True for a direct exchange hot-wallet label; false for an inferred per-user deposit label. */
 exchangeHotWallet?: boolean;
 /** Full-balance sweeps of this deposit address, for on-chain follow-up. */
 sweeps?: Array<{ digest: string }>;
}

export interface LaunchScoringInput {
 creator: {
  address: string;
  /** Direct payments discovered from destination history after launch. */
  payments: LaunchPayment[];
  /** Payments strictly before launch; never a post-launch direct edge. */
  priorPayments?: LaunchPayment[];
  firstFunding?: LaunchFirstFunding;
 };
 buyers: LaunchBuyer[];
 destinations: LaunchDestination[];
 totalSupplyRaw: bigint;
}

export type LaunchSignalType =
 | "shared_destination" | "shared_deposit_address" | "creator_linked_destination" | "creator_paid_deposit" | "direct" | "first_funding"
 | "funding_burst" | "shared_funding_tx" | "shared_first_funder" | "referral" | "suins";

export interface LaunchSignal {
 type: LaunchSignalType;
 weight: number;
 via?: string;
 asset?: "sui" | "token" | "both";
 amount?: string;
 /** Direct payments and first funding point from the payer/funder to the recipient. */
 from?: string;
 to?: string;
 /** Both directions may qualify for one unordered pair, which still scores only three. */
 directions?: Array<{ from: string; to: string; asset: "sui" | "token"; amount: string; digests: string[] }>;
 transactionRecipientCount?: number;
 transactionStrength?: "targeted" | "other";
 digests: string[];
 sweep_digests?: string[];
 /** Total historical payments; digests sample both ends when the history is long. */
 prior_payment_count?: number;
 basis?: string;
}

export interface LaunchPairScore {
 a: string;
 b: string;
 score: number;
 sharedDestination: boolean;
 signals: LaunchSignal[];
}

export interface LaunchMemberPathEdge {
 from: string;
 to: string;
 score: number;
 /** The scored pair's actual evidence, not an inferred relationship. */
 signals: LaunchSignal[];
}

export interface LaunchMemberLink {
 address: string;
 /** Direction is part of the signal: paying the creator is not a creator payment. */
 status: "direct" | "paid_creator" | "via_creator_linked_destination" | "buyer_link_only";
 /** Shortest sequence of qualifying pairs from the creator (or micro-cluster root). */
 path: LaunchMemberPathEdge[];
}

export interface LaunchCluster {
 id: string;
 members: string[];
 /** Weakest qualifying pair, not an additive component score. */
 score: number;
 edges: LaunchPairScore[];
 status: "core" | "micro_cluster";
 evidence_tier: "heuristic";
 member_links: LaunchMemberLink[];
}

export interface LaunchObservation {
 type: "hub_mediated" | "funding_unmeasured" | "destination_ineligible" | "non_targeted_funding_tx" | "funding_below_floor" | "transfer_unpriced";
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
 buyers: { address: string; status: "core" | "micro_cluster" | "unclustered"; clusterId?: string; creator_relation?: Omit<LaunchMemberLink, "address"> }[];
 destinations: { address: string; eligible: boolean; affiliation: "creator_affiliated" | "buyer_shared" | "none" }[];
 observations: LaunchObservation[];
 sub_threshold_payments: LaunchSubThresholdPayment[];
}

function strongDeposit(d: LaunchDestination | undefined): boolean {
 return d?.depositVerdict === "likely" && d.classificationComplete === true
  && d.distinctDepositors != null && d.distinctDepositors <= 50;
}

function destinationEligible(d: LaunchDestination | undefined): boolean {
 // A burn address is nobody: two buyers burning coins there share no party.
 if (!d || isUnspendableAddress(d.address) || d.kind !== "wallet" || d.exchangeHotWallet
  || d.labelCategory === "bridge" || d.labelCategory === "protocol") return false;
 if (strongDeposit(d)) return true;
 return d.popularity === "narrow" && (d.labelCategory !== "cex" || d.exchangeHotWallet === false);
}

function ordered(a: string, b: string): [string, string] {
 return a < b ? [a, b] : [b, a];
}

function paymentFloor(asset: "sui" | "token", supply: bigint): bigint {
 // At least 0.05% of supply, rounded UP in raw launch-token units.
 return asset === "sui" ? SUI_PAYMENT_FLOOR : (supply + 1_999n) / 2_000n;
}

function launchAsset(asset: string): asset is "sui" | "token" {
 return asset === "sui" || asset === "token";
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

 // A destination must be a measured narrow wallet or a complete, small likely
 // deposit classification. Incomplete deposits use only the narrow fallback.
 const toDestination = new Map<string, Map<string, LaunchTransfer[]>>();
 for (const b of input.buyers) {
  for (const t of b.transfers) {
   if (t.qualifies === "unpriced") {
    observations.push({
     type: "transfer_unpriced", addresses: [b.address], via: t.destination,
     digests: [t.digest], reason: "Coin price or dust floor is unknown; the transfer cannot establish a qualifying destination."
    });
    continue;
   }
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
  if (p.referral || p.amount <= 0n || p.to === input.creator.address || !launchAsset(p.asset)) continue;
  const k = JSON.stringify([p.to, p.asset]);
  creatorTotals.set(k, (creatorTotals.get(k) ?? 0n) + p.amount);
 }
 for (const p of input.creator.payments) {
  const total = creatorTotals.get(JSON.stringify([p.to, p.asset]));
  if (p.referral || p.amount <= 0n || !launchAsset(p.asset) || total === undefined || total < paymentFloor(p.asset, input.totalSupplyRaw)) continue;
  const payments = creatorDestinations.get(p.to) ?? [];
  payments.push(p);
  creatorDestinations.set(p.to, payments);
 }
 // Keep the historical set separate: a creator's payment in any coin to an
 // exchange deposit is evidence of a payment, not of control over its owner.
 const priorDestinations = new Map<string, LaunchPayment[]>();
 const priorTotals = new Map<string, bigint>();
 const postlaunchPayments = new Set(input.creator.payments.map((p) => JSON.stringify([p.digest, p.to, p.asset, p.amount.toString()])));
 const seenPrior = new Set<string>();
 for (const p of input.creator.priorPayments ?? []) {
  if (p.referral || p.amount <= 0n || p.to === input.creator.address) continue;
  const identity = JSON.stringify([p.digest, p.to, p.asset, p.amount.toString()]);
  if (postlaunchPayments.has(identity) || seenPrior.has(identity)) continue;
  seenPrior.add(identity);
  const k = JSON.stringify([p.to, p.asset]);
  priorTotals.set(k, (priorTotals.get(k) ?? 0n) + p.amount);
  const payments = priorDestinations.get(p.to) ?? [];
  payments.push(p);
  priorDestinations.set(p.to, payments);
 }
 for (const [address, payments] of priorDestinations) {
  const historicalOnly = strongDeposit(destinationByAddress.get(address));
  priorDestinations.set(address, payments.filter((p) => {
   const k = JSON.stringify([p.to, p.asset]);
   const total = (priorTotals.get(k) ?? 0n) + (historicalOnly ? 0n : creatorTotals.get(k) ?? 0n);
   // An independently classified deposit establishes only a historical payment,
   // not control. Count every positive transfer by its own coin, without using
   // the launch token's supply as the floor of an unrelated coin.
   return historicalOnly || (launchAsset(p.asset) && total >= paymentFloor(p.asset, input.totalSupplyRaw));
  }));
 }
 const destinations: LaunchScoringResult["destinations"] = [];
 for (const address of new Set([...destinationByAddress.keys(), ...toDestination.keys()])) {
  const byBuyer = toDestination.get(address);
  const eligible = destinationEligible(destinationByAddress.get(address));
  const shared = !!byBuyer && byBuyer.size >= 2;
  const priorPayments = priorDestinations.get(address);
  const deposit = strongDeposit(destinationByAddress.get(address));
  const postlaunch = creatorDestinations.get(address) ?? [];
  const historicNarrow = !deposit && eligible && !!priorPayments?.length;
  const creatorPayments = [
   ...postlaunch,
   ...(historicNarrow ? input.creator.payments.filter((p) =>
    p.to === address && !p.referral && p.amount > 0n && launchAsset(p.asset) && !postlaunch.includes(p) &&
    (priorTotals.get(JSON.stringify([p.to, p.asset])) ?? 0n) +
    (creatorTotals.get(JSON.stringify([p.to, p.asset])) ?? 0n) >= paymentFloor(p.asset, input.totalSupplyRaw)) : []),
   ...(historicNarrow ? priorPayments! : []),
  ];
  destinations.push({
   address, eligible, affiliation: eligible && !deposit && creatorPayments.length && byBuyer?.size
    ? "creator_affiliated" : shared && eligible ? "buyer_shared" : "none"
  });
  if (!byBuyer || !eligible) {
   if (shared && !eligible) {
   observations.push({
     type: "destination_ineligible", addresses: [...byBuyer!.keys()].sort(), via: address,
     digests: [...new Set([...byBuyer!.values()].flat().map((t) => t.digest))].sort(),
    reason: "Destination is not a measured narrow wallet or a likely deposit address."
   });
   }
   continue;
  }
  if (deposit && priorPayments?.length) {
   const amounts = new Map<string, { amount: bigint; count: number }>();
   for (const payment of priorPayments) {
    const sum = amounts.get(payment.asset) ?? { amount: 0n, count: 0 };
    sum.amount += payment.amount;
    sum.count++;
    amounts.set(payment.asset, sum);
   }
   const chronological = [...priorPayments].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? "") || a.digest.localeCompare(b.digest));
   const sampled = chronological.length <= 8 ? chronological : [...chronological.slice(0, 4), ...chronological.slice(-4)];
   for (const [buyer, transfers] of byBuyer) {
    if (buyer === input.creator.address) continue;
    const assets = new Set([...transfers.map((t) => t.asset), ...amounts.keys()]);
    add(buyer, input.creator.address, {
     type: "creator_paid_deposit", weight: 3, via: address,
     ...(assets.size <= 2 && [...assets].every(launchAsset)
      ? { asset: assets.size === 2 ? "both" as const : [...assets][0] as "sui" | "token" } : {}),
     amount: [...transfers.map((t) => `${t.amount} ${t.asset}`),
     ...[...amounts].map(([asset, sum]) =>
      `${sum.amount} ${asset} in ${sum.count} qualifying positive payment(s)`)].join(", "),
     digests: [...new Set([...transfers.map((t) => t.digest), ...sampled.map((p) => p.digest)])].sort(),
     prior_payment_count: priorPayments.length,
     basis: "The creator previously paid this likely single-account deposit. Amounts are raw, grouped by coin type rather than added across coins; prior_payment_count counts qualifying positive payments per coin, not distinct transactions read. Digests sample earliest and latest payments; destinations[].creator_prior_payments lists every dated transfer. Anyone can pay a deposit; payment amounts do not prove who owns its account."
    });
   }
  }
  if (shared) {
  const buyers = [...byBuyer.keys()].sort();
  for (let i = 0; i < buyers.length; i++) {
   for (let j = i + 1; j < buyers.length; j++) {
    const transfers = [...byBuyer.get(buyers[i])!, ...byBuyer.get(buyers[j])!];
    const assets = new Set(transfers.map((t) => t.asset));
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
   }
  }
  if (!deposit && creatorPayments.length) {
   for (const [buyer, buyerTransfers] of byBuyer) {
    if (buyer === input.creator.address) continue;
    // One buyer and a verified creator payment to the same measured private
    // destination suffice; no second buyer is required.
    const assets = new Set([...buyerTransfers.map((t) => t.asset), ...creatorPayments.map((p) => p.asset)]);
    add(buyer, input.creator.address, {
     type: "creator_linked_destination", weight: 6, via: address,
     asset: assets.size === 2 ? "both" : buyerTransfers[0].asset,
     amount: [...buyerTransfers.map((t) => `${t.amount} ${t.asset}`),
     ...creatorPayments.map((p) => `${p.amount} ${p.asset}`)].join(", "),
     digests: [...new Set([
      ...buyerTransfers.map((t) => t.digest), ...creatorPayments.map((p) => p.digest),
     ])].sort()
    });
   }
  }
 }

 // First-ever funding is evaluated before launch-window direct payments so a
 // transaction appearing in both reads contributes only its first-funding edge.
 // First-ever funding is a directed payment from a known subject to another
 // subject, regardless of when it happened or whether that subject is popular.
 // Shared ancestry through a third-party funder is different: it needs two
 // independently measured narrow verdicts below. A recorded funding digest
 // cannot also earn direct-payment or launch-top-up points for the same pair.
 const firstEntries = [{ address: input.creator.address, funding: input.creator.firstFunding },
 ...input.buyers.map((b) => ({ address: b.address, funding: b.firstFunding }))];
 const firstFundingDirectDigests = new Map<string, Set<string>>();
 for (const { address, funding: first } of firstEntries) {
  if (first && !first.lookupComplete && first.funder) {
   observations.push({
    type: "funding_unmeasured", addresses: [address], via: first.funder,
    digests: first.digest ? [first.digest] : [],
    reason: "An earlier inflow could qualify; this tentative first funder scores zero."
   });
  }
  if (!first?.lookupComplete || !first.funder || !allAddresses.has(first.funder) || first.funder === address || isUnspendableAddress(first.funder)) continue;
  const pairKey = key(first.funder, address);
  const digests = firstFundingDirectDigests.get(pairKey) ?? new Set<string>();
  if (first.digest) digests.add(first.digest);
  firstFundingDirectDigests.set(pairKey, digests);
  add(first.funder, address, {
   type: "first_funding", weight: 3, from: first.funder, to: address,
   digests: first.digest ? [first.digest] : [],
   basis: "The funder is itself a launch subject and first-funded this recipient, at any date. This direct edge does not infer a relationship through a third-party hub."
  });
 }
 type PaymentGroup = { from: string; to: string; asset: "sui" | "token"; amount: bigint; digests: Set<string> };
 const grouped = new Map<string, PaymentGroup>();
 for (const b of input.buyers) {
  for (const p of b.payments) {
   if (p.referral || !launchAsset(p.asset) || !allAddresses.has(p.to) || p.to === b.address || p.amount <= 0n
    || firstFundingDirectDigests.get(key(b.address, p.to))?.has(p.digest)) continue;
   const k = JSON.stringify([b.address, p.to, p.asset]);
   const group = grouped.get(k) ?? { from: b.address, to: p.to, asset: p.asset, amount: 0n, digests: new Set<string>() };
   group.amount += p.amount;
   group.digests.add(p.digest);
   grouped.set(k, group);
  }
 }
 for (const p of input.creator.payments) {
  if (p.referral || !launchAsset(p.asset) || !buyerAddresses.has(p.to) || p.amount <= 0n
   || firstFundingDirectDigests.get(key(input.creator.address, p.to))?.has(p.digest)) continue;
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
   ...(flows.every((f) => f.from === p.from && f.to === p.to) ? { from: p.from, to: p.to } : {}),
   directions: flows.map((f) => ({
    from: f.from, to: f.to, asset: f.asset,
    amount: f.amount.toString(), digests: [...f.digests].sort()
   })),
   amount: flows.map((f) => `${f.amount} ${f.asset}`).join(", "),
   digests: [...new Set(flows.flatMap((f) => [...f.digests]))].sort()
  });
 }
 // Shared first funders are third-party ancestry, not direct funding. They
 // score only when both origins are measured narrow; a hub or partial
 // verdict stays an observation even if the first transfers were on one date.
 const firstBySource = new Map<string, Array<{ address: string; funding: LaunchFirstFunding }>>();
 for (const entry of firstEntries) {
  if (!entry.funding?.lookupComplete || !entry.funding.funder || isUnspendableAddress(entry.funding.funder)) continue;
  const group = firstBySource.get(entry.funding.funder) ?? [];
  group.push({ address: entry.address, funding: entry.funding });
  firstBySource.set(entry.funding.funder, group);
 }
 for (const [funder, group] of firstBySource) {
  for (let i = 0; i < group.length; i++) {
   for (let j = i + 1; j < group.length; j++) {
    const a = group[i], b = group[j];
    if (a.address === b.address) continue;
    const digests = [...new Set([a.funding.digest, b.funding.digest].filter((d): d is string => d != null))].sort();
    if (a.funding.status === "narrow" && b.funding.status === "narrow") {
     add(a.address, b.address, { type: "shared_first_funder", weight: 3, via: funder, digests });
    } else {
     const statuses = [a.funding.status, b.funding.status];
     observations.push({
      type: statuses.includes("hub") ? "hub_mediated" : "funding_unmeasured",
      addresses: ordered(a.address, b.address), via: funder, digests,
      reason: `Shared first funder has ${statuses.join(" and ")} source verdicts; a hub or incomplete source scores zero.`
     });
    }
   }
  }
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
    const excluded = firstFundingDirectDigests.get(k);
    if (!excluded) {
    const digests = burstPairs.get(k) ?? new Set<string>();
    for (const digest of [...buyers.get(addresses[i])!, ...buyers.get(addresses[j])!]) digests.add(digest);
     burstPairs.set(k, digests);
     continue;
    }
    // Removing one first-funding transaction can remove a participant,
    // not merely a digest. Keep the pair only if both members and a third
    // buyer still have independent top-ups within this same ten-minute window.
    const independent = new Set<string>();
    let participants = 0, pairParticipants = 0;
    for (const [buyer, digests] of buyers) {
     let included = false;
     for (const digest of digests) {
      if (excluded.has(digest)) continue;
      included = true;
      if (buyer === addresses[i] || buyer === addresses[j]) independent.add(digest);
     }
     if (!included) continue;
     participants++;
     if (buyer === addresses[i] || buyer === addresses[j]) pairParticipants++;
    }
    if (participants < 3 || pairParticipants < 2) continue;
    const digests = burstPairs.get(k) ?? new Set<string>();
    for (const digest of independent) digests.add(digest);
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
    if (firstFundingDirectDigests.get(k)?.has(digest)) continue;
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
   evidence_tier: "heuristic" as const, member_links: []
  }))
  .sort((a, b) => a.members[0].localeCompare(b.members[0]));
 // Breadth-first traversal gives every member a shortest path made only of
 // qualifying edges. Sort neighbours so ties do not depend on input order.
 for (const cluster of clusters) {
  const source = cluster.members.includes(input.creator.address) ? input.creator.address : cluster.members[0];
  const neighbours = new Map<string, Array<{ to: string; pair: LaunchPairScore }>>();
  for (const edge of cluster.edges) {
   for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]]) {
    const rows = neighbours.get(from) ?? [];
    rows.push({ to, pair: edge });
    neighbours.set(from, rows);
   }
  }
  const paths = new Map<string, LaunchMemberPathEdge[]>([[source, []]]);
  const queue = [source];
  for (let index = 0; index < queue.length; index++) {
   const from = queue[index];
   for (const { to, pair } of (neighbours.get(from) ?? []).sort((a, b) => a.to.localeCompare(b.to))) {
    if (paths.has(to)) continue;
    paths.set(to, [...paths.get(from)!, { from, to, score: pair.score, signals: pair.signals }]);
    queue.push(to);
   }
  }
  cluster.member_links = cluster.members.map((address) => {
   const creatorPair = cluster.edges.find((edge) =>
    (edge.a === input.creator.address && edge.b === address) || (edge.b === input.creator.address && edge.a === address));
   const status = address === input.creator.address || creatorPair?.signals.some((s) =>
    s.type === "first_funding" && s.from === input.creator.address && s.to === address
    || s.type === "direct" && s.directions?.some((direction) =>
     direction.from === input.creator.address && direction.to === address))
    ? "direct" : creatorPair?.signals.some((s) =>
     s.type === "first_funding" && s.from === address && s.to === input.creator.address
     || s.type === "direct" && s.directions?.some((direction) =>
      direction.from === address && direction.to === input.creator.address))
     ? "paid_creator" : creatorPair?.signals.some((s) => s.type === "creator_linked_destination")
     ? "via_creator_linked_destination" : "buyer_link_only";
   return { address, status, path: paths.get(address)! };
  });
 }
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
   if (!cluster) return { address: b.address, status: "unclustered" as const };
   const { status, path } = cluster.member_links.find((link) => link.address === b.address)!;
   return { address: b.address, status: cluster.status, clusterId: cluster.id, creator_relation: { status, path } };
  }),
  destinations: destinations.sort((a, b) => a.address.localeCompare(b.address)), observations,
  sub_threshold_payments: subThreshold.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.asset.localeCompare(b.asset)),
 };
}
