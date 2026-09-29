import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { leadsWithBinaryTool, toolCallsIn, unknownToolsIn } from "./helpers/tool-names.js";
import { registerAllTools } from "../src/tools/index.js";
import { registerAllResources } from "../src/resources.js";
import { PROMPTS, SKILL_URL, registerAllPrompts } from "../src/prompts.js";
import { serverInstructions } from "../src/tools/toolset.js";
import { DEFAULT_PROFILES, PROFILES, allProfiledTools, toolsForProfiles, type ProfileName } from "../src/tools/profiles.js";

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

/**
 * The address and digest prefixes the incident cases name, as guidance would
 * abbreviate them (`0x1234abcd…`, `use 1234abcd…`, `AbCd1234…`). A verified
 * coin's package and a system address are shared infrastructure, not a fact
 * of one case.
 */
function caseIdentifierPrefixes(): string[] {
  const dir = new URL("../cases/incidents/", import.meta.url);
  const text = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readFileSync(new URL(f, dir), "utf8"))
    .join("\n");
  const coins = JSON.parse(readFileSync(new URL("../src/data/coins.json", import.meta.url), "utf8")) as { coins: { coin_type: string }[] };
  const shared = new Set(coins.coins.map((c) => c.coin_type.split("::")[0].toLowerCase()));
  const addresses = (text.match(/0x(?:[0-9a-f]{64}|[0-9a-f]{40})(?![0-9a-f])/gi) ?? [])
    .map((a) => a.toLowerCase())
    .filter((a) => !shared.has(a) && !a.startsWith("0x00000000"))
    .map((a) => a.slice(0, 10));
  const digests = (text.match(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{43,44}(?![1-9A-HJ-NP-Za-km-z])/g) ?? []).map((d) => d.slice(0, 8));
  return [...new Set([...addresses, ...digests])];
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
    for (const name of ["get_transaction", "get_transactions", "get_object", "find_funding_sources", "screen_address"]) {
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

  it("lead an exploit's mechanism to tools every install has", () => {
    const text = client.getInstructions() ?? "";
    for (const tool of ["decode_ptb", "get_move_function", "disassemble_module", "get_package", "get_object", "diff_package_upgrade"]) {
      expect(text, tool).toMatch(new RegExp(`\\b${tool}\\b`));
    }
    expect(leadsWithBinaryTool(text)).toBe(false);
  });
});

/** Arguments rendering a prompt: every required one, or every one with `all`. */
const promptArgs = (name: string, all = false) =>
  Object.fromEntries(PROMPTS[name].args.filter((a) => all || a.required).map((a) => [a.name, ADDR]));

/** A prompt task's numbered steps, each with the indented lines under it. */
function numberedSteps(task: string): string[] {
  const steps: string[] = [];
  for (const line of task.split("\n")) {
    if (/^\d+\. /.test(line)) steps.push(line);
    else if (/^\s+\S/.test(line) && steps.length > 0) steps[steps.length - 1] += `\n${line}`;
  }
  return steps;
}

describe("prompts", () => {
  it("lists the investigation and everyday prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "attribute_cluster",
      "investigate_address",
      "trace_incident",
      "was_i_scammed",
      "what_happened_to_my_funds",
      "who_controls_this_protocol",
      "who_controls_this_token",
      "who_is_this_wallet",
    ]);
  });

  it("requires only the arguments a prompt marks required", async () => {
    await expect(client.getPrompt({ name: "what_happened_to_my_funds", arguments: { digest: ADDR } })).resolves.toBeDefined();
    await expect(client.getPrompt({ name: "what_happened_to_my_funds", arguments: {} })).resolves.toBeDefined();
    await expect(client.getPrompt({ name: "who_controls_this_token", arguments: {} })).rejects.toThrow();
  });

  // The protocol makes `arguments` optional in prompts/get.
  it("renders a prompt whose arguments are all optional when the request has no arguments field", async () => {
    const res = await client.getPrompt({ name: "what_happened_to_my_funds" });
    expect(res.messages).toHaveLength(1);
    await expect(client.getPrompt({ name: "who_is_this_wallet" })).rejects.toThrow();
  });

  // A client that saved the former name keeps getting the prompt for the
  // release after the rename, told the new name in the first line.
  it("renders what_happened_to_my_funds under its former name was_i_scammed, after a first line naming the new one", async () => {
    const { prompts } = await client.listPrompts();
    const text = async (name: string, args: Record<string, string>) => {
      const content = (await client.getPrompt({ name, arguments: args })).messages[0].content;
      return content.type === "text" ? content.text : "";
    };
    const former = prompts.find((p) => p.name === "was_i_scammed");
    expect(former?.arguments).toEqual(prompts.find((p) => p.name === "what_happened_to_my_funds")?.arguments);
    for (const args of [{ address: ADDR, digest: ADDR }, {}]) {
      const [first, ...rest] = (await text("was_i_scammed", args)).split("\n");
      expect(first).toMatch(/\bwhat_happened_to_my_funds\b/);
      expect(rest.join("\n").trimStart()).toBe(await text("what_happened_to_my_funds", args));
    }
  });

  // Someone asking has usually lost funds already, so what can still be lost
  // is settled before how it happened and where the funds went.
  it("walks what_happened_to_my_funds from stopping further loss to how it happened, then where the funds went", () => {
    const steps = numberedSteps(PROMPTS.what_happened_to_my_funds.task({ digest: ADDR }));
    const stepOf = (pattern: RegExp) => steps.findIndex((s) => pattern.test(s));
    const standingAccess = stepOf(/`delegated_to`/);
    const drainerCheck = stepOf(/\banalyze_attack_tx\b/);
    const trace = stepOf(/\btrace_funds\b/);
    expect(standingAccess).toBeGreaterThanOrEqual(0);
    expect(standingAccess).toBeLessThan(drainerCheck);
    expect(drainerCheck).toBeLessThan(trace);
  });

  it("renders the task with the skill's method", async () => {
    const res = await client.getPrompt({ name: "investigate_address", arguments: { address: ADDR } });
    const text = (res.messages[0].content as { text: string }).text;
    expect(text).toContain(`Investigate the Sui address ${ADDR}`);
    expect(text).toContain("## Conclusions to refuse");
    expect(text).toContain("network: 'mainnet'");
  });

  it("name only tools that exist, and no binary-only tool ahead of one every install has", async () => {
    const names = new Set(tools.map((t) => t.name));
    for (const name of Object.keys(PROMPTS)) {
      const res = await client.getPrompt({ name, arguments: promptArgs(name) });
      const content = res.messages[0].content;
      const text = content.type === "text" ? content.text : "";
      expect(unknownToolsIn(text, names), name).toEqual([]);
      expect(leadsWithBinaryTool(text), name).toBe(false);
    }
    expect(leadsWithBinaryTool(readFileSync(SKILL_URL, "utf8"))).toBe(false);
  });

  // A prompt that names a tool the server lacks, an argument its schema
  // rejects, or a tool whose profile is off without saying how to turn it on
  // sends the model into a failed call.
  it("call only registered tools, with arguments and values their schemas accept, enabling each tool's profile", async () => {
    const defaultTools = toolsForProfiles(DEFAULT_PROFILES);
    const profiled = allProfiledTools();
    const mentions = (text: string) => tools.map((t) => t.name).filter((t) => new RegExp(`\\b${t}\\b`).test(text));
    for (const name of Object.keys(PROMPTS)) {
      const task = PROMPTS[name].task(promptArgs(name, true));
      const calls = toolCallsIn(task);
      if (calls.length === 0) continue;
      // Every tool the task mentions is spelled as a call, so every one is checked.
      expect(mentions(task).filter((t) => !calls.some((c) => c.tool === t)), name).toEqual([]);
      for (const call of calls) {
        const tool = tools.find((t) => t.name === call.tool);
        expect(tool, `${name}: ${call.tool}`).toBeDefined();
        const props = (tool!.inputSchema.properties ?? {}) as Record<string, { enum?: unknown[] }>;
        for (const arg of call.args) {
          expect(props[arg.name], `${name}: ${call.tool}(${arg.name})`).toBeDefined();
          const allowed = props[arg.name]?.enum;
          if (allowed && arg.value !== undefined) expect(allowed, `${name}: ${call.tool}(${arg.name}: ${arg.value})`).toContain(arg.value);
        }
      }
      // Every tool the rendered prompt names, carried skill text included, is
      // reachable through the profiles it enables.
      const enabled = calls
        .filter((c) => c.tool === "enable_tools")
        .flatMap((c) => c.args.filter((a) => a.name === "profile").map((a) => a.value as ProfileName));
      const reachable = new Set([...defaultTools, ...enabled.flatMap((p) => PROFILES[p] ?? [])]);
      const res = await client.getPrompt({ name, arguments: promptArgs(name, true) });
      const content = res.messages[0].content;
      const rendered = content.type === "text" ? content.text : "";
      const unreachable = mentions(rendered).filter((t) => profiled.has(t) && !reachable.has(t));
      expect(unreachable, `${name} names tools it never enables`).toEqual([]);
    }
  });

  // A step marks the profile its tools need, and the model enables only that
  // one when it reaches the step, so a wrong mark leaves the call unavailable.
  it("mark each step outside the default profile with a profile that holds its tools", () => {
    const defaultTools = toolsForProfiles(DEFAULT_PROFILES);
    for (const name of Object.keys(PROMPTS)) {
      const steps = numberedSteps(PROMPTS[name].task(promptArgs(name, true)));
      for (const step of steps) {
        const marks = [...step.matchAll(/\((forensics|developer|market)\b/g)].map((m) => m[1] as ProfileName);
        for (const call of toolCallsIn(step)) {
          if (defaultTools.has(call.tool)) continue;
          const covered = marks.some((p) => (PROFILES[p] as readonly string[]).includes(call.tool));
          expect(covered, `${name}: ${call.tool} in a step marked ${marks.join(",") || "nothing"}`).toBe(true);
        }
      }
    }
  });

  // The flaw is found by reading the code the exploit ran, and a fixing or
  // introducing upgrade need not exist, so the steps read code before diffing.
  // The calls' arguments come from decode_ptb, a fraction of get_transaction's
  // full detail.
  it("walks trace_incident from the exploit's calls to the code that ran, then its dependencies, then diffs", () => {
    const steps = PROMPTS.trace_incident.task({ subject: ADDR });
    const at = (tool: string) => steps.search(new RegExp(`\\b${tool}\\b`));
    for (const tool of ["decode_ptb", "get_upgrade_history", "get_move_function", "disassemble_module", "get_package", "diff_package_upgrade", "get_object"]) {
      expect(at(tool), tool).toBeGreaterThanOrEqual(0);
    }
    const full = at("get_transaction");
    expect(full < 0 || at("decode_ptb") < full).toBe(true);
    expect(at("disassemble_module")).toBeLessThan(at("get_package"));
    expect(at("get_package")).toBeLessThan(at("diff_package_upgrade"));
    expect(steps).not.toMatch(/\bdecompile_module\b/);
  });

  // Held-out rounds measure whether the method finds a mechanism it was never
  // shown, so the guidance a client receives names no case's addresses or
  // digests, in full or abbreviated.
  it("carry no address or digest from an incident case", async () => {
    const served = [client.getInstructions() ?? "", readFileSync(SKILL_URL, "utf8")];
    for (const name of Object.keys(PROMPTS)) {
      const res = await client.getPrompt({ name, arguments: promptArgs(name, true) });
      const content = res.messages[0].content;
      served.push(content.type === "text" ? content.text : "");
    }
    for (const t of tools) served.push(t.description ?? "", JSON.stringify(t.inputSchema));
    const text = served.join("\n");
    const found = caseIdentifierPrefixes().filter((p) =>
      p.startsWith("0x")
        ? new RegExp(`(?<![0-9a-z])(?:0x)?${p.slice(2)}`, "i").test(text)
        : new RegExp(`(?<![1-9A-HJ-NP-Za-km-z])${p}`).test(text),
    );
    expect(found).toEqual([]);
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
