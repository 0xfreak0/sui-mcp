import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { resolveWindow } from "./checkpoint-time.js";
import { fetchPackageVersions, resolveEventTypeFilter } from "./package-versions.js";
import { BALANCE_CHANGES_SELECTION, EVENTS_SELECTION, completeTxConnections, type GqlConnection, type GqlEventNode } from "./tx-connections.js";
import type { GqlBalanceChangeNode } from "./gql-adapters.js";
import { accountBuy, isLaunchPoolEvent, launchPoolSwap, type LaunchPool, type LaunchBuy, type LaunchChange, type LaunchEvent } from "./launch-accounting.js";
import { fetchEventJson } from "./event-json.js";
import { netGas, type GqlGasSummary } from "./trace-read.js";
import { isSponsorGasChange, isSuiCoinType } from "./sponsor-gas.js";
import { clearsDustFloor } from "./funding.js";
import { poolOfEvent, typeArgsOf } from "./attack-analysis.js";
import { lookupProtocol } from "../protocols/registry.js";

export const SUIPUMP = "0xb205fea41ccedac051bc66498e6ca68cb802c4a6ea06da12e524bed09c80d9b0";
export const LAUNCHPAD_ADAPTERS = [{ root: SUIPUMP, name: "SuiPump", module: "bonding_curve", buy: "TokensPurchased", sell: "TokensSold", create: "CurveCreated", graduation: "Graduated", coinField: "curve_id", referralField: "referral" }] as const;
const EVENT_QUERY = `query($type:String!,$afterCp:UInt53!,$beforeCp:UInt53!,$after:String){ events(filter:{type:$type,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},first:50,after:$after){nodes{contents{type{repr} json} timestamp transaction{digest}}pageInfo{hasNextPage endCursor}}}`;
const CURVE_QUERY = `query($type:String!){objects(filter:{type:$type},first:2){nodes{address asMoveObject{contents{type{repr} json}}}pageInfo{hasNextPage endCursor}}}`;
const CREATION_QUERY = `query($id:SuiAddress!){objectVersions(address:$id,first:1){nodes{previousTransaction{digest sender{address} effects{timestamp checkpoint{sequenceNumber} events(first:50){nodes{contents{type{repr} json}}pageInfo{hasNextPage}}}}}}}`;
const TOKEN_QUERY = `query($coin:String!){coinMetadata(coinType:$coin){symbol decimals supply}}`;
const TX_QUERY = `query($address:SuiAddress!,$afterCp:UInt53!,$beforeCp:UInt53!,$after:String){transactions(filter:{affectedAddress:$address,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},first:50,after:$after){nodes{digest sender{address} gasInput{gasSponsor{address}} effects{status timestamp checkpoint{sequenceNumber} gasEffects{gasSummary{computationCost storageCost storageRebate}} ${BALANCE_CHANGES_SELECTION} ${EVENTS_SELECTION}}}pageInfo{hasNextPage endCursor}}}`;
const POOL_QUERY = `query($id:SuiAddress!){object(address:$id){asMoveObject{contents{type{repr}}}}}`;
const POOL_TRADES_QUERY = `query($id:SuiAddress!,$afterCp:UInt53!,$beforeCp:UInt53!,$after:String){transactions(filter:{affectedObject:$id,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},first:50,after:$after){nodes{digest sender{address} effects{status timestamp ${EVENTS_SELECTION}}}pageInfo{hasNextPage endCursor}}}`;
const PAYERS_QUERY = `query($address:SuiAddress!,$afterCp:UInt53!,$beforeCp:UInt53!,$before:String){transactions(filter:{affectedAddress:$address,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},last:50,before:$before){nodes{digest sender{address} gasInput{gasSponsor{address}} effects{${BALANCE_CHANGES_SELECTION}}}pageInfo{hasPreviousPage startCursor}}}`;
/** Pages of an address's newest transactions read for its distinct payers. */
const PAYER_PAGES = 20;

interface EventNode { contents?: { type?: { repr: string }; json?: Record<string, unknown> }; timestamp?: string; transaction?: { digest: string } }
interface EventPage { events: { nodes: EventNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
interface TxNode { digest: string; sender?: { address: string }; gasInput?: { gasSponsor?: { address: string } }; effects?: { status: string; timestamp: string; checkpoint?: { sequenceNumber: number }; gasEffects?: { gasSummary?: GqlGasSummary | null } | null; balanceChanges?: GqlConnection<GqlBalanceChangeNode>; events?: GqlConnection<GqlEventNode> } }
interface TxPage { transactions: { nodes: TxNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
export interface LaunchTx { digest: string; sender: string | null; sponsor: string | null; timestamp: string; checkpoint: number | null; status: string | null; gas: bigint | null; changes: LaunchChange[]; events: Array<{ type: string; data: Record<string, unknown> }>; complete: boolean }
export interface LaunchScan<T> { rows: T[]; complete: boolean; reads: number; next_cursor: string | null }
export interface LaunchPoolScan extends LaunchScan<LaunchEvent> { unread_swap_events: number; buyer_attribution: "signer_only"; pool_lineage_unverified: boolean }
const value = (data: Record<string, unknown> | undefined, key: string) => typeof data?.[key] === "string" ? data[key] as string : null;
const address = (s: string | null) => s ? normalizeSuiAddress(s) : null;
const isContinuation = (next: string | null, previous: string | undefined) => Boolean(next && next !== previous);

/** A curve's concrete type is the coin identity; no buy/sell event contains a coin type. */
export async function readLaunchOrigin(coinType: string) {
  const versions = await fetchPackageVersions(SUIPUMP);
  if (!versions?.length) throw new Error("SuiPump's curated package lineage could not be read.");
  const type = `${SUIPUMP}::bonding_curve::Curve<${coinType}>`;
  const result = await gqlQuery<{ objects: { nodes: Array<{ address: string; asMoveObject?: { contents?: { type?: { repr: string }; json?: Record<string, unknown> } } }>; pageInfo: { hasNextPage: boolean } } | null }>(CURVE_QUERY, { type });
  const curves = result.objects;
  if (!curves || curves.nodes.length !== 1 || curves.pageInfo.hasNextPage || curves.nodes[0].asMoveObject?.contents?.type?.repr !== type) throw new Error(`No unique SuiPump curve found for ${coinType}; supported launchpads: SuiPump.`);
  const curve = curves.nodes[0];
  const launch = await gqlQuery<{ objectVersions: { nodes: Array<{ previousTransaction?: { digest: string; sender?: { address: string }; effects?: { timestamp: string; checkpoint?: { sequenceNumber: number }; events?: GqlConnection<GqlEventNode> } } }> } | null }>(CREATION_QUERY, { id: curve.address });
  const created = launch.objectVersions?.nodes[0]?.previousTransaction;
  if (!created?.digest || !created.sender?.address || !created.effects?.timestamp) throw new Error("The curve's creation transaction could not be read.");
  const creation = created.effects.events;
  if (!creation || creation.pageInfo?.hasNextPage || !creation.nodes.some((e) => e.contents?.type?.repr?.endsWith("::bonding_curve::CurveCreated") && value(e.contents.json as Record<string, unknown>, "curve_id") === curve.address)) throw new Error("The curve's creation event could not be verified.");
  const metadata = await gqlQuery<{ coinMetadata: { symbol: string; decimals: number; supply?: string } | null }>(TOKEN_QUERY, { coin: coinType });
 const target = curve.asMoveObject?.contents?.json?.graduation_target;
 return { curve_id: curve.address, creator: address(created.sender.address)!, creation_tx: created.digest, created_at: created.effects.timestamp, created_checkpoint: created.effects.checkpoint?.sequenceNumber ?? null, graduated: curve.asMoveObject?.contents?.json?.graduated === true, graduation_target: typeof target === "string" || typeof target === "number" ? target : null, pool_id: curve.asMoveObject?.contents?.json?.pool_id ?? null, token: { symbol: metadata.coinMetadata?.symbol ?? null, decimals: metadata.coinMetadata?.decimals ?? null, total_supply_raw: metadata.coinMetadata?.supply ?? null }, defining_package: SUIPUMP, versions: versions.map((v) => v.address) };
}

export async function readLaunchEvents(kind: "buy" | "sell" | "graduation", from: string, to: string, curve: string, maxPages: number): Promise<LaunchScan<LaunchEvent & { kind: string }>> {
  const field = kind === "buy" ? "TokensPurchased" : kind === "sell" ? "TokensSold" : "Graduated";
  const type = (await resolveEventTypeFilter(`${SUIPUMP}::bonding_curve::${field}`)).filter;
  const window = await resolveWindow(from, to);
  if (window.after?.checkpoint == null || window.before?.checkpoint == null) throw new Error("A closed checkpoint range is needed for launch events.");
  let cursor: string | undefined;
  const rows: Array<LaunchEvent & { kind: string }> = [];
  let reads = 0;
  let complete = false;
  while (reads < maxPages) {
    const page = (await gqlQuery<EventPage>(EVENT_QUERY, { type, afterCp: window.after.checkpoint, beforeCp: window.before.checkpoint, after: cursor })).events;
    reads++;
    for (const node of page.nodes) {
      const data = node.contents?.json;
      if (value(data, "curve_id") !== curve || !node.transaction?.digest || !node.timestamp) continue;
      const buyer = value(data, kind === "buy" ? "buyer" : "seller") ?? "";
   rows.push({ digest: node.transaction.digest, timestamp: node.timestamp, buyer: address(buyer) ?? "", buyer_basis: kind === "buy" ? "event_signer_unverified" : undefined, curve_id: curve, sui_in: value(data, kind === "buy" ? "sui_in" : "sui_out") ?? "0", tokens_out: value(data, kind === "buy" ? "tokens_out" : "tokens_in") ?? "0", referral: address(value(data, "referral")), kind });
    }
    if (!page.pageInfo.hasNextPage) { complete = true; cursor = undefined; break; }
    const next = page.pageInfo.endCursor;
    if (!isContinuation(next, cursor)) break;
    cursor = next!;
  }
  return { rows, complete, reads, next_cursor: cursor ?? null };
}

const convert = (rows: GqlBalanceChangeNode[]): LaunchChange[] => rows.flatMap((r) => r.owner?.address && r.coinType?.repr && r.amount != null ? [{ address: normalizeSuiAddress(r.owner.address), coin_type: r.coinType.repr, amount: BigInt(r.amount) }] : []);
async function completeRows(nodes: TxNode[]): Promise<LaunchTx[]> {
  const completed = await completeTxConnections(nodes.map((n) => ({ digest: n.digest, balanceChanges: n.effects?.balanceChanges })));
  const events = await Promise.all(nodes.map(async (n) => n.effects?.events?.pageInfo?.hasNextPage ? fetchEventJson(n.digest) : undefined));
  return nodes.map((n, i) => {
    const rawEvents = events[i] === undefined ? n.effects?.events?.nodes.map(e => ({ type: e.contents?.type?.repr, json: e.contents?.json })) : events[i];
  return { digest: n.digest, sender: address(n.sender?.address ?? null), sponsor: address(n.gasInput?.gasSponsor?.address ?? null), timestamp: n.effects?.timestamp ?? "", checkpoint: n.effects?.checkpoint?.sequenceNumber ?? null, status: n.effects?.status ?? null, gas: n.effects ? BigInt(netGas(n.effects.gasEffects?.gasSummary) ?? "0") : null, changes: convert(completed[i].balanceChanges), events: (rawEvents ?? []).flatMap(e => e.type && e.json && typeof e.json === "object" ? [{ type: e.type, data: e.json as Record<string, unknown> }] : []), complete: !completed[i].balanceChangesTruncated && events[i] !== null && n.effects?.events != null && n.effects != null && netGas(n.effects.gasEffects?.gasSummary) !== null };
  });
}
export async function readLaunchHistory(owner: string, from: string, to: string, maxPages: number): Promise<LaunchScan<LaunchTx>> {
  const window = await resolveWindow(from, to);
  if (window.after?.checkpoint == null || window.before?.checkpoint == null) throw new Error("A closed checkpoint range is needed for buyer history.");
  return readHistoryBetween(owner, window.after.checkpoint, window.before.checkpoint, maxPages);
}

/**
 * Read the owner's activity up to and including `historyAfterCheckpoint`, the
 * exclusive lower bound of its window history, to establish its opening
 * balance. Both bounds are exclusive, so the early read ends one checkpoint
 * later; ending at the same number would leave that checkpoint in neither.
 */
export async function readEarlyLaunchHistory(owner: string, historyAfterCheckpoint: number, maxPages: number): Promise<LaunchScan<LaunchTx>> {
  return readHistoryBetween(owner, 0, historyAfterCheckpoint + 1, maxPages);
}

async function readHistoryBetween(owner: string, afterCp: number, beforeCp: number, maxPages: number): Promise<LaunchScan<LaunchTx>> {
  let cursor: string | undefined;
  let reads = 0;
  let complete = false;
  const rows: LaunchTx[] = [];
  while (reads < maxPages) {
    const page = (await gqlQuery<TxPage>(TX_QUERY, { address: owner, afterCp, beforeCp, after: cursor })).transactions;
    reads++;
    rows.push(...await completeRows(page.nodes));
    if (!page.pageInfo.hasNextPage) { complete = true; cursor = undefined; break; }
    const next = page.pageInfo.endCursor;
    if (!isContinuation(next, cursor)) break;
    cursor = next!;
  }
  return { rows, complete: complete && rows.every((r) => r.complete), reads, next_cursor: cursor ?? null };
}
export function matchBuy(event: LaunchEvent, tx: LaunchTx): LaunchBuy { return accountBuy(event, tx.changes, tx.gas); }

/** Resolve the graduated pool's exact type, venue and coin order. Null means it cannot be read as this coin/SUI pool. */
export async function readLaunchPool(poolId: string, coinType: string): Promise<LaunchPool | null> {
  const result = await gqlQuery<{ object: { asMoveObject?: { contents?: { type?: { repr: string } } } } | null }>(POOL_QUERY, { id: poolId }).catch(() => null);
  const repr = result?.object?.asMoveObject?.contents?.type?.repr;
 if (!repr) return null;
 const args = typeArgsOf(repr);
 if (args.length < 2) return null;
 let coin: string;
 let first: string;
 let second: string;
 try {
  coin = normalizeStructTag(coinType);
  first = normalizeStructTag(args[0]);
  second = normalizeStructTag(args[1]);
 } catch { return null; }
 const sui = normalizeStructTag("0x2::sui::SUI");
 if (!((first === coin && second === sui) || (first === sui && second === coin))) return null;
 const pkg = normalizeSuiAddress(repr.split("::")[0]);
 const versions = await fetchPackageVersions(pkg).catch(() => null);
 const eventPackages = versions ? [...new Set([...versions.map(v => normalizeSuiAddress(v.address)), pkg])] : undefined;
 return { id: normalizeSuiAddress(poolId), type: repr, venue: lookupProtocol(pkg)?.name ?? pkg, coinIsA: first === coin, eventPackages, pool_lineage_unverified: !versions };
  }

/** Pure event interpretation shared by discovery and its synthetic regressions. */
export function poolBuysIn(transactions: Array<Pick<LaunchTx, "digest" | "sender" | "timestamp" | "events">>, pool: LaunchPool, coinType: string): { rows: LaunchEvent[]; unread_swap_events: number } {
 const rows: LaunchEvent[] = [];
 let unread = 0;
 const targets = new Map<string, string | null>([[pool.id, pool.type]]);
 for (const tx of transactions) for (const event of tx.events) {
  if (!event.type.toLowerCase().includes("swap") || poolOfEvent(event.data, targets) !== pool.id) continue;
  if (!isLaunchPoolEvent(event.type, pool)) { if (!pool.eventPackages) unread++; continue; }
  const swap = launchPoolSwap(event, pool, coinType);
  if (!swap) { unread++; continue; }
  if (swap.side === "buy") {
   if (!tx.sender || !tx.timestamp) { unread++; continue; }
   rows.push({ digest: tx.digest, timestamp: tx.timestamp, buyer: normalizeSuiAddress(tx.sender), buyer_basis: "transaction_signer_unverified", venue: pool.venue, curve_id: pool.id, sui_in: String(swap.sui), tokens_out: String(swap.tokens) });
  }
 }
 return { rows, unread_swap_events: unread };
}

/**
 * Initial-window graduated pool buys. The pool's affected-object history
 * reaches every venue without guessing its event type. Pool events name no
 * trader: `buyer` is the transaction signer, explicitly not verified owner.
 */
export async function readLaunchPoolBuys(pool: LaunchPool, coinType: string, from: string, to: string, maxPages: number): Promise<LaunchPoolScan> {
 const window = await resolveWindow(from, to);
 if (window.after?.checkpoint == null || window.before?.checkpoint == null) throw new Error("A closed checkpoint range is needed for graduated pool trades.");
 const rows: LaunchEvent[] = [];
 let cursor: string | undefined;
 let reads = 0;
 let complete = false;
 let unread = 0;
 for (; reads < maxPages;) {
  const page = (await gqlQuery<TxPage>(POOL_TRADES_QUERY, { id: pool.id, afterCp: window.after.checkpoint, beforeCp: window.before.checkpoint, after: cursor })).transactions;
  reads++;
  const eventPages = await Promise.all(page.nodes.map(tx => tx.effects?.status === "SUCCESS" && tx.effects.events?.pageInfo?.hasNextPage ? fetchEventJson(tx.digest) : undefined));
  for (const [index, tx] of page.nodes.entries()) {
   if (tx.effects?.status === "FAILURE") continue;
   if (tx.effects?.status !== "SUCCESS") { unread++; continue; }
   const parsed = eventPages[index] === undefined ? tx.effects.events?.nodes.map(e => ({ type: e.contents?.type?.repr, json: e.contents?.json })) : eventPages[index];
   if (!parsed) { unread++; continue; }
   const events = parsed.flatMap(event => {
    if (event.type && (isLaunchPoolEvent(event.type, pool) || (!pool.eventPackages && event.type.toLowerCase().includes("swap"))) && (!event.json || typeof event.json !== "object")) unread++;
    return event.type && event.json && typeof event.json === "object" ? [{ type: event.type, data: event.json as Record<string, unknown> }] : [];
   });
   const result = poolBuysIn([{ digest: tx.digest, sender: address(tx.sender?.address ?? null), timestamp: tx.effects.timestamp, events }], pool, coinType);
   rows.push(...result.rows);
   unread += result.unread_swap_events;
  }
  if (!page.pageInfo.hasNextPage) { complete = true; cursor = undefined; break; }
  if (!isContinuation(page.pageInfo.endCursor, cursor)) break;
  cursor = page.pageInfo.endCursor!;
 }
 return { rows, complete: complete && unread === 0 && !!pool.eventPackages, reads, next_cursor: cursor ?? null, unread_swap_events: unread, buyer_attribution: "signer_only", pool_lineage_unverified: !pool.eventPackages };
}

/**
 * Distinct addresses that paid `target` in the given transactions: the sender
 * of each transaction that credited it SUI above the dust floor or any of the
 * launch coin. Its own transactions and a sponsor's gas rebate are not payments.
 */
export function payersIn(rows: Array<{ sender: string | null; sponsor: string | null; changes: LaunchChange[] }>, target: string, coinType: string): Set<string> {
  const payers = new Set<string>();
  for (const row of rows) {
    if (!row.sender || row.sender === target) continue;
    let sui = 0n;
    let token = 0n;
    let suiType: string | null = null;
    for (const c of row.changes) {
      if (c.address !== target) continue;
      if (isSuiCoinType(c.coin_type)) { sui += c.amount; suiType = c.coin_type; }
      else if (c.coin_type === coinType) token += c.amount;
    }
    const paidSui = suiType !== null && !isSponsorGasChange(target, suiType, row.sender, row.sponsor ?? undefined) && clearsDustFloor(suiType, sui) === true;
    if (paidSui || token > 0n) payers.add(row.sender);
  }
  return payers;
}

/**
 * How many distinct addresses pay into `address`, newest transactions first,
 * stopping once `limit` is passed. An outgoing popularity probe cannot see a
 * collector (a bot's fee wallet, a payment processor) that many pay and that
 * pays few, so a shared destination is narrow only when this is narrow too.
 * A scan that ran out of pages or budget, or failed, is unmeasured: a
 * destination never reads narrow on an unread inflow side.
 */
export async function probeLaunchPayers(target: string, coinType: string, limit: number, take: () => boolean, beforeCheckpoint: number): Promise<{ payers: number; verdict: "narrow" | "popular" | "unmeasured" }> {
  const payers = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < PAYER_PAGES; page++) {
    if (!take()) return { payers: payers.size, verdict: "unmeasured" };
    const read = await gqlQuery<{ transactions: { nodes: TxNode[]; pageInfo: { hasPreviousPage: boolean; startCursor: string | null } } }>(PAYERS_QUERY, { address: target, afterCp: 0, beforeCp: beforeCheckpoint, before }).catch(() => null);
    if (!read) return { payers: payers.size, verdict: "unmeasured" };
    const nodes = read.transactions.nodes;
    const completed = await completeTxConnections(nodes.map((n) => ({ digest: n.digest, balanceChanges: n.effects?.balanceChanges })), take);
    if (completed.some((c) => c.balanceChangesTruncated)) return { payers: payers.size, verdict: "unmeasured" };
    const rows = nodes.map((n, i) => ({ sender: address(n.sender?.address ?? null), sponsor: address(n.gasInput?.gasSponsor?.address ?? null), changes: convert(completed[i].balanceChanges) }));
    for (const payer of payersIn(rows, target, coinType)) payers.add(payer);
    if (payers.size > limit) return { payers: payers.size, verdict: "popular" };
    const next = read.transactions.pageInfo.startCursor;
    if (!read.transactions.pageInfo.hasPreviousPage) return { payers: payers.size, verdict: "narrow" };
    if (!next || next === before) return { payers: payers.size, verdict: "unmeasured" };
    before = next;
  }
  return { payers: payers.size, verdict: "unmeasured" };
}
