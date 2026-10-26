import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { resolveWindow } from "./checkpoint-time.js";
import { fetchPackageVersions, resolveEventTypeFilter } from "./package-versions.js";
import { BALANCE_CHANGES_SELECTION, EVENTS_SELECTION, completeTxConnections, type GqlConnection, type GqlEventNode } from "./tx-connections.js";
import type { GqlBalanceChangeNode } from "./gql-adapters.js";
import { accountBuy, type LaunchBuy, type LaunchChange, type LaunchEvent } from "./launch-accounting.js";
import { fetchEventJson } from "./event-json.js";
import { netGas, type GqlGasSummary } from "./trace-read.js";
import { isSponsorGasChange, isSuiCoinType } from "./sponsor-gas.js";
import { clearsDustFloor } from "./funding.js";

export const SUIPUMP = "0xb205fea41ccedac051bc66498e6ca68cb802c4a6ea06da12e524bed09c80d9b0";
export const LAUNCHPAD_ADAPTERS = [{ root: SUIPUMP, name: "SuiPump", module: "bonding_curve", buy: "TokensPurchased", sell: "TokensSold", create: "CurveCreated", graduation: "Graduated", coinField: "curve_id", referralField: "referral" }] as const;
const EVENT_QUERY = `query($type:String!,$afterCp:UInt53!,$beforeCp:UInt53!,$after:String){ events(filter:{type:$type,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},first:50,after:$after){nodes{contents{type{repr} json} timestamp transaction{digest}}pageInfo{hasNextPage endCursor}}}`;
const CURVE_QUERY = `query($type:String!){objects(filter:{type:$type},first:2){nodes{address asMoveObject{contents{type{repr} json}}}pageInfo{hasNextPage endCursor}}}`;
const CREATION_QUERY = `query($id:SuiAddress!){objectVersions(address:$id,first:1){nodes{previousTransaction{digest sender{address} effects{timestamp checkpoint{sequenceNumber} events(first:50){nodes{contents{type{repr} json}}pageInfo{hasNextPage}}}}}}}`;
const TOKEN_QUERY = `query($coin:String!){coinMetadata(coinType:$coin){symbol decimals supply}}`;
const TX_QUERY = `query($address:SuiAddress!,$afterCp:UInt53!,$beforeCp:UInt53!,$after:String){transactions(filter:{affectedAddress:$address,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},first:50,after:$after){nodes{digest sender{address} gasInput{gasSponsor{address}} effects{status timestamp gasEffects{gasSummary{computationCost storageCost storageRebate}} ${BALANCE_CHANGES_SELECTION} ${EVENTS_SELECTION}}}pageInfo{hasNextPage endCursor}}}`;
const POOL_QUERY = `query($id:SuiAddress!){object(address:$id){asMoveObject{contents{type{repr}}}}}`;
const PAYERS_QUERY = `query($address:SuiAddress!,$before:String){transactions(filter:{affectedAddress:$address},last:50,before:$before){nodes{digest sender{address} gasInput{gasSponsor{address}} effects{${BALANCE_CHANGES_SELECTION}}}pageInfo{hasPreviousPage startCursor}}}`;
/** Pages of an address's newest transactions read for its distinct payers. */
const PAYER_PAGES = 20;

interface EventNode { contents?: { type?: { repr: string }; json?: Record<string, unknown> }; timestamp?: string; transaction?: { digest: string } }
interface EventPage { events: { nodes: EventNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
interface TxNode { digest: string; sender?: { address: string }; gasInput?: { gasSponsor?: { address: string } }; effects?: { status: string; timestamp: string; gasEffects?: { gasSummary?: GqlGasSummary | null } | null; balanceChanges?: GqlConnection<GqlBalanceChangeNode>; events?: GqlConnection<GqlEventNode> } }
interface TxPage { transactions: { nodes: TxNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
export interface LaunchTx { digest: string; sender: string | null; sponsor: string | null; timestamp: string; status: string | null; gas: bigint | null; changes: LaunchChange[]; events: Array<{ type: string; data: Record<string, unknown> }>; complete: boolean }
export interface LaunchScan<T> { rows: T[]; complete: boolean; reads: number; next_cursor: string | null }
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
  return { curve_id: curve.address, creator: address(created.sender.address)!, creation_tx: created.digest, created_at: created.effects.timestamp, created_checkpoint: created.effects.checkpoint?.sequenceNumber ?? null, graduated: curve.asMoveObject?.contents?.json?.graduated === true, pool_id: curve.asMoveObject?.contents?.json?.pool_id ?? null, token: { symbol: metadata.coinMetadata?.symbol ?? null, decimals: metadata.coinMetadata?.decimals ?? null, total_supply_raw: metadata.coinMetadata?.supply ?? null }, defining_package: SUIPUMP, versions: versions.map((v) => v.address) };
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
      rows.push({ digest: node.transaction.digest, timestamp: node.timestamp, buyer: address(buyer) ?? "", curve_id: curve, sui_in: value(data, kind === "buy" ? "sui_in" : "sui_out") ?? "0", tokens_out: value(data, kind === "buy" ? "tokens_out" : "tokens_in") ?? "0", referral: address(value(data, "referral")), kind });
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
    return { digest: n.digest, sender: address(n.sender?.address ?? null), sponsor: address(n.gasInput?.gasSponsor?.address ?? null), timestamp: n.effects?.timestamp ?? "", status: n.effects?.status ?? null, gas: n.effects ? BigInt(netGas(n.effects.gasEffects?.gasSummary) ?? "0") : null, changes: convert(completed[i].balanceChanges), events: (rawEvents ?? []).flatMap(e => e.type && e.json && typeof e.json === "object" ? [{ type: e.type, data: e.json as Record<string, unknown> }] : []), complete: !completed[i].balanceChangesTruncated && events[i] !== null && n.effects != null && netGas(n.effects.gasEffects?.gasSummary) !== null };
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

/**
 * Whether the launch coin is coin A of the graduated pool, read from the pool
 * object's type. A swap event states direction only as `atob`. Null when the
 * pool or its type cannot be read.
 */
export async function readPoolCoinIsA(poolId: string, coinType: string): Promise<boolean | null> {
  const result = await gqlQuery<{ object: { asMoveObject?: { contents?: { type?: { repr: string } } } } | null }>(POOL_QUERY, { id: poolId }).catch(() => null);
  const repr = result?.object?.asMoveObject?.contents?.type?.repr;
  const open = repr?.indexOf("<") ?? -1;
  if (!repr || open < 0 || !repr.endsWith(">")) return null;
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = start; i < repr.length - 1; i++) {
    if (repr[i] === "<") depth++;
    else if (repr[i] === ">") depth--;
    else if (repr[i] === "," && depth === 0) { args.push(repr.slice(start, i).trim()); start = i + 1; }
  }
  args.push(repr.slice(start, repr.length - 1).trim());
  if (args.length !== 2) return null;
  return args[0] === coinType ? true : args[1] === coinType ? false : null;
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
export async function probeLaunchPayers(target: string, coinType: string, limit: number, take: () => boolean): Promise<{ payers: number; verdict: "narrow" | "popular" | "unmeasured" }> {
  const payers = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < PAYER_PAGES; page++) {
    if (!take()) return { payers: payers.size, verdict: "unmeasured" };
    const read = await gqlQuery<{ transactions: { nodes: TxNode[]; pageInfo: { hasPreviousPage: boolean; startCursor: string | null } } }>(PAYERS_QUERY, { address: target, before }).catch(() => null);
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
