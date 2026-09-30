import { z } from "zod";
import { addressArg, numArg, coinTypeArg, timePointArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { describeAddresses, identityNote, type AddressIdentity } from "../utils/identity.js";
import { getLabel, labelProvenance } from "../utils/labels.js";
import { describeWindow, resolveWindow } from "../utils/checkpoint-time.js";
import { coinKey } from "../utils/trace-hop.js";
import { ActivityLedger, lookalikeReport, lookalikeWarning, type LookalikeReport } from "../utils/address-lookalike.js";
import { formatAmount, MOVES_PER_NODE } from "../utils/trace-read.js";
import { capPayload, type ListCap } from "../utils/output-cap.js";
import { CROSS_CHAIN_LEAD_MEANING } from "../utils/bridge/cross-chain.js";
import { displayCoin, formatUsd } from "../utils/valuation.js";
import { invalidDigestMessage, isDigest, normalizeDigest } from "../utils/digest.js";
import { canonicalSuiAddress, currentSuiAccount, currentSuiChain, parseAccountId } from "../utils/chain-id.js";
import { FlowEngine, MOVES_PER_START_ADDRESS, type EngineOptions, type GraphEdge, type GraphNode } from "../utils/flow-engine.js";
import { meetingPoints, STOP_MEANING, type PathStep } from "../utils/flow-graph.js";
import {
  EXPORT_FORMATS,
  shortAddress,
  toCsv,
  toGraphJson,
  toMermaid,
  type ExportFormat,
  type ExportGraph,
  type ExportNodeKind,
} from "../utils/flow-export.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Transactions read in full per graph: each is one to three GraphQL requests. */
const MAX_TX_READS = 400;

const round4 = (x: number) => Number(x.toFixed(4));
const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
/** Magnitude with symbol: `formatAmount` signs its output. */
const human = (raw: bigint, coin: string) => formatAmount(raw.toString(), coin).replace(/^[+-]/, "");

const FORMAT_ARG = z
  .enum(EXPORT_FORMATS)
  .optional()
  .describe(
    "Output format (default json). mermaid: a fenced flowchart for a markdown viewer. graph_json: {nodes, edges}, plus address_poisoning in trace_flow_graph. csv: one row per edge.",
  );

/** Who an address is, for labels: name, then label, then protocol, then the short address. */
function displayName(address: string, ids: Map<string, AddressIdentity>): string {
  const id = ids.get(address);
  return id?.name ?? id?.label ?? getLabel(address)?.label ?? id?.protocol ?? shortAddress(address);
}

interface Rendered {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  terminals: Array<Record<string, unknown>>;
  coverage: Record<string, unknown>;
  pruned: Array<Record<string, unknown>>;
}

/** The engine's graph as the JSON a tool returns: identities attached, amounts formatted, shares rounded. */
function render(engines: FlowEngine[], ids: Map<string, AddressIdentity>): Rendered {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const terminals: Array<Record<string, unknown>> = [];
  const pruned: Array<Record<string, unknown>> = [];
  for (const engine of engines) {
    for (const n of engine.nodes.values()) nodes.push(renderNode(engine, n, ids));
    for (const e of engine.edges.values()) edges.push(renderEdge(e));
    for (const group of engine.ledger.summary()) {
      if (group.code === "below_threshold") continue;
      terminals.push({
        reason: group.code,
        meaning: STOP_MEANING[group.code],
        share: round4(group.share),
        usd: group.usd === null ? null : Number(group.usd.toFixed(2)),
        entries: group.entries.slice(0, 15).map((en) => ({
          node: en.node,
          label: labelOfNode(engine.nodes.get(en.node), en.node, ids),
          share: round4(en.share),
          usd: en.usd === null ? null : Number(en.usd.toFixed(2)),
          ...(en.detail ? { detail: en.detail } : {}),
        })),
        ...(group.entries.length > 15 ? { more_entries: group.entries.length - 15 } : {}),
      });
    }
    for (const p of [...engine.pruned].sort((a, b) => b.share - a.share).slice(0, 10)) {
      pruned.push({
        address: p.address,
        coin: displayCoin(p.coin_type).symbol,
        coin_type: p.coin_type,
        share: round4(p.share),
        usd: p.usd === null ? null : Number(p.usd.toFixed(2)),
        digest: p.digest,
      });
    }
  }
  const coverage: Record<string, unknown> = {};
  engines.forEach((engine, i) => {
    const below = engine.ledger.summary().find((g) => g.code === "below_threshold");
    const c = {
      direction: engine.opts.direction,
      nodes_expanded: engine.expandedNodes,
      address_nodes: [...engine.nodes.values()].filter((n) => n.kind === "address").length,
      branches_pruned: engine.pruned.length,
      pruned_share: round4(below?.share ?? 0),
      nodes_left_unexpanded: engine.pending,
      depth_reached: engine.depthReached,
      transactions_read: engine.txReads,
      ...(engine.archiveReads ? { served_by_archive: engine.archiveReads } : {}),
      share_accounted: round4(engine.ledger.total()),
      truncated: engine.truncated || engine.pending > 0,
      limits: {
        max_depth: engine.opts.maxDepth,
        max_nodes: engine.opts.maxNodes,
        min_share: engine.opts.minShare,
        ...(engine.opts.minUsd !== null ? { min_usd: engine.opts.minUsd } : {}),
        moves_per_node: MOVES_PER_NODE,
        moves_per_start_address: MOVES_PER_START_ADDRESS,
        max_transaction_reads: engine.opts.maxTxReads,
      },
      ...(engine.notes.length ? { notes: engine.notes } : {}),
      ...(engine.partial.length ? { partial: engine.partial } : {}),
    };
    if (engines.length === 1) Object.assign(coverage, c);
    else coverage[i === 0 ? "forward" : "backward"] = c;
  });
  return { nodes, edges, terminals, coverage, pruned };
}

function labelOfNode(n: GraphNode | undefined, id: string, ids: Map<string, AddressIdentity>): string {
  if (!n) {
    const [address] = id.split("|");
    return canonicalSuiAddress(address) ? displayName(address, ids) : id;
  }
  if (n.address) return `${displayName(n.address, ids)}${n.coin_type ? ` (${displayCoin(n.coin_type).symbol})` : ""}`;
  if (n.kind === "origin_tx") return `tx ${n.id.slice(3)}`;
  if (n.kind === "bridge_exit") {
    const to = (n.beneficiaries ?? []).map((b) => `${b.chain_label} ${b.address ? shortAddress(b.address) : "?"}`);
    return `${(n.protocols ?? []).join(" + ")}${to.length ? ` → ${[...new Set(to)].slice(0, 3).join(", ")}` : ""}`;
  }
  if (n.kind === "retained") {
    const into = n.id.split(":").slice(2).join(":").split("+");
    return `retained by ${into.map((x) => (x.startsWith("0x") && !x.includes("::") ? shortAddress(x) : x)).join(", ")}`;
  }
  return n.id.split(":").slice(n.kind === "consumed" ? 2 : 1).join(":").replace(/\+/g, ", ") || n.kind;
}

function renderNode(engine: FlowEngine, n: GraphNode, ids: Map<string, AddressIdentity>): Record<string, unknown> {
  const id = n.address ? ids.get(n.address) : undefined;
  const label = n.address ? getLabel(n.address) : null;
  const ends = engine.ledger.codesFor(n.id);
  const note = id ? identityNote(id) : undefined;
  return {
    id: n.id,
    kind: n.kind,
    ...(n.address
      ? {
          address: n.address,
          account: currentSuiAccount(n.address),
          ...(id?.name ? { name: id.name } : {}),
          ...(label ? { label: label.label, category: label.category, provenance: labelProvenance(label) } : {}),
          ...(id && id.kind !== "wallet" ? { address_kind: id.kind } : {}),
          ...(id?.protocol ? { protocol: id.protocol } : {}),
          ...(note ? { note } : {}),
        }
      : { label: labelOfNode(n, n.id, ids) }),
    ...(n.coin_type ? { coin: displayCoin(n.coin_type).symbol, coin_type: n.coin_type } : {}),
    ...(n.kind === "address" ? { depth: n.depth, expanded: n.expanded } : {}),
    traced_share: round4(n.share),
    ...(n.coin_type && n.traced > 0n ? { traced_amount: n.traced.toString(), traced_formatted: human(n.traced, n.coin_type) } : {}),
    ...(n.usd !== null ? { traced_usd: Number(n.usd.toFixed(2)) } : {}),
    ...(n.stop ? { stop_reason: n.stop } : {}),
    ...(ends.length ? { ends } : {}),
    ...(n.unspent && n.coin_type ? { unspent: n.unspent.toString(), unspent_formatted: human(n.unspent, n.coin_type) } : {}),
    ...(n.protocols ? { protocols: n.protocols } : {}),
    ...(n.beneficiaries?.length ? { beneficiaries: n.beneficiaries } : {}),
    ...(n.beneficiaries_unavailable ? { beneficiaries_unavailable: n.beneficiaries_unavailable } : {}),
    ...(n.detail ? { detail: n.detail } : {}),
    ...(n.shared_objects?.length ? { shared_objects: n.shared_objects } : {}),
    ...(n.cross_chain_leads?.length ? { cross_chain_leads: n.cross_chain_leads, cross_chain_leads_meaning: CROSS_CHAIN_LEAD_MEANING } : {}),
  };
}

function renderEdge(e: GraphEdge): Record<string, unknown> {
  const coin = e.coin_type || null;
  return {
    from: e.from,
    to: e.to,
    ...(coin ? { coin: displayCoin(coin).symbol, coin_type: coin } : {}),
    amount: e.amount.toString(),
    ...(coin ? { amount_formatted: human(e.amount, coin) } : {}),
    ...(e.traced !== e.amount ? { traced_amount: e.traced.toString() } : {}),
    usd: e.usd === null ? null : Number(e.usd.toFixed(2)),
    traced_share: round4(e.share),
    basis: e.basis,
    first_time: e.first_time,
    first_checkpoint: e.first_checkpoint,
    digest_count: e.digests.length,
    digests: e.digests.slice(0, 20),
  };
}

/** What a node draws as, from why it ended. */
function drawKind(engine: FlowEngine, n: GraphNode): ExportNodeKind {
  if (n.kind === "origin_tx") return "origin";
  if (n.kind === "bridge_exit") return n.stop?.code === "target" ? "target" : "bridge_exit";
  if (n.kind === "consumed" || n.kind === "retained") return n.kind;
  if (n.kind === "source") return "source";
  const code = n.stop?.code;
  if (code === "sink" || code === "hub" || code === "protocol" || code === "target") return code;
  if (code === "bridge_exit") return "bridge_exit";
  const ends = engine.ledger.codesFor(n.id);
  if (!n.expanded && ends.includes("budget")) return "budget";
  if (ends.includes("unspent")) return "unspent";
  return "wallet";
}

function exportGraph(engines: FlowEngine[], ids: Map<string, AddressIdentity>, only?: Set<string>): ExportGraph {
  const g: ExportGraph = { directed: true, nodes: [], edges: [] };
  const seen = new Set<string>();
  for (const engine of engines) {
    for (const n of engine.nodes.values()) {
      if (seen.has(n.id) || (only && !only.has(n.id))) continue;
      seen.add(n.id);
      const name = n.address ? displayName(n.address, ids) : labelOfNode(n, n.id, ids);
      const lines = [name];
      if (n.address && name !== shortAddress(n.address)) lines.push(shortAddress(n.address));
      if (n.coin_type && n.traced > 0n) lines.push(human(n.traced, n.coin_type));
      if (n.unspent && n.coin_type) lines.push(`holds ${human(n.unspent, n.coin_type)}`);
      const code = n.stop?.code;
      if (code && code !== "bridge_exit") lines.push(code.replace(/_/g, " "));
      g.nodes.push({
        id: n.id,
        label: lines,
        kind: drawKind(engine, n),
        attrs: {
          ...(n.address ? { address: n.address } : {}),
          ...(n.coin_type ? { coin_type: n.coin_type } : {}),
          traced_share: round4(n.share),
          ...(n.beneficiaries?.length ? { beneficiaries: n.beneficiaries.map((b) => b.account ?? b.address) } : {}),
          ...(n.shared_objects?.length ? { shared_objects: n.shared_objects.map((o) => o.object_id) } : {}),
          ...(n.cross_chain_leads?.length ? { cross_chain_leads: n.cross_chain_leads } : {}),
        },
      });
    }
    for (const e of engine.edges.values()) {
      if (only && (!only.has(e.from) || !only.has(e.to))) continue;
      const amount = e.coin_type ? human(e.amount, e.coin_type) : e.amount.toString();
      const usd = e.usd !== null && e.usd > 0 ? ` (${formatUsd(e.usd)})` : "";
      const count = e.digests.length > 1 ? `, ${e.digests.length} txs` : "";
      g.edges.push({
        from: e.from,
        to: e.to,
        label: `${amount}${usd}${count}`,
        attrs: {
          coin_type: e.coin_type,
          amount: e.amount.toString(),
          usd: e.usd,
          traced_share: round4(e.share),
          basis: e.basis,
          digests: e.digests,
        },
      });
    }
  }
  return g;
}

function edgeCsv(engines: FlowEngine[], ids: Map<string, AddressIdentity>): string {
  const rows: Array<Record<string, unknown>> = [];
  for (const engine of engines) {
    for (const e of engine.edges.values()) {
      const from = engine.nodes.get(e.from);
      const to = engine.nodes.get(e.to);
      rows.push({
        from: from?.address ?? e.from,
        from_label: labelOfNode(from, e.from, ids),
        to: to?.address ?? e.to,
        to_label: labelOfNode(to, e.to, ids),
        coin: e.coin_type ? displayCoin(e.coin_type).symbol : "",
        coin_type: e.coin_type,
        amount_raw: e.amount.toString(),
        amount: e.coin_type ? human(e.amount, e.coin_type).split(" ")[0] : "",
        traced_raw: e.traced.toString(),
        usd: e.usd === null ? "" : e.usd.toFixed(2),
        traced_share: round4(e.share),
        basis: e.basis,
        first_time: e.first_time ?? "",
        digest_count: e.digests.length,
        digests: e.digests.join(" "),
      });
    }
  }
  return toCsv(
    ["from", "from_label", "to", "to_label", "coin", "coin_type", "amount", "amount_raw", "traced_raw", "usd", "traced_share", "basis", "first_time", "digest_count", "digests"],
    rows,
  );
}

async function identitiesFor(engines: FlowEngine[]): Promise<Map<string, AddressIdentity>> {
  const addresses = new Set<string>();
  for (const e of engines) for (const n of e.nodes.values()) if (n.address) addresses.add(n.address);
  return describeAddresses([...addresses]).catch(() => new Map<string, AddressIdentity>());
}

/** Plain-language summary: where the value ended, largest first. */
function prose(engine: FlowEngine, ids: Map<string, AddressIdentity>, start: string, poisoning: LookalikeReport): string {
  const lines = [`FLOW GRAPH — ${engine.opts.direction.toUpperCase()} from ${start}`];
  const addressNodes = [...engine.nodes.values()].filter((n) => n.kind === "address");
  lines.push(
    `${addressNodes.length} address nodes (${engine.expandedNodes} expanded), ${engine.edges.size} edges, ` +
      `${engine.txReads} transactions read. Traced value accounted for: ${pct(engine.ledger.total())}.`,
  );
  lines.push("");
  lines.push(engine.opts.direction === "forward" ? "Where it went:" : "Where it came from:");
  for (const g of engine.ledger.summary()) {
    // A group's USD sums its priced entries only; saying so keeps a share
    // carried by unpriced coins from reading as worth that sum.
    const unpriced = g.entries.filter((en) => en.usd === null).length;
    const priced = g.usd !== null && g.usd > 0 ? formatUsd(g.usd) : null;
    const usd = unpriced
      ? ` (${priced ? `${priced} priced, ` : ""}${unpriced} unpriced branch${unpriced === 1 ? "" : "es"})`
      : priced
        ? ` (${priced})`
        : "";
    lines.push(`  ${g.code.replace(/_/g, " ")}: ${pct(g.share)}${usd}`);
    for (const en of g.entries.slice(0, g.code === "below_threshold" ? 0 : 5)) {
      const n = engine.nodes.get(en.node);
      const eu = en.usd !== null && en.usd > 0 ? ` ${formatUsd(en.usd)}` : "";
      lines.push(`    ${pct(en.share)}${eu}  ${labelOfNode(n, en.node, ids)}`);
      if (g.code === "read_failed" && en.detail) lines.push(`      ${en.detail}`);
    }
    if (g.code !== "below_threshold" && g.entries.length > 5) lines.push(`    … ${g.entries.length - 5} more`);
  }
  const ends = engine.ledger.summary().map((g) => g.code);
  if (engine.pending > 0 || ends.includes("budget") || (engine.truncated && !ends.includes("read_failed") && engine.partial.length === 0)) {
    lines.push("");
    lines.push(
      "⚠ Partial: some branches hit a limit (see terminals `budget` and coverage). Raise max_depth or max_nodes, or start a new graph from a budget node.",
    );
  }
  if (ends.includes("read_failed")) {
    lines.push("");
    lines.push("Partial: some branches are unread (see read_failed terminals). No further flows are attributed through those stops.");
  }
  if (engine.partial.length > 0) {
    lines.push("");
    lines.push("⚠ Partial: the start address's search stopped at its limit before reading every move in the window. Narrow `from` and `to` to read the rest.");
    for (const reason of engine.partial) lines.push(`  ${reason}`);
  }
  if (poisoning.pairs.length > 0) {
    // In the prose, which every format carries, and not only in the JSON: a
    // mermaid or CSV export has no JSON, and the lookalike is drawn there as
    // an ordinary wallet.
    lines.push("");
    lines.push(lookalikeWarning(poisoning, "graph"));
  }
  const leadNodes = [...engine.nodes.values()].filter((n) => n.cross_chain_leads?.length);
  if (leadNodes.length > 0) {
    lines.push("");
    lines.push(
      `Lead: ${leadNodes.length} consumed or retained terminal(s) came from transactions whose events are shaped like a cross-chain message ` +
        "(a chain field beside a foreign-address-sized byte string) from a package no bridge reader here covers. The value may have left Sui " +
        "through an unrecognised bridge; see cross_chain_leads on those nodes.",
    );
    for (const n of leadNodes.slice(0, 5)) lines.push(`  ${labelOfNode(n, n.id, ids)}: ${n.cross_chain_leads!.map((l) => l.digest).join(", ")}`);
  }
  lines.push("");
  lines.push(
    "Shares are fractions of the traced value, allocated first-in first-out: an address that spends more than it received from these funds is treated as spending these funds first. That is a convention, not a fact the chain records.",
  );
  return lines.join("\n");
}

function formatted(
  format: ExportFormat,
  engines: FlowEngine[],
  ids: Map<string, AddressIdentity>,
  json: Record<string, unknown>,
  summary: string,
  poisoning: LookalikeReport,
) {
  const text = (t: string) => ({ type: "text" as const, text: t });
  if (format === "mermaid") return { content: [text(summary), text(toMermaid(exportGraph(engines, ids)))] };
  if (format === "graph_json") {
    const graph = { ...toGraphJson(exportGraph(engines, ids)), terminals: json.terminals, coverage: json.coverage, address_poisoning: poisoning };
    return { content: [text(JSON.stringify(graph))] };
  }
  if (format === "csv") return { content: [text(summary), text(edgeCsv(engines, ids))] };
  return { content: [text(summary), text(JSON.stringify(json))] };
}

/**
 * Coins no price source quoted, grouped by the reason: most share one, and a
 * graph through meme-coin pools names a hundred of them.
 */
function unpricedByReason(unpriced: Map<string, string>): Array<{ reason: string; coin_types: string[] }> {
  const byReason = new Map<string, Set<string>>();
  for (const [key, reason] of unpriced) {
    const coins = byReason.get(reason) ?? new Set<string>();
    coins.add(key.split("|")[1]);
    byReason.set(reason, coins);
  }
  return [...byReason].map(([reason, coins]) => ({ reason, coin_types: [...coins] }));
}

/** A find_flow_path target: a Sui address, or an account on another chain a bridge exit may pay. */
type Target = { sui: string; account: string } | { foreign: string; account: string | null };

function parseTarget(raw: string): Target {
  const text = raw.trim();
  if (text.includes(":")) {
    const acct = parseAccountId(text, currentSuiChain());
    if (acct.chain.startsWith("sui:")) return { sui: acct.address, account: `${acct.chain}:${acct.address}` };
    return { foreign: acct.address, account: `${acct.chain}:${acct.address}` };
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) return { foreign: text.toLowerCase(), account: null };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) && !/^0x/.test(text)) return { foreign: text, account: null };
  const sui = canonicalSuiAddress(text);
  if (sui) return { sui, account: currentSuiAccount(sui) };
  throw new Error(
    `'${raw}' is not a Sui address, a 20-byte EVM address, a Solana address or a CAIP-10 account id. A SuiNS name must be resolved first (resolve_name).`,
  );
}

export function registerFlowGraphTools(server: McpServer) {
  server.tool(
    "trace_flow_graph",
    "(Incident investigation) Trace every branch of funds forward or backward from a transaction or a time-bounded address, rather than the single branch trace_funds follows. Each recipient gets a proportional share of traced value. The walk follows the coin through swaps, self-credits and value released from objects; it stops at sinks, hubs, protocols, bridge exits with decoded beneficiaries, and transactions signed by someone other than the sender. An address's swap counts once: later spending carries its proceeds forward, earlier inflows carry its input backward. The rest ends as unspent or source, or budget if the move limit stopped the search. coverage.partial marks a start-address move limit; coverage.truncated marks other limits. Terminals report where each share ended. address_poisoning covers only reached addresses: empty pairs clear nothing beyond them, lookalike branches are never pruned, and every format's summary names the pairs. Consumed or retained terminals may carry heuristic cross_chain_leads from messages no bridge reader covers. Formats include Mermaid, graph JSON and CSV. A 40-node graph typically costs 100–300 requests.",
    {
      digest: z.string().optional().describe("Starting transaction (Base58). Give this or `address`."),
      address: addressArg().optional().describe("Start from this address's payouts after from (forward), or receipts before to (backward), instead of a digest."),
      direction: z.enum(["forward", "backward"]).optional().describe("forward (default) follows where the value went; backward follows who paid it in."),
      coin_type: coinTypeArg().optional().describe("Starting coin filter; omitted follows every coin moved. Value is still followed across swaps."),
      from: timePointArg().optional().describe("Window start: ISO date or checkpoint. With `address` and forward, where the walk starts. Bounds every search."),
      to: timePointArg().optional().describe("Window end: ISO date or checkpoint. With `address` and backward, where the walk starts. Bounds every search."),
      max_depth: numArg().int().min(1).max(8).optional().describe("Hops to follow from the start (default 4, max 8)."),
      max_nodes: numArg().int().min(1).max(150).optional().describe("Address nodes to expand (default 40, max 150). The branch carrying the most value is expanded next, at any depth."),
      min_share: numArg().min(0).max(1).optional().describe("Prune below this fraction of traced value (default 0.01 = 1%); never prune lookalikes. coverage.pruned counts them."),
      min_usd: numArg().min(0).optional().describe("Prune below this USD value at transaction time, except lookalikes. Unpriced branches use min_share."),
      format: FORMAT_ARG,
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe(
          "'summary' (default): ~20k chars, largest shares first; keeps all bridge exits, sinks, hubs, protocols, consumed and retained nodes, labelled addresses, lookalikes and their incoming edges. Terminals, coverage and shares cover the whole graph; omitted reports missing rows. 'full': every node and edge.",
        ),
    },
    async ({ digest, address, direction, coin_type, from, to, max_depth, max_nodes, min_share, min_usd, format, detail }) => {
      if ((digest ? 1 : 0) + (address ? 1 : 0) !== 1) {
        return errorResult("Give exactly one of `digest` (start from a transaction) or `address` (start from an address's activity).");
      }
      if (digest && !isDigest(normalizeDigest(digest))) return errorResult(invalidDigestMessage(digest));
      let window;
      try {
        window = await resolveWindow(from, to);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const opts: EngineOptions = {
        direction: direction ?? "forward",
        coin: coin_type ? coinKey(coin_type) : null,
        maxDepth: max_depth ?? 4,
        maxNodes: max_nodes ?? 40,
        minShare: min_share ?? 0.01,
        minUsd: min_usd ?? null,
        window: {
          ...(window.after?.checkpoint != null ? { afterCheckpoint: window.after.checkpoint } : {}),
          ...(window.before?.checkpoint != null ? { beforeCheckpoint: window.before.checkpoint } : {}),
        },
        maxTxReads: MAX_TX_READS,
      };
      const engine = new FlowEngine(opts);
      if (digest) {
        try {
          await engine.startFromDigest(normalizeDigest(digest));
        } catch (err) {
          return errorResult((err as Error).message);
        }
      } else {
        engine.startFromAddress(address!);
      }
      await engine.run();

      // Address poisoning over every address the graph named, expanded or
      // pruned: a lookalike branch is protected from pruning (see
      // FlowEngine.connect), but an investigator still needs the warning
      // stated, not just the edge left visible.
      const poisonLedger = new ActivityLedger();
      for (const n of engine.nodes.values()) if (n.address) poisonLedger.observe([{ address: n.address, amount: n.traced }]);
      for (const p of engine.pruned) poisonLedger.observe([{ address: p.address, amount: p.traced }]);
      const poisoning = lookalikeReport(poisonLedger.addresses(), poisonLedger.activity);

      const ids = await identitiesFor([engine]);
      const r = render([engine], ids);
      const start = digest ? `tx ${normalizeDigest(digest)}` : `${address} (${displayName(address!, ids)})`;
      const summary = prose(engine, ids, start, poisoning);
      const json = {
        start: digest ? { digest: normalizeDigest(digest) } : { address, account: currentSuiAccount(address!) },
        direction: opts.direction,
        coin_type: opts.coin ?? "all",
        ...(from || to ? { window: describeWindow(from, to, window) } : {}),
        terminals: r.terminals,
        coverage: r.coverage,
        address_poisoning: poisoning,
        ...(r.pruned.length ? { largest_pruned: r.pruned } : {}),
        nodes: r.nodes,
        edges: r.edges,
        ...(engine.unpriced.size ? { unpriced_coins: unpricedByReason(engine.unpriced) } : {}),
        method:
          "Each node is an (address, coin) pair. A node's traced amount is allocated to the transactions that moved it, first in first out, and each transaction's share to the parties it paid, in proportion to the amounts. traced_share is the fraction of the value at the start. USD is at each transaction's hour (Pyth for verified coins with PYTH_API_KEY, DefiLlama otherwise). A bridge_exit's beneficiaries are chain-derived from the transaction's events; confirm the destination on that chain.",
        next_steps:
          "resolve_bridge_transfer on an exit's digests to follow it on the destination chain; classify_deposit_address or screen_address on a sink or hub; trace_flow_graph again from a `budget` node's address to go further.",
      };
      if ((format ?? "json") !== "json") return formatted(format!, [engine], ids, json, summary, poisoning);
      const lookalikes = new Set(poisoning.pairs.flatMap((p) => [p.suspect, p.established]));
      const flaggedNode = (n: Record<string, unknown>) =>
        n.kind !== "address" || Boolean(n.stop_reason || n.label || n.address_kind) || lookalikes.has(String(n.address));
      const flaggedIds = new Set(r.nodes.filter(flaggedNode).map((n) => String(n.id)));
      const byShare = (a: Record<string, unknown>, b: Record<string, unknown>) => Number(b.traced_share) - Number(a.traced_share);
      const { payload } = capPayload(
        "trace_flow_graph",
        { digest, address, direction, coin_type, from, to, max_depth, max_nodes, min_share, min_usd },
        json,
        {
          nodes: {
            budget: 9_000,
            keepOrder: true,
            rank: byShare,
            keep: flaggedNode,
            usd: (n: Record<string, unknown>) => (typeof n.traced_usd === "number" ? n.traced_usd : null),
            brief: (n: Record<string, unknown>) => ({ id: n.id, traced_share: n.traced_share, traced_usd: n.traced_usd }),
          } satisfies ListCap<Record<string, unknown>>,
          edges: {
            budget: 11_000,
            keepOrder: true,
            rank: byShare,
            keep: (e: Record<string, unknown>) => flaggedIds.has(String(e.to)),
            usd: (e: Record<string, unknown>) => (typeof e.usd === "number" ? e.usd : null),
            brief: (e: Record<string, unknown>) => ({ from: e.from, to: e.to, traced_share: e.traced_share, usd: e.usd }),
          } satisfies ListCap<Record<string, unknown>>,
        },
        { full: detail === "full", next_call: { tool: "trace_flow_graph", repeat_with: { detail: "full" } } },
      );
      return formatted("json", [engine], ids, payload, summary, poisoning);
    },
  );

  server.tool(
    "find_flow_path",
    "(Incident investigation) Find value paths from one address to another. Searches forward from `from` and backward from `to` on trace_flow_graph's engine, heaviest branch first, and returns each path with every hop's transaction digests and amounts in time order. `to` may be an account on another chain (EVM, Solana or CAIP-10); a path then ends at a Sui bridge exit whose chain-derived beneficiary is that account. When nothing is found, `explored` says what was searched, and `explored.node_limited` names, per side, the nodes the node limit left unexpanded and the share of value they carry. A missing path does not show that none exists: every search is bounded, and value can move off-chain or through a hub.",
    {
      from: addressArg().describe("Address the value starts at."),
      to: z.string().describe("Target: a Sui address, an EVM (0x + 40 hex) or Solana (base58) address a bridge exit pays, or a CAIP-10 account."),
      max_hops: numArg().int().min(1).max(6).optional().describe("Longest path to look for, in transfers (default 5, max 6)."),
      coin_type: coinTypeArg().optional().describe("Start by following only this coin. Swaps are still followed."),
      window_start: timePointArg().optional().describe("Only transactions after this: ISO date or checkpoint. Set it to the incident time to skip the source's older history."),
      window_end: timePointArg().optional().describe("Only transactions before this: ISO date or checkpoint."),
      max_nodes: numArg().int().min(1).max(100).optional().describe("Address nodes to expand on each side (default 30, max 100), the branches carrying the most value first."),
      min_share: numArg().min(0).max(1).optional().describe("Skip branches below this fraction of each side's value (default 0.001), except those to a lookalike of a reached address."),
      format: FORMAT_ARG,
    },
    async ({ from, to, max_hops, coin_type, window_start, window_end, max_nodes, min_share, format }) => {
      let target: Target;
      let window;
      try {
        target = parseTarget(to);
        window = await resolveWindow(window_start, window_end);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const hops = max_hops ?? 5;
      const base = {
        coin: coin_type ? coinKey(coin_type) : null,
        maxDepth: hops,
        maxNodes: max_nodes ?? 30,
        minShare: min_share ?? 0.001,
        minUsd: null,
        window: {
          ...(window.after?.checkpoint != null ? { afterCheckpoint: window.after.checkpoint } : {}),
          ...(window.before?.checkpoint != null ? { beforeCheckpoint: window.before.checkpoint } : {}),
        },
        maxTxReads: MAX_TX_READS,
      };
      const forward = new FlowEngine({
        ...base,
        direction: "forward",
        target: "sui" in target ? { sui: target.sui } : { foreign: target.foreign },
      });
      forward.startFromAddress(from);
      let backward: FlowEngine | null = null;
      if ("sui" in target) {
        backward = new FlowEngine({ ...base, direction: "backward", target: { sui: from } });
        backward.startFromAddress(target.sui);
      }

      let paths: Array<{ steps: Array<{ engine: FlowEngine; step: PathStep }>; meets: string | null }> = [];
      // One node at a time, each side heaviest first, so the node limit goes
      // to the branches carrying the most value. A path joins nodes of any
      // depth, and only those within max_hops transfers count.
      for (;;) {
        paths = findPaths(forward, backward, target).filter((p) => p.steps.length <= hops);
        if (paths.length > 0) break;
        // The smaller frontier is the cheaper side; on a tie, the side that
        // has expanded less, so neither end is left unexplored.
        const pickBackward =
          backward !== null &&
          backward.pending > 0 &&
          (forward.pending === 0 ||
            backward.pending < forward.pending ||
            (backward.pending === forward.pending && backward.expandedNodes < forward.expandedNodes));
        const side = pickBackward ? backward! : forward;
        if (side.pending === 0) break;
        await side.expandNext();
      }
      const fLevels = forward.levels;
      const bLevels = backward?.levels ?? 0;

      const engines = backward ? [forward, backward] : [forward];
      const ids = await identitiesFor(engines);
      const r = render(engines, ids);
      const rendered = paths.slice(0, 5).map((p) => ({
        hops: p.steps.length,
        ...(p.meets ? { meets_at: p.meets } : {}),
        steps: p.steps.map(({ engine, step }) => {
          const e = engine.edges.get(step.edge)!;
          const a = engine.nodes.get(step.from);
          const b = engine.nodes.get(step.to);
          return {
            from: a?.address ?? step.from,
            from_label: labelOfNode(a, step.from, ids),
            to: b?.address ?? step.to,
            to_label: labelOfNode(b, step.to, ids),
            ...(b?.beneficiaries?.length ? { beneficiaries: b.beneficiaries } : {}),
            ...(e.coin_type ? { coin: displayCoin(e.coin_type).symbol, coin_type: e.coin_type, amount_formatted: human(e.amount, e.coin_type) } : {}),
            amount: e.amount.toString(),
            usd: e.usd === null ? null : Number(e.usd.toFixed(2)),
            basis: e.basis,
            first_time: e.first_time,
            digests: e.digests.slice(0, 5),
            digest_count: e.digests.length,
          };
        }),
      }));
      const toAccount = "sui" in target ? target.account : (target.account ?? target.foreign);
      const found = rendered.length > 0;
      const unread = engines.flatMap((engine) => engine.ledger.summary().find((group) => group.code === "read_failed")?.entries ?? []);
      const lines = [
        found
          ? `PATH FOUND — ${shortAddress(from)} → ${toAccount}: ${rendered.length} path(s), shortest ${Math.min(...rendered.map((p) => p.hops))} transfer(s).`
          : unread.length
            ? `SEARCH INCOMPLETE from ${shortAddress(from)} to ${toAccount}: no path established; some branches are unread.`
            : `NO PATH within budget from ${shortAddress(from)} to ${toAccount}.`,
      ];
      for (const [i, p] of rendered.entries()) {
        lines.push(`Path ${i + 1} (${p.hops} hops):`);
        for (const s of p.steps) lines.push(`  ${s.from_label} → ${s.to_label}: ${s.amount_formatted ?? s.amount}${s.usd ? ` (${formatUsd(s.usd)})` : ""}  [${s.digests[0]}${s.digest_count > 1 ? ` +${s.digest_count - 1}` : ""}]`);
      }
      lines.push(
        `Explored: forward ${forward.expandedNodes} node(s) over ${fLevels} level(s)` +
          (backward ? `, backward ${backward.expandedNodes} node(s) over ${bLevels} level(s)` : " (a foreign-chain target is reached only forward, through a bridge exit)") +
          `, ${forward.txReads + (backward?.txReads ?? 0)} transactions read.`,
      );
      for (const reason of forward.partial) lines.push(`Partial (the \`from\` address): ${reason} Narrow the window to read the rest.`);
      for (const reason of backward?.partial ?? []) lines.push(`Partial (the \`to\` address): ${reason} Narrow the window to read the rest.`);
      for (const entry of unread.slice(0, 5)) lines.push(`Unread: ${entry.detail ?? labelOfNode(undefined, entry.node, ids)}`);
      if (unread.length > 5) lines.push(`${unread.length - 5} more unread stops; see explored.terminals.`);
      // The node limit is the bound a caller can raise, so a search that found
      // nothing says how much of the value it left unread and where. Per side:
      // a forward share is a fraction of what `from` moved, a backward one of
      // what `to` received. A node refused on several arrivals counts once.
      const limitedSide = (e: FlowEngine | null) => {
        const byNode = new Map<string, number>();
        for (const l of e?.nodeLimited ?? []) byNode.set(l.node, (byNode.get(l.node) ?? 0) + l.share);
        if (byNode.size === 0) return null;
        const rows = [...byNode].map(([node, share]) => ({ node, share })).sort((a, b) => b.share - a.share);
        return {
          nodes_unexpanded: rows.length,
          share: round4(Math.min(1, rows.reduce((t, l) => t + l.share, 0))),
          largest: rows.slice(0, 5).map((l) => ({ node: l.node, label: labelOfNode(undefined, l.node, ids), share: round4(l.share) })),
        };
      };
      const limitedForward = found ? null : limitedSide(forward);
      const limitedBackward = found ? null : limitedSide(backward);
      const nodeLimited =
        limitedForward || limitedBackward
          ? {
              max_nodes: forward.opts.maxNodes,
              ...(limitedForward ? { forward: limitedForward } : {}),
              ...(limitedBackward ? { backward: limitedBackward } : {}),
            }
          : null;
      if (!found) {
        if (nodeLimited) {
          const sides = [
            limitedForward ? { side: limitedForward, of: "of what `from` moved" } : null,
            limitedBackward ? { side: limitedBackward, of: "of what `to` received" } : null,
          ].filter((x) => x !== null);
          lines.push(
            `The node limit (${nodeLimited.max_nodes}) left unexpanded: ` +
              sides
                .map(
                  ({ side, of }) =>
                    `${side.nodes_unexpanded} node(s) carrying ${pct(side.share)} ${of}, the largest ` +
                    side.largest.slice(0, 3).map((l) => `${l.label} (${pct(l.share)})`).join(", "),
                )
                .join("; ") +
              "." +
              (nodeLimited.max_nodes < 100 ? " Raise max_nodes (up to 100) to follow them." : ""),
          );
        }
        lines.push(
          unread.length
            ? "Unread branches prevent a complete search. See the read_failed terminal reasons; increasing limits does not repair a failed read."
            : "Absence is not evidence: the search is bounded by max_hops, max_nodes and min_share, stops at hubs and sinks, and cannot see value that leaves through an exchange or another chain. Widen the window or the limits, or trace_flow_graph from either end.",
        );
      }
      const summary = lines.join("\n");
      const json = {
        from,
        from_account: currentSuiAccount(from),
        to: toAccount,
        max_hops: hops,
        ...(window_start || window_end ? { window: describeWindow(window_start, window_end, window) } : {}),
        found,
        ...(found
          ? { paths: rendered }
          : {
              result: unread.length ? "search incomplete" : "no path within budget",
              note: unread.length
                ? "Some branches could not be read; see explored.terminals for their reasons. No path was established from the readable evidence."
                : "Absence is not evidence that no path exists. The search is bounded (max_hops, max_nodes, min_share), stops at hubs, sinks and protocol addresses, and cannot see value that leaves through an exchange or another chain.",
            }),
        explored: {
          forward_levels: fLevels,
          backward_levels: bLevels,
          coverage: r.coverage,
          terminals: r.terminals,
          ...(nodeLimited ? { node_limited: nodeLimited } : {}),
        },
        method:
          "Forward from `from` and backward from `to` on the trace_flow_graph engine, one node at a time, expanding whichever side has the smaller frontier and, on each side, the queued node carrying the most value first. A path joins at an address both sides reached, where the forward side arrived no later than the backward side paid on toward `to`. Each step is a transfer with its digests.",
      };
      if ((format ?? "json") === "json") return { content: [{ type: "text" as const, text: summary }, { type: "text" as const, text: JSON.stringify(json) }] };
      // Diagrams draw the paths only: the explored graph is in the JSON.
      const onPath = new Set(paths.slice(0, 5).flatMap((p) => p.steps.flatMap((s) => [s.step.from, s.step.to])));
      const g = exportGraph(engines, ids, onPath.size ? onPath : undefined);
      if (format === "mermaid") return { content: [{ type: "text" as const, text: summary }, { type: "text" as const, text: toMermaid(g) }] };
      if (format === "graph_json") return { content: [{ type: "text" as const, text: JSON.stringify({ ...toGraphJson(g), found, explored: json.explored }) }] };
      return { content: [{ type: "text" as const, text: summary }, { type: "text" as const, text: edgeCsv(engines, ids) }] };
    },
  );
}

/** Paths found so far: the forward side reaching the target, or both sides meeting in time order. */
function findPaths(
  forward: FlowEngine,
  backward: FlowEngine | null,
  target: Target,
): Array<{ steps: Array<{ engine: FlowEngine; step: PathStep }>; meets: string | null }> {
  const out: Array<{ steps: Array<{ engine: FlowEngine; step: PathStep }>; meets: string | null }> = [];
  const key = (steps: PathStep[]) => steps.map((s) => s.edge).join(" ");
  const seen = new Set<string>();
  const push = (steps: Array<{ engine: FlowEngine; step: PathStep }>, meets: string | null) => {
    const k = key(steps.map((s) => s.step));
    if (steps.length === 0 || seen.has(k)) return;
    seen.add(k);
    out.push({ steps, meets });
  };
  if ("foreign" in target) {
    for (const n of forward.nodes.values()) {
      if (n.kind === "bridge_exit" && n.stop?.code === "target") {
        push(forward.pathFromRoot(n.id).map((step) => ({ engine: forward, step })), null);
      }
    }
    return out.sort((a, b) => a.steps.length - b.steps.length);
  }
  const addressNodes = (e: FlowEngine) =>
    new Map(
      [...e.nodes.values()]
        .filter((n) => n.kind === "address" && n.address)
        .map((n) => [n.id, { address: n.address!, arrivedAt: n.arrivedAt }]),
    );
  const f = addressNodes(forward);
  for (const [id, n] of f) {
    if (n.address === target.sui) push(forward.pathFromRoot(id).map((step) => ({ engine: forward, step })), null);
  }
  if (backward) {
    for (const m of meetingPoints(f, addressNodes(backward))) {
      const steps = [
        ...forward.pathFromRoot(m.forwardNode).map((step) => ({ engine: forward, step })),
        ...backward.pathFromRoot(m.backwardNode).map((step) => ({ engine: backward, step })),
      ];
      push(steps, m.address);
    }
  }
  return out.sort((a, b) => a.steps.length - b.steps.length);
}

