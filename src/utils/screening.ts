import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { detectBridges, type CallSite } from "./bridge/detect.js";
import {
  CCTP_DEPOSIT_EVENT_SUFFIX,
  CCTP_MESSAGE_EVENT_SUFFIX,
  parseDepositForBurn,
  parseMessageHeader,
} from "./bridge/cctp.js";
import { DEPOSIT_EVENT_SUFFIXES, parseDepositEvent } from "./bridge/sui-native.js";
import { disclosedLabelSources, getLabel, labelProvenance, type LabelCategory } from "./labels.js";
import { sanctions } from "./sanctions.js";
import { pricesForRanking } from "./price-providers.js";
import { decimalsForCoinType, displayCoin, toHumanAmount, usdValue } from "./valuation.js";

/**
 * Exposure screening: is this address, directly or within a few hops, connected
 * to a labelled exploiter, exchange, bridge, mixer or sanctioned account?
 *
 * Pure logic first (flows, paths, hits), then the network wrapper. Paths are
 * read from chain data; each hit carries the provenance of the label or list
 * that produced it. Nothing here decides risk: it reports exposure and its
 * evidence, and says what it could not see.
 */

/** Label categories a screen reports. `burn`, `protocol`, `defi` and the rest are context, not exposure. */
export const SCREENED_CATEGORIES: ReadonlySet<LabelCategory> = new Set<LabelCategory>([
  "malicious",
  "mixer",
  "cex",
  "bridge",
]);

export type Direction = "in" | "out";

export interface ScreenChange {
  owner: string;
  coinType: string;
  amount: bigint;
}

export interface ScreenTx {
  digest: string;
  timestamp: string | null;
  sender: string | null;
  gasSponsor: string | null;
  changes: ScreenChange[];
  calls: CallSite[];
}

/** Value moved between the subject and one counterparty, in one direction. */
export interface Leg {
  digest: string;
  timestamp: string | null;
  coinType: string;
  amount: bigint;
}

export interface Flows {
  out: Map<string, Leg[]>;
  in: Map<string, Leg[]>;
}

/**
 * Who `subject` paid and who paid `subject`, per transaction and per coin.
 *
 * A counterparty is paired with the subject only on a coin the subject moved
 * the opposite way, so one side of a swap is not read as a payment. A gas
 * sponsor that is not the sender only paid gas or took a storage rebate, so
 * its SUI change is never a leg.
 */
export function flowsOf(subject: string, txs: ScreenTx[]): Flows {
  const flows: Flows = { out: new Map(), in: new Map() };
  const push = (dir: Direction, who: string, leg: Leg) => {
    const list = flows[dir].get(who) ?? [];
    list.push(leg);
    flows[dir].set(who, list);
  };
  for (const tx of txs) {
    const own = new Map<string, bigint>();
    for (const c of tx.changes) {
      if (c.owner === subject) own.set(c.coinType, (own.get(c.coinType) ?? 0n) + c.amount);
    }
    const gasOnly = tx.gasSponsor && tx.gasSponsor !== tx.sender ? tx.gasSponsor : null;
    for (const c of tx.changes) {
      if (c.owner === subject) continue;
      const mine = own.get(c.coinType) ?? 0n;
      if (c.owner === gasOnly && /^0x0*2::sui::SUI$/.test(c.coinType)) continue;
      if (mine < 0n && c.amount > 0n) {
        push("out", c.owner, { digest: tx.digest, timestamp: tx.timestamp, coinType: c.coinType, amount: c.amount });
      } else if (mine > 0n && c.amount < 0n) {
        push("in", c.owner, { digest: tx.digest, timestamp: tx.timestamp, coinType: c.coinType, amount: -c.amount });
      }
    }
  }
  return flows;
}

/**
 * Legs that can continue a path: for money flowing out, a later leg must not
 * predate the earliest earlier one (it cannot carry funds it had not received
 * yet); for money flowing in, it must not postdate the latest one.
 */
export function timeConsistent(dir: Direction, legs: Leg[], previous: Leg[] | null): Leg[] {
  if (!previous || previous.length === 0) return legs;
  const times = previous.map((l) => (l.timestamp ? Date.parse(l.timestamp) : NaN)).filter(Number.isFinite);
  if (times.length === 0) return legs;
  const bound = dir === "out" ? Math.min(...times) : Math.max(...times);
  return legs.filter((l) => {
    const t = l.timestamp ? Date.parse(l.timestamp) : NaN;
    if (!Number.isFinite(t)) return true;
    return dir === "out" ? t >= bound : t <= bound;
  });
}

/** Bridge exits `address` itself sent, from curated call markers only. */
export function bridgeExitsOf(address: string, txs: ScreenTx[]) {
  const out: Array<{ tx: ScreenTx; protocol: string; resolution: string }> = [];
  for (const tx of txs) {
    if (tx.sender !== address) continue;
    // Markers only. The registry tier fires on any call into a bridge-typed
    // package, which includes a lending protocol verifying a Wormhole price
    // VAA; a screen that called that bridge exposure would be wrong.
    for (const hit of detectBridges(tx.calls).filter((h) => h.matched === "call")) {
      out.push({ tx, protocol: hit.protocol, resolution: hit.resolution });
    }
  }
  return out;
}

export interface Hit {
  category: LabelCategory | "sanctioned";
  label: string;
  entity?: string;
  evidence?: string;
  source_url?: string;
  retrieved_at?: string;
  /** For sanctions hits. */
  sdn?: { name: string; entity_id: string | null; programs: string[]; listed_as: string[]; data_as_of: string | null };
}

/** Screening hits for one account: its label, if screened, and any sanctions listing. */
export function hitsFor(account: string): Hit[] {
  const hits: Hit[] = [];
  const label = getLabel(account);
  if (label && SCREENED_CATEGORIES.has(label.category)) {
    hits.push({ category: label.category, label: label.label, ...labelProvenance(label) });
  }
  const s = sanctions().match(account);
  if (s) {
    hits.push({
      category: "sanctioned",
      label: `${s.list}: ${s.sdn_name}`,
      evidence: "sanctions-list",
      source_url: s.source_url,
      retrieved_at: s.retrieved_at,
      sdn: { name: s.sdn_name, entity_id: s.sdn_entity_id, programs: s.programs, listed_as: s.listed_as, data_as_of: s.data_as_of },
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const WINDOW_QUERY = `query ($filter: TransactionFilter!, $last: Int!, $before: String) {
  transactions(filter: $filter, last: $last, before: $before) {
    nodes {
      digest
      sender { address }
      gasInput { gasSponsor { address } }
      effects {
        timestamp
        balanceChanges(first: 50) { nodes { amount owner { address } coinType { repr } } }
      }
      kind {
        ... on ProgrammableTransaction {
          commands(first: 50) {
            nodes { ... on MoveCallCommand { function { name module { name package { address } } } } }
          }
        }
      }
    }
    pageInfo { hasPreviousPage startCursor }
  }
}`;

interface WindowResult {
  transactions: {
    nodes: Array<{
      digest: string;
      sender?: { address?: string } | null;
      gasInput?: { gasSponsor?: { address?: string } | null } | null;
      effects?: {
        timestamp?: string | null;
        balanceChanges?: { nodes: Array<{ amount?: string; owner?: { address?: string } | null; coinType?: { repr: string } }> };
      } | null;
      kind?: {
        commands?: { nodes: Array<{ function?: { name: string; module: { name: string; package: { address: string } } } }> };
      } | null;
    }>;
    pageInfo: { hasPreviousPage: boolean; startCursor?: string | null };
  };
}

/**
 * Which transactions a window reads. Outgoing value and bridge exits need the
 * address's signature, so `sent` reads only what it sent: an exploiter's
 * wallet collects a long tail of airdropped spam afterwards, and a window of
 * everything that touched it would be all spam and no exits. Incoming value
 * arrives in other people's transactions, so `affected` reads everything.
 */
export type WindowKind = "sent" | "affected";

export interface TxWindow {
  address: string;
  kind: WindowKind;
  txs: ScreenTx[];
  truncated: boolean;
}

/** The most recent `limit` transactions of `kind` for `address`, oldest first. */
export async function fetchWindow(address: string, kind: WindowKind, limit: number): Promise<TxWindow> {
  const txs: ScreenTx[] = [];
  let before: string | undefined;
  let more = true;
  const filter = kind === "sent" ? { sentAddress: address } : { affectedAddress: address };
  while (more && txs.length < limit) {
    const res: WindowResult = await gqlQuery(WINDOW_QUERY, {
      filter,
      last: Math.min(50, limit - txs.length),
      before,
    });
    const page = res.transactions.nodes.map((n) => ({
      digest: n.digest,
      timestamp: n.effects?.timestamp ?? null,
      sender: n.sender?.address ?? null,
      gasSponsor: n.gasInput?.gasSponsor?.address ?? null,
      changes: (n.effects?.balanceChanges?.nodes ?? [])
        .filter((c) => c.owner?.address && c.coinType?.repr && c.amount !== undefined)
        .map((c) => ({ owner: c.owner!.address!, coinType: c.coinType!.repr, amount: BigInt(c.amount!) })),
      calls: (n.kind?.commands?.nodes ?? [])
        .filter((c) => c.function)
        .map((c) => ({ packageId: c.function!.module.package.address, module: c.function!.module.name, function: c.function!.name })),
    }));
    txs.unshift(...page);
    more = res.transactions.pageInfo.hasPreviousPage;
    const cursor = res.transactions.pageInfo.startCursor;
    if (!cursor) break;
    before = cursor;
  }
  return { address, kind, txs, truncated: more };
}

const EVENTS_QUERY = `query ($digest: String!) {
  transaction(digest: $digest) { effects { events(first: 50) { nodes { contents { type { repr } json } } } } }
}`;

interface EventsResult {
  transaction?: { effects?: { events?: { nodes?: Array<{ contents?: { type?: { repr?: string }; json?: unknown } }> } } } | null;
}

/**
 * Chain-derived destinations of a CCTP or Sui-bridge exit: both put the
 * destination chain and recipient in their own events, so no indexer is asked.
 */
async function bridgeDestinations(digest: string): Promise<Array<{ protocol: string; account: string | null; chain_label: string; raw: string | null }>> {
  const res = await gqlQuery<EventsResult>(EVENTS_QUERY, { digest });
  const events = res.transaction?.effects?.events?.nodes ?? [];
  const typed = events.map((e) => ({ type: e.contents?.type?.repr ?? "", json: e.contents?.json }));
  const out: Array<{ protocol: string; account: string | null; chain_label: string; raw: string | null }> = [];
  const qualify = getNetwork() === "mainnet";
  const header = typed.find((e) => e.type.endsWith(CCTP_MESSAGE_EVENT_SUFFIX));
  const headerJson = header?.json as { message?: string } | undefined;
  const parsedHeader = headerJson?.message ? parseMessageHeader(headerJson.message) : null;
  for (const e of typed) {
    if (e.type.endsWith(CCTP_DEPOSIT_EVENT_SUFFIX)) {
      const t = parseDepositForBurn(e.json, parsedHeader, qualify);
      if (t) out.push({ protocol: "Circle CCTP", account: t.destinationAccount, chain_label: t.destinationChainLabel, raw: t.destinationAddress });
    } else if (DEPOSIT_EVENT_SUFFIXES.some((s) => e.type.endsWith(s))) {
      const t = parseDepositEvent(e.json);
      if (t) out.push({ protocol: "Sui Bridge", account: qualify ? t.targetAccount : null, chain_label: t.targetChainLabel, raw: t.targetAddress });
    }
  }
  return out;
}

export interface ScreenOptions {
  hops: number;
  directions: Direction[];
  subjectTransactions: number;
  hopTransactions: number;
  maxExpand: number;
  maxBridgeLookups: number;
}

/** One exposure in a screen result. The remaining fields depend on the kind of hit. */
export interface Exposure {
  category: string;
  hops: number;
  [field: string]: unknown;
}

interface PathNode {
  address: string;
  path: string[];
  legs: Leg[][];
}

const fmt = (raw: bigint, coinType: string) =>
  `${toHumanAmount(raw, decimalsForCoinType(coinType))} ${displayCoin(coinType).symbol}`;

function summarizeLegs(legs: Leg[]) {
  const byCoin = new Map<string, bigint>();
  for (const l of legs) byCoin.set(l.coinType, (byCoin.get(l.coinType) ?? 0n) + l.amount);
  const digests = [...new Set(legs.map((l) => l.digest))];
  const times = legs.map((l) => l.timestamp).filter((t): t is string => !!t).sort();
  return {
    amount: [...byCoin].map(([coin, raw]) => fmt(raw, coin)).join(" + "),
    digests: digests.slice(0, 5),
    ...(digests.length > 5 ? { more_digests: digests.length - 5 } : {}),
    first_at: times[0] ?? null,
    last_at: times.at(-1) ?? null,
  };
}

export async function screenAddress(subjectRaw: string, options: ScreenOptions) {
  const subject = normalizeSuiAddress(subjectRaw);
  const windows = new Map<string, Promise<TxWindow>>();
  const windowReport: Array<{ address: string; kind: WindowKind; scanned: number; truncated: boolean }> = [];
  const windowFor = async (address: string, dir: Direction) => {
    const kind: WindowKind = dir === "out" ? "sent" : "affected";
    const key = `${kind}|${address}`;
    const fresh = !windows.has(key);
    if (fresh) {
      const limit = address === subject ? options.subjectTransactions : options.hopTransactions;
      windows.set(key, fetchWindow(address, kind, limit));
    }
    const win = await windows.get(key)!;
    if (fresh) windowReport.push({ address, kind, scanned: win.txs.length, truncated: win.truncated });
    return win;
  };

  const exposures: Exposure[] = [];
  const exits: Array<{ tx: ScreenTx; protocol: string; resolution: string; hops: number; path: string[]; legs: Leg[][] }> = [];
  let unexpanded = 0;
  const exitsScanned = new Set<string>();

  // Prices only rank which counterparties to expand; an unpriced coin still counts.
  const subjectWindows = await Promise.all(options.directions.map((d) => windowFor(subject, d)));
  const coinTypes = new Set<string>();
  for (const win of subjectWindows) for (const tx of win.txs) for (const c of tx.changes) coinTypes.add(c.coinType);
  const prices = await pricesForRanking([...coinTypes]).catch(() => new Map());
  const legValue = (legs: Leg[]) =>
    legs.reduce((sum, l) => sum + usdValue(l.amount, decimalsForCoinType(l.coinType), prices.get(l.coinType)?.price), 0);

  for (const dir of options.directions) {
    const visited = new Set<string>([subject]);
    let frontier: PathNode[] = [{ address: subject, path: [subject], legs: [] }];

    for (let hop = 1; hop <= options.hops && frontier.length > 0; hop++) {
      const next: Array<PathNode & { value: number }> = [];
      for (const node of frontier) {
        const win = await windowFor(node.address, dir);
        // Bridge exits the node itself sent, after the funds reached it.
        if (dir === "out" && !exitsScanned.has(node.address)) {
          exitsScanned.add(node.address);
          const prior = node.legs.at(-1) ?? null;
          for (const e of bridgeExitsOf(node.address, win.txs)) {
            const asLeg = { digest: e.tx.digest, timestamp: e.tx.timestamp, coinType: "", amount: 0n };
            if (timeConsistent("out", [asLeg], prior).length === 0) continue;
            exits.push({ ...e, hops: hop, path: node.path, legs: node.legs });
          }
        }
        for (const [counterparty, allLegs] of flowsOf(node.address, win.txs)[dir]) {
          if (visited.has(counterparty)) continue;
          const legs = timeConsistent(dir, allLegs, node.legs.at(-1) ?? null);
          if (legs.length === 0) continue;
          const path = [...node.path, counterparty];
          const pathLegs = [...node.legs, legs];
          const hits = hitsFor(counterparty);
          if (hits.length > 0) {
            visited.add(counterparty);
            for (const h of hits) {
              exposures.push({
                ...h,
                counterparty,
                direction: dir === "out" ? "outgoing" : "incoming",
                hops: hop,
                path,
                legs: pathLegs.map(summarizeLegs),
              });
            }
            continue;
          }
          next.push({ address: counterparty, path, legs: pathLegs, value: legValue(legs) });
        }
      }
      if (hop === options.hops) break;
      // Deduplicate, then expand the highest-value counterparties only.
      const best = new Map<string, PathNode & { value: number }>();
      for (const n of next) if (!best.has(n.address) || best.get(n.address)!.value < n.value) best.set(n.address, n);
      const ranked = [...best.values()].sort((a, b) => b.value - a.value || b.legs.at(-1)!.length - a.legs.at(-1)!.length);
      frontier = ranked.slice(0, options.maxExpand);
      unexpanded += Math.max(0, ranked.length - frontier.length);
      for (const n of frontier) visited.add(n.address);
    }
  }

  // Bridge exits, grouped per protocol and path so sixty CCTP burns read as
  // one exposure with sixty digests. Destinations are read from chain events
  // for CCTP and the Sui Bridge, up to maxBridgeLookups transactions.
  let lookups = 0;
  const groups = new Map<string, {
    entry: Exposure;
    digests: string[];
    sent: Map<string, bigint>;
    times: string[];
    destinations: Map<string, Record<string, unknown>>;
  }>();
  const viaBridge = new Map<string, Exposure & { digests: string[] }>();
  for (const e of exits) {
    const key = `${e.protocol}|${e.path.join(">")}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        entry: {
          category: "bridge",
          label: e.protocol,
          direction: "outgoing",
          hops: e.hops,
          path: e.path,
          legs: e.legs.map(summarizeLegs),
          evidence: "bridge call marker in a transaction the address sent",
        },
        digests: [],
        sent: new Map(),
        times: [],
        destinations: new Map(),
      };
      groups.set(key, g);
    }
    g.digests.push(e.tx.digest);
    if (e.tx.timestamp) g.times.push(e.tx.timestamp);
    for (const c of e.tx.changes) {
      if (c.owner === e.tx.sender && c.amount < 0n) g.sent.set(c.coinType, (g.sent.get(c.coinType) ?? 0n) - c.amount);
    }

    const canResolve = e.protocol === "Circle CCTP" || e.protocol === "Sui Bridge";
    if (!canResolve) {
      if (e.resolution === "identifier") g.entry.next_step = "Run resolve_bridge_transfer on these digests for the destination.";
      continue;
    }
    if (lookups >= options.maxBridgeLookups) continue;
    lookups++;
    const dests = await bridgeDestinations(e.tx.digest).catch(() => null);
    for (const d of dests ?? []) {
      g.destinations.set(d.account ?? d.raw ?? d.chain_label, { ...d, tier: "chain-derived" });
      if (!d.account) continue;
      for (const h of hitsFor(d.account)) {
        const vKey = `${d.account}|${h.category}|${e.path.join(">")}`;
        const existing = viaBridge.get(vKey);
        if (existing) {
          existing.digests.push(e.tx.digest);
          continue;
        }
        viaBridge.set(vKey, {
          ...h,
          counterparty: d.account,
          direction: "outgoing",
          hops: e.hops + 1,
          path: [...e.path, d.account],
          via_bridge: { protocol: d.protocol, tier: "chain-derived" },
          legs: e.legs.map(summarizeLegs),
          digests: [e.tx.digest],
        });
      }
    }
  }

  const bridgeExposures = [...groups.values()].map((g): Exposure => {
    const times = g.times.sort();
    return {
      ...g.entry,
      exit_count: g.digests.length,
      sent: [...g.sent].map(([coin, raw]) => fmt(raw, coin)).join(" + ") || null,
      first_at: times[0] ?? null,
      last_at: times.at(-1) ?? null,
      digests: g.digests.slice(0, 20),
      ...(g.digests.length > 20 ? { more_digests: g.digests.length - 20 } : {}),
      ...(g.destinations.size ? { destinations: [...g.destinations.values()] } : {}),
    };
  });

  return {
    exposures: [...exposures, ...viaBridge.values(), ...bridgeExposures].sort((a, b) => a.hops - b.hops),
    windows: windowReport,
    unexpanded_counterparties: unexpanded,
    bridge_exits_seen: exits.length,
    bridge_exits_with_destination_read: lookups,
  };
}

/** What a screen could and could not see, stated with every result. */
export function screeningCoverage() {
  const cov = sanctions().coverage();
  return {
    labels: disclosedLabelSources(),
    sanctions: {
      ...cov,
      sui_note:
        cov.sui_addresses_listed === 0
          ? `OFAC's SDN list (data as of ${cov.data_as_of}) contains no Sui addresses, so no Sui account can match it directly. Sanctions exposure can only appear on the far side of a bridge, as an EVM or Solana account read from a CCTP or Sui Bridge exit.`
          : `OFAC's SDN list (data as of ${cov.data_as_of}) lists ${cov.sui_addresses_listed} Sui address(es).`,
    },
  };
}
