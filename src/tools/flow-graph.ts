import { z } from "zod";
import { addressArg, numArg, coinTypeArg, timePointArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { describeAddresses, identityNote, type AddressIdentity } from "../utils/identity.js";
import { getLabel, labelProvenance } from "../utils/labels.js";
import { describeWindow, resolveWindow } from "../utils/checkpoint-time.js";
import { coinKey } from "../utils/trace-hop.js";
import { formatAmount } from "../utils/trace-read.js";
import { displayCoin, formatUsd } from "../utils/valuation.js";
import { invalidDigestMessage, isDigest, normalizeDigest } from "../utils/digest.js";
import { canonicalSuiAddress, currentSuiAccount, currentSuiChain, parseAccountId } from "../utils/chain-id.js";
import { FlowEngine, MOVES_PER_NODE, MOVES_PER_START_ADDRESS, type EngineOptions, type GraphEdge, type GraphNode } from "../utils/flow-engine.js";
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
    "Output format (default json). mermaid: a fenced ```mermaid flowchart that renders in a markdown viewer. graph_json: {nodes, edges} for graph tools. csv: one row per edge.",
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
  if (n.kind === "consumed") return "consumed";
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
function prose(engine: FlowEngine, ids: Map<string, AddressIdentity>, start: string): string {
  const lines = [`FLOW GRAPH — ${engine.opts.direction.toUpperCase()} from ${start}`];
  const addressNodes = [...engine.nodes.values()].filter((n) => n.kind === "address");
  lines.push(
    `${addressNodes.length} address nodes (${engine.expandedNodes} expanded), ${engine.edges.size} edges, ` +
      `${engine.txReads} transactions read. Traced value accounted for: ${pct(engine.ledger.total())}.`,
  );
  lines.push("");
  lines.push(engine.opts.direction === "forward" ? "Where it went:" : "Where it came from:");
  for (const g of engine.ledger.summary()) {
    const usd = g.usd !== null && g.usd > 0 ? ` (${formatUsd(g.usd)})` : "";
    lines.push(`  ${g.code.replace(/_/g, " ")}: ${pct(g.share)}${usd}`);
    for (const en of g.entries.slice(0, g.code === "below_threshold" ? 0 : 5)) {
      const n = engine.nodes.get(en.node);
      const eu = en.usd !== null && en.usd > 0 ? ` ${formatUsd(en.usd)}` : "";
      lines.push(`    ${pct(en.share)}${eu}  ${labelOfNode(n, en.node, ids)}`);
    }
    if (g.code !== "below_threshold" && g.entries.length > 5) lines.push(`    … ${g.entries.length - 5} more`);
  }
  if (engine.truncated || engine.pending > 0) {
    lines.push("");
    lines.push(
      "⚠ Partial: some branches hit a limit (see terminals `budget` and coverage). Raise max_depth or max_nodes, or start a new graph from a budget node.",
    );
  }
  lines.push("");
  lines.push(
    "Shares are fractions of the traced value, allocated first-in first-out: an address that spends more than it received from these funds is treated as spending these funds first. That is a convention, not a fact the chain records.",
  );
  return lines.join("\n");
}

function formatted(format: ExportFormat, engines: FlowEngine[], ids: Map<string, AddressIdentity>, json: unknown, summary: string) {
  const text = (t: string) => ({ type: "text" as const, text: t });
  if (format === "mermaid") return { content: [text(summary), text(toMermaid(exportGraph(engines, ids)))] };
  if (format === "graph_json") return { content: [text(JSON.stringify(toGraphJson(exportGraph(engines, ids)), null, 2))] };
  if (format === "csv") return { content: [text(summary), text(edgeCsv(engines, ids))] };
  return { content: [text(summary), text(JSON.stringify(json, null, 2))] };
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
    "(Incident investigation) Follow ALL of the funds, not one branch. Builds a fund-flow graph from a transaction (or from an address after a time), forward to where the value went or backward to where it came from, allocating each transfer's traced value across every recipient in proportion to what each received. Same hop rules as trace_funds: follows the tracked coin, keeps the actor across swaps and self-credits, follows value released from objects, and stops at sinks, hubs, protocol addresses, bridge exits (with the far-side beneficiary read from the transaction) and transactions signed by someone other than the sender. Returns nodes (address, coin, identity, traced share and amount, why it ended), edges (amount, USD at transaction time, digests), `terminals` grouped by reason with the share of the traced value that ended there (bridge_exit, sink, hub, unspent, consumed, budget, …), and `coverage` (nodes expanded, pruned, truncated). `format` renders Mermaid, graph JSON or CSV. Costs roughly one search plus the spends it finds per node: 40 nodes is typically 100-300 requests.",
    {
      digest: z.string().optional().describe("Starting transaction (Base58). Give this or `address`."),
      address: addressArg().optional().describe("Start from this address instead of a transaction: its outflows after `from` (forward) or inflows before `to` (backward)."),
      direction: z.enum(["forward", "backward"]).optional().describe("forward (default) follows where the value went; backward follows who paid it in."),
      coin_type: coinTypeArg().optional().describe("Follow only this coin from the start (e.g. 0x2::sui::SUI). The graph still follows value across swaps. Omitted: every coin the start moved."),
      from: timePointArg().optional().describe("Window start: ISO date or checkpoint. With `address` and forward, where the walk starts. Bounds every search."),
      to: timePointArg().optional().describe("Window end: ISO date or checkpoint. With `address` and backward, where the walk starts. Bounds every search."),
      max_depth: numArg().int().min(1).max(8).optional().describe("Hops to follow from the start (default 4, max 8)."),
      max_nodes: numArg().int().min(1).max(150).optional().describe("Address nodes to expand (default 40, max 150). Larger branches are expanded first."),
      min_share: numArg().min(0).max(1).optional().describe("Do not expand branches carrying less than this fraction of the traced value (default 0.01 = 1%). They are counted under coverage.pruned."),
      min_usd: numArg().min(0).optional().describe("Prune by USD instead: branches worth less than this at transaction time. Unpriced branches fall back to min_share."),
      format: FORMAT_ARG,
    },
    async ({ digest, address, direction, coin_type, from, to, max_depth, max_nodes, min_share, min_usd, format }) => {
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

      const ids = await identitiesFor([engine]);
      const r = render([engine], ids);
      const start = digest ? `tx ${normalizeDigest(digest)}` : `${address} (${displayName(address!, ids)})`;
      const summary = prose(engine, ids, start);
      const json = {
        start: digest ? { digest: normalizeDigest(digest) } : { address, account: currentSuiAccount(address!) },
        direction: opts.direction,
        coin_type: opts.coin ?? "all",
        ...(from || to ? { window: describeWindow(from, to, window) } : {}),
        terminals: r.terminals,
        coverage: r.coverage,
        ...(r.pruned.length ? { largest_pruned: r.pruned } : {}),
        nodes: r.nodes,
        edges: r.edges,
        ...(engine.unpriced.size ? { unpriced_coins: [...new Set([...engine.unpriced].map(([k, reason]) => `${k.split("|")[1]}: ${reason}`))] } : {}),
        method:
          "Each node is an (address, coin) pair. A node's traced amount is allocated to the transactions that moved it, first in first out, and each transaction's share to the parties it paid, in proportion to the amounts. traced_share is the fraction of the value at the start. USD is at each transaction's hour (Pyth for verified coins with PYTH_API_KEY, DefiLlama otherwise). A bridge_exit's beneficiaries are chain-derived from the transaction's events; confirm the destination on that chain.",
        next_steps:
          "resolve_bridge_transfer on an exit's digests to follow it on the destination chain; classify_deposit_address or screen_address on a sink or hub; trace_flow_graph again from a `budget` node's address to go further.",
      };
      return formatted(format ?? "json", [engine], ids, json, summary);
    },
  );

  server.tool(
    "find_flow_path",
    "(Incident investigation) Is there a value path from one address to another? Searches forward from `from` and backward from `to` on the trace_flow_graph engine, alternating levels, and returns each path found with the transaction digests and amounts of every hop, in time order. `to` may be an account on another chain (an EVM or Solana address, or CAIP-10): the path then ends at a Sui bridge exit whose chain-derived beneficiary is that account. When nothing is found it says what was explored. A missing path is not evidence that none exists: every search here is bounded, and value can move off-chain or through a hub.",
    {
      from: addressArg().describe("Address the value starts at."),
      to: z.string().describe("Address the value should reach: a Sui address, a foreign-chain address a bridge exit pays (0x + 40 hex for EVM, base58 for Solana), or a CAIP-10 account."),
      max_hops: numArg().int().min(1).max(6).optional().describe("Longest path to look for, in transfers (default 4, max 6)."),
      coin_type: coinTypeArg().optional().describe("Start by following only this coin. Swaps are still followed."),
      window_start: timePointArg().optional().describe("Only transactions after this: ISO date or checkpoint. Set it to the incident time to skip the source's older history."),
      window_end: timePointArg().optional().describe("Only transactions before this: ISO date or checkpoint."),
      max_nodes: numArg().int().min(1).max(100).optional().describe("Address nodes to expand on each side (default 30, max 100)."),
      min_share: numArg().min(0).max(1).optional().describe("Do not expand branches below this fraction of each side's value (default 0.001)."),
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
      const hops = max_hops ?? 4;
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

      let fLevels = 0;
      let bLevels = 0;
      let paths: Array<{ steps: Array<{ engine: FlowEngine; step: PathStep }>; meets: string | null }> = [];
      for (;;) {
        paths = findPaths(forward, backward, target);
        if (paths.length > 0 || fLevels + bLevels >= hops) break;
        // The smaller frontier is the cheaper level; on a tie, the side
        // that has expanded less, so neither end is left unexplored.
        const pickBackward =
          backward !== null &&
          backward.pending > 0 &&
          (forward.pending === 0 ||
            backward.pending < forward.pending ||
            (backward.pending === forward.pending && bLevels < fLevels));
        const side = pickBackward ? backward! : forward;
        if (side.pending === 0) break;
        await side.expandLevel();
        if (pickBackward) bLevels++;
        else fLevels++;
      }

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
      const lines = [
        found
          ? `PATH FOUND — ${shortAddress(from)} → ${toAccount}: ${rendered.length} path(s), shortest ${Math.min(...rendered.map((p) => p.hops))} transfer(s).`
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
      if (!found) {
        lines.push(
          "Absence is not evidence: the search is bounded by max_hops, max_nodes and min_share, stops at hubs and sinks, and cannot see value that leaves through an exchange or another chain. Widen the window or the limits, or trace_flow_graph from either end.",
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
              result: "no path within budget",
              note: "Absence is not evidence that no path exists. The search is bounded (max_hops, max_nodes, min_share), stops at hubs, sinks and protocol addresses, and cannot see value that leaves through an exchange or another chain.",
            }),
        explored: {
          forward_levels: fLevels,
          backward_levels: bLevels,
          coverage: r.coverage,
          terminals: r.terminals,
        },
        method:
          "Forward from `from` and backward from `to` on the trace_flow_graph engine, one level at a time, expanding whichever side has the smaller frontier. A path joins at an address both sides reached, where the forward side arrived no later than the backward side paid on toward `to`. Each step is a transfer with its digests.",
      };
      if ((format ?? "json") === "json") return { content: [{ type: "text" as const, text: summary }, { type: "text" as const, text: JSON.stringify(json, null, 2) }] };
      // Diagrams draw the paths only: the explored graph is in the JSON.
      const onPath = new Set(paths.slice(0, 5).flatMap((p) => p.steps.flatMap((s) => [s.step.from, s.step.to])));
      const g = exportGraph(engines, ids, onPath.size ? onPath : undefined);
      if (format === "mermaid") return { content: [{ type: "text" as const, text: summary }, { type: "text" as const, text: toMermaid(g) }] };
      if (format === "graph_json") return { content: [{ type: "text" as const, text: JSON.stringify(toGraphJson(g), null, 2) }] };
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

