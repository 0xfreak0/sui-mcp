import { describe, it, expect } from "vitest";
import { mermaidText, toCsv, toGraphJson, toMermaid, type ExportGraph } from "../src/utils/flow-export.js";

/**
 * Mermaid flowchart syntax, as far as these renderers emit it. Each line must
 * be one of the forms below, labels must stay inside their quotes, and every
 * edge must name declared nodes: a label that breaks out of its quotes or an
 * id with syntax in it makes the whole diagram fail to render.
 */
function assertValidMermaid(text: string): void {
  const lines = text.split("\n");
  expect(lines[0]).toBe("```mermaid");
  expect(lines.at(-1)).toBe("```");
  expect(lines[1]).toMatch(/^flowchart (LR|TD)$/);
  const QUOTED = '"[^"]*"';
  const SHAPE = [
    ["\\[", "\\]"],
    ["\\(\\[", "\\]\\)"],
    ["\\{\\{", "\\}\\}"],
    ["\\[\\[", "\\]\\]"],
    ["\\[\\(", "\\)\\]"],
    ["\\(", "\\)"],
  ]
    .map(([o, c]) => `${o}${QUOTED}${c}`)
    .join("|");
  const node = new RegExp(`^\\s+(n\\d+)(?:${SHAPE})$`);
  const edge = new RegExp(`^\\s+(n\\d+) (?:-->|-\\.->|---|-\\.-)(?:\\|${QUOTED}\\|)? (n\\d+)$`);
  const declared = new Set<string>();
  const used: string[] = [];
  let depth = 0;
  for (const line of lines.slice(2, -1)) {
    const n = node.exec(line);
    if (n) {
      declared.add(n[1]);
      // Inside the quotes only entities and <br/> may carry markup.
      const label = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
      expect(label.replace(/<br\/>/g, "")).not.toMatch(/[<>"`|]/);
      continue;
    }
    const e = edge.exec(line);
    if (e) {
      used.push(e[1], e[2]);
      continue;
    }
    if (/^\s+subgraph g\d+\["[^"]*"\]$/.test(line)) {
      depth++;
      continue;
    }
    if (/^\s+end$/.test(line)) {
      depth--;
      continue;
    }
    if (/^\s+classDef [a-z_]+ [\w:#,\-. ]+$/.test(line)) continue;
    if (/^\s+class n\d+(,n\d+)* [a-z_]+$/.test(line)) continue;
    throw new Error(`not a Mermaid flowchart line: ${line}`);
  }
  expect(depth).toBe(0);
  for (const id of used) expect(declared.has(id)).toBe(true);
}

const hostile = 'Evil "name" | <script> #1 `x`\nnext';

const graph: ExportGraph = {
  directed: true,
  nodes: [
    { id: "0xabc|0x2::sui::SUI", label: [hostile, "0xa1b2…c3d4"], kind: "wallet" },
    { id: "exit:Circle CCTP:eip155:1:0x1354", label: ["Circle CCTP → Ethereum 0x1354…645c"], kind: "bridge_exit" },
    { id: "tx:19Zkat", label: ["tx 19Zkat…"], kind: "origin" },
    { id: "consumed:0xabc:Suilend", label: ["Suilend"], kind: "consumed" },
  ],
  edges: [
    { from: "tx:19Zkat", to: "0xabc|0x2::sui::SUI", label: "144,834.9 SUI ($493.9K)" },
    { from: "0xabc|0x2::sui::SUI", to: "exit:Circle CCTP:eip155:1:0x1354", label: "699930 USDC | 3 txs" },
    { from: "0xabc|0x2::sui::SUI", to: "consumed:0xabc:Suilend", label: "", dashed: true },
    { from: "0xabc|0x2::sui::SUI", to: "missing", label: "dropped" },
  ],
  groups: [{ title: 'cluster "1"', members: ["consumed:0xabc:Suilend"] }],
};

describe("mermaidText", () => {
  it("escapes everything that ends or reinterprets a quoted label", () => {
    expect(mermaidText(hostile)).toBe("Evil #quot;name#quot; #124; #lt;script#gt; #35;1 #96;x#96; next");
  });
});

describe("toMermaid", () => {
  it("emits a diagram that follows flowchart syntax whatever the labels hold", () => {
    assertValidMermaid(toMermaid(graph));
  });

  it("draws an undirected graph with plain links", () => {
    const text = toMermaid({ ...graph, directed: false, groups: [] });
    assertValidMermaid(text);
    expect(text).not.toContain("-->");
    expect(text).toContain("---");
  });

  it("never uses a caller's id as a Mermaid id", () => {
    // Addresses and `kind:…` ids hold `:` and `|`, which Mermaid parses.
    const text = toMermaid(graph);
    expect(text).not.toContain("exit:Circle");
    expect(text).toMatch(/n0\["Evil/);
  });
});

describe("toGraphJson", () => {
  it("keeps the caller's ids so edges can be joined back to the full JSON", () => {
    const g = toGraphJson(graph);
    expect(g.edges[0]).toMatchObject({ source: "tx:19Zkat", target: "0xabc|0x2::sui::SUI" });
    expect(g.nodes[1]).toMatchObject({ id: "exit:Circle CCTP:eip155:1:0x1354", kind: "bridge_exit" });
  });
});

describe("toCsv", () => {
  it("quotes fields holding commas, quotes or line breaks", () => {
    const csv = toCsv(["a", "b", "c"], [{ a: 'say "hi"', b: "x,y", c: ["d1", "d2"] }, { a: "line\nbreak", b: null }]);
    expect(csv.split("\n")[0]).toBe("a,b,c");
    expect(csv).toContain('"say ""hi""","x,y",d1 d2');
    expect(csv).toContain('"line\nbreak",,');
  });
});
