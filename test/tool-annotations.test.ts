import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { unknownToolsIn } from "./helpers/tool-names.js";
import { registerAllTools } from "../src/tools/index.js";
import { registerAllResources } from "../src/resources.js";
import { registerAllPrompts } from "../src/prompts.js";
import { serverInstructions } from "../src/tools/toolset.js";

/**
 * The MCP metadata every tool carries (annotations, title, the injected
 * `network` argument), checked on the tools/list a client receives. Clients
 * decide from `readOnlyHint` whether a call needs the user's approval, so a
 * tool that writes the store and says it does not is auto-approved.
 */

// The only chain read the store-writing tools make: the current checkpoint a
// new watch starts from.
vi.mock("../src/clients/graphql.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  gqlQuery: vi.fn(async () => ({ checkpoint: { sequenceNumber: 200 } })),
}));

const ADDR = `0xab${"1".repeat(62)}`;
// Set before the imports run: the store opens on first use and keeps its
// path. vi.hoisted runs ahead of the static imports, so it imports its own.
const { dir, storePath } = await vi.hoisted(async () => {
  const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([
    import("node:fs"),
    import("node:os"),
    import("node:path"),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "sui-annotations-"));
  const storePath = join(dir, "store.db");
  process.env.SUI_STORE_PATH = storePath;
  return { dir, storePath };
});

async function connect(profiles: string) {
  process.env.SUI_TOOLS = profiles;
  const server = new McpServer({ name: "test", version: "0" }, { instructions: serverInstructions() });
  registerAllTools(server);
  registerAllResources(server);
  registerAllPrompts(server);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function rows(table: string): number {
  const db = new DatabaseSync(storePath);
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

let client: Client;
let tools: Tool[];
const byName = (name: string) => tools.find((t) => t.name === name)!;

beforeAll(async () => {
  client = await connect("all");
  tools = (await client.listTools()).tools;
});

afterAll(async () => {
  await client.close();
  delete process.env.SUI_STORE_PATH;
  delete process.env.SUI_TOOLS;
  rmSync(dir, { recursive: true, force: true });
});

describe("tool annotations", () => {
  it("gives every tool a title and read-only and open-world hints", () => {
    const missing = tools
      .filter(
        (t) =>
          !t.title ||
          typeof t.annotations?.readOnlyHint !== "boolean" ||
          typeof t.annotations?.openWorldHint !== "boolean",
      )
      .map((t) => t.name);
    expect(tools.length).toBeGreaterThan(60);
    expect(missing).toEqual([]);
  });

  /**
   * Each call writes to the store; the row count proves it did. A call that
   * removes a row must come from a tool marked destructive. Every tool marked
   * as writing must appear here, so the list and the annotations cannot drift
   * apart.
   */
  const writes: Array<{ tool: string; args: () => Record<string, unknown>; table: string; delta: number }> = [
    {
      tool: "save_finding",
      args: () => ({ case_name: "case-a", title: "Funded by the exploiter", detail: "d", addresses: [ADDR] }),
      table: "findings",
      delta: 1,
    },
    { tool: "delete_finding", args: () => ({ finding_id: 1 }), table: "findings", delta: -1 },
    {
      tool: "manage_labels",
      args: () => ({ action: "add", address: ADDR, label: "Exchange", category: "cex" }),
      table: "labels",
      delta: 1,
    },
    { tool: "manage_labels", args: () => ({ action: "remove", address: ADDR }), table: "labels", delta: -1 },
    { tool: "watch_addresses", args: () => ({ action: "add", addresses: [ADDR] }), table: "watches", delta: 1 },
    { tool: "watch_addresses", args: () => ({ action: "remove", addresses: [ADDR] }), table: "watches", delta: -1 },
  ];

  it.each(writes.map((w) => [`${w.tool} ${JSON.stringify(w.args())}`, w] as const))(
    "marks %s as a write",
    async (_label, w) => {
      const before = rows(w.table);
      const res = await client.callTool({ name: w.tool, arguments: w.args() });
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      expect(rows(w.table) - before).toBe(w.delta);
      expect(byName(w.tool).annotations?.readOnlyHint).toBe(false);
      if (w.delta < 0) expect(byName(w.tool).annotations?.destructiveHint).toBe(true);
    },
  );

  it("marks as writing only tools that write", () => {
    // poll_watch advances each watch's cursor; it has no row count to show,
    // so it is checked by name.
    const writers = new Set([...writes.map((w) => w.tool), "poll_watch"]);
    const markedWriting = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
    expect(markedWriting.sort()).toEqual([...writers].sort());
  });
});

describe("the injected network argument", () => {
  const hasNetwork = (t: Tool) => "network" in (t.inputSchema.properties ?? {});

  it("is left out of tools that only read or write the local store", () => {
    for (const name of ["list_findings", "export_case", "delete_finding", "enable_tools"]) {
      expect(hasNetwork(byName(name)), name).toBe(false);
    }
  });

  it("stays on tools that qualify a bare address with the call's network", () => {
    for (const name of ["save_finding", "manage_labels", "watch_addresses", "get_balance"]) {
      expect(hasNetwork(byName(name)), name).toBe(true);
    }
  });

  // A tool without the argument always runs on the default network, so it
  // must not be one that reads the chain.
  it("is only missing from tools that stay off the chain", () => {
    const offChainWithoutNetwork = tools.filter((t) => !hasNetwork(t) && t.annotations?.openWorldHint !== false);
    expect(offChainWithoutNetwork.map((t) => t.name)).toEqual([]);
  });
});

describe("result size", () => {
  it("declares the result-size ceiling on tools whose completeness is policy", () => {
    for (const name of ["get_transaction", "get_transactions", "find_funding_sources", "screen_address"]) {
      expect(byName(name)._meta?.["anthropic/maxResultSizeChars"], name).toBe(500_000);
    }
  });
});

describe("server instructions", () => {
  it("fit Claude Code's limit and name only tools and prompts that exist", async () => {
    const text = client.getInstructions() ?? "";
    const { prompts } = await client.listPrompts();
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(2048);
    expect(unknownToolsIn(text, new Set([...tools, ...prompts].map((t) => t.name)))).toEqual([]);
  });
});

describe("prompts", () => {
  it("lists the three investigation prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["attribute_cluster", "investigate_address", "trace_incident"]);
  });

  it("renders the task with the skill's method", async () => {
    const res = await client.getPrompt({ name: "investigate_address", arguments: { address: ADDR } });
    const text = (res.messages[0].content as { text: string }).text;
    expect(text).toContain(`Investigate the Sui address ${ADDR}`);
    expect(text).toContain("## Conclusions to refuse");
    expect(text).toContain("network: 'mainnet'");
  });
});

describe("case resource", () => {
  it("lists recorded cases and renders one as the export_case report", async () => {
    await client.callTool({
      name: "save_finding",
      arguments: { case_name: "case b", title: "Shared first funder", detail: "d" },
    });
    const { resources } = await client.listResources();
    const uri = resources.find((r) => r.name === "case b")?.uri;
    expect(uri).toBe("sui://case/case%20b");

    const read = await client.readResource({ uri: uri! });
    const exported = await client.callTool({ name: "export_case", arguments: { case_name: "case b" } });
    const report = (read.contents[0] as { text: string }).text;
    expect(report).toContain("Shared first funder");
    // Same document, less the generation time stamped into each.
    const strip = (s: string) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "");
    expect(strip(report)).toBe(strip((exported.content as Array<{ text: string }>)[0].text));
  });

  it("answers an unknown case with an error", async () => {
    await expect(client.readResource({ uri: "sui://case/nope" })).rejects.toThrow(/No findings recorded/);
  });
});

describe("enable_tools", () => {
  it("turns a profile on with one list-changed notification, in any case", async () => {
    const c = await connect("core");
    let notified = 0;
    const first = Promise.withResolvers<void>();
    c.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified++;
      first.resolve();
    });
    const before = (await c.listTools()).tools;
    expect(before.some((t) => t.name === "trace_funds")).toBe(false);
    expect(before.find((t) => t.name === "enable_tools")?.description).toContain("trace_funds");

    const res = await c.callTool({ name: "enable_tools", arguments: { profile: "Forensics" } });
    expect(res.isError).toBeFalsy();
    await first.promise;

    // Any further notification would have been sent before this response.
    const after = (await c.listTools()).tools;
    expect(notified).toBe(1);
    expect(after.some((t) => t.name === "trace_funds")).toBe(true);
    // Tools the model can now see are no longer spelled out.
    expect(after.find((t) => t.name === "enable_tools")?.description).not.toContain("trace_funds");
    await c.close();
  });
});
