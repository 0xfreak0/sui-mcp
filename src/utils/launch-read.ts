import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { resolveWindow } from "./checkpoint-time.js";
import { fetchPackageVersions, resolveEventTypeFilter } from "./package-versions.js";
import { BALANCE_CHANGES_SELECTION, EVENTS_SELECTION, completeTxConnections, type GqlConnection, type GqlEventNode } from "./tx-connections.js";
import type { GqlBalanceChangeNode } from "./gql-adapters.js";
import { accountBuy, type LaunchBuy, type LaunchChange, type LaunchEvent } from "./launch-accounting.js";
import { fetchEventJson } from "./event-json.js";
import { netGas, type GqlGasSummary } from "./trace-read.js";

export const SUIPUMP = "0xb205fea41ccedac051bc66498e6ca68cb802c4a6ea06da12e524bed09c80d9b0";
export const LAUNCHPAD_ADAPTERS = [{ root: SUIPUMP, name: "SuiPump", module: "bonding_curve", buy: "TokensPurchased", sell: "TokensSold", create: "CurveCreated", graduation: "Graduated", coinField: "curve_id", referralField: "referral" }] as const;
const EVENT_QUERY = `query($type:String!,$afterCp:UInt53!,$beforeCp:UInt53!,$after:String){ events(filter:{type:$type,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},first:50,after:$after){nodes{contents{type{repr} json} timestamp transaction{digest}}pageInfo{hasNextPage endCursor}}}`;
const CURVE_QUERY = `query($type:String!){objects(filter:{type:$type},first:2){nodes{address asMoveObject{contents{type{repr} json}}}pageInfo{hasNextPage endCursor}}}`;
const CREATION_QUERY = `query($id:SuiAddress!){objectVersions(address:$id,first:1){nodes{previousTransaction{digest sender{address} effects{timestamp checkpoint{sequenceNumber} events(first:50){nodes{contents{type{repr} json}}pageInfo{hasNextPage}}}}}}}`;
const TOKEN_QUERY = `query($coin:String!){coinMetadata(coinType:$coin){symbol decimals supply}}`;
const TX_QUERY = `query($address:SuiAddress!,$afterCp:UInt53!,$beforeCp:UInt53!,$after:String){transactions(filter:{affectedAddress:$address,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},first:50,after:$after){nodes{digest sender{address} gasInput{gasSponsor{address}} effects{status timestamp gasEffects{gasSummary{computationCost storageCost storageRebate}} ${BALANCE_CHANGES_SELECTION} ${EVENTS_SELECTION}}}pageInfo{hasNextPage endCursor}}}`;

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

/** Read the owner's earlier activity as a closed range to establish its opening balance. */
export async function readEarlyLaunchHistory(owner: string, beforeCheckpoint: number, maxPages: number): Promise<LaunchScan<LaunchTx>> {
  return readHistoryBetween(owner, 0, beforeCheckpoint, maxPages);
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
export function matchBuy(event: LaunchEvent, tx: LaunchTx, coinType: string): LaunchBuy { return accountBuy(event, tx.changes, coinType); }
