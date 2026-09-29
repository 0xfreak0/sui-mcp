import { z } from "zod";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { numArg, refinePoint } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { isDigest, invalidDigestMessage, normalizeDigest } from "../utils/digest.js";
import { lookupPackageTrust, prefetchProtocolCustody, prefetchProtocolNames, lookupProtocolDisplay } from "../protocols/registry.js";
import { packageOfEventType } from "../utils/event-json.js";
import { originIncomplete } from "../protocols/package-custody.js";
import { foldSwaps } from "../utils/swap-fold.js";
import { capPayload, type ListCap } from "../utils/output-cap.js";
import { flagPtbAnomalies, isSystemPackage, NO_MATCH_NOTE, PTB_CHECKS, SEVERITY_RANK, supersededWrites, type FormattedCommand, type PtbAnomaly } from "../utils/ptb-anomalies.js";
import { readSupersededChanges } from "../utils/superseded-diff.js";
import { ptbDataFromBcs, resolvePtb, type ExecutedObjects } from "../utils/ptb-resolve.js";
import { guardiansFlagsForCoin, guardiansFlagsForObjectType, guardiansFlagsForPackage } from "../utils/guardians.js";
import {
  movedObjectsOf,
  objectValueByAddress,
  valueMovedObjects,
  valueTransactionObjects,
  SCAN_OBJECT_BUDGET,
  type AddressObjectValue,
  type MovedObjectValue,
  type MovedValues,
} from "../utils/moved-value.js";
import { effectsPayouts } from "../utils/payouts.js";
import { getLabel } from "../utils/labels.js";
import { resolveWindow } from "../utils/checkpoint-time.js";
import {
  displayCoin,
  formatUsd,
  prefetchCoinScale,
  priceUsdAtTime,
  pricingScale,
  PRICE_STALE_THRESHOLD_SEC,
  type HistoricalPrices,
} from "../utils/valuation.js";
import {
  aggregateIncident,
  addDeltas,
  callerValueWrites,
  canonicalId,
  foldRecordedChanges,
  isCoinTypeKey,
  isGasOnly,
  needsStateLoss,
  netByAddress,
  oracleTouches,
  pairFlashLegs,
  poolFlows,
  readSwap,
  reconcileValue,
  reconciliationAnomaly,
  eventTargetsOf,
  shortEventType,
  stateLossOf,
  tradeAnomalies,
  TRADE_CHECKS,
  typeArgsOf,
  valueDeltas,
  type AttackTx,
  type StateLoss,
  type ValuedCoin,
  type ValuedDeltas,
  type ValueReconciliation,
} from "../utils/attack-analysis.js";
import { digestsSentBy, readAttackTransactions } from "../utils/attack-read.js";
import { compareStates, STATE_JUMP_FACTOR, VALUE_SHARE_LOST } from "../utils/state-delta.js";
import { MAX_SHARED_READ, readObjectStates } from "../utils/state-read.js";
import { offMarketPrices, PRICE_CHECK, priceAnomaly, priceClaimsOf } from "../utils/price-claims.js";
import { ROUND_TRIP_CHECK, roundTripAnomaly, roundTripsOf } from "../utils/round-trip.js";
import { RECENT_WRITE_CHECK, recentForeignWrites, recentWriteAnomaly } from "../utils/recent-writes.js";

const EVIDENCE_TIERS = {
  "chain-derived":
    "Read from the transaction: balance changes, and pool reserve changes decoded from the pool's own events.",
  "price-provider":
    "USD is DefiLlama's or Pyth's price at the stated time, a third-party figure. Coins without one are listed, never valued at zero.",
  heuristic:
    "Matched on function and event names, the PTB's data flow and who published each called package: flash legs, oracle touches and anomaly flags. A lead to check against the calls, not a finding on its own; a check that matched nothing clears nothing.",
};

/**
 * A net this small, in either direction, reads as "paid gas and nothing
 * else" rather than a real gain or loss. Sui gas on a mainnet transaction
 * runs from a fraction of a cent to a few cents. $1 is above that and below
 * any real profit worth naming.
 */
const GAS_ONLY_USD_THRESHOLD = 1;

/**
 * Transactions of one summarize_incident_losses call whose moved objects are
 * valued. Each costs one object read plus its readers' reads.
 */
const MAX_OBJECT_VALUE_TXS = 100;

/** One moved object as a signed gain or loss; `method` is left to `object_values` in compact rows. */
function objectRow(r: MovedObjectValue, sign: 1 | -1, withMethod = true) {
  return {
    object_id: r.object_id,
    object_type: r.type,
    kind: r.kind,
    protocol: r.protocol,
    usd: r.usd === null ? null : sign * r.usd,
    ...(r.changed_in_place ? { changed_in_place: true } : {}),
    ...(r.custody ? { custody: r.custody } : {}),
    tier: r.tier,
    ...(r.estimate ? { estimate: true } : {}),
    ...(withMethod ? { method: r.method } : {}),
    ...(r.unpriced_reason ? { unpriced_reason: r.unpriced_reason } : {}),
  };
}

/**
 * Set what reached addresses unexplained against the valued positions the
 * transaction consumed (deleted with no recipient) or drew down in place,
 * per coin by the raw amounts those positions held: an unstake pays out
 * SUI from a pool the state read does not reach, and the StakedSui it
 * burned says how much.
 */
function explainByPositions(r: ValueReconciliation, rows: MovedObjectValue[]): ValueReconciliation & { positions_usd?: number } {
  const released = new Map<string, bigint>();
  for (const row of rows) {
    if (row.custody || !row.coin_amounts) continue;
    const consumed = !row.changed_in_place && row.to === null && row.from !== null;
    if (!consumed && !row.changed_in_place) continue;
    for (const c of row.coin_amounts) {
      // Consumed: all it held came out. Kept: a fall in what it holds did.
      const out = consumed ? BigInt(c.amount) : -BigInt(c.amount);
      if (out <= 0n) continue;
      const key = canonicalCoin(c.coin_type);
      released.set(key, (released.get(key) ?? 0n) + out);
    }
  }
  if (released.size === 0 || r.unexplained.length === 0) return r;
  let positionsUsd = 0;
  let unexplainedUsd = 0;
  let unpriced = 0;
  const unexplained: ValueReconciliation["unexplained"] = [];
  for (const u of r.unexplained) {
    const amount = BigInt(u.amount);
    const key = canonicalCoin(u.coin_type);
    const byPositions = amount < (released.get(key) ?? 0n) ? amount : (released.get(key) ?? 0n);
    released.set(key, (released.get(key) ?? 0n) - byPositions);
    const rest = amount - byPositions;
    const unit = u.usd === null || amount === 0n ? null : u.usd / Number(amount);
    if (unit !== null) positionsUsd += unit * Number(byPositions);
    if (rest <= 0n) continue;
    const restUsd = unit === null ? null : Number((unit * Number(rest)).toFixed(2));
    if (restUsd === null) unpriced++;
    else unexplainedUsd += restUsd;
    unexplained.push({ coin_type: u.coin_type, amount: rest.toString(), usd: restUsd });
  }
  return {
    ...r,
    unexplained,
    unexplained_usd: Number(unexplainedUsd.toFixed(2)),
    unexplained_unpriced: unpriced,
    positions_usd: Number(positionsUsd.toFixed(2)),
  };
}

/** Canonical coin type, or the input when it does not parse. */
function canonicalCoin(t: string): string {
  try {
    return normalizeStructTag(t);
  } catch {
    return t;
  }
}

/** Whether an address gained, gave up or saw a change in priced (not estimated) object value past the gas-only threshold. */
function movedPricedObjects(o: AddressObjectValue | undefined): boolean {
  return o !== undefined && (Math.abs(o.usd_net) >= GAS_ONLY_USD_THRESHOLD || o.usd_gained >= GAS_ONLY_USD_THRESHOLD);
}

/** An address's valued objects in, out, changed in place and in custody changes (not counted), compact, for its row. */
function objectEntries(o: AddressObjectValue) {
  return [
    ...o.gained.map((r) => objectRow(r, 1, false)),
    ...o.lost.map((r) => objectRow(r, -1, false)),
    ...o.changed.map((r) => objectRow(r, 1, false)),
    ...o.custody.map((r) => objectRow(r, 1, false)),
  ];
}

/**
 * Whether an address took something of unknown value: a coin with no price
 * that no third-party scam list flags, or an object with no price. A flagged
 * coin is a decoy, so it does not count. Neither does a coin the senders set
 * aside themselves paid out (`paidBySenders`): it is part of what they gave
 * away, not value that came out of an object someone could be hiding.
 */
function takesUnpricedValue(coins: ValuedCoin[], objects: AddressObjectValue | undefined, paidBySenders: ReadonlySet<string> = new Set()): boolean {
  return (
    coins.some(
      (c) => c.usd === null && BigInt(c.amount) > 0n && guardiansFlagsForCoin(c.coin_type).length === 0 && !paidBySenders.has(c.coin_type),
    ) ||
    (objects?.gained.some((r) => r.usd === null) ?? false)
  );
}

/** Commands the flagged-commands call lists, most severe first: about one decode_ptb page of calls. */
const FLAGGED_COMMANDS_READ = 20;

/**
 * Transactions whose shared objects are read for their losses, per
 * summarize_incident_losses call. Each read takes two to four requests; an
 * exploit that drains vaults with no pool event runs to tens of transactions,
 * and the rest are named.
 */
const MAX_STATE_READS = 50;

/** State reads in flight at once. */
const STATE_READ_CONCURRENCY = 4;

/** Digests a summary group row lists; `transaction_count` and the full view carry every one. */
const GROUP_DIGESTS = 5;

/**
 * The losses of every transaction no event decodes into pool amounts, read
 * from its shared objects' holdings ({@link needsStateLoss}), at most
 * {@link MAX_STATE_READS} of them.
 */
async function readStateLosses(txs: AttackTx[]): Promise<{ losses: Map<string, StateLoss>; read: number; unread: string[]; failed: string[] }> {
  const want = txs.filter((tx) => needsStateLoss(tx));
  const reading = want.slice(0, MAX_STATE_READS);
  const losses = new Map<string, StateLoss>();
  const failed: string[] = [];
  for (let i = 0; i < reading.length; i += STATE_READ_CONCURRENCY) {
    await Promise.all(
      reading.slice(i, i + STATE_READ_CONCURRENCY).map(async (tx) => {
        try {
          const loss = stateLossOf(await readObjectStates(tx));
          if (loss) losses.set(tx.digest, loss);
        } catch {
          failed.push(tx.digest);
        }
      }),
    );
  }
  return { losses, read: reading.length - failed.length, unread: want.slice(MAX_STATE_READS).map((t) => t.digest), failed };
}

/**
 * Protocol names for one call's output: curated registry, MVR name, or the
 * curated protocol whose key published the package. The last is read only for
 * the packages this call resolved it for (`custodyFor`); the custody cache is
 * process-wide, and reading it for any other package would make the output
 * depend on which tools ran before.
 */
function protocolNamer(custodyFor: Set<string>) {
  return (pkg: string | null) => {
    const id = canonicalId(pkg);
    return id ? lookupProtocolDisplay(id, { custody: custodyFor.has(id) })?.name ?? null : null;
  };
}

/** Protocol attribution and trust this call could not finish: called packages whose origin was not read. */
function custodySkippedNote(read: { skipped: string[]; failed: string[] }) {
  const incomplete = originIncomplete(read);
  return incomplete ? { protocol_attribution_incomplete: incomplete } : {};
}

async function prefetchFor(
  txs: AttackTx[],
): Promise<{ protocolOf: (pkg: string | null) => string | null; unread: { skipped: string[]; failed: string[] } }> {
  const pkgs = new Set<string>();
  const called = new Set<string>();
  for (const tx of txs) {
    for (const c of tx.calls) {
      pkgs.add(c.package);
      const id = canonicalId(c.package);
      if (id && !isSystemPackage(id)) called.add(id);
    }
    for (const e of tx.events) {
      const p = packageOfEventType(e.type);
      if (p) pkgs.add(p);
    }
    for (const o of tx.objects) {
      const p = o.objectType ? packageOfEventType(o.objectType) : null;
      if (p) pkgs.add(p);
    }
  }
  if (pkgs.size > 0) await prefetchProtocolNames(pkgs);
  // Every called package's publisher and newer versions: the custody name,
  // the publisher trust basis and the superseded-version check read them.
  const unread = called.size > 0 ? await prefetchProtocolCustody(called) : { skipped: [], failed: [] };
  const custodyFor = new Set([...called].filter((id) => !unread.skipped.includes(id) && !unread.failed.includes(id)));
  return { protocolOf: protocolNamer(custodyFor), unread };
}

/**
 * decode_ptb's anomaly pass over an executed transaction, with what only an
 * executed transaction has: payouts read from its effects, the addresses that
 * gained, and the checkpoint a superseded version is judged at. `leads` are
 * the trade anomalies, which count as other leads. `anomalies` is null when
 * the pass did not run, and `unread` then says why.
 */
async function ptbAnomaliesFor(
  tx: AttackTx,
  leads: PtbAnomaly[],
): Promise<{ anomalies: PtbAnomaly[]; unread: null } | { anomalies: null; unread: string }> {
  const read = tx.bcs ? ptbDataFromBcs(tx.bcs) : null;
  const data = read?.data;
  if (!data) {
    return {
      anomalies: null,
      unread: read === null
        ? "The response carried no transaction bytes to read the PTB from."
        : read.unread ?? "This transaction carried no programmable PTB to read.",
    };
  }
  // Mutable shared inputs are always among the changed objects, which is
  // where the superseded-version check reads their types.
  const executed: ExecutedObjects = new Map();
  for (const o of tx.objects) {
    const id = canonicalId(o.objectId);
    if (id) executed.set(id, { version: null, type: o.objectType });
  }
  const { commands, inputs } = await resolvePtb(data, executed);
  const called = [...new Set(tx.calls.map((c) => canonicalId(c.package)).filter((p): p is string => p !== null))];
  const checkpoint = tx.checkpoint !== null ? Number(tx.checkpoint) : null;
  const trust = (pkg: string) => lookupPackageTrust(pkg, checkpoint);
  const anomalies = flagPtbAnomalies(commands as FormattedCommand[], {
    sender: tx.sender ?? undefined,
    blocklistedPackages: new Set(called.filter((p) => guardiansFlagsForPackage(p).length > 0)),
    inputs,
    trust,
    supersededChanges: await readSupersededChanges(supersededWrites(commands as FormattedCommand[], inputs, trust)),
    effects: effectsPayouts(tx.sender, tx.balanceChanges, tx.movements, tx.gas),
    leads,
  });
  return { anomalies, unread: null };
}

/** The per-coin price table a response carries once, instead of per row. */
function priceTable(prices: HistoricalPrices, atSec: number) {
  return [...prices.points].map(([coin_type, p]) => {
    const offset = p.publishTime - atSec;
    return {
      coin_type,
      price_usd: p.price,
      source: p.source,
      ...(p.priced_as ? { priced_as: p.priced_as } : {}),
      ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
      price_time: new Date(p.publishTime * 1000).toISOString(),
      price_offset_sec: offset,
      ...(Math.abs(offset) > PRICE_STALE_THRESHOLD_SEC ? { stale: true } : {}),
    };
  });
}

function parseAt(at: string | number | undefined): number | null | "invalid" {
  if (at === undefined) return null;
  if (typeof at === "number") return Math.floor(at);
  if (/^\d+$/.test(at.trim())) return Number(at.trim());
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? "invalid" : Math.floor(ms / 1000);
}

export function registerAttackTools(server: McpServer) {
  server.tool(
    "analyze_attack_tx",
    "Investigate one exploit transaction: per-address/coin gains and losses in USD at block time, attacker profit or a signing victim's loss and gainers, paired flash-loan/swap legs, swap amounts/prices (where events supply them), pool/vault/market flows attributed by event object ID, oracle calls/updates, and shared-object before/after state. Reconciles object/mint outflows to addresses against decoded events/read objects; address-to-address transfers cancel, and capped-out objects are counted. Flags caller-fed state/accounting reused in the PTB, state jumps, drains, excess liquidity/share minting, key replacement, coin-specific oracle mispricing, rapid profitable redemptions and last-minute third-party state rewrites. Includes decode_ptb checks, effects-based payouts, superseded versions and packages unvouched by registry/publishing key. The whole transaction is read, including large command/event sets. USD needs no key; unpriced coins are listed. Flash legs, oracle touches and anomalies are heuristic leads; checks_run with no matches clears nothing. Follow flagged_commands to decode_ptb for medium/high flags' commands.",
    {
      digest: z.string().describe("Transaction digest (Base58)"),
      attacker: z
        .string()
        .optional()
        .describe("Profit address; default sender. May switch to largest priced gainer (>= $1) if sender has only a SUI payment/no coin change and no priced object movement, or gives away valued objects without taking value. Unpriced gains outside sender/chosen gainer block it, excluding flagged coins and sender-paid coin types. Reports attacker_defaulted_from_sender; pass an address to override."),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default): ~40k chars across lists; keeps anomaly/flash-linked pools, holders and addresses, sender and profit address. Totals/anomalies cover all rows; omitted counts the rest. 'full': all rows."),
    },
    async ({ digest: rawDigest, attacker, detail }) => {
      try {
        const digest = normalizeDigest(rawDigest);
        if (!isDigest(digest)) return errorResult(invalidDigestMessage(digest));
        const subject = attacker ? canonicalId(attacker) : null;
        if (attacker && !subject) return errorResult(`'${attacker}' is not a Sui address.`);

        const read = await readAttackTransactions([digest]);
        const tx = read.txs[0];
        if (!tx) {
          return errorResult(
            `Transaction ${digest} was not returned by the fullnode or the archive. Check the digest and the network.`,
          );
        }
        const { protocolOf, unread: custodySkipped } = await prefetchFor([tx]);

        const senderId = canonicalId(tx.sender);
        const net = netByAddress(tx.balanceChanges);
        const flows = poolFlows(tx);
        const shared = eventTargetsOf(tx);
        const coins = new Set<string>(tx.balanceChanges.map((b) => b.coinType));
        for (const f of flows) for (const c of f.deltas.keys()) if (isCoinTypeKey(c)) coins.add(c);
        const atSec = tx.timestampMs !== null ? Math.floor(tx.timestampMs / 1000) : Math.floor(Date.now() / 1000);
        // Decimals first: `valueDeltas` scales every amount it reports. A
        // failed transaction changed no object but its gas coin.
        const noObjects: MovedValues = { rows: [], unread: [] };
        const [prices, , stateRead, movedValues] = await Promise.all([
          priceUsdAtTime([...coins], atSec),
          prefetchCoinScale(coins),
          tx.success ? readObjectStates(tx).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))) : Promise.resolve(undefined),
          // A failed transaction moved no object.
          tx.success ? valueMovedObjects(movedObjectsOf(tx), tx.checkpoint) : Promise.resolve(noObjects),
        ]);
        const state = stateRead instanceof Error ? undefined : stateRead;
        const objectValue = objectValueByAddress(movedValues.rows);

        const addresses = [...new Set([...net.keys(), ...objectValue.keys()])]
          .map((address) => {
            const v = valueDeltas(net.get(address) ?? new Map(), prices.points);
            const o = objectValue.get(address);
            const label = getLabel(address);
            return {
              address,
              ...(address === senderId ? { role: "sender" } : {}),
              ...(label ? { label: label.label, label_source: label.source } : {}),
              usd_net: Number((v.usd_net + (o?.usd_net ?? 0)).toFixed(2)),
              coins: v.coins,
              ...(o ? { objects: objectEntries(o) } : {}),
              ...(o?.estimate_usd_net ? { objects_estimate_usd_net: o.estimate_usd_net } : {}),
              ...(v.unpriced.length ? { unpriced_coins: v.unpriced.length } : {}),
              ...(o?.unpriced ? { unpriced_objects: o.unpriced } : {}),
            };
          })
          .sort((a, b) => Math.abs(b.usd_net) - Math.abs(a.usd_net));

        // In a key compromise or an alias/protocol-level substitution, the
        // signer does not end up holding the funds: it paid gas and nothing
        // else in the same transaction that paid someone else. When the
        // sender is gas-only, the largest actual gainer is named instead, with
        // the reason stated.
        const senderEntry = addresses.find((a) => a.role === "sender");
        const senderObjects = senderId ? objectValue.get(senderId) : undefined;
        // Objects with no price or only an estimate leave a gas-only sender gas-only.
        const senderIsGasOnly =
          isGasOnly(senderId ? net.get(senderId) : undefined, prices.points, GAS_ONLY_USD_THRESHOLD) && !movedPricedObjects(senderObjects);
        // A sender that took nothing of value, in priced coins or valued
        // objects, and gave valued objects away signed them over to others,
        // as a victim-signed drain does. A coin a third-party scam list flags
        // is a decoy, not value it took.
        const senderCoins = valueDeltas(senderId ? net.get(senderId) ?? new Map() : new Map(), prices.points);
        const senderGaveAway =
          !senderIsGasOnly &&
          senderCoins.usd_gained + (senderObjects?.usd_gained ?? 0) < GAS_ONLY_USD_THRESHOLD &&
          (senderObjects?.usd_net ?? 0) <= -GAS_ONLY_USD_THRESHOLD &&
          !takesUnpricedValue(senderCoins.coins, senderObjects);
        const senderTookNothing = senderIsGasOnly || senderGaveAway;
        // A candidate whose gain includes a coin with no price must not be
        // passed over for a smaller priced gain in the same transaction: a
        // drained vault's assets are often exactly the coins with no price
        // (LP tokens, receipts, a DefiLlama miss), and the address holding a
        // small priced fee is not the one who took the value. The top priced
        // gainer's own unpriced coins pass nobody over, so they do not block
        // the default; its profit is then reported as a partial figure.
        // Coins the sender paid out: another address gaining one of them took
        // part of what the sender gave, not value from elsewhere.
        const senderPaid = new Set(
          [...(senderId ? net.get(senderId) ?? new Map<string, bigint>() : new Map<string, bigint>())].filter(([, v]) => v < 0n).map(([c]) => c),
        );
        const topPriced =
          !subject && senderTookNothing
            ? [...addresses]
                .filter((a) => a.address !== senderId && a.usd_net >= GAS_ONLY_USD_THRESHOLD)
                .sort((a, b) => b.usd_net - a.usd_net)[0]
            : undefined;
        const unpricedGainers =
          !subject && senderTookNothing
            ? addresses.filter(
                (a) =>
                  a.address !== senderId &&
                  a.address !== topPriced?.address &&
                  takesUnpricedValue(a.coins, objectValue.get(a.address), senderPaid),
              )
            : [];
        const defaultedFrom = unpricedGainers.length === 0 ? topPriced : undefined;
        const who = subject ?? defaultedFrom?.address ?? senderId;

        const mineCoins = valueDeltas(who ? net.get(who) ?? new Map() : new Map(), prices.points);
        const mineObjects = who ? objectValue.get(who) : undefined;
        const mine = {
          usd_net: Number((mineCoins.usd_net + (mineObjects?.usd_net ?? 0)).toFixed(2)),
          usd_gained: Number((mineCoins.usd_gained + (mineObjects?.usd_gained ?? 0)).toFixed(2)),
          unpriced: mineCoins.unpriced,
        };
        // An object kept but changed is a gain or a loss by the sign of its change.
        const changedUp = (mineObjects?.changed ?? []).filter((r) => (r.usd ?? 0) >= 0);
        const changedDown = (mineObjects?.changed ?? []).filter((r) => (r.usd ?? 0) < 0);
        const gains: unknown[] = [
          ...mineCoins.coins.filter((c) => BigInt(c.amount) > 0n),
          ...(mineObjects?.gained ?? []).map((r) => objectRow(r, 1, false)),
          ...changedUp.map((r) => objectRow(r, 1, false)),
        ];
        const losses: unknown[] = [
          ...mineCoins.coins.filter((c) => BigInt(c.amount) < 0n),
          ...(mineObjects?.lost ?? []).map((r) => objectRow(r, -1, false)),
          ...changedDown.map((r) => objectRow(r, 1, false)),
        ];

        const typeById = new Map(tx.objects.map((o) => [canonicalId(o.objectId), o.objectType]));
        const readSwaps = tx.events.map((e) => readSwap(e, shared)).filter((s): s is NonNullable<typeof s> => s !== null);
        // A swap event this cannot read (no pool, direction or amounts) would
        // be a row of nulls. Those are counted per type with their indices.
        const opaque = readSwaps.filter((s) => s.pool === null && s.amount_in === null && s.price_before === null);
        const opaqueByType = new Map<string, number[]>();
        for (const s of opaque) opaqueByType.set(s.event_type, [...(opaqueByType.get(s.event_type) ?? []), s.event]);
        const undecodedSwaps = [...opaqueByType].map(([event_type, events]) => ({
          event_type,
          protocol: protocolOf(packageOfEventType(tx.events[events[0]].type)),
          count: events.length,
          events,
        }));
        const swaps = readSwaps
          .filter((s) => !opaque.includes(s))
          .map((s) => {
            // An id-less swap (Typus) names its pool through the flow it was credited to.
            const pool = s.pool ?? flows.find((f) => f.events.includes(s.event))?.pool ?? null;
            const poolType = pool ? typeById.get(pool) ?? null : null;
            const args = poolType ? typeArgsOf(poolType) : [];
            const [coinIn, coinOut] =
              s.coin_in !== null
                ? [s.coin_in, s.coin_out]
                : s.a_to_b === null || args.length < 2
                  ? [null, null]
                  : s.a_to_b
                    ? [args[0], args[1]]
                    : [args[1], args[0]];
            return {
              ...s,
              pool,
              protocol: protocolOf(packageOfEventType(tx.events[s.event].type)),
              coin_in: coinIn,
              coin_out: coinOut,
            };
          });

        const legs = pairFlashLegs(tx.calls, tx.events, shared).map((l) => ({
          ...l,
          protocol: protocolOf((l.borrow.target ?? "").split("::")[0]) ?? protocolOf(l.repay?.target.split("::")[0] ?? null),
          evidence_tier: "heuristic",
        }));

        const poolRows = flows.map((f) => {
          const v = valueDeltas(f.deltas, prices.points);
          return {
            pool: f.pool,
            pool_type: f.pool_type,
            protocol: protocolOf(packageOfEventType(f.pool_type)),
            usd_net: Number((v.usd_net - (f.recorded_loss_usd ?? 0)).toFixed(2)),
            deltas: v.coins,
            ...(v.unpriced.length ? { unpriced_coins: v.unpriced.length } : {}),
            events: f.events,
            ...(f.undecoded_events.length ? { undecoded_events: f.undecoded_events } : {}),
            ...(f.recorded_loss_usd
              ? {
                  recorded_loss_usd: Number(f.recorded_loss_usd.toFixed(2)),
                  recorded_loss_note: "This pool's own event states a USD value change directly (no coin amount to price); it is folded into usd_net above.",
                }
              : {}),
            ...(f.recorded_changes.length ? { recorded_changes: foldRecordedChanges(f.recorded_changes) } : {}),
          };
        });

        const reconciliation = explainByPositions(reconcileValue(tx, flows, prices.points, state), movedValues.rows);
        const stateFindings = state ? compareStates(tx, state, flows, prices.points) : null;
        const unreconciled = reconciliationAnomaly(reconciliation, GAS_ONLY_USD_THRESHOLD);
        // Prices the transaction states for coins, against a provider at block
        // time; what the sender redeems against what it paid within a day; and
        // shared objects another address rewrote just before this ran.
        const claims = priceClaimsOf(tx.events, state?.keyed ?? []);
        const claimCoins = [...new Set(claims.map((c) => c.coin))].filter((c) => !prices.points.has(c));
        const [claimPrices, trips, recent] = await Promise.all([
          claimCoins.length ? priceUsdAtTime(claimCoins, atSec) : Promise.resolve(null),
          roundTripsOf(tx, state, prices.points).catch(() => ({ trips: [], unread: ["the sender's earlier transactions"] })),
          tx.success ? recentForeignWrites(tx).catch(() => ({ writes: [], unread: ["the shared objects' earlier versions"] })) : Promise.resolve({ writes: [], unread: [] }),
        ]);
        const offMarket = offMarketPrices(claims, claimPrices ? new Map([...prices.points, ...claimPrices.points]) : prices.points, atSec);
        const priceFlag = priceAnomaly(offMarket);
        const tripFlag = roundTripAnomaly(trips.trips);
        // What the signer lost that other addresses gained, coins and valued objects.
        const movedToOthers = Math.min(
          Math.max(0, -(senderEntry?.usd_net ?? 0)),
          addresses.filter((a) => a.role !== "sender" && a.usd_net > 0).reduce((s, a) => s + a.usd_net, 0),
        );
        const recentFlag = recentWriteAnomaly(recent.writes, movedToOthers);
        const trade = [
          ...tradeAnomalies(tx, state, flows, prices.points),
          ...(unreconciled ? [unreconciled] : []),
          ...(priceFlag ? [priceFlag] : []),
          ...(tripFlag ? [tripFlag] : []),
          ...(recentFlag ? [recentFlag] : []),
        ];
        const callerWrites = callerValueWrites(tx, state);
        const ptbPass = await ptbAnomaliesFor(tx, trade);
        const anomalies = [...trade, ...(ptbPass.anomalies ?? [])].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
        const checksRun = [...TRADE_CHECKS, PRICE_CHECK, ROUND_TRIP_CHECK, RECENT_WRITE_CHECK, ...(ptbPass.anomalies ? PTB_CHECKS : [])];
        const ptbUnreadNote = ptbPass.unread === null ? "" : ` The PTB checks did not run. ${ptbPass.unread}`;
        const oracle = oracleTouches(tx.calls, tx.events);

        const lines: string[] = [];
        lines.push(
          `${digest} at ${tx.timestampMs ? new Date(tx.timestampMs).toISOString() : "unknown time"}, ${tx.success ? "success" : "FAILED"}: ` +
            `${tx.commandKinds.length} commands, ${tx.events.length} events, ${tx.balanceChanges.length} balance changes.`,
        );
        // Why the sender was set aside, for the headline and the payload.
        const senderAside = senderGaveAway
          ? `took nothing priced in this transaction (only coins a third-party scam list flags, if any) and gave away ${formatUsd(-(senderObjects?.usd_net ?? 0))} in valued objects`
          : "only paid gas in this transaction";
        if (unpricedGainers.length > 0) {
          lines.push(
            `No attacker given: the sender ${senderId} ${senderAside}, but ${unpricedGainers.length === 1 ? `${unpricedGainers[0].address} gained` : `${unpricedGainers.length} other addresses gained`} a coin or object with no price, so the sender is kept rather than guessing from priced gains alone. See unpriced_gain_candidates.`,
          );
        } else if (defaultedFrom) {
          lines.push(
            `No attacker given: the sender ${senderId} ${senderAside} (net ${formatUsd(senderEntry?.usd_net ?? 0)}), so ${who} is used instead as the largest gainer (net ${formatUsd(defaultedFrom.usd_net)}). Pass "attacker" to name a different address.`,
          );
        }
        // A subject that lost value is not profiting: a victim-signed theft
        // has the victim as sender, so the headline names the loss and the
        // addresses that gained instead.
        const gainersElsewhere = mine.usd_net < 0 ? addresses.filter((a) => a.address !== who && a.usd_net >= GAS_ONLY_USD_THRESHOLD).slice(0, 3) : [];
        const unpricedObjects = mineObjects?.unpriced ?? 0;
        // Objects of this transaction a reader handles but could not value.
        const objectsNotValued = movedValues.unread.length;
        if (who) {
          lines.push(
            (mine.usd_net < 0
              ? `Loss for ${who}${who === senderId ? " (the sender)" : ""}: ${formatUsd(-mine.usd_net)} net at block time`
              : `Profit for ${who}: ${formatUsd(mine.usd_net)} net at block time`) +
              (mine.unpriced.length || unpricedObjects || objectsNotValued
                ? `, plus ${mine.unpriced.length} unpriced coin(s) and ${unpricedObjects} unpriced object(s)${objectsNotValued ? `, with ${objectsNotValued} object(s) not valued (object_values_unread)` : ""}, so this is a partial figure.`
                : ".") +
              (gainersElsewhere.length
                ? ` Gained in the same transaction: ${gainersElsewhere.map((a) => `${a.address} ${formatUsd(a.usd_net)}`).join(", ")}. Pass "attacker" to break down one of them.`
                : ""),
          );
          for (const c of mineCoins.coins) {
            lines.push(`  ${BigInt(c.amount) > 0n ? "+" : ""}${c.amount_human.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${c.symbol}${c.verified === false ? " (unverified)" : ""} ${c.usd !== null ? formatUsd(c.usd) : "(unpriced)"}`);
          }
          for (const [sign, rows] of [["+", mineObjects?.gained ?? []], ["-", mineObjects?.lost ?? []], ["changed ", mineObjects?.changed ?? []]] as const) {
            for (const r of rows) {
              lines.push(
                `  ${sign}${r.kind} ${r.object_id}${r.protocol ? ` (${r.protocol})` : ""} ${r.usd !== null ? formatUsd(r.usd) : "(unpriced)"}${r.estimate ? " (estimate)" : ""}`,
              );
            }
          }
        }
        for (const l of legs) {
          lines.push(
            `${l.kind.replace("_", " ")} (${l.basis}): ${l.borrow.target}` +
              (l.repay ? ` repaid by ${l.repay.target}` : " with no repayment seen") +
              (l.objects.length ? ` on ${l.objects.join(", ")}` : ""),
          );
        }
        const moved = swaps.filter((s) => s.price_change_pct !== null).sort((a, b) => Math.abs(b.price_change_pct!) - Math.abs(a.price_change_pct!));
        if (moved.length) {
          lines.push(`Largest pool price move: ${moved[0].price_change_pct!.toFixed(4)}% on ${moved[0].pool} (${moved[0].protocol ?? moved[0].event_type}).`);
        }
        for (const p of [...poolRows].sort((a, b) => a.usd_net - b.usd_net).slice(0, 5)) {
          const unpricedMoves = p.deltas.filter((d) => d.usd === null);
          if (p.usd_net < 0) {
            lines.push(
              `Pool ${p.pool} (${p.protocol ?? "unknown protocol"}) lost ${formatUsd(-p.usd_net)} by its own events` +
                (p.unpriced_coins ? `, leaving out ${p.unpriced_coins} unpriced coin(s) or unit(s) it also moved.` : "."),
            );
          } else if (unpricedMoves.some((d) => BigInt(d.amount) < 0n)) {
            // Nothing priced to total, but the pool still paid something out.
            const moves = unpricedMoves
              .slice(0, 4)
              .map((d) => `${d.amount_human > 0 ? "+" : ""}${d.amount_human.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${d.symbol}`);
            lines.push(`Pool ${p.pool} (${p.protocol ?? "unknown protocol"}) moved, by its own events and with no price: ${moves.join(", ")}.`);
          }
        }
        if (oracle.length) lines.push(`Oracle touches: ${oracle.map((o) => `${o.target.split("::").slice(1).join("::")} ×${o.count}`).join(", ")}.`);
        // Per coin the address changes are summed, so a payment from one
        // address to another cancels: the figure is value that came out of
        // objects or mints, and a plain transfer theft reads $0 here.
        const unreadNote = reconciliation.objects_unread && (reconciliation.unexplained_usd > 0 || reconciliation.unexplained_unpriced > 0)
          ? ` ${reconciliation.objects_unread} changed object(s) were left unread past the read caps or unavailable, so part of what is unexplained may have come from them.`
          : "";
        lines.push(
          (reconciliation.reached_addresses_usd > 0
            ? `Value reconciliation: ${formatUsd(reconciliation.reached_addresses_usd)} of priced coins came out of objects or mints and reached addresses (per coin, summed over every address, so transfers between addresses cancel); decoded pool and vault events account for ${formatUsd(reconciliation.decoded_usd)}` +
              (reconciliation.state_usd !== null ? `, the read objects' balances for ${formatUsd(reconciliation.state_usd)}` : "") +
              (reconciliation.positions_usd ? `, positions the transaction closed or drew down for ${formatUsd(reconciliation.positions_usd)}` : "") +
              (reconciliation.unexplained_usd > 0 ? `, leaving ${formatUsd(reconciliation.unexplained_usd)} unexplained` : "")
            : "Value reconciliation: no priced coin came out of an object or a mint to addresses on net. Per coin the address changes are summed, so value moved from one address to another cancels here; the addresses list shows who paid whom") +
            (reconciliation.unexplained_unpriced ? `; ${reconciliation.unexplained_unpriced} unpriced coin(s) reached addresses with nothing read paying them out.` : ".") +
            unreadNote,
        );
        if (state) {
          const readShared = state.objects.filter((o) => o.role === "shared").length;
          lines.push(
            `State read at input and output versions: ${readShared} shared object(s), ${state.objects.length - readShared} coin holding(s), created object(s) or treasury cap(s)` +
              (state.skipped.length || state.unavailable.length ? `; ${state.skipped.length} left unread (past a read cap, or a field whose layout could not be read) and ${state.unavailable.length} unavailable, see state_deltas.` : "."),
          );
        }
        for (const a of anomalies) lines.push(`Anomaly (heuristic lead, ${a.severity}) ${a.code}: ${a.title}.`);
        const leadCount = anomalies.filter((a) => a.severity !== "info").length;
        // The commands the medium and high flags name, by severity, and the
        // decode_ptb call that lists the most severe of them whatever page
        // they fall on.
        const high = [...new Set(anomalies.filter((a) => a.severity === "high").flatMap((a) => a.commands ?? []))].sort((a, b) => a - b);
        const medium = [...new Set(anomalies.filter((a) => a.severity === "medium").flatMap((a) => a.commands ?? []))].filter((i) => !high.includes(i)).sort((a, b) => a - b);
        const flaggedCount = high.length + medium.length;
        const readFlagged = { tool: "decode_ptb", args: { digest, commands: [...high, ...medium].slice(0, FLAGGED_COMMANDS_READ).sort((a, b) => a - b) } };
        if (flaggedCount) {
          const list = (xs: number[]) => (xs.length > 12 ? `${xs.slice(0, 12).join(", ")} and ${xs.length - 12} more` : xs.join(", "));
          lines.push(
            `Flagged commands: ${[...(high.length ? [`high ${list(high)}`] : []), ...(medium.length ? [`medium ${list(medium)}`] : [])].join("; ")}. ` +
              `decode_ptb with commands: [${readFlagged.args.commands.join(", ")}] lists ${flaggedCount > FLAGGED_COMMANDS_READ ? `the ${FLAGGED_COMMANDS_READ} most severe` : "them"}.`,
          );
        }
        lines.push(
          `Checks run: ${checksRun.map((c) => c.code).join(", ")}. ${leadCount ? `${leadCount} matched at medium or high` : "None matched at medium or high"}; a check that did not match clears nothing.` +
            ptbUnreadNote,
        );
        if (prices.unpriced.length) lines.push(`Unpriced coins: ${prices.unpriced.length}. See \`unpriced\`.`);

        const payload = {
          digest,
          sender: tx.sender,
          status: tx.success ? "success" : "failure",
          timestamp: tx.timestampMs !== null ? new Date(tx.timestampMs).toISOString() : null,
          checkpoint: tx.checkpoint,
          command_count: tx.commandKinds.length,
          event_count: tx.events.length,
          ...(read.served_by_archive ? { served_by_archive: true } : {}),
          ...(read.events_undecoded.length
            ? { events_undecoded_note: "Event fields could not be decoded, so pool flows, swaps and flash events below are incomplete." }
            : {}),
          evidence_tiers: EVIDENCE_TIERS,
          profit: who
            ? {
                address: who,
                usd_net: mine.usd_net,
                usd_gained: mine.usd_gained,
                gains,
                losses,
                ...(mine.unpriced.length || unpricedObjects || objectsNotValued
                  ? {
                      ...(mine.unpriced.length ? { unpriced_coins: mine.unpriced } : {}),
                      ...(unpricedObjects ? { unpriced_objects: unpricedObjects } : {}),
                      ...(objectsNotValued ? { objects_not_valued: objectsNotValued } : {}),
                      partial_note:
                        "At least one coin or object this address gained or lost has no price, or an object of this transaction could not be valued (object_values_unread), so usd_net covers only what is priced.",
                    }
                  : {}),
                ...(mineObjects?.estimate_usd_net
                  ? {
                      objects_estimate_usd_net: mineObjects.estimate_usd_net,
                      objects_estimate_note: "Objects valued by heuristic estimate (NFTs), kept out of usd_net.",
                    }
                  : {}),
                ...(defaultedFrom
                  ? {
                      attacker_defaulted_from_sender: {
                        sender: senderId,
                        sender_usd_net: senderEntry?.usd_net ?? 0,
                        reason: `No "attacker" was given. The sender ${senderAside}, so this address, the largest gainer in the same transaction, is used instead. Pass "attacker" to name a different address.`,
                      },
                    }
                  : {}),
                note: "Net of gas: the sender's SUI change includes the fee it paid. Objects count at their value at the transaction's checkpoint; each object row states its method.",
                ...(gainersElsewhere.length
                  ? {
                      gained_elsewhere: gainersElsewhere.map((a) => ({ address: a.address, usd_net: a.usd_net })),
                      gained_elsewhere_note: `This address lost value in the transaction; these addresses gained. Pass "attacker" to break one of them down.`,
                    }
                  : {}),
              }
            : null,
          ...(unpricedGainers.length > 0
            ? {
                unpriced_gain_candidates: unpricedGainers.map((a) => ({
                  address: a.address,
                  unpriced_coins: a.coins
                    .filter((c) => c.usd === null && BigInt(c.amount) > 0n)
                    .map((c) => ({ coin_type: c.coin_type, symbol: c.symbol, amount: c.amount_human })),
                  ...(objectValue.get(a.address)?.gained.some((r) => r.usd === null)
                    ? { unpriced_objects: objectValue.get(a.address)!.gained.filter((r) => r.usd === null).map((r) => ({ object_id: r.object_id, type: r.type })) }
                    : {}),
                })),
                unpriced_gain_candidates_note:
                  `The sender ${senderAside}, but an address other than the largest priced gainer gained a coin or object with no price. Defaulting to the largest PRICED gainer risks naming a small fee wallet or referrer over the address that actually took the unpriced value, so the sender was kept as \`profit.address\` instead. Investigate these candidates directly, or pass "attacker" to name one.`,
              }
            : {}),
          addresses,
          ...(movedValues.rows.length || movedValues.unread.length
            ? {
                object_values: movedValues.rows,
                ...(movedValues.unread.length ? { object_values_unread: movedValues.unread } : {}),
                object_values_note:
                  "Non-coin objects that entered or left an address in this transaction, or that it kept while the transaction changed their value (changed_in_place: usd is the change, both sides at one set of prices), each valued by its reader at the transaction's checkpoint (its method says when a state was the latest instead). Each address's usd_net counts them; estimates (tier heuristic, NFTs) are kept out of usd_net, and so are rows with `custody` (wrapped into or unwrapped from another object, or from a holder that could not be read), which the holder still owns in another form.",
              }
            : {}),
          flash_legs: legs,
          swap_count: swaps.length,
          swaps: foldSwaps(swaps),
          ...(undecodedSwaps.length
            ? {
                undecoded_swaps: undecodedSwaps,
                undecoded_swaps_note:
                  "Swap events whose fields name no pool, direction or amounts in a form read here. Their decoded fields are in get_transaction.",
              }
            : {}),
          swap_price_note:
            "amount_in/amount_out are what the pool took in and paid out, in coin_in/coin_out. price_before/price_after are the pool's own price as raw coin B per raw coin A, from the event's sqrt price (Q64.64) or tick. price_change_pct is unit-free. Null where the event does not carry the price on both sides.",
          pool_flows: poolRows,
          pool_flows_note:
            "Each pool's reserve change, summed from its swap, add-liquidity, remove-liquidity and fee events. An event belongs to the changed shared object whose id one of its fields carries, whatever the field is named. Negative is what left the pool. A key of the form PT<coin> is Nemo's principal token, a position balance rather than a coin, in the units of that coin and never priced. recorded_changes are before/after pairs the object's own events state (X_before/X_after, before_X/after_X, old_X/new_X, X_old/X_new), first before and last after per field. Events naming a pool with an amount field in a shape not read here are listed in undecoded_events.",
          oracle_activity: oracle.map((o) => ({ ...o, evidence_tier: "heuristic" })),
          ...(callerWrites.length ? { caller_value_writes: callerWrites.map(({ line: _line, ...w }) => w) } : {}),
          ...(offMarket.length ? { off_market_prices: offMarket } : {}),
          ...(recent.writes.length || recent.unread.length
            ? { recent_foreign_writes: recent.writes, ...(recent.unread.length ? { recent_foreign_writes_unread: recent.unread } : {}) }
            : {}),
          ...(trips.trips.length || trips.unread.length
            ? { round_trips: trips.trips, ...(trips.unread.length ? { round_trips_unread: trips.unread } : {}) }
            : {}),
          value_reconciliation: {
            ...reconciliation,
            note: "Per coin, the sum of every address's balance change (coins moving between addresses cancel) against the net the decoded pools and vaults paid out by their own events (decoded_usd, plus losses those events state in USD), and against the net the read objects' Balance<T> holdings fell by (state_usd). The larger of the two explains a coin. What remains is then set against the valued positions the transaction consumed or drew down (a stake unstaked, a position closed, an obligation withdrawn from), per coin by the amounts they held (positions_usd). Unexplained value came from an object that was not read, or that holds funds outside a Balance<T> field; objects_unread counts the changed objects the state read left out.",
          },
          ...(state
            ? {
                state_deltas: {
                  ...(stateFindings ?? { jumps: [], drops: [], wrong_source: [] }),
                  objects_read: state.objects.map((o) => ({ object_id: o.objectId, object_type: o.objectType, role: o.role })),
                  ...(state.skipped.length ? { skipped: state.skipped } : {}),
                  ...(state.unavailable.length ? { unavailable: state.unavailable } : {}),
                  ...(state.layout_unread.length ? { layout_unread: state.layout_unread } : {}),
                  note: `Read at the transaction's input and output versions: each changed shared object (at most ${MAX_SHARED_READ}, the largest first by storage rebate), each dynamic field whose value keeps a Balance<T> or Supply<T>, each other object owned by an object (a pool kept as a dynamic object field), each created object and each changed TreasuryCap<T>. skipped lists every candidate left unread. jumps: a shared object's stored number that moved ${STATE_JUMP_FACTOR}x or more between non-zero values, from the object or from a before/after pair its own event stated. drops: a read object's Balance<T> holdings of one coin falling ${STATE_JUMP_FACTOR}x or to zero, or falling by less while its holder lost ${VALUE_SHARE_LOST * 100}% or more of its priced value across all its coins (value_share_lost) and addresses gained at least half of that; paid_to names the addresses whose gains, by USD in any coin (in the same coin when unpriced), cover at least half of it, and offset_by the coins its holder took back when they cover 90% of all it paid out. wrong_source: a number an object took from an object other than the one it references. List entries, per-user table rows, tick and order-book entries are not read. Empty lists clear nothing about what was not read.`,
                },
              }
            : stateRead instanceof Error
              ? { state_deltas: { error: `The objects could not be read at their versions, so the state rule did not run: ${stateRead.message}` } }
              : {}),
          anomalies: anomalies.map((a) => ({ ...a, evidence_tier: "heuristic" })),
          ...(flaggedCount
            ? {
                flagged_commands: {
                  high,
                  medium,
                  next_call: readFlagged,
                  ...(flaggedCount > FLAGGED_COMMANDS_READ ? { note: `next_call lists the ${FLAGGED_COMMANDS_READ} most severe of the ${flaggedCount}; high and medium hold every index, and decode_ptb commands takes up to 100.` } : {}),
                },
              }
            : {}),
          checks_run: checksRun,
          checks_note: NO_MATCH_NOTE + ptbUnreadNote,
          ...custodySkippedNote(custodySkipped),
          prices: priceTable(prices, atSec),
          ...(prices.unpriced.length
            ? {
                unpriced: prices.unpriced.map(({ reason: _reason, ...u }) => u),
                unpriced_reasons: Object.fromEntries(prices.unpriced.map((u) => [u.code, u.reason])),
              }
            : {}),
        };

        // Swaps fold by pool, coins and direction; the rows then fit the cap,
        // keeping every pool a flash leg or an anomaly names and the largest
        // price move. Every other list keeps what an anomaly or flash leg
        // names, the sender and the profit address, and the largest values.
        const named = new Set<string>([
          ...legs.flatMap((l) => l.objects),
          ...anomalies.flatMap((a) => (a.evidence ?? []).flatMap((e) => e.match(/0x[0-9a-f]{64}/g) ?? [])),
          ...(moved[0]?.pool ? [moved[0].pool] : []),
        ]);
        // Each named holder keeps one drop row past the budget, a priced
        // coin's where it has one; its other coins' rows are capped.
        const leadDrops = new Set<unknown>();
        const drops = stateFindings?.drops ?? [];
        for (const holder of new Set(drops.map((d) => d.holder))) {
          if (!named.has(holder)) continue;
          const own = drops.filter((d) => d.holder === holder);
          leadDrops.add(own.find((d) => prices.points.has(d.coin_type)) ?? own[0]);
        }
        type Row = { pool: string | null };
        type Coin = { coin_type: string; amount?: string; usd: number | null };
        type Addr = { address: string; role?: string; label?: string; usd_net: number };
        type Flow = { pool: string; pool_type: string | null; usd_net: number };
        type Drop = { holder: string; coin_type: string; before: string; after: string };
        type Obj = { object_id: string };
        type ObjValue = { object_id: string; kind: string; usd: number | null };
        const coinCap: ListCap<Coin> = {
          budget: 1_500,
          rank: (a, b) => Math.abs(b.usd ?? -1) - Math.abs(a.usd ?? -1),
          usd: (c) => (c.usd === null ? null : Math.abs(c.usd)),
          brief: (c) => ({ coin_type: c.coin_type, amount: c.amount, usd: c.usd }),
        };
        const { payload: capped } = capPayload(
          "analyze_attack_tx",
          { digest, attacker },
          payload,
          {
            swaps: { budget: 8_000, keepOrder: true, keep: (r: Row) => r.pool !== null && named.has(r.pool) } satisfies ListCap<Row>,
            // Per-row lists first: a list cap renumbers the rows after it.
            ...Object.fromEntries(addresses.map((_, i) => [`addresses.${i}.coins`, coinCap])),
            addresses: {
              budget: 6_000,
              keep: (a: Addr) => a.role === "sender" || a.address === who || a.label !== undefined || named.has(a.address),
              usd: (a: Addr) => Math.abs(a.usd_net),
              brief: (a: Addr) => ({ address: a.address, usd_net: a.usd_net }),
            } satisfies ListCap<Addr>,
            "profit.losses": { ...coinCap, budget: 3_000 },
            object_values_unread: { budget: 2_000, keepOrder: true, brief: (u: { what: string }) => u.what } satisfies ListCap<{ what: string }>,
            object_values: {
              budget: 4_000,
              usd: (r: ObjValue) => r.usd,
              brief: (r: ObjValue) => ({ object_id: r.object_id, kind: r.kind, usd: r.usd }),
            } satisfies ListCap<ObjValue>,
            "profit.unpriced_coins": { budget: 1_000, keepOrder: true },
            pool_flows: {
              budget: 6_000,
              keep: (f: Flow) => named.has(f.pool),
              rank: (a: Flow, b: Flow) => a.usd_net - b.usd_net,
              usd: (f: Flow) => Math.abs(f.usd_net),
              brief: (f: Flow) => ({ pool: f.pool, pool_type: f.pool_type, usd_net: f.usd_net }),
            } satisfies ListCap<Flow>,
            "state_deltas.drops": {
              budget: 5_000,
              keepOrder: true,
              keep: (d: Drop) => leadDrops.has(d),
              brief: (d: Drop) => ({ holder: d.holder, coin_type: d.coin_type, before: d.before, after: d.after }),
            } satisfies ListCap<Drop>,
            "state_deltas.objects_read": { budget: 1_200, keepOrder: true, brief: (o: Obj) => o.object_id } satisfies ListCap<Obj>,
            "state_deltas.skipped": { budget: 1_000, keepOrder: true, brief: (o: Obj) => o.object_id } satisfies ListCap<Obj>,
            "value_reconciliation.unexplained": { budget: 2_000, usd: (u: Coin) => u.usd } satisfies ListCap<Coin>,
            unpriced: { budget: 1_200, keepOrder: true },
          },
          { full: detail === "full", next_call: { tool: "analyze_attack_tx", repeat_with: { detail: "full" } } },
        );
        return {
          content: [
            { type: "text" as const, text: lines.join("\n") },
            { type: "text" as const, text: JSON.stringify(capped) },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "summarize_incident_losses",
    "(Incident investigation) Total what an attacker took across many transactions, grouped by the pool or vault each one drained, in USD at the time of the attack. Give the exploit digests, or a sender and a window. For each group: the attacker's net per coin, the pool's own reserve change from its events (or, when no event of the transaction decodes into amounts, from the drained objects' Balance<T> holdings at its input and output versions), and the USD of both. Coins the attacker sent on to other addresses, in a coin that moved only between addresses in that transaction, are listed under transfers_out and kept out of the take. Totals come with the coins that could not be priced listed separately, so the figure is stated as a lower bound when any are. The default view lists what fits about 40k characters, largest first, and `omitted` states the rest; detail: 'full' lists every row. Needs no API key. Reads every transaction over gRPC with archive fallback.",
    {
      digests: z
        .array(z.string())
        .min(1)
        .max(1000)
        .optional()
        .describe("Exploit transaction digests (Base58). Duplicates are collapsed."),
      sender: z
        .string()
        .optional()
        .describe("Read every transaction this address sent inside the window instead of a digest list."),
      start: z
        .union([numArg(), z.string()])
        .superRefine(refinePoint)
        .optional()
        .describe("Window start with `sender`: a checkpoint number or ISO 8601 time. Inclusive."),
      end: z
        .union([numArg(), z.string()])
        .superRefine(refinePoint)
        .optional()
        .describe("Window end with `sender`: a checkpoint number or ISO 8601 time. Inclusive."),
      max_transactions: numArg()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Cap on transactions read in `sender` mode (default 1000, the most). Hitting it is reported."),
      attacker: z
        .string()
        .optional()
        .describe("Address whose gains to total. Defaults to `sender`, or to each transaction's sender, unless every successful transaction's sender only paid gas: then it defaults to the largest PRICED gainer over the gas-only threshold across the same transactions instead, reported in attacker_defaulted_from_sender. A gain in an unpriced coin by any non-sender other than that gainer blocks this default; pass \"attacker\" to name a different address."),
      price_at: z
        .union([numArg(), z.string()])
        .superRefine(refinePoint)
        .optional()
        .describe("Price every coin and object at this moment (Unix seconds or ISO 8601). Without it coins are priced at the first successful transaction's time, before prices reacted, and each moved object at its own transaction's time."),
      max_groups: numArg()
        .int()
        .min(1)
        .optional()
        .describe("List only the largest N groups; the totals still cover all of them and the omission is reported."),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default): each list keeps what fits about 40k characters in all, largest first; totals cover every row, and `omitted` states each list's count, USD and largest row with the call that returns them. 'full': every row of every list."),
    },
    async ({ digests, sender, start, end, max_transactions, attacker, price_at, max_groups, detail }) => {
      try {
        if (!digests && !sender) return errorResult("Give `digests`, or `sender` with an optional window.");
        if (digests && sender) return errorResult("Give `digests` or `sender`, not both.");
        if (digests && (start !== undefined || end !== undefined)) {
          return errorResult("`start` and `end` bound the `sender` window. With `digests`, every listed transaction is read, so drop them.");
        }
        const senderId = sender ? canonicalId(sender) : null;
        if (sender && !senderId) return errorResult(`'${sender}' is not a Sui address.`);
        const attackerId = attacker ? canonicalId(attacker) : senderId;
        if (attacker && !attackerId) return errorResult(`'${attacker}' is not a Sui address.`);
        const priceAt = parseAt(price_at);
        if (priceAt === "invalid") return errorResult("Invalid `price_at`. Use Unix seconds or ISO 8601.");
        const maxTransactions = max_transactions ?? 1000;

        let list: string[];
        let invalid: string[] = [];
        let window: Record<string, unknown> | null = null;
        let truncated = false;
        if (digests) {
          const uniq = [...new Set(digests.map(normalizeDigest))];
          invalid = uniq.filter((d) => !isDigest(d));
          list = uniq.filter((d) => isDigest(d));
        } else {
          // Times resolve to the checkpoints either side of the moment, so the
          // window holds exactly the checkpoints stamped inside it. A checkpoint
          // number is inclusive, and the filter's bounds are exclusive.
          const w = await resolveWindow(start, end);
          const afterCp =
            w.after?.checkpoint == null ? null : w.after.resolved_from === "checkpoint" ? Math.max(0, w.after.checkpoint - 1) : w.after.checkpoint;
          const beforeCp =
            w.before?.checkpoint == null ? null : w.before.resolved_from === "checkpoint" ? w.before.checkpoint + 1 : w.before.checkpoint;
          const r = await digestsSentBy(
            senderId!,
            {
              ...(afterCp !== null ? { afterCheckpoint: afterCp } : {}),
              ...(beforeCp !== null ? { beforeCheckpoint: beforeCp } : {}),
            },
            maxTransactions,
          );
          list = r.digests;
          truncated = r.truncated;
          window = { from: start ?? null, to: end ?? null, after_checkpoint: afterCp, before_checkpoint: beforeCp };
        }
        if (list.length === 0) return errorResult("No transactions to read.");

        const read = await readAttackTransactions(list);
        const [{ protocolOf, unread: custodySkipped }, stateRead] = await Promise.all([prefetchFor(read.txs), readStateLosses(read.txs)]);
        let agg = aggregateIncident(read.txs, attackerId ?? undefined, stateRead.losses);

        const firstOk = read.txs
          .filter((t) => t.success && t.timestampMs !== null)
          .reduce<number | null>((m, t) => (m === null || t.timestampMs! < m ? t.timestampMs! : m), null);
        const atSec = priceAt ?? (firstOk !== null ? Math.floor(firstOk / 1000) : Math.floor(Date.now() / 1000));

        // Every coin any address received across these transactions, not only
        // the chosen subject's: with no attacker given, the subject defaults
        // to each transaction's sender, and a sender that only paid gas never
        // touches the coins the real beneficiary gained, so pricing keyed to
        // `agg` alone would leave that beneficiary permanently unpriced.
        const coins = new Set<string>();
        for (const tx of read.txs) for (const b of tx.balanceChanges) if (b.coinType) coins.add(b.coinType);
        for (const loss of stateRead.losses.values()) for (const c of loss.deltas.keys()) coins.add(c);
        for (const g of agg.groups) for (const c of g.pool_deltas.keys()) if (isCoinTypeKey(c)) coins.add(c);
        const successfulTxs = read.txs.filter((t) => t.success);
        const [prices, , txObjects] = await Promise.all([
          priceUsdAtTime([...coins], atSec),
          prefetchCoinScale(coins),
          // Objects are read at each transaction's checkpoint.
          valueTransactionObjects(
            // Specific readers only: NFT estimates stay out of the totals,
            // and their market reads cost far more per object than the rest.
            successfulTxs.map((t) => ({ digest: t.digest, checkpoint: t.checkpoint, moved: movedObjectsOf(t, true) })),
            { maxTxs: MAX_OBJECT_VALUE_TXS, maxObjects: SCAN_OBJECT_BUDGET },
            // Each object at its own transaction's time unless price_at
            // names one moment: a drainer campaign runs over days, and the
            // first drain's prices misstate the later ones.
            priceAt ?? undefined,
          ),
        ]);
        const objectsByTx = new Map<string, Map<string, AddressObjectValue>>();
        for (const digest of new Set(txObjects.rows.map((r) => r.digest))) {
          objectsByTx.set(digest, objectValueByAddress(txObjects.rows.filter((r) => r.digest === digest)));
        }

        // No attacker was named, and the sender-per-transaction default looks
        // like it only paid gas: default to whoever gained the most across
        // these same transactions instead of reporting near-zero for
        // everyone. Excludes every address `agg` already used as a sender,
        // since a key compromise's signer is never its own beneficiary.
        // Decided from every successful transaction's own sender deltas, not
        // the cross-transaction net: `agg.totals` nets a drain against a
        // later forward of the same funds across transactions, which reads
        // a sender that moved real money as "only paid gas".
        let defaultedFrom: { address: string; senders: string[]; sender_usd_net: number } | undefined;
        let unpricedGainers: Array<{
          address: string;
          unpriced_coins: Array<{ coin_type: string; symbol: string; amount: number }>;
          unpriced_objects?: Array<{ object_id: string; type: string }>;
        }> = [];
        let sendersGaveAway = false;
        if (!attacker) {
          // Each sender either paid gas and nothing else, or took nothing
          // priced (in coins or valued objects) while giving valued objects
          // away, as the signer of a victim-signed drain does.
          const tookNothing = successfulTxs.map((tx) => {
            const sender = canonicalId(tx.sender);
            const coinsOf = sender ? netByAddress(tx.balanceChanges).get(sender) : undefined;
            const objs = sender ? objectsByTx.get(tx.digest)?.get(sender) : undefined;
            if (isGasOnly(coinsOf, prices.points, GAS_ONLY_USD_THRESHOLD) && !movedPricedObjects(objs)) return "gas" as const;
            const v = valueDeltas(coinsOf ?? new Map(), prices.points);
            const gaveAway =
              v.usd_gained + (objs?.usd_gained ?? 0) < GAS_ONLY_USD_THRESHOLD &&
              (objs?.usd_net ?? 0) <= -GAS_ONLY_USD_THRESHOLD &&
              !takesUnpricedValue(v.coins, objs);
            return gaveAway ? ("gave" as const) : null;
          });
          if (tookNothing.every((t) => t !== null)) {
            sendersGaveAway = tookNothing.includes("gave");
            const byAddress = new Map<string, Map<string, bigint>>();
            for (const tx of successfulTxs) {
              for (const [address, deltas] of netByAddress(tx.balanceChanges)) {
                if (agg.senders.includes(address)) continue;
                const existing = byAddress.get(address);
                if (existing) addDeltas(existing, deltas);
                else byAddress.set(address, new Map(deltas));
              }
            }
            // Coins a transaction's own sender paid out: a gainer of one
            // took part of what that sender gave.
            const sendersPaid = new Set<string>();
            for (const tx of successfulTxs) {
              const sender = canonicalId(tx.sender);
              for (const [coin, v] of (sender ? netByAddress(tx.balanceChanges).get(sender) : undefined) ?? []) if (v < 0n) sendersPaid.add(coin);
            }
            const objectsBy = objectValueByAddress(txObjects.rows);
            for (const address of objectsBy.keys()) if (!agg.senders.includes(address) && !byAddress.has(address)) byAddress.set(address, new Map());
            const valued = [...byAddress].map(([address, deltas]) => {
              const v = valueDeltas(deltas, prices.points);
              const o = objectsBy.get(address);
              return { address, v, o, usd_net: v.usd_net + (o?.usd_net ?? 0) };
            });
            // A gain in a coin or object with no price must not be passed
            // over for a smaller priced gain elsewhere in the same set: a
            // drained vault's assets are often exactly the coins with no
            // price. The top priced gainer's own unpriced gains pass nobody
            // over.
            const top = valued.filter((c) => c.usd_net >= GAS_ONLY_USD_THRESHOLD).sort((a, b) => b.usd_net - a.usd_net)[0];
            unpricedGainers = valued
              .filter((c) => c.address !== top?.address && takesUnpricedValue(c.v.coins, c.o, sendersPaid))
              .map((c) => ({
                address: c.address,
                unpriced_coins: c.v.coins
                  .filter((coin) => coin.usd === null && BigInt(coin.amount) > 0n)
                  .map((coin) => ({ coin_type: coin.coin_type, symbol: coin.symbol, amount: coin.amount_human })),
                ...(c.o?.gained.some((r) => r.usd === null)
                  ? { unpriced_objects: c.o.gained.filter((r) => r.usd === null).map((r) => ({ object_id: r.object_id, type: r.type })) }
                  : {}),
              }));
            if (unpricedGainers.length === 0 && top) {
              const senderObjects = [...objectsBy].filter(([a]) => agg.senders.includes(a)).reduce((s, [, o]) => s + o.usd_net, 0);
              defaultedFrom = {
                address: top.address,
                senders: agg.senders,
                sender_usd_net: Number((valueDeltas(agg.totals, prices.points).usd_net + senderObjects).toFixed(2)),
              };
              agg = aggregateIncident(read.txs, top.address, stateRead.losses);
            }
          }
        }
        const sendersAside = sendersGaveAway
          ? "took nothing priced (only coins a third-party scam list flags, if any) while paying gas or giving valued objects away"
          : "only paid gas";

        // The attacker's objects: received ones count as gains, ones it
        // consumed (deleted) as losses, and ones it handed to another
        // address are moving value on, kept out of the totals as coins sent
        // on are. Each object is netted across the incident, as coins are
        // per coin type, so a stake received and later unstaked counts once,
        // as the coins the unstake paid. Objects wrapped, unwrapped or from
        // an unknown holder are listed under "custody" and never counted.
        const txById = new Map(read.txs.map((t) => [t.digest, t]));
        const subjectOf = (digest: string) => defaultedFrom?.address ?? attackerId ?? canonicalId(txById.get(digest)?.sender);
        const objectRows: Array<
          ReturnType<typeof objectRow> & { digest: string; direction: "in" | "consumed" | "sent_on" | "changed" | "custody"; to?: string }
        > = [];
        const legsByObject = new Map<string, Array<{ signed: number; sign: 1 | -1; coins: MovedObjectValue["coin_amounts"] }>>();
        let objectsSentOn = 0;
        let objectsEstimate = 0;
        let objectsUnpriced = 0;
        for (const r of txObjects.rows) {
          const subject = subjectOf(r.digest);
          if (!subject) continue;
          const direction = r.custody
            ? r.to === subject || r.from === subject
              ? "custody"
              : null
            : r.changed_in_place
              ? r.to === subject
                ? "changed"
                : null
              : r.to === subject
                ? "in"
                : r.from === subject
                  ? r.to
                    ? "sent_on"
                    : "consumed"
                  : null;
          if (!direction) continue;
          objectRows.push({
            // Methods stay in the reader's object_values of analyze_attack_tx; an incident lists many rows.
            ...objectRow(r, direction === "consumed" || direction === "sent_on" ? -1 : 1, false),
            digest: r.digest,
            direction,
            ...(direction === "sent_on" ? { to: r.to! } : {}),
          });
          if (direction === "custody") continue;
          if (direction === "sent_on") {
            if (r.usd !== null && !r.estimate) objectsSentOn += r.usd;
            continue;
          }
          // A kept object's change is signed already.
          const signed = r.usd === null ? null : direction === "consumed" ? -r.usd : r.usd;
          if (signed === null) objectsUnpriced++;
          else if (r.estimate) objectsEstimate += signed;
          else {
            const rowsOf = legsByObject.get(r.object_id) ?? [];
            rowsOf.push({ signed, sign: direction === "consumed" ? -1 : 1, coins: r.coin_amounts });
            legsByObject.set(r.object_id, rowsOf);
          }
        }
        // An object seen in several transactions (received, then unstaked or
        // closed) is netted by its amounts at one price, the first row's, so
        // the price moving between the two does not leave value behind that
        // the coins it paid out, all priced at one moment, cancel against.
        const netByObject = new Map<string, number>();
        for (const [id, rowsOf] of legsByObject) {
          const coinOf = (c: MovedObjectValue["coin_amounts"]) => (c && c.length === 1 ? c[0] : null);
          const first = coinOf(rowsOf[0].coins);
          const oneCoin =
            rowsOf.length > 1 && first !== null && BigInt(first.amount) !== 0n && rowsOf.every((x) => coinOf(x.coins)?.coin_type === first.coin_type);
          if (!oneCoin) {
            netByObject.set(id, rowsOf.reduce((t, x) => t + x.signed, 0));
            continue;
          }
          const unit = Math.abs(rowsOf[0].signed) / Math.abs(Number(first!.amount));
          const net = rowsOf.reduce((t, x) => t + x.sign * Number(coinOf(x.coins)!.amount), 0);
          netByObject.set(id, net * unit);
        }
        let objectsGained = 0;
        let objectsConsumed = 0;
        for (const net of netByObject.values()) {
          if (net > 0) objectsGained += net;
          else objectsConsumed -= net;
        }
        const objectsUnread = txObjects.unread.length + txObjects.skipped.length;
        objectRows.sort((a, b) => Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0));

        const perCoin = (v: ValuedDeltas) =>
          Object.fromEntries(v.coins.map((c) => [c.coin_type, [c.amount_human, c.usd]]));
        const allGroups = agg.groups
          .map((g) => {
            const a = valueDeltas(g.attacker_deltas, prices.points);
            const p = valueDeltas(g.pool_deltas, prices.points);
            const poolUsd = Number((p.usd_net - (g.recorded_loss_usd ?? 0)).toFixed(2));
            const unpricedHere = new Set([...a.unpriced, ...p.unpriced]).size;
            const scamListed = g.pool_type !== null && guardiansFlagsForObjectType(g.pool_type).length > 0;
            return {
              pools: g.pools,
              protocol: protocolOf(packageOfEventType(g.pool_type)),
              ...(scamListed ? { pool_type_scam_listed: true } : {}),
              ...(g.basis === "state" ? { pool_basis: "state" } : {}),
              transaction_count: g.digests.length,
              transactions: g.digests,
              attacker_usd: a.usd_net,
              pool_usd: poolUsd,
              ...(unpricedHere ? { unpriced_coins: unpricedHere } : {}),
              attacker: perCoin(a),
              pool: perCoin(p),
              ...(g.recorded_loss_usd
                ? {
                    recorded_loss_usd: Number(g.recorded_loss_usd.toFixed(2)),
                    recorded_loss_note: "At least one of these pools states its USD value change directly, from its own event, rather than a coin amount; it is folded into pool_usd above and not itemised in `pool`.",
                  }
                : {}),
            };
          })
          .sort((x, y) => Math.max(y.attacker_usd, -y.pool_usd) - Math.max(x.attacker_usd, -x.pool_usd));
        const groups = max_groups ? allGroups.slice(0, max_groups) : allGroups;
        const rankedGroups = allGroups.filter((g) => !g.pool_type_scam_listed && (g.attacker_usd !== 0 || g.pool_usd !== 0));

        const coinTotal = valueDeltas(agg.totals, prices.points);
        // The attacker's totals count the objects it received or consumed.
        const total = {
          ...coinTotal,
          usd_gained: Number((coinTotal.usd_gained + objectsGained).toFixed(2)),
          usd_net: Number((coinTotal.usd_net + objectsGained - objectsConsumed).toFixed(2)),
        };
        const poolLossUsd = allGroups.reduce((s, g) => s + Math.min(0, g.pool_usd), 0);
        const unpricedBy = new Map(prices.unpriced.map((u) => [u.coin_type, u]));
        const netOf = new Map(total.coins.map((c) => [c.coin_type, c]));
        // Only the final attacker's own coins and the pools' reserve coins,
        // not every coin any address touched across every transaction: the
        // wide set above exists only to price the default candidates, and
        // using it here mislabels a fully priced attacker total as a lower
        // bound and lists irrelevant counterparties' coins.
        const rowCoins = new Set<string>(agg.totals.keys());
        for (const g of agg.groups) for (const c of g.pool_deltas.keys()) if (isCoinTypeKey(c)) rowCoins.add(c);
        const coinRows = [...rowCoins].map((coinType) => {
          const t = netOf.get(coinType);
          const coin = displayCoin(coinType);
          return {
            coin_type: coinType,
            symbol: coin.symbol,
            verified: coin.verified,
            attacker_net: t?.amount_human ?? 0,
            attacker_net_raw: t?.amount ?? "0",
            decimals_source: t?.decimals_source ?? pricingScale(coinType, prices.points.get(coinType)).source,
            usd: t?.usd ?? null,
          };
        });
        const pricedCoins = coinRows.filter((c) => prices.points.has(c.coin_type)).sort((a, b) => Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0));
        const unpricedRemainder = coinRows
          .filter((c) => !prices.points.has(c.coin_type))
          .map(({ usd: _usd, ...c }) => ({ ...c, reason: unpricedBy.get(c.coin_type)?.reason ?? "No price." }));
        const lowerBound = unpricedRemainder.length > 0 || objectsUnpriced > 0 || objectsUnread > 0;

        // Transfers out, one row per coin and set of recipients.
        const sentRows = new Map<string, { coin: string; to: Map<string, bigint>; amount: bigint; digests: string[] }>();
        for (const t of agg.transfers_out) {
          const key = `${t.coin} ${t.to.map((r) => r.address).sort().join(",")}`;
          const row = sentRows.get(key) ?? { coin: t.coin, to: new Map<string, bigint>(), amount: 0n, digests: [] };
          row.amount += t.amount;
          row.digests.push(t.digest);
          for (const r of t.to) row.to.set(r.address, (row.to.get(r.address) ?? 0n) + r.amount);
          sentRows.set(key, row);
        }
        const transfersOut = [...sentRows.values()]
          .map((row) => {
            const v = valueDeltas(new Map([[row.coin, row.amount]]), prices.points).coins[0];
            return {
              to: [...row.to].map(([address, amount]) => ({ address, amount: amount.toString() })),
              coin_type: row.coin,
              symbol: v.symbol,
              amount: v.amount_human,
              amount_raw: v.amount,
              usd: v.usd,
              transactions: row.digests,
            };
          })
          .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
        const sentUsd = Number(transfersOut.reduce((s, t) => s + (t.usd ?? 0), 0).toFixed(2));
        const sentUnpriced = transfersOut.filter((t) => t.usd === null).length;
        const recipients = new Set(transfersOut.flatMap((t) => t.to.map((r) => r.address)));

        const lines = [
          `${read.txs.length} transaction(s) read${read.missing.length ? `, ${read.missing.length} not found` : ""}` +
            `${agg.failed.length ? `, ${agg.failed.length} failed` : ""}. ${allGroups.length} pool group(s).`,
          ...(unpricedGainers.length > 0
            ? [
                `No attacker given: the sender(s) ${sendersAside} across these transactions, but ${unpricedGainers.length === 1 ? "one address gained" : `${unpricedGainers.length} addresses gained`} a coin or object with no price, so the sender(s) are kept rather than guessing from priced gains alone. See unpriced_gain_candidates.`,
              ]
            : defaultedFrom
              ? [
                  `No attacker given: ${defaultedFrom.senders.join(", ")} ${sendersAside} across these transactions (net ${formatUsd(defaultedFrom.sender_usd_net)}), so ${defaultedFrom.address} is used instead as the largest gainer. Pass "attacker" to name a different address.`,
                ]
              : []),
          `Attacker gains at ${new Date(atSec * 1000).toISOString()}: ${formatUsd(total.usd_gained)} across ${pricedCoins.length} priced coin(s)` +
            (objectsGained > 0 ? ` and valued objects (${formatUsd(objectsGained)})` : "") +
            (lowerBound
              ? `; ${unpricedRemainder.length} more coin(s) and ${objectsUnpriced} object(s) have no price${objectsUnread ? `, and ${objectsUnread} object(s) or transaction(s) were not valued` : ""}, so this is a lower bound.`
              : "."),
          ...(objectRows.length
            ? [
                `Objects: received ${formatUsd(objectsGained)}, consumed ${formatUsd(objectsConsumed)}, sent on ${formatUsd(objectsSentOn)} (kept out of the totals)` +
                  (objectsEstimate ? `, NFT estimates ${formatUsd(objectsEstimate)} (kept out of the totals)` : "") +
                  ". See objects.",
              ]
            : []),
          ...(transfersOut.length
            ? [
                `Sent on to ${recipients.size} other address(es) in ${agg.transfers_out.length} transfer(s), kept out of the gains: ${formatUsd(sentUsd)}` +
                  (sentUnpriced ? ` plus ${sentUnpriced} unpriced coin row(s)` : "") +
                  `. Largest: ${transfersOut[0].amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${transfersOut[0].symbol} to ${transfersOut[0].to.map((r) => r.address).join(", ")}.`,
              ]
            : []),
          `Pool reserves lost, by their own events and holdings: ${formatUsd(-poolLossUsd)}.`,
          // Only groups that moved priced value, and none whose pool type a
          // scam list flags (an airdropped object an event happened to name).
          ...(rankedGroups.length ? ["Largest pools by attacker gain or pool loss:"] : ["No pool group moved priced value; see groups."]),
          ...rankedGroups.slice(0, 5).map(
            (g) =>
              `  ${g.pools.slice(0, 3).join(" + ")}${g.pools.length > 3 ? ` + ${g.pools.length - 3} more` : ""} ${g.protocol ? `(${g.protocol}) ` : ""}` +
              `attacker ${formatUsd(g.attacker_usd)}, pool ${formatUsd(g.pool_usd)}${g.pool_basis ? " by holdings" : ""}${g.unpriced_coins ? ` + ${g.unpriced_coins} unpriced coin(s)` : ""}`,
          ),
        ];
        if (truncated) lines.push(`⚠ Stopped at max_transactions=${maxTransactions}; the window holds more.`);
        if (stateRead.unread.length) lines.push(`⚠ ${stateRead.unread.length} transaction(s) past the state-read cap are grouped by their events only; see state_reads.`);

        const payload = {
          transactions_requested: list.length,
          transactions_read: read.txs.length,
          ...(read.served_by_archive ? { served_by_archive: read.served_by_archive } : {}),
          ...(invalid.length ? { invalid_digests: invalid } : {}),
          ...(read.missing.length ? { not_found: read.missing } : {}),
          ...(read.events_undecoded.length ? { events_undecoded: read.events_undecoded } : {}),
          ...(window ? { window, ...(truncated ? { window_truncated: true } : {}) } : {}),
          attacker: defaultedFrom?.address ?? attackerId ?? "each transaction's sender",
          ...(defaultedFrom
            ? {
                attacker_defaulted_from_sender: {
                  senders: defaultedFrom.senders,
                  senders_usd_net: defaultedFrom.sender_usd_net,
                  reason: `No "attacker" was given. ${defaultedFrom.senders.length === 1 ? "The sender" : "The senders"} ${sendersAside} across these transactions, so this address, the largest gainer across the same transactions, is used instead. Pass "attacker" to name a different address.`,
                },
              }
            : {}),
          ...(unpricedGainers.length > 0
            ? {
                unpriced_gain_candidates: unpricedGainers,
                unpriced_gain_candidates_note:
                  `The sender(s) ${sendersAside} across these transactions, but an address other than the largest priced gainer gained a coin or object with no price. Defaulting to the largest PRICED gainer risks naming a small fee wallet or referrer over the address that actually took the unpriced value, so \`attacker\` was kept as the sender instead. Investigate these candidates directly, or pass "attacker" to name one.`,
              }
            : {}),
          sender_count: agg.senders.length,
          senders: agg.senders,
          priced_at: new Date(atSec * 1000).toISOString(),
          evidence_tiers: EVIDENCE_TIERS,
          totals: {
            usd_gained: total.usd_gained,
            usd_net: total.usd_net,
            ...(objectRows.length
              ? {
                  objects_usd_gained: Number(objectsGained.toFixed(2)),
                  objects_usd_consumed: Number(objectsConsumed.toFixed(2)),
                  objects_sent_on_usd: Number(objectsSentOn.toFixed(2)),
                  ...(objectsEstimate ? { objects_estimate_usd_net: Number(objectsEstimate.toFixed(2)) } : {}),
                  ...(objectsUnpriced ? { objects_unpriced: objectsUnpriced } : {}),
                }
              : {}),
            ...(txObjects.skipped.length ? { objects_partial: true } : {}),
            pool_reserves_lost_usd: Number((-poolLossUsd).toFixed(2)),
            coins: coinRows.length,
            priced_coins: pricedCoins.length,
            ...(transfersOut.length ? { transfers_out_usd: sentUsd, transfers_out: agg.transfers_out.length } : {}),
            ...(lowerBound
              ? {
                  lower_bound: true,
                  lower_bound_note:
                    `${unpricedRemainder.length} of ${coinRows.length} coins${objectsUnpriced ? ` and ${objectsUnpriced} object(s)` : ""} have no price at ${new Date(atSec * 1000).toISOString()}, so the USD totals leave them out. Coins are listed with amounts in unpriced_remainder, objects in objects.` +
                    (objectsUnread ? ` ${objectsUnread} object(s) or transaction(s) were not valued at all (objects_unread, objects_skipped_transactions).` : ""),
                }
              : {}),
          },
          priced_coins: pricedCoins,
          unpriced_remainder: unpricedRemainder,
          ...(transfersOut.length
            ? {
                transfers_out: transfersOut,
                transfers_out_note:
                  "Coins the attacker paid to other addresses in a transaction where that coin moved only between addresses (every address's change in it sums to zero, and for SUI to minus the gas paid), so no pool or vault paid or took any. Moving value on is not a loss to the incident, so these are kept out of the totals and groups above; `to` lists every address that gained the coin in those transactions. Follow them with trace_funds or summarize_address_flows.",
              }
            : {}),
          ...(objectRows.length || txObjects.unread.length || txObjects.skipped.length
            ? {
                objects: objectRows,
                ...(txObjects.unread.length ? { objects_unread: txObjects.unread } : {}),
                ...(txObjects.skipped.length ? { objects_skipped_transactions: txObjects.skipped } : {}),
                objects_note:
                  `Non-coin objects the attacker received ("in", counted as gains), consumed ("consumed": deleted or wrapped, counted as losses), kept while the transaction changed their value ("changed", the signed change counted), or handed to another address ("sent_on", moving value on, kept out of the totals as coins sent on are), each valued by its reader at its transaction's checkpoint and priced ${priceAt !== null ? `at ${new Date(priceAt * 1000).toISOString()} (price_at)` : "at its own transaction's time"}; each row states its method. NFTs are not valued across many transactions; analyze_attack_tx values them one transaction at a time, as estimates.` +
                  (txObjects.skipped.length ? ` Objects of the ${txObjects.skipped.length} transaction(s) in objects_skipped_transactions, past the first ${MAX_OBJECT_VALUE_TXS} transactions or ${SCAN_OBJECT_BUDGET} objects, were not valued and are not in the totals; pass fewer digests to value them.` : ""),
              }
            : {}),
          ...(agg.failed.length ? { failed_transactions: agg.failed } : {}),
          ...(agg.unattributed.length
            ? {
                unattributed_transactions: agg.unattributed,
                unattributed_note: "These succeeded but named no pool in their events or changed objects, no holding of theirs fell, and they sent nothing on. Their balance changes are in the totals and in no pool group.",
              }
            : {}),
          ...(stateRead.read || stateRead.unread.length || stateRead.failed.length
            ? {
                state_reads: {
                  read: stateRead.read,
                  ...(stateRead.unread.length ? { unread: stateRead.unread } : {}),
                  ...(stateRead.failed.length ? { failed: stateRead.failed } : {}),
                  note: `Transactions no event decodes into pool amounts have their changed shared objects read at the input and output versions, and are grouped by the holders whose Balance<T> holdings fell (pool_basis "state"). At most ${MAX_STATE_READS} are read per call; the digests in unread were not, and their groups come from events alone. Pass them as digests to read them.`,
                },
              }
            : {}),
          groups_note:
            "A group is one pool, or the set of pools one transaction touched together, ranked by the larger of the attacker's gain and the pool's loss. `attacker` is the attacker's net balance change across the group's transactions and `pool` is the pools' reserve change from their own events (negative is what they lost), both as coin type -> [amount in whole tokens, USD or null when unpriced]. A group with pool_basis \"state\" read `pool` from the holders' Balance<T> holdings at each transaction's input and output versions instead, because none of its events decoded into amounts.",
          ...(groups.length < allGroups.length
            ? {
                groups_omitted: allGroups.length - groups.length,
                groups_omitted_note: `You set max_groups=${max_groups}, so only the largest groups are listed. The totals above still include every group.`,
              }
            : {}),
          groups,
          ...custodySkippedNote(custodySkipped),
          prices: priceTable(prices, atSec),
        };

        // A group row lists its first transactions; transaction_count and
        // the stored full view carry every one.
        const shownGroups = groups.map((g) =>
          g.transactions.length > GROUP_DIGESTS ? { ...g, transactions: g.transactions.slice(0, GROUP_DIGESTS) } : g,
        );
        type Group = (typeof groups)[number];
        type Unpriced = (typeof unpricedRemainder)[number];
        type Sent = (typeof transfersOut)[number];
        const args = { digests, sender, start, end, max_transactions, attacker, price_at, max_groups };
        const { payload: capped } = capPayload(
          "summarize_incident_losses",
          args,
          detail === "full" ? payload : { ...payload, groups: shownGroups },
          {
            groups: {
              budget: 14_000,
              usd: (g: Group) => Math.max(g.attacker_usd, -g.pool_usd),
              brief: (g: Group) => ({ pools: g.pools, attacker_usd: g.attacker_usd, pool_usd: g.pool_usd, transaction_count: g.transaction_count }),
            } satisfies ListCap<Group>,
            priced_coins: { budget: 5_000, usd: (c: { usd: number | null }) => (c.usd === null ? null : Math.abs(c.usd)) } satisfies ListCap<{ usd: number | null }>,
            // A gain the attacker kept ranks ahead of a coin it spent, and a
            // coin a curated list vouches for ahead of one anyone can mint.
            unpriced_remainder: {
              budget: 6_000,
              rank: (a: Unpriced, b: Unpriced) =>
                Number(BigInt(b.attacker_net_raw) > 0n) - Number(BigInt(a.attacker_net_raw) > 0n) || Number(b.verified === true) - Number(a.verified === true),
              brief: (c: Unpriced) => ({ coin_type: c.coin_type, symbol: c.symbol, attacker_net: c.attacker_net }),
            } satisfies ListCap<Unpriced>,
            transfers_out: {
              budget: 5_000,
              usd: (t: Sent) => t.usd,
              brief: (t: Sent) => ({ to: t.to.map((r) => r.address), symbol: t.symbol, amount: t.amount, usd: t.usd }),
            } satisfies ListCap<Sent>,
            senders: { budget: 2_000, keepOrder: true },
            "attacker_defaulted_from_sender.senders": { budget: 1_000, keepOrder: true },
            unattributed_transactions: { budget: 2_000, keepOrder: true },
            failed_transactions: { budget: 2_000, keepOrder: true },
            not_found: { budget: 1_000, keepOrder: true },
            events_undecoded: { budget: 1_000, keepOrder: true },
            "state_reads.unread": { budget: 1_000, keepOrder: true },
            objects: {
              budget: 3_000,
              usd: (r: { usd: number | null }) => (r.usd === null ? null : Math.abs(r.usd)),
              brief: (r: { object_id: string; direction: string; usd: number | null }) => ({ object_id: r.object_id, direction: r.direction, usd: r.usd }),
            } satisfies ListCap<{ object_id: string; direction: string; usd: number | null }>,
            objects_skipped_transactions: { budget: 1_000, keepOrder: true },
            objects_unread: { budget: 2_000, keepOrder: true, brief: (u: { what: string }) => u.what } satisfies ListCap<{ what: string }>,
            // One price per priced coin; the coins the attacker's total
            // moved most rank first.
            prices: {
              budget: 5_000,
              rank: (a: { coin_type: string }, b: { coin_type: string }) => Math.abs(netOf.get(b.coin_type)?.usd ?? 0) - Math.abs(netOf.get(a.coin_type)?.usd ?? 0),
              brief: (p: { coin_type: string }) => p.coin_type,
            } satisfies ListCap<{ coin_type: string }>,
          },
          {
            full: detail === "full",
            stored: payload,
            next_call: { tool: "summarize_incident_losses", repeat_with: { detail: "full" } },
          },
        );
        return {
          content: [
            { type: "text" as const, text: lines.join("\n") },
            // Compact: an incident runs to hundreds of groups, and indentation
            // alone is a large share of the payload.
            { type: "text" as const, text: JSON.stringify(capped) },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
