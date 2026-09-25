import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { numArg, refinePoint } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { isDigest, invalidDigestMessage, normalizeDigest } from "../utils/digest.js";
import { prefetchProtocolNames, lookupProtocolDisplay } from "../protocols/registry.js";
import { packageOfEventType } from "../utils/event-json.js";
import { flagPtbAnomalies, type FormattedCommand } from "../utils/ptb-anomalies.js";
import { getLabel } from "../utils/labels.js";
import { resolveWindow } from "../utils/checkpoint-time.js";
import {
  displayCoin,
  formatUsd,
  priceUsdAtTime,
  pricingScale,
  PRICE_STALE_THRESHOLD_SEC,
  type HistoricalPrices,
} from "../utils/valuation.js";
import {
  aggregateIncident,
  canonicalId,
  netByAddress,
  oracleTouches,
  pairFlashLegs,
  poolFlows,
  readSwap,
  shortEventType,
  typeArgsOf,
  valueDeltas,
  type AttackTx,
  type ValuedDeltas,
} from "../utils/attack-analysis.js";
import { digestsSentBy, readAttackTransactions } from "../utils/attack-read.js";

const EVIDENCE_TIERS = {
  "chain-derived":
    "Read from the transaction: balance changes, and pool reserve changes decoded from the pool's own events.",
  "price-provider":
    "USD is DefiLlama's or Pyth's price at the stated time, a third-party figure. Coins without one are listed, never valued at zero.",
  heuristic:
    "Matched on function and event names: flash legs, oracle touches and anomaly flags. A lead to check against the calls, not a finding on its own.",
};

/** The protocol a package belongs to, by curated registry or MVR name. */
const protocolOf = (pkg: string | null) => (pkg ? lookupProtocolDisplay(pkg)?.name ?? null : null);

async function prefetchFor(txs: AttackTx[]): Promise<void> {
  const pkgs = new Set<string>();
  for (const tx of txs) {
    for (const c of tx.calls) pkgs.add(c.package);
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
}

/** The per-coin price table a response carries once, instead of per row. */
function priceTable(prices: HistoricalPrices, atSec: number) {
  return [...prices.points].map(([coin_type, p]) => {
    const offset = p.publishTime - atSec;
    return {
      coin_type,
      price_usd: p.price,
      source: p.source,
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
    "(Incident investigation) Break down one exploit transaction: who gained or lost what, per address and coin, in USD at block time; flash-loan and flash-swap legs paired borrow to repay; each swap's pool price before and after, where the DEX event carries it; what each pool gained or lost, from its own events; oracle calls and updates inside the PTB; anomaly flags; and the attacker's profit. Reads the whole transaction over gRPC with archive fallback, so a PTB with hundreds of commands and events is read completely. USD needs no API key (DefiLlama; Pyth for verified coins when PYTH_API_KEY is set) and every coin without a price is listed. Flash legs, oracle touches and anomalies are name-matched and tagged heuristic.",
    {
      digest: z.string().describe("Transaction digest (Base58)"),
      attacker: z
        .string()
        .optional()
        .describe("Address whose profit to summarise. Defaults to the transaction's sender."),
    },
    async ({ digest: rawDigest, attacker }) => {
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
        await prefetchFor([tx]);

        const who = subject ?? canonicalId(tx.sender);
        const net = netByAddress(tx.balanceChanges);
        const flows = poolFlows(tx);
        const coins = new Set<string>(tx.balanceChanges.map((b) => b.coinType));
        for (const f of flows) for (const c of f.deltas.keys()) if (c.includes("::")) coins.add(c);
        const atSec = tx.timestampMs !== null ? Math.floor(tx.timestampMs / 1000) : Math.floor(Date.now() / 1000);
        const prices = await priceUsdAtTime([...coins], atSec);

        const addresses = [...net]
          .map(([address, deltas]) => {
            const v = valueDeltas(deltas, prices.points);
            const label = getLabel(address);
            return {
              address,
              ...(address === canonicalId(tx.sender) ? { role: "sender" } : {}),
              ...(label ? { label: label.label, label_source: label.source } : {}),
              usd_net: v.usd_net,
              coins: v.coins,
              ...(v.unpriced.length ? { unpriced_coins: v.unpriced.length } : {}),
            };
          })
          .sort((a, b) => Math.abs(b.usd_net) - Math.abs(a.usd_net));

        const mine = valueDeltas(who ? net.get(who) ?? new Map() : new Map(), prices.points);
        const gains = mine.coins.filter((c) => BigInt(c.amount) > 0n);
        const losses = mine.coins.filter((c) => BigInt(c.amount) < 0n);

        const typeById = new Map(tx.objects.map((o) => [canonicalId(o.objectId), o.objectType]));
        const readSwaps = tx.events.map((e) => readSwap(e)).filter((s): s is NonNullable<typeof s> => s !== null);
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
            const poolType = s.pool ? typeById.get(s.pool) ?? null : null;
            const args = poolType ? typeArgsOf(poolType) : [];
            const [coinIn, coinOut] = s.a_to_b === null || args.length < 2 ? [null, null] : s.a_to_b ? [args[0], args[1]] : [args[1], args[0]];
            return {
              ...s,
              protocol: protocolOf(packageOfEventType(tx.events[s.event].type)),
              coin_in: coinIn,
              coin_out: coinOut,
            };
          });

        const legs = pairFlashLegs(tx.calls, tx.events).map((l) => ({
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
            usd_net: v.usd_net,
            deltas: v.coins,
            events: f.events,
            ...(f.undecoded_events.length ? { undecoded_events: f.undecoded_events } : {}),
          };
        });

        const commands: FormattedCommand[] = tx.commandKinds.map((kind, i) => {
          const call = tx.calls.find((c) => c.command === i);
          if (!call) return { type: kind };
          const protocol = protocolOf(call.package);
          return {
            type: "MoveCall",
            target: `${call.package}::${call.module}::${call.function}`,
            ...(protocol ? { protocol } : {}),
          };
        });
        const anomalies = flagPtbAnomalies(commands);
        const oracle = oracleTouches(tx.calls, tx.events);

        const lines: string[] = [];
        lines.push(
          `${digest} at ${tx.timestampMs ? new Date(tx.timestampMs).toISOString() : "unknown time"}, ${tx.success ? "success" : "FAILED"}: ` +
            `${tx.commandKinds.length} commands, ${tx.events.length} events, ${tx.balanceChanges.length} balance changes.`,
        );
        if (who) {
          lines.push(
            `Profit for ${who}: ${formatUsd(mine.usd_net)} net at block time` +
              (mine.unpriced.length ? `, plus ${mine.unpriced.length} unpriced coin(s), so this is a partial figure.` : "."),
          );
          for (const c of gains) {
            lines.push(`  +${c.amount_human.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${c.symbol}${c.verified === false ? " (unverified)" : ""} ${c.usd !== null ? formatUsd(c.usd) : "(unpriced)"}`);
          }
          for (const c of losses) {
            lines.push(`  ${c.amount_human.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${c.symbol}${c.verified === false ? " (unverified)" : ""} ${c.usd !== null ? formatUsd(c.usd) : "(unpriced)"}`);
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
          if (p.usd_net < 0) lines.push(`Pool ${p.pool} (${p.protocol ?? "unknown protocol"}) lost ${formatUsd(-p.usd_net)} by its own events.`);
        }
        if (oracle.length) lines.push(`Oracle touches: ${oracle.map((o) => `${o.target.split("::").slice(1).join("::")} ×${o.count}`).join(", ")}.`);
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
                ...(mine.unpriced.length
                  ? {
                      unpriced_coins: mine.unpriced,
                      partial_note: "At least one coin this address gained or lost has no price, so usd_net covers only the priced coins.",
                    }
                  : {}),
                note: "Net of gas: the sender's SUI change includes the fee it paid.",
              }
            : null,
          addresses,
          flash_legs: legs,
          swaps,
          ...(undecodedSwaps.length
            ? {
                undecoded_swaps: undecodedSwaps,
                undecoded_swaps_note:
                  "Swap events whose fields name no pool, direction or amounts in a form read here. Their decoded fields are in get_transaction.",
              }
            : {}),
          swap_price_note:
            "price_before/price_after are the pool's own price as raw coin B per raw coin A, from the event's sqrt price (Q64.64) or tick. price_change_pct is unit-free. Null where the event does not carry the price on both sides.",
          pool_flows: poolRows,
          pool_flows_note:
            "Each pool's reserve change, summed from its swap, add-liquidity, remove-liquidity and fee events. Negative is what left the pool. Events naming a pool in a shape not read here are listed in undecoded_events.",
          oracle_activity: oracle.map((o) => ({ ...o, evidence_tier: "heuristic" })),
          anomalies: anomalies.map((a) => ({ ...a, evidence_tier: "heuristic" })),
          prices: priceTable(prices, atSec),
          ...(prices.unpriced.length ? { unpriced: prices.unpriced } : {}),
        };

        return {
          content: [
            { type: "text" as const, text: lines.join("\n") },
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "summarize_incident_losses",
    "(Incident investigation) Total what an attacker took across many transactions, grouped by the pool each one drained, in USD at the time of the attack. Give the exploit digests, or a sender and a window. For each pool: the attacker's net per coin, the pool's own reserve change from its events, and the USD of both. Totals come with the coins that could not be priced listed separately, so the figure is stated as a lower bound when any are. Needs no API key. Reads every transaction over gRPC with archive fallback.",
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
        .describe("Cap on transactions read in `sender` mode (default 500). Hitting it is reported."),
      attacker: z
        .string()
        .optional()
        .describe("Address whose gains to total. Defaults to `sender`, or to each transaction's sender."),
      price_at: z
        .union([numArg(), z.string()])
        .superRefine(refinePoint)
        .optional()
        .describe("Price every coin at this moment (Unix seconds or ISO 8601). Defaults to the first successful transaction's time, before prices reacted."),
      max_groups: numArg()
        .int()
        .min(1)
        .optional()
        .describe("UNSET BY DEFAULT: every pool group is listed. Set it to list only the largest N groups; the totals still cover all of them and the omission is reported."),
    },
    async ({ digests, sender, start, end, max_transactions, attacker, price_at, max_groups }) => {
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
            max_transactions ?? 500,
          );
          list = r.digests;
          truncated = r.truncated;
          window = { from: start ?? null, to: end ?? null, after_checkpoint: afterCp, before_checkpoint: beforeCp };
        }
        if (list.length === 0) return errorResult("No transactions to read.");

        const read = await readAttackTransactions(list);
        await prefetchFor(read.txs);
        const agg = aggregateIncident(read.txs, attackerId ?? undefined);

        const firstOk = read.txs
          .filter((t) => t.success && t.timestampMs !== null)
          .reduce<number | null>((m, t) => (m === null || t.timestampMs! < m ? t.timestampMs! : m), null);
        const atSec = priceAt ?? (firstOk !== null ? Math.floor(firstOk / 1000) : Math.floor(Date.now() / 1000));

        const coins = new Set<string>(agg.totals.keys());
        for (const g of agg.groups) {
          for (const c of g.attacker_deltas.keys()) coins.add(c);
          for (const c of g.pool_deltas.keys()) if (c.includes("::")) coins.add(c);
        }
        const prices = await priceUsdAtTime([...coins], atSec);

        const perCoin = (v: ValuedDeltas) =>
          Object.fromEntries(v.coins.map((c) => [c.coin_type, [c.amount_human, c.usd]]));
        const allGroups = agg.groups
          .map((g) => {
            const a = valueDeltas(g.attacker_deltas, prices.points);
            const p = valueDeltas(g.pool_deltas, prices.points);
            const unpricedHere = new Set([...a.unpriced, ...p.unpriced]).size;
            return {
              pools: g.pools,
              protocol: protocolOf(packageOfEventType(g.pool_type)),
              transactions: g.digests,
              attacker_usd: a.usd_net,
              pool_usd: p.usd_net,
              ...(unpricedHere ? { unpriced_coins: unpricedHere } : {}),
              attacker: perCoin(a),
              pool: perCoin(p),
            };
          })
          .sort((x, y) => y.attacker_usd - x.attacker_usd);
        const groups = max_groups ? allGroups.slice(0, max_groups) : allGroups;

        const total = valueDeltas(agg.totals, prices.points);
        const poolLossUsd = allGroups.reduce((s, g) => s + Math.min(0, g.pool_usd), 0);
        const unpricedBy = new Map(prices.unpriced.map((u) => [u.coin_type, u]));
        const netOf = new Map(total.coins.map((c) => [c.coin_type, c]));
        const coinRows = [...coins].map((coinType) => {
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
        const pricedCoins = coinRows.filter((c) => prices.points.has(c.coin_type)).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
        const unpricedRemainder = coinRows
          .filter((c) => !prices.points.has(c.coin_type))
          .map(({ usd: _usd, ...c }) => ({ ...c, reason: unpricedBy.get(c.coin_type)?.reason ?? "No price." }));
        const lowerBound = unpricedRemainder.length > 0;

        const lines = [
          `${read.txs.length} transaction(s) read${read.missing.length ? `, ${read.missing.length} not found` : ""}` +
            `${agg.failed.length ? `, ${agg.failed.length} failed` : ""}. ${allGroups.length} pool group(s).`,
          `Attacker gains at ${new Date(atSec * 1000).toISOString()}: ${formatUsd(total.usd_gained)} across ${pricedCoins.length} priced coin(s)` +
            (lowerBound ? `; ${unpricedRemainder.length} more coin(s) have no price, so this is a lower bound.` : "."),
          `Pool reserves lost, by their own events: ${formatUsd(-poolLossUsd)}.`,
          "Largest pools by attacker gain:",
          ...allGroups.slice(0, 10).map(
            (g) => `  ${g.pools.join(" + ")} ${g.protocol ? `(${g.protocol}) ` : ""}${formatUsd(g.attacker_usd)}${g.unpriced_coins ? ` + ${g.unpriced_coins} unpriced coin(s)` : ""}`,
          ),
        ];
        if (truncated) lines.push(`⚠ Stopped at max_transactions=${max_transactions ?? 500}; the window holds more.`);

        const payload = {
          transactions_requested: list.length,
          transactions_read: read.txs.length,
          ...(read.served_by_archive ? { served_by_archive: read.served_by_archive } : {}),
          ...(invalid.length ? { invalid_digests: invalid } : {}),
          ...(read.missing.length ? { not_found: read.missing } : {}),
          ...(read.events_undecoded.length ? { events_undecoded: read.events_undecoded } : {}),
          ...(window ? { window, ...(truncated ? { truncated: true } : {}) } : {}),
          attacker: attackerId ?? "each transaction's sender",
          senders: agg.senders,
          priced_at: new Date(atSec * 1000).toISOString(),
          evidence_tiers: EVIDENCE_TIERS,
          totals: {
            usd_gained: total.usd_gained,
            usd_net: total.usd_net,
            pool_reserves_lost_usd: Number((-poolLossUsd).toFixed(2)),
            coins: coinRows.length,
            priced_coins: pricedCoins.length,
            ...(lowerBound
              ? {
                  lower_bound: true,
                  lower_bound_note: `${unpricedRemainder.length} of ${coinRows.length} coins have no price at ${new Date(atSec * 1000).toISOString()}, so the USD totals leave them out. They are listed with amounts in unpriced_remainder.`,
                }
              : {}),
          },
          priced_coins: pricedCoins,
          unpriced_remainder: unpricedRemainder,
          ...(agg.failed.length ? { failed_transactions: agg.failed } : {}),
          ...(agg.unattributed.length
            ? {
                unattributed_transactions: agg.unattributed,
                unattributed_note: "These succeeded but named no pool in their events or changed objects. Their balance changes are in the totals and in no pool group.",
              }
            : {}),
          groups_note:
            "A group is one pool, or the set of pools one transaction touched together. `attacker` is the attacker's net balance change across the group's transactions and `pool` is the pool's reserve change from its own events (negative is what it lost), both as coin type -> [amount in whole tokens, USD or null when unpriced].",
          ...(groups.length < allGroups.length
            ? {
                groups_omitted: allGroups.length - groups.length,
                groups_omitted_note: `You set max_groups=${max_groups}, so only the largest groups are listed. The totals above still include every group.`,
              }
            : {}),
          groups,
          prices: priceTable(prices, atSec),
        };
        return {
          content: [
            { type: "text" as const, text: lines.join("\n") },
            // Compact: an incident runs to hundreds of groups, and indentation
            // alone was a third of the payload.
            { type: "text" as const, text: JSON.stringify(payload) },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
