import { z } from "zod";
import { numArg, coinTypeArg } from "./args.js";
import { describeAddresses, identityNote } from "../utils/identity.js";
import { lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import { getLabel, isSink, labelProvenance, type LabelProvenance } from "../utils/labels.js";
import { detectBridges, resolvableHit, type BridgeHit } from "../utils/bridge/detect.js";
import {
  chooseNextHop,
  coinKey,
  nonGasAmount,
  sameCoin,
  type GasCharge,
  type HopBasis,
  type UnfollowedRecipient,
} from "../utils/trace-hop.js";
import {
  backwardDeadEnd,
  fetchTx,
  findNextForward,
  findPriorInflow,
  formatAmount,
  forwardDeadEnd,
  HUB_SCAN_TRANSACTIONS,
  isPassThroughAddress,
  OBJECT_CHANGE_PAGES,
  type BalanceChangeInfo,
  type FetchedTx,
} from "../utils/trace-read.js";
import { assignSignerRoles } from "../utils/multisig.js";
import { measureFanout } from "../utils/fanout.js";
import {
  custodyChanges,
  objectCounterparties,
  summarizeObjectFlow,
  type ObjectMovement,
} from "../utils/object-flow.js";
import { ActivityLedger, lookalikeReport } from "../utils/address-lookalike.js";
import type { Appearance } from "../utils/address-lookalike.js";
import { pricesForRanking } from "../utils/price-providers.js";
import {
  coinScale,
  decimalsForCoinType,
  displayCoin,
  dominantFlowUsd,
  formatUsd,
  PRICE_STALE_THRESHOLD_SEC,
  priceUsdAtTime,
  pricingScale,
  usdValue,
  type PricePoint,
} from "../utils/valuation.js";
import { collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { errorResult } from "../utils/errors.js";
import { EXPORT_FORMATS, shortAddress, toCsv, toGraphJson, toMermaid, type ExportGraph } from "../utils/flow-export.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface HopResult {
  hop: number;
  digest: string;
  sender: string | null;
  balance_changes: BalanceChangeInfo[];
  timestamp: string | null;
  checkpoint: string | null;
  protocols: string[];
  /** How the next hop was chosen. See `HopBasis`. */
  basis?: HopBasis;
  /** Forward: recipients on this hop that the trace did not follow. */
  unfollowed_recipients?: UnfollowedRecipient[];
  /**
   * Backward: other parties that paid the tracked coin in on this hop, and
   * earlier inflows to the followed source that were not followed.
   */
  unfollowed_sources?: UnfollowedRecipient[];
  /**
   * Set when this hop was not sent by the address the trace was following:
   * the value was held by an object (a `Receiving<T>` transfer, an object's
   * address balance) and this transaction took it out.
   */
  reached_via?: "released-from-object";
  /**
   * False when the sender's own key did not sign: another address authorized
   * it through an address alias or a protocol-level substitution.
   */
  signer_is_sender?: false;
  authorized_by?: string[];
  /** The holder spent more of the tracked coin than the trace delivered to it. */
  commingled?: { received: string; spent: string; coin_type: string; note: string };
  actions: string[];
  token_flow: { coin: string; amount: string; raw_type: string }[];
  /**
   * Non-coin objects that changed hands on this hop. Absent when none did.
   * An NFT, a Kiosk or a capability moves without producing a balance change,
   * so these do not appear in `balance_changes` and never will.
   */
  object_transfers?: ObjectMovement[];
  /** Set when more object changes existed than the page returned. */
  object_changes_truncated?: string;
  /** More balance changes or commands existed than could be read. */
  balance_changes_truncated?: true;
  commands_truncated?: true;
  /** More events existed than could be read, so bridge detection may be incomplete. */
  events_incomplete?: true;
  /**
   * Set when the transport that answered this hop cannot report object
   * changes at all — the archive path. "No objects moved" and "could not
   * read what moved" are opposite claims, and only one of them is knowable
   * here.
   */
  object_flow_unavailable?: string;
  /** Note about how the next hop was chosen (swap follow-through, pool skip). */
  note?: string;
}

function shortCoinType(coinType: string): string {
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
}

function addrLabel(addr: string, nameMap: Map<string, string>): string {
  return nameMap.get(addr) ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * At least 0.001 of a whole unit of the coin, on the coin's own scale.
 *
 * A raw threshold of 1e6 hid every USDC flow under 1 USDC as "gas only",
 * because USDC has 6 decimals where SUI has 9.
 */
function isSignificant(amount: string, coinType: string): boolean {
  const v = BigInt(amount);
  const abs = v < 0n ? -v : v;
  return abs * 1000n >= 10n ** BigInt(coinScale(coinType).decimals);
}

function formatTimeSpan(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "< 1 minute";
  if (min < 60) return `${min} minute${min !== 1 ? "s" : ""}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr !== 1 ? "s" : ""}`;
  const days = Math.round(hr / 24);
  return `${days} day${days !== 1 ? "s" : ""}`;
}

function buildSummary(
  hops: HopResult[],
  direction: string,
  nameMap: Map<string, string>,
): string {
  if (hops.length === 0) return "No hops traced.";

  const lines: string[] = [];
  const first = hops[0];
  const last = hops[hops.length - 1];

  // Header
  lines.push(`FUND TRACE — ${direction.toUpperCase()}`);
  lines.push(`Starting tx: ${first.digest}`);

  // Time range
  if (first.timestamp && last.timestamp && hops.length > 1) {
    const diffMs = Math.abs(new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime());
    lines.push(`Time span: ${formatTimeSpan(diffMs)} across ${hops.length} hops`);
  } else {
    lines.push(`Hops: ${hops.length}`);
  }

  // Protocols
  const allProtocols = new Set<string>();
  for (const hop of hops) for (const p of hop.protocols) allProtocols.add(p);
  if (allProtocols.size > 0) {
    lines.push(`Protocols: ${[...allProtocols].join(", ")}`);
  }

  lines.push("");

  // Per-hop breakdown
  for (const hop of hops) {
    const sender = hop.sender ? addrLabel(hop.sender, nameMap) : "unknown";
    const ts = hop.timestamp ? new Date(hop.timestamp).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "";

    lines.push(`--- Hop ${hop.hop} ${ts ? `(${ts})` : ""} ---`);
    lines.push(`Tx:     ${hop.digest}`);
    lines.push(`Sender: ${sender}`);

    if (hop.actions.length > 0) {
      lines.push(`Action: ${hop.actions.join(", ")}`);
    }

    // Balance changes — separate significant from gas
    const significant: typeof hop.balance_changes = [];
    const gasOnly: typeof hop.balance_changes = [];
    for (const bc of hop.balance_changes) {
      if (isSignificant(bc.amount, bc.coin_type)) {
        significant.push(bc);
      } else {
        gasOnly.push(bc);
      }
    }

    if (significant.length > 0) {
      lines.push("Flows:");
      for (const bc of significant) {
        const who = addrLabel(bc.address, nameMap);
        lines.push(`  ${who}: ${formatAmount(bc.amount, bc.coin_type)}`);
      }
    }

    // "gas only" has meant two different things: no value moved, and value
    // moved as an object where a balance change cannot see it. On a hop that
    // handed over a capability, the second reading is the finding and the
    // first is false.
    const objectsHere = hop.object_transfers ?? [];
    if (gasOnly.length > 0 && significant.length === 0 && objectsHere.length === 0) {
      lines.push(hop.object_flow_unavailable ? "Flows:  no coin moved" : "Flows:  gas only");
    }

    if (objectsHere.length > 0) {
      lines.push("Objects:");
      for (const m of objectsHere) {
        const mark = m.high_consequence && !m.renounced ? " ⚠" : "";
        const who = (ref: typeof m.from) => {
          if (!ref) return "?";
          if (ref.kind === "address") return addrLabel(ref.address ?? "?", nameMap);
          if (ref.kind === "object") return `kiosk/object ${String(ref.address ?? "?").slice(0, 10)}…`;
          return ref.kind;
        };
        const label = m.protocol ? `${m.type_short} (${m.protocol})` : (m.type_short ?? "unknown type");
        const arrow = m.kind === "appeared" ? "(previous holder not recorded) ->" : "->";
        lines.push(`  ${label}${mark}  ${m.kind === "appeared" ? "" : who(m.from) + " "}${arrow} ${who(m.to)}`);
        if (m.note) lines.push(`    ${m.note}`);
      }
    }

    if (hop.object_changes_truncated) lines.push(`  ⚠ ${hop.object_changes_truncated}`);
    if (hop.object_flow_unavailable) lines.push(`  (${hop.object_flow_unavailable})`);
    if (hop.balance_changes_truncated) lines.push("  ⚠ More balance changes exist than could be read; the flows above are incomplete.");
    if (hop.signer_is_sender === false) {
      lines.push(`  ⚠ Not signed by the sender: authorized by ${hop.authorized_by?.join(", ")}.`);
    }
    if (hop.commingled) lines.push(`  ⚠ ${hop.commingled.note}`);
    if (hop.note) lines.push(`Note:   ${hop.note}`);

    lines.push("");
  }

  // End-state summary
  const lastHop = hops[hops.length - 1];
  const allCoinsTraced = new Set<string>();
  for (const hop of hops) {
    for (const bc of hop.balance_changes) {
      if (isSignificant(bc.amount, bc.coin_type)) allCoinsTraced.add(shortCoinType(bc.coin_type));
    }
  }
  if (allCoinsTraced.size > 0) {
    lines.push(`Coins involved: ${[...allCoinsTraced].join(", ")}`);
  }
  if (lastHop.actions.length > 0) {
    lines.push(`Final action: ${lastHop.actions.join(", ")}`);
  }

  return lines.join("\n");
}

/** The branch one hop followed, in the direction the money moved. */
interface FollowedHop {
  hop: number;
  digest: string;
  from: string;
  to: string;
  coin: string | null;
  amount: bigint;
  basis: HopBasis;
}

function amountLabel(amount: string | bigint, coin: string | null): string {
  return coin ? formatAmount(amount.toString(), coin).replace(/^[+-]/, "") : amount.toString();
}

/**
 * The trace as a graph: the followed path solid, the branches each hop set
 * aside dashed, bridge exits as their own nodes, and the stop reason at the
 * end, so the diagram cannot read as "the money stopped here" when it did not.
 */
function traceGraph(
  direction: "forward" | "backward",
  followed: FollowedHop[],
  hops: HopResult[],
  bridgeExits: Array<{ digest: string; hits: BridgeHit[] }>,
  stopReason: string | null,
  nameMap: Map<string, string>,
): ExportGraph {
  const g: ExportGraph = { directed: true, nodes: [], edges: [] };
  const ids = new Set<string>();
  const wallet = (address: string) => {
    if (ids.has(address)) return;
    ids.add(address);
    const name = nameMap.get(address);
    g.nodes.push({ id: address, label: name ? [name, shortAddress(address)] : [shortAddress(address)], kind: "wallet", attrs: { address } });
  };
  for (const f of followed) {
    wallet(f.from);
    wallet(f.to);
    g.edges.push({
      from: f.from,
      to: f.to,
      label: `hop ${f.hop}: ${amountLabel(f.amount, f.coin)}`,
      attrs: { hop: f.hop, digest: f.digest, coin_type: f.coin, amount: f.amount.toString(), basis: f.basis },
    });
  }
  for (const h of hops) {
    const actor = followed.find((f) => f.hop === h.hop);
    const anchor = direction === "forward" ? (actor?.from ?? h.sender) : (actor?.to ?? h.sender);
    if (!anchor) continue;
    wallet(anchor);
    for (const r of [...(h.unfollowed_recipients ?? []), ...(h.unfollowed_sources ?? [])]) {
      if (!r.address) continue;
      wallet(r.address);
      const forwardEdge = direction === "forward";
      g.edges.push({
        from: forwardEdge ? anchor : r.address,
        to: forwardEdge ? r.address : anchor,
        label: `not followed: ${amountLabel(r.amount.replace(/^-/, ""), r.coin_type || null)}`,
        dashed: true,
        attrs: { hop: h.hop, digest: r.digest ?? h.digest, coin_type: r.coin_type, amount: r.amount },
      });
    }
  }
  for (const exit of bridgeExits) {
    const hop = hops.find((h) => h.digest === exit.digest);
    const id = `exit:${exit.digest}`;
    g.nodes.push({ id, label: [`${[...new Set(exit.hits.map((x) => x.protocol))].join(" + ")} exit`, exit.digest.slice(0, 10) + "…"], kind: "bridge_exit", attrs: { digest: exit.digest } });
    const from = followed.find((f) => f.digest === exit.digest)?.from ?? hop?.sender;
    if (from) {
      wallet(from);
      g.edges.push({ from, to: id, label: `hop ${hop?.hop ?? "?"}`, attrs: { digest: exit.digest } });
    }
  }
  if (stopReason) {
    const last = followed.at(-1);
    const at = last ? (direction === "forward" ? last.to : last.from) : hops[0]?.sender;
    const text = stopReason.length > 90 ? `${stopReason.slice(0, 89)}…` : stopReason;
    g.nodes.push({ id: "stop", label: ["stopped", text], kind: "note", attrs: { stop_reason: stopReason } });
    if (at) {
      wallet(at);
      g.edges.push({ from: at, to: "stop", label: "", dashed: true });
    }
  }
  return g;
}

/** One row per transfer the trace saw: followed or not. */
function traceCsv(direction: "forward" | "backward", followed: FollowedHop[], hops: HopResult[], nameMap: Map<string, string>): string {
  const rows: Array<Record<string, unknown>> = followed.map((f) => ({
    hop: f.hop,
    digest: f.digest,
    timestamp: hops.find((h) => h.hop === f.hop)?.timestamp ?? "",
    from: f.from,
    from_label: nameMap.get(f.from) ?? "",
    to: f.to,
    to_label: nameMap.get(f.to) ?? "",
    coin_type: f.coin ?? "",
    amount_raw: f.amount.toString(),
    amount: amountLabel(f.amount, f.coin),
    basis: f.basis,
    followed: "yes",
  }));
  for (const h of hops) {
    const actor = followed.find((f) => f.hop === h.hop);
    const anchor = (direction === "forward" ? actor?.from : actor?.to) ?? h.sender ?? "";
    for (const r of [...(h.unfollowed_recipients ?? []), ...(h.unfollowed_sources ?? [])]) {
      const forwardRow = direction === "forward";
      rows.push({
        hop: h.hop,
        digest: r.digest ?? h.digest,
        timestamp: h.timestamp ?? "",
        from: forwardRow ? anchor : r.address,
        from_label: nameMap.get(forwardRow ? anchor : r.address) ?? "",
        to: forwardRow ? r.address : anchor,
        to_label: nameMap.get(forwardRow ? r.address : anchor) ?? "",
        coin_type: r.coin_type,
        amount_raw: r.amount.replace(/^-/, ""),
        amount: amountLabel(r.amount.replace(/^-/, ""), r.coin_type || null),
        basis: "",
        followed: "no",
      });
    }
  }
  return toCsv(["hop", "digest", "timestamp", "from", "from_label", "to", "to_label", "coin_type", "amount", "amount_raw", "basis", "followed"], rows);
}

export function registerTraceTools(server: McpServer) {
  server.tool(
    "trace_funds",
    "(Advanced — multi-hop) Trace fund flow from a transaction. Forward follows the tracked coin to whoever received it and then to that address's next transaction that moves it; backward follows whoever paid the coin in, then that address's most recent earlier inflow of it. Swap-aware (follows value across DEX swaps instead of losing it in the pool), follows the actor through an exploit or withdrawal that credits only itself, follows value out of objects that received it, stops at known sinks (exchanges, bridges, mixers, burn addresses — see manage_labels; a wallet labelled malicious is followed, not a stop), at bridge exits, and backward at high-fanout hubs, and always says why it stopped in `stop_reason`. Values each hop in USD at block time (see `usd` for the price source). Returns protocol-decoded actions and a human-readable summary. Makes sequential API calls per hop (up to 10).",
    {
      digest: z.string().describe("Starting transaction digest (Base58)"),
      direction: z
        .enum(["forward", "backward"])
        .describe("Direction to trace: 'forward' follows recipients, 'backward' follows sender"),
      hops: numArg()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Max hops to follow (default 3, max 10)"),
      coin_type: coinTypeArg()
        .optional()
        .describe("Start by following this coin type, and restrict the DISPLAYED balance changes to it (e.g. 0x2::sui::SUI; the short and padded forms match). The trace still follows value across swaps regardless. If omitted, all of each hop's balance changes are shown and the first hop picks the largest flow."),
      format: z
        .enum(EXPORT_FORMATS)
        .optional()
        .describe(
          "Output format (default json). mermaid: a fenced ```mermaid diagram of the followed path, with unfollowed branches dashed, bridge exits and the stop reason. graph_json: {nodes, edges}. csv: one row per followed or unfollowed transfer. The prose summary comes first in every format but graph_json.",
        ),
    },
    async ({ digest, direction, hops, coin_type, format: formatArg }) => {
      const format = formatArg ?? "json";
      const maxHops = Math.min(hops ?? 3, 10);
      // Compared and echoed in canonical form. GraphQL reports the padded type,
      // so `0x2::sui::SUI` compared as a raw string matched nothing and every
      // hop rendered empty.
      const coinFilter = coin_type ? coinKey(coin_type) : null;
      const traceHops: HopResult[] = [];
      /** Full movement lists per hop — internal, never serialised. */
      const movementsByHop = new Map<number, ObjectMovement[]>();
      /** The branch each hop followed, for the graph formats. */
      const followed: FollowedHop[] = [];
      let currentDigest: string | null = digest;
      // Why the trace ended. Every exit from the loop sets it: a trace that
      // just ends reads as "the money stopped here", which is the wrong
      // conclusion for most of the ways a trace can end.
      let terminationReason: string | null = null;
      // Bridge exits seen anywhere in the trace, keyed by digest.
      //
      // Detected from the hop's Move calls and events rather than from a sink
      // label. A bridge does not transfer value to an identifiable wallet — it
      // burns or locks the coin and emits a message — so there is usually no
      // recipient address to label, and `isSink` never fires.
      const bridgeExits: Array<{ digest: string; hits: BridgeHit[] }> = [];
      // Who the next hop's transaction must have been sent by, for the chain to
      // still be about the same funds. Null on the first hop, which has no
      // predecessor to disagree with, and on a hop that released funds from an
      // object, which someone else necessarily sent.
      let expectedSender: string | null = null;
      // Forward: whose funds the current hop moves. The sender, except on a
      // hop that took value out of an object.
      let holder: string | null = null;
      let reachedVia: HopResult["reached_via"];
      // Backward: the address whose inflow the current hop explains.
      let recipient: string | null = null;
      // Forward: what the followed address received on the previous hop, so a
      // larger outflow can be flagged as mixed with other funds.
      let delivered: { address: string; coin: string; amount: bigint } | null = null;
      // Hops the fullnode had pruned. Worth reporting: it tells a reader the
      // trace reached back past the fullnode's retention, which is usually the
      // interesting part of an old case.
      let archiveHops = 0;
      // Hops served from the local transaction cache. Reported so a fast trace
      // is legible as reuse rather than as a different chain read.
      let cacheHops = 0;
      // Addresses already followed. A↔B ping-pong is a common obfuscation
      // pattern, and it passes the custody check on every hop — without this
      // the trace fills maxHops with a two-wallet loop and presents it as a
      // ten-hop chain.
      const visitedAddresses = new Set<string>();
      // Digests already read, so a same-checkpoint window cannot hand one back.
      const visitedDigests = new Set<string>();
      let custodyBreak: Record<string, unknown> | null = null;
      // The coin we're following. May change mid-trace after a swap (A→B).
      let trackedCoin: string | null = coinFilter;

      for (let hop = 0; hop < maxHops && currentDigest; hop++) {
        let tx: FetchedTx | null;
        try {
          tx = await fetchTx(currentDigest);
        } catch (err) {
          // A transport failure is not an empty trace. On the first hop there
          // is nothing to report, so say why; later, keep what was found and
          // mark it incomplete.
          if (hop === 0) return errorResult((err as Error).message);
          terminationReason = `${(err as Error).message} The trace is incomplete rather than finished.`;
          break;
        }
        if (!tx) {
          // Not found on the fullnode *or* the archive. Breaking silently here
          // produced `hop_count: 0, hops: []` with no error, which a reader
          // takes as "there is nothing to follow" rather than "this could not
          // be fetched" — and on hop 0 those are opposite conclusions.
          if (hop === 0) {
            return errorResult(
              `Could not fetch the starting transaction ${currentDigest} from the fullnode or the archive. ` +
                "Check the digest and the network. This is not evidence that no funds moved.",
            );
          }
          terminationReason =
            `Could not fetch the next transaction (${currentDigest}) from the fullnode or the archive. ` +
            "The trace is incomplete rather than finished — value may have moved beyond this point.";
          break;
        }
        if (tx.source === "archive") archiveHops++;
        if (tx.source === "cache") cacheHops++;
        visitedDigests.add(currentDigest);

        const sender = tx.sender;
        const allChanges = tx.balanceChanges;
        // What we DISPLAY for the hop. Filter only by the caller's explicit
        // coin_type (a constant), NOT the mutable `trackedCoin`: when the trace
        // auto-switches assets across a swap, the hop's real flows must still be
        // shown. Next-hop selection still sees allChanges.
        const displayChanges = coinFilter
          ? allChanges.filter((c) => sameCoin(c.coin_type, coinFilter))
          : allChanges;

        const checkpointNum = tx.checkpoint ?? undefined;
        const gas: GasCharge = { payer: tx.gasPayer ?? null, net: tx.netGas == null ? null : BigInt(tx.netGas) };

        // Decode protocol actions
        const commands = tx.commands;
        const grpcBc = tx.grpcBalanceChanges;
        // Per-hop rather than batched: hops are discovered one at a time, so
        // there is no earlier point at which the package set is known.
        await prefetchProtocolNames(collectPackageIds(commands));
        const decoded = decodeTransaction(commands, grpcBc, sender ?? undefined);

        // Detect a bridge exit from this hop's Move calls and events. Runs
        // after the prefetch so the registry tier can see lineage-resolved
        // packages — an upgraded bridge still identifies. Events catch a
        // bridge reached through a wrapper package, whose own call carries no
        // marker.
        const hits = detectBridges(tx.callSites, tx.eventTypes ?? []);
        if (hits.length) bridgeExits.push({ digest: currentDigest, hits });

        // Chain of custody. The next transaction was found among those the
        // followed address SENT, so a different sender means the search
        // returned something it should not have, and the trace would
        // attribute a stranger's flows to the subject.
        // Forward only. Backward tracing deliberately walks to the transaction
        // that FUNDED the address, which by definition someone else sent — so
        // requiring the sender to match would fire on every backward hop.
        if (direction === "forward" && expectedSender && sender && sender !== expectedSender) {
          custodyBreak = {
            at_hop: hop + 1,
            digest: currentDigest,
            expected_sender: expectedSender,
            actual_sender: sender,
            meaning:
              "The next transaction on this address was not sent by it. That happens when the trace " +
              "followed a shared contract (a pool or protocol), whose subsequent activity belongs to " +
              "other users. Stopping here rather than attributing their flows to the subject.",
          };
          terminationReason =
            "Chain of custody broken — the following transaction was sent by a different address. " +
            "Stopping trace.";
          break;
        }

        // `?? []`: a row cached by an earlier build lacks the field.
        const signers = assignSignerRoles(sender, tx.gasPayer, tx.signatures ?? []);

        const hopResult: HopResult = {
          hop: hop + 1,
          digest: currentDigest,
          sender,
          balance_changes: displayChanges,
          timestamp: tx.timestamp,
          checkpoint: tx.checkpoint?.toString() ?? null,
          protocols: decoded.protocols,
          actions: decoded.actions,
          token_flow: decoded.token_flow,
          ...(reachedVia ? { reached_via: reachedVia } : {}),
          ...(signers.signer_is_sender === false
            ? { signer_is_sender: false as const, authorized_by: signers.authorized_by }
            : {}),
          ...(tx.balanceChangesTruncated ? { balance_changes_truncated: true as const } : {}),
          ...(tx.commandsTruncated ? { commands_truncated: true as const } : {}),
          ...(tx.eventsIncomplete ? { events_incomplete: true as const } : {}),
        };

        // Spending more than the trace delivered means other funds are mixed
        // in, so amounts from here on are not all the traced funds.
        if (direction === "forward" && delivered && holder === delivered.address) {
          const spent = -allChanges
            .filter((c) => c.address === holder && sameCoin(c.coin_type, delivered!.coin))
            .reduce((sum, c) => sum + nonGasAmount(c, gas), 0n);
          // More than 1% over, so a gas rebate or rounding dust is not flagged.
          if (spent * 100n > delivered.amount * 101n) {
            hopResult.commingled = {
              received: delivered.amount.toString(),
              spent: spent.toString(),
              coin_type: delivered.coin,
              note:
                // formatAmount signs its output; these are magnitudes.
                `${holder} spent ${formatAmount(spent.toString(), delivered.coin).slice(1)} here, more than the ` +
                `${formatAmount(delivered.amount.toString(), delivered.coin).slice(1)} the previous hop delivered, so funds it ` +
                "already held or received elsewhere are mixed in. Amounts from here on are not all the traced funds.",
            };
          }
        }

        // Object flow. Both live transports report it, so `undefined` now means
        // exactly one thing: a row cached before this field existed. Saying
        // "the archive cannot see objects" for a cache hit was wrong twice
        // over — the source is known two lines above, and the archive can.
        if (tx.objectMovements === undefined) {
          hopResult.object_flow_unavailable =
            tx.source === "cache"
              ? "This hop came from the local store, cached before object flow was recorded. " +
                "Re-run with the store disabled (unset SUI_STORE_PATH) to read it — this is not a statement that no objects moved."
              : "Object changes were not reported for this hop. That is not a statement that none happened.";
        } else {
          // Kept out of the hop payload on purpose: creations, deletions and
          // wraps are needed to COUNT movements and to collect counterparties,
          // but serialising them costs tokens for output nobody reads. A
          // 13-movement kiosk hop carries one transfer.
          movementsByHop.set(hopResult.hop, tx.objectMovements);
          const moved = custodyChanges(tx.objectMovements);
          if (moved.length > 0) hopResult.object_transfers = moved;
          if (tx.objectChangesTruncated) {
            hopResult.object_changes_truncated =
              `This transaction has more object changes than were read (${OBJECT_CHANGE_PAGES} pages of 50), ` +
              "so the list above is incomplete. Changes are ordered by object id, not by importance.";
          }
        }

        traceHops.push(hopResult);

        // A bridge exit ends the on-chain trace. The coin was burned or locked,
        // so there is no recipient to follow, and the value's next move is on
        // another chain: resolve_bridge_transfer is how it is followed.
        // Forward only. A bridge exit means value left the chain going forward;
        // a backward trace is asking where the money in this transaction came
        // FROM, which the exit says nothing about. Terminating there cut a
        // four-hop funding walk to one.
        const exitHere =
          direction === "forward"
            ? bridgeExits.find((e) => e.digest === currentDigest)
            : undefined;
        if (exitHere) {
          const protocols = exitHere.hits.map((h) => h.protocol).join(", ");
          terminationReason =
            `Value left Sui via ${protocols}. Stopping: the coin was burned or locked, so nothing ` +
            "on this chain continues it. Run resolve_bridge_transfer on this transaction to pick " +
            "the transfer up on the destination chain.";
          break;
        }

        // Forward only: what happens after a transaction signed by someone
        // else is that party's decision. Following on would attribute a
        // protocol recovery or an alias's actions to the address it acted for.
        if (direction === "forward" && signers.signer_is_sender === false) {
          terminationReason =
            `Hop ${hop + 1} was sent as ${sender} but signed by ${signers.authorized_by.join(", ")}, acting for it ` +
            "through an address alias or a protocol-level substitution. Its movements are not the sender's own, " +
            "so the trace stops rather than attributing them to the sender. Follow the signer separately if its actions belong to the case.";
          break;
        }

        // Price this hop's coins before choosing, so the next-hop ranking
        // compares value rather than raw units — 1 USDC is 1e6 units and 1 SUI
        // is 1e9, so a raw comparison ranks by decimal places and can follow
        // dust over the real transfer.
        //
        // Current prices, deliberately. Ranking needs *relative* value, and
        // which of five recipients got the most does not become more correct
        // with block-time precision, while a historical lookup per hop costs
        // a request per ranking decision. Coins with no quote fall back to raw
        // magnitude, which is at least consistent within one coin.
        const hopCoins = [...new Set(allChanges.map((c) => c.coin_type))];
        const decisionPrices = await pricesForRanking(hopCoins).catch(
          () => new Map<string, { price: number }>(),
        );
        const valueUsd = (c: { amount: string; coin_type: string }) => {
          const price = decisionPrices.get(c.coin_type)?.price;
          if (price == null) return null;
          return usdValue(c.amount, decimalsForCoinType(c.coin_type), price);
        };

        // Swap-aware, pool-skipping next-hop selection.
        const actor: string | null = direction === "forward" ? (holder ?? sender) : (recipient ?? sender);
        const decision = chooseNextHop({
          sender,
          changes: allChanges,
          actions: decoded.actions,
          direction,
          trackedCoin,
          isPassThrough: isPassThroughAddress,
          valueUsd,
          gas,
          ...(direction === "forward" ? { holder: holder ?? sender } : { recipient }),
        });
        const coinBefore = trackedCoin;
        trackedCoin = decision.nextCoinType;
        if (decision.note) hopResult.note = decision.note;
        hopResult.basis = decision.basis;
        // Branches the trace set aside. Reported per hop so "the money went
        // here" is never read off a split that had five other recipients.
        if (decision.unfollowed.length) {
          if (direction === "forward") hopResult.unfollowed_recipients = decision.unfollowed;
          else hopResult.unfollowed_sources = decision.unfollowed;
        }
        const nextAddress = decision.nextAddress;
        if (!nextAddress) {
          terminationReason =
            direction === "forward"
              ? forwardDeadEnd(tx, actor, coinBefore, decision.consumed === true, decision.note)
              : backwardDeadEnd(tx, actor, coinBefore);
          break;
        }
        if (format !== "json") {
          const coin = decision.nextCoinType;
          const moved = coin
            ? allChanges
                .filter((c) => c.address === nextAddress && sameCoin(c.coin_type, coin))
                .reduce((sum, c) => sum + nonGasAmount(c, gas), 0n)
            : 0n;
          followed.push({
            hop: hop + 1,
            digest: currentDigest,
            from: direction === "forward" ? (actor ?? "?") : nextAddress,
            to: direction === "forward" ? nextAddress : (actor ?? "?"),
            coin,
            amount: moved < 0n ? -moved : moved,
            basis: decision.basis,
          });
        }
        // Following the same actor across a swap or a self-credit is not a
        // cycle; value coming back to an earlier party is.
        if (nextAddress !== actor && visitedAddresses.has(nextAddress)) {
          terminationReason =
            `Cycle detected — value returned to ${nextAddress}, an address already in this trace. ` +
            "Stopping rather than reporting the same wallets again as further hops.";
          break;
        }
        visitedAddresses.add(nextAddress);

        // Stop at known sinks: once funds reach an exchange, bridge, mixer or
        // burn address, further hops are noise. A malicious label is not a
        // sink: it marks the attacker whose money the trace is following, and
        // since the shipped labels name exploiters, stopping there ended every
        // exploit trace at hop 1. trace_flow_graph applies the same rule.
        if (isSink(nextAddress)) {
          const label = getLabel(nextAddress);
          terminationReason = `Funds reached ${label?.label ?? nextAddress} (${label?.category}) — a known sink. Stopping trace.`;
          // A bridge is the one sink that is not terminal, and a labeled one
          // may carry no curated Move-call marker at all — a relayer forward,
          // an unlisted bridge, or a plain transfer into a deposit address.
          // Detection from calls alone therefore misses exactly the case an
          // investigator created the label for, and the trace reads as "the
          // money stopped here" when it left the chain.
          if (label?.category === "bridge") {
            bridgeExits.push({
              digest: currentDigest,
              hits: [
                {
                  protocol: label.label,
                  resolution: "detect-only",
                  matched: "address-label",
                  note:
                    "Labeled as a bridge. No curated marker fired on this transaction, so the " +
                    "protocol is whatever the label says — try resolve_bridge_transfer on this " +
                    "digest, and follow the value on the destination chain if it cannot resolve it.",
                },
              ],
            });
          }
          break;
        }

        if (hop === maxHops - 1) {
          terminationReason =
            `Reached the hop limit (${maxHops}) while following ${nextAddress}. The funds may have moved ` +
            `further: raise hops, or trace again from ${direction === "forward" ? "that address's next transaction" : "this hop"}.`;
          break;
        }

        // A hub pools many parties' money. Backward, its earlier inflows are
        // strangers' deposits, so walking past it names one of them as the
        // source. Forward, its next outflow is someone's withdrawal: an
        // exchange hot wallet's next SUI payment is not the traced SUI. Not
        // asked when the trace keeps following the same actor, who is the
        // subject rather than a new party.
        if (direction === "backward" || nextAddress !== actor) {
          const fanout = await measureFanout(nextAddress, HUB_SCAN_TRANSACTIONS).catch(() => null);
          if (fanout && fanout.classification !== "narrow") {
            terminationReason =
              `${nextAddress} is a ${fanout.classification}: ${fanout.counterparty_count}${fanout.truncated ? "+" : ""} ` +
              `counterparties in its last ${fanout.scanned_transactions} transactions. ` +
              (direction === "backward"
                ? "Its earlier inflows are other parties' money, so the transaction before this one does not say where these funds came from. "
                : "Funds it receives are pooled with other parties' money, so its next outflow is not a continuation of these funds. ") +
              "Stopping here: attribute this address (manage_labels, get_address_fanout) rather than walking past it.";
            break;
          }
        }

        // How much of the tracked coin the chosen address moved on this hop.
        const movedHere: bigint = trackedCoin
          ? allChanges
              .filter((c) => c.address === nextAddress && sameCoin(c.coin_type, trackedCoin!))
              .reduce((sum, c) => sum + nonGasAmount(c, gas), 0n)
          : 0n;

        if (direction === "forward") {
          delivered = trackedCoin && movedHere > 0n ? { address: nextAddress, coin: trackedCoin, amount: movedHere } : null;
          const step = await findNextForward(nextAddress, checkpointNum, trackedCoin, visitedDigests, currentDigest);
          if (step.digest === null) {
            terminationReason = step.reason;
            break;
          }
          holder = nextAddress;
          reachedVia = step.via === "released-from-object" ? step.via : undefined;
          // Only meaningful for a transaction the followed address sent. An
          // object's funds leave in a transaction someone else sends.
          expectedSender = step.via === "sent" ? nextAddress : null;
          currentDigest = step.digest;
        } else {
          const need = movedHere < 0n ? -movedHere : 1n;
          const step = await findPriorInflow(nextAddress, checkpointNum, trackedCoin, visitedDigests, currentDigest, need);
          if (step.digest === null) {
            terminationReason = step.reason;
            break;
          }
          if (step.others.length) {
            hopResult.unfollowed_sources = [...(hopResult.unfollowed_sources ?? []), ...step.others];
          }
          if (step.shortfall || step.others.length) {
            const coin = trackedCoin ? displayCoin(trackedCoin).symbol : "value";
            const cover = step.shortfall
              ? "The inflows found before it do not cover the whole outflow either, so part of it came from further back."
              : "The older inflows that make up the rest are listed in unfollowed_sources.";
            hopResult.note = [
              hopResult.note,
              `${nextAddress}'s latest ${coin} inflow before this hop is smaller than what it paid out here. ${cover}`,
            ]
              .filter(Boolean)
              .join(" ");
          }
          recipient = nextAddress;
          currentDigest = step.digest;
        }
      }

      // Collect all unique addresses from hops
      const allAddresses = new Set<string>();
      for (const hop of traceHops) {
        if (hop.sender) allAddresses.add(hop.sender);
        for (const bc of hop.balance_changes) {
          if (bc.address) allAddresses.add(bc.address);
        }
        // Object counterparties belong here too. Whoever receives a capability
        // is as much a party to the trace as whoever receives a coin, and
        // without this they get no name, no label, no sink check and no
        // lookalike comparison — while the prose truncates their address,
        // which is precisely the attack address_poisoning exists to catch.
        for (const a of objectCounterparties(movementsByHop.get(hop.hop) ?? [])) allAddresses.add(a);
        for (const s of hop.unfollowed_sources ?? []) if (s.address) allAddresses.add(s.address);
        for (const a of hop.authorized_by ?? []) allAddresses.add(a);
      }

      // Name, label and WHAT EACH ADDRESS IS, in two batched calls. A hop that
      // is a package or a shared object is not "someone the funds went to",
      // and nothing else in a trace says so.
      const identities = await describeAddresses([...allAddresses], { expandMembers: true });
      const nameMap = new Map(
        [...identities].filter(([, v]) => v.name).map(([k, v]) => [k, v.name!]),
      );

      // Build labels from SuiNS names, protocol package IDs, and the
      // attribution registry (exchanges, bridges, malicious wallets, ...).
      const addressLabels: Record<
        string,
        {
          name?: string;
          protocol?: string;
          label?: string;
          category?: string;
          confidence?: string;
          source?: string;
          provenance?: LabelProvenance;
          is_sink?: boolean;
          kind?: string;
          object_type?: string;
          names_held?: Array<{ name: string; expired: boolean; expires_at?: string }>;
          note?: string;
        }
      > = {};
      for (const addr of allAddresses) {
        const label: (typeof addressLabels)[string] = {};
        const name = nameMap.get(addr);
        if (name) label.name = name;
        // Display-only enrichment of the address label, so an MVR name is fine.
        const proto = lookupProtocolDisplay(addr);
        if (proto) label.protocol = proto.name;
        const id = identities.get(addr);
        if (id?.names_held?.length) label.names_held = id.names_held;
        if (id && id.kind !== "wallet") {
          label.kind = id.kind;
          if (id.object_type) label.object_type = id.object_type;
          const note = identityNote(id);
          if (note) label.note = note;
        }
        const known = getLabel(addr);
        if (known) {
          label.label = known.label;
          label.category = known.category;
          label.confidence = known.confidence;
          label.source = known.source;
          const provenance = labelProvenance(known);
          if (provenance) label.provenance = provenance;
          label.is_sink = isSink(addr);
          // Prefer explicit attribution over the short-hex fallback in the
          // human summary — "Binance deposit" beats "0x1234…abcd".
          if (!name) nameMap.set(addr, known.label);
        }
        // The kind alone is worth a label: an unnamed object read as a wallet
        // is the misreading this field exists to prevent.
        if (label.name || label.protocol || label.label || label.kind) {
          addressLabels[addr] = label;
        }
      }

      // Value each hop's flows in USD at that hop's block time: Pyth for
      // verified coins when a key is set, DefiLlama otherwise. Best-effort:
      // a coin with no price gets a null usd_value and is listed in
      // `usd.unpriced` with the reason, and pricing failures never break the
      // trace.
      const hopPrices: Array<Map<string, PricePoint>> = [];
      const hopUnix: Array<number | null> = [];
      const unpricedCoins = new Map<string, string>();
      for (const hop of traceHops) {
        const coinTypes = hop.balance_changes.map((bc) => bc.coin_type);
        const unixTs = hop.timestamp ? Math.floor(new Date(hop.timestamp).getTime() / 1000) : null;
        hopUnix.push(unixTs);
        const priced = await priceUsdAtTime(coinTypes, unixTs ?? undefined);
        hopPrices.push(priced.points);
        for (const u of priced.unpriced) if (!unpricedCoins.has(u.coin_type)) unpricedCoins.set(u.coin_type, u.reason);
      }

      let anyStalePrice = false;

      // Enrich hops with names, protocol labels, formatted amounts, and USD value
      const enrichedHops = traceHops.map((hop, i) => {
        const prices = hopPrices[i];
        const blockUnix = hopUnix[i];
        const flows: Array<{ address: string; usd: number }> = [];
        const balance_changes = hop.balance_changes.map((bc) => {
          const pp = prices.get(bc.coin_type) ?? null;
          const price = pp?.price ?? null;
          const usd = usdValue(bc.amount, pricingScale(bc.coin_type, pp).decimals, price);
          if (price != null) flows.push({ address: bc.address, usd: BigInt(bc.amount) < 0n ? -usd : usd });
          // How far is the price we used from the actual block time?
          const ageSec = pp && blockUnix != null ? Math.abs(pp.publishTime - blockUnix) : null;
          const stale = ageSec != null && ageSec > PRICE_STALE_THRESHOLD_SEC;
          if (stale) anyStalePrice = true;
          const coin = displayCoin(bc.coin_type);
          return {
            ...bc,
            formatted: formatAmount(bc.amount, bc.coin_type),
            // Structural, not just in the formatted string: a report generated
            // from this must be able to see that the asset is unidentified
            // without parsing prose. 8,008 mainnet coins share a symbol with
            // another, so "moved 10,000 USDC" is not a claim about which USDC.
            coin_verified: coin.verified,
            ...(coin.verified ? {} : { coin_scale: coinScale(bc.coin_type).source }),
            name: nameMap.get(bc.address) ?? null,
            protocol: lookupProtocolDisplay(bc.address)?.name ?? null,
            usd_value: price != null ? Number(usd.toFixed(2)) : null,
            // Unit price actually used, where it came from and when it was
            // sampled, so the valuation is auditable.
            price_usd: price != null ? Number(price.toFixed(price < 1 ? 6 : 4)) : null,
            price_source: pp?.source ?? null,
            ...(pp?.confidence !== undefined ? { price_confidence: pp.confidence } : {}),
            priced_at: pp ? new Date(pp.publishTime * 1000).toISOString() : null,
            price_age_sec: ageSec,
            price_stale: stale || undefined,
          };
        });
        const hopUsd = dominantFlowUsd(flows);
        return {
          ...hop,
          sender_name: hop.sender ? nameMap.get(hop.sender) ?? null : null,
          usd_total: hopUsd > 0 ? Number(hopUsd.toFixed(2)) : null,
          balance_changes,
        };
      });

      // USD headline. We do NOT sum across hops — that's the same money moving,
      // so a sum overstates impact. Report the origin and the largest hop.
      const usdTotals = enrichedHops.map((h) => h.usd_total ?? 0);
      const originUsd = usdTotals[0] ?? 0;
      const peakUsd = usdTotals.length ? Math.max(...usdTotals) : 0;

      const baseSummary = buildSummary(traceHops, direction, nameMap);
      const parts = [baseSummary];
      if (peakUsd > 0) {
        const usedSources = [
          ...new Set(enrichedHops.flatMap((h) => h.balance_changes.map((bc) => bc.price_source)).filter(Boolean)),
        ];
        const usd = [`Value (USD, at transaction time — ${usedSources.join(" + ")}):`];
        if (originUsd > 0) usd.push(`  Origin (hop 1): ${formatUsd(originUsd)}`);
        usd.push(`  Largest single-hop flow: ${formatUsd(peakUsd)}`);
        // Show the unit prices and their exact sample times, so it's visible
        // these are transaction-second prices — not a daily average.
        const shown = new Set<string>();
        for (const bc of enrichedHops[0].balance_changes) {
          if (bc.price_usd == null || shown.has(bc.coin_type)) continue;
          shown.add(bc.coin_type);
          const at = bc.priced_at ? ` (${bc.priced_at.replace("T", " ").slice(0, 19)} UTC)` : "";
          usd.push(`  ${shortCoinType(bc.coin_type)} @ $${bc.price_usd}${at}${bc.price_stale ? " ⚠stale" : ""}`);
        }
        usd.push("  (Later hops are largely the same funds moving; values are not summed.)");
        if (anyStalePrice) {
          usd.push("  ⚠ Some prices are >1h from block time (illiquid coin or a gap in the provider's history), so treat them as approximate.");
        }
        parts.push(usd.join("\n"));
      }
      if (terminationReason) parts.push(`⚠ Stopped: ${terminationReason}`);
      if (custodyBreak) {
        parts.push(
          `⚠ Chain of custody broke at hop ${custodyBreak.at_hop}: expected a transaction from ` +
            `${custodyBreak.expected_sender}, found one sent by ${custodyBreak.actual_sender}. ` +
            `Hops beyond this point were not followed.`,
        );
      }
      if (bridgeExits.length) {
        // Said in the summary as well as the structured payload: a trace that
        // just ends reads as "the money stopped here", which is the wrong
        // conclusion when it actually left the chain.
        const lines = ["🌉 Value left Sui in this trace:"];
        for (const exit of bridgeExits) {
          for (const hit of exit.hits) {
            lines.push(`  ${exit.digest} — ${hit.protocol}: ${hit.note}`);
          }
        }
        parts.push(lines.join("\n"));
      }
      // Address poisoning across the whole trace, not per hop.
      //
      // A trace is where this matters most and where a per-page check cannot
      // reach: the lookalike and the address it imitates are usually several
      // hops apart, so only the accumulated set of everyone the trace touched
      // puts them side by side. The comparison covers senders, everyone who
      // took a balance change, and the recipients the trace chose NOT to
      // follow — an unfollowed branch that imitates a followed one is exactly
      // the branch an investigator would otherwise pick by eye.
      const ledger = new ActivityLedger();
      for (const hop of enrichedHops) {
        const appearances: Appearance[] = hop.sender ? [{ address: hop.sender }] : [];
        for (const bc of hop.balance_changes) {
          let amount = 0n;
          try {
            amount = BigInt(bc.amount);
          } catch {
            // A non-numeric amount only costs this address its received total,
            // never its presence in the comparison.
          }
          appearances.push({ address: bc.address, amount });
        }
        for (const r of hop.unfollowed_recipients ?? []) appearances.push({ address: r.address });
        for (const r of hop.unfollowed_sources ?? []) appearances.push({ address: r.address });
        for (const a of objectCounterparties(movementsByHop.get(hop.hop) ?? [])) {
          appearances.push({ address: a });
        }
        ledger.observe(appearances);
      }
      const poisoning = lookalikeReport(ledger.addresses(), ledger.activity);

      // Object flow across the whole trace. Gathered here rather than per hop
      // because a capability handed over on hop 1 and exercised on hop 4 is
      // one story, and the hop-level lists cannot say that.
      const allMovements = [...movementsByHop.values()].flat();
      const objectFlow = summarizeObjectFlow(allMovements, {
        truncated: enrichedHops.some((h) => h.object_changes_truncated),
      });
      if (objectFlow && objectFlow.capability_transfers.length > 0) {
        // In the prose as well as the payload, for the same reason bridge
        // exits are: a trace whose coin amounts are all zero reads as "nothing
        // happened", which is the wrong conclusion when authority moved.
        const lines = ["⚠ Control of something changed hands in this trace:"];
        for (const m of objectFlow.capability_transfers) {
          lines.push(
            `  ${m.type_short} — ${addrLabel(m.from?.address ?? "?", nameMap)} -> ${addrLabel(m.to?.address ?? "?", nameMap)}`,
          );
          lines.push(`    object ${m.object_id}`);
          if (m.note) lines.push(`    ${m.note}`);
        }
        lines.push(
          "  This produces no balance change, so fund tracing alone would report that nothing moved.",
        );
        parts.push(lines.join("\n"));
      }
      // Renunciation is the opposite finding and must not borrow the warning.
      // Measured in upgrade-cap.ts: 27 of 30 UpgradeCap departures go to an
      // unspendable address, so treating those as handovers would make the
      // loudest output wrong most of the time.
      if (objectFlow && objectFlow.renounced_capabilities.length > 0) {
        const lines = ["Capability rights renounced in this trace:"];
        for (const m of objectFlow.renounced_capabilities) {
          lines.push(
            `  ${m.type_short} — ${addrLabel(m.from?.address ?? "?", nameMap)} -> ${m.to?.address} (unspendable)`,
          );
        }
        lines.push("  A reduction in risk, not a warning: nobody can exercise these rights again.");
        parts.push(lines.join("\n"));
      }
      if (poisoning) {
        // In the summary as well as the payload, for the same reason the bridge
        // exits are: the prose is what gets read, and a lookalike that only
        // appears in JSON is a warning nobody sees before they copy an address.
        const lines = ["⚠ Addresses in this trace close enough to be mistaken for one another:"];
        for (const pair of poisoning.pairs) {
          lines.push(`  ${pair.rendered.established}  vs  ${pair.rendered.suspect}`);
          lines.push(`    ${pair.note}`);
        }
        parts.push(lines.join("\n"));
      }

      const summary = parts.join("\n\n");

      const fullData = {
        starting_digest: digest,
        direction,
        coin_type: coinFilter ?? "all",
        hop_count: enrichedHops.length,
        // Same field name as find_funding_source. Always set: a sink, a bridge
        // exit, a dead end, a hub, a cycle, the hop limit or a read failure.
        stop_reason: terminationReason,
        ...(archiveHops ? { hops_served_by_archive: archiveHops } : {}),
        ...(cacheHops ? { hops_from_cache: cacheHops } : {}),
        ...(custodyBreak ? { custody_break: custodyBreak } : {}),
        // Structured, not just prose in the summary, so a caller can chain
        // straight into resolve_bridge_transfer without re-parsing the text.
        ...(bridgeExits.length
          ? {
              bridge_exits: bridgeExits.map((e) => ({
                digest: e.digest,
                protocols: e.hits.map((h) => ({
                  protocol: h.protocol,
                  resolution: h.resolution,
                  matched: h.matched,
                  note: h.note,
                })),
                ...(resolvableHit(e.hits)
                  ? { next_tool: "resolve_bridge_transfer" }
                  : {}),
              })),
            }
          : {}),
        usd: {
          origin: originUsd > 0 ? Number(originUsd.toFixed(2)) : null,
          peak_hop: peakUsd > 0 ? Number(peakUsd.toFixed(2)) : null,
          note: "Per-hop USD at each hop's block time, from Pyth for verified coins when PYTH_API_KEY is set and DefiLlama otherwise; not summed across hops (same funds moving). Each balance change carries price_usd, price_source, priced_at and price_age_sec.",
          ...(unpricedCoins.size
            ? { unpriced: [...unpricedCoins].map(([coin_type, reason]) => ({ coin_type, reason })) }
            : {}),
        },
        ...(poisoning ? { address_poisoning: poisoning } : {}),
        // The hop already carries these records in `object_transfers`; the
        // trace-level block repeats the digest-level view, so it names them by
        // id rather than serialising each one a second time.
        ...(objectFlow
          ? {
              object_flow: {
                movements: objectFlow.movements,
                transfer_count: objectFlow.transfers.length,
                capability_transfers: objectFlow.capability_transfers,
                renounced_capabilities: objectFlow.renounced_capabilities,
                ...(objectFlow.truncated ? { truncated: true } : {}),
                note: objectFlow.note,
              },
            }
          : {}),
        hops: enrichedHops,
        address_labels: addressLabels,
      };

      if (format !== "json") {
        const graph = traceGraph(direction, followed, enrichedHops, bridgeExits, terminationReason, nameMap);
        if (format === "graph_json") {
          return { content: [{ type: "text" as const, text: JSON.stringify(toGraphJson(graph), null, 2) }] };
        }
        return {
          content: [
            { type: "text" as const, text: summary },
            { type: "text" as const, text: format === "mermaid" ? toMermaid(graph) : traceCsv(direction, followed, enrichedHops, nameMap) },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: summary,
          },
          {
            type: "text" as const,
            text: JSON.stringify(fullData, null, 2),
          },
        ],
      };
    }
  );
}
