/**
 * Render a graph of addresses and transfers as Mermaid, as a node/edge JSON
 * document, or as CSV. Shared by `trace_flow_graph`, `find_flow_path`,
 * `trace_funds`, `build_wallet_edges` and `export_case`, so every tool draws
 * the same shapes and escapes labels the same way. Pure.
 */

export const EXPORT_FORMATS = ["json", "mermaid", "graph_json", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Drawing role of a node; picks its Mermaid shape and style. */
export type ExportNodeKind =
  | "wallet"
  | "origin"
  | "seed"
  | "bridge_exit"
  | "sink"
  | "hub"
  | "protocol"
  | "consumed"
  | "source"
  | "object"
  | "unspent"
  | "budget"
  | "target"
  | "foreign"
  | "note";

export interface ExportNode {
  id: string;
  /** One entry per rendered line. */
  label: string[];
  kind: ExportNodeKind;
  attrs?: Record<string, unknown>;
}

export interface ExportEdge {
  from: string;
  to: string;
  label: string;
  /** Dashed for a branch that was seen but not followed, or an inferred link. */
  dashed?: boolean;
  attrs?: Record<string, unknown>;
}

export interface ExportGraph {
  directed: boolean;
  nodes: ExportNode[];
  edges: ExportEdge[];
  /** Mermaid subgraphs: a title and the ids inside it. */
  groups?: Array<{ title: string; members: string[] }>;
}

/** `0x0122…c724`: enough to tell addresses apart in a diagram, with the full one in the JSON. */
export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * Text safe inside a quoted Mermaid label.
 *
 * Mermaid reads `#name;` as an entity, so `#` is escaped first and the other
 * characters that end or reinterpret a label (`"`, `|`, `<`, `>`, a backtick,
 * which starts a markdown string) become entities after it. Line breaks are
 * the renderer's `<br/>`, added between lines by the caller, never taken
 * from the text.
 */
export function mermaidText(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/\|/g, "#124;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/`/g, "#96;")
    .trim();
}

const SHAPES: Record<ExportNodeKind, [string, string]> = {
  wallet: ["[", "]"],
  origin: ["([", "])"],
  seed: ["[[", "]]"],
  bridge_exit: ["{{", "}}"],
  sink: ["[[", "]]"],
  hub: ["[[", "]]"],
  protocol: ["[[", "]]"],
  consumed: ["[(", ")]"],
  source: ["[(", ")]"],
  object: ["[", "]"],
  unspent: ["(", ")"],
  budget: ["[", "]"],
  target: ["[[", "]]"],
  foreign: ["{{", "}}"],
  note: ["[", "]"],
};

const STYLES: Partial<Record<ExportNodeKind, string>> = {
  origin: "fill:#e8eaf6,stroke:#3949ab",
  seed: "fill:#e8eaf6,stroke:#3949ab",
  bridge_exit: "fill:#fde2e2,stroke:#c0392b",
  foreign: "fill:#fde2e2,stroke:#c0392b",
  sink: "fill:#fff3cd,stroke:#b8860b",
  hub: "fill:#fff3cd,stroke:#b8860b",
  target: "fill:#d4edda,stroke:#2e7d32",
  protocol: "fill:#eeeeee,stroke:#757575",
  consumed: "fill:#eeeeee,stroke:#757575",
  source: "fill:#eeeeee,stroke:#757575",
  unspent: "fill:#e3f2fd,stroke:#1565c0",
  budget: "fill:#ffffff,stroke:#9e9e9e,stroke-dasharray:4 3",
  note: "fill:#ffffff,stroke:#9e9e9e",
};

/**
 * A Mermaid `flowchart`, fenced so it renders in a markdown viewer.
 *
 * Node ids are `n0`, `n1`, … whatever the caller's ids are: an address or a
 * `kind:…` id holds characters Mermaid reads as syntax. Labels are always
 * quoted and escaped.
 */
export function toMermaid(g: ExportGraph, opts: { direction?: "LR" | "TD"; fenced?: boolean } = {}): string {
  const ids = new Map<string, string>();
  g.nodes.forEach((n, i) => ids.set(n.id, `n${i}`));
  const lines = [`flowchart ${opts.direction ?? "LR"}`];
  const inGroup = new Set((g.groups ?? []).flatMap((gr) => gr.members));
  const decl = (n: ExportNode) => {
    const [open, close] = SHAPES[n.kind];
    return `${ids.get(n.id)}${open}"${n.label.map(mermaidText).filter(Boolean).join("<br/>")}"${close}`;
  };
  for (const n of g.nodes) if (!inGroup.has(n.id)) lines.push(`  ${decl(n)}`);
  (g.groups ?? []).forEach((gr, i) => {
    lines.push(`  subgraph g${i}["${mermaidText(gr.title)}"]`);
    for (const id of gr.members) {
      const n = g.nodes.find((x) => x.id === id);
      if (n) lines.push(`    ${decl(n)}`);
    }
    lines.push("  end");
  });
  for (const e of g.edges) {
    const a = ids.get(e.from);
    const b = ids.get(e.to);
    if (!a || !b) continue;
    const arrow = g.directed ? (e.dashed ? "-.->" : "-->") : e.dashed ? "-.-" : "---";
    const label = mermaidText(e.label);
    lines.push(label ? `  ${a} ${arrow}|"${label}"| ${b}` : `  ${a} ${arrow} ${b}`);
  }
  const byKind = new Map<ExportNodeKind, string[]>();
  for (const n of g.nodes) {
    if (!STYLES[n.kind]) continue;
    byKind.set(n.kind, [...(byKind.get(n.kind) ?? []), ids.get(n.id)!]);
  }
  for (const [kind, members] of byKind) {
    lines.push(`  classDef ${kind} ${STYLES[kind]}`);
    lines.push(`  class ${members.join(",")} ${kind}`);
  }
  const body = lines.join("\n");
  return opts.fenced === false ? body : "```mermaid\n" + body + "\n```";
}

/** Nodes and edges as plain JSON, the shape graph tools (Cytoscape, Gephi importers, networkx) read. */
export function toGraphJson(g: ExportGraph): {
  directed: boolean;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
} {
  return {
    directed: g.directed,
    nodes: g.nodes.map((n) => ({ id: n.id, label: n.label.join(" — "), kind: n.kind, ...(n.attrs ?? {}) })),
    edges: g.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      label: e.label,
      ...(e.dashed ? { dashed: true } : {}),
      ...(e.attrs ?? {}),
    })),
  };
}

/** One RFC 4180 field: quoted when it holds a comma, quote or line break. */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join(" ") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A header row and one row per record, in `columns` order. */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => csvField(r[c])).join(","))].join("\n");
}
