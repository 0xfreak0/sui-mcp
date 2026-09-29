import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../../src/tools/index.js";

export interface RegisteredTool {
  name: string;
  /** The tool description and every parameter description. */
  texts: string[];
}

/** Every tool `registerAllTools` registers, with the text a client sees. */
export function registeredTools(): RegisteredTool[] {
  const out: RegisteredTool[] = [];
  const fake = {
    // registerAllTools wraps the protocol server's request handler to explain
    // calls to disabled tools, so the fake has to expose one.
    server: { setRequestHandler() {} },
    registerTool(
      name: string,
      config: { description?: string; inputSchema: { shape: Record<string, { description?: string }> } },
    ) {
      const params = Object.values(config.inputSchema.shape)
        .map((s) => s?.description)
        .filter((d): d is string => typeof d === "string");
      out.push({ name, texts: [config.description ?? "", ...params] });
      return { enabled: true, enable() {}, disable() {}, update() {} };
    },
  } as unknown as McpServer;
  registerAllTools(fake);
  return out;
}

/** Identifiers shaped like this server's tool names. */
const TOOL_LIKE =
  /\b(?:get|list|find|trace|analyze|resolve|check|query|identify|decode|diff|simulate|manage|save|export|delete|watch|poll|aggregate|search|decompile|disassemble|build|compare|mvr|enable)_[a-z0-9_]+\b/g;

/**
 * Tool-shaped names in `text` that no registered tool answers to. A name
 * spelled as an argument (`find_redeploys: true`) is a parameter there, so
 * that spelling is skipped.
 */
export function unknownToolsIn(text: string, names: Set<string>): string[] {
  const bare = text.replace(/`[a-z0-9_]+:/g, "`:");
  return [...new Set(bare.match(TOOL_LIKE) ?? [])].filter((n) => !names.has(n));
}

export interface ToolCall {
  tool: string;
  /** Each argument as written; `value` is set for `name: value`, unquoted. */
  args: Array<{ name: string; value?: string }>;
}

/**
 * The tool calls a prompt spells as `` `tool_name(arg, arg: 'value')` ``.
 * Values in the prompts never contain a comma, so arguments split on commas.
 */
export function toolCallsIn(text: string): ToolCall[] {
  return [...text.matchAll(/`([a-z][a-z0-9_]*)\(([^`)]*)\)`/g)].map(([, tool, list]) => ({
    tool,
    args: list
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => {
        const colon = a.indexOf(":");
        if (colon < 0) return { name: a };
        return { name: a.slice(0, colon).trim(), value: a.slice(colon + 1).trim().replace(/^'(.*)'$/, "$1") };
      }),
  }));
}

/** Tools that need an external binary the server does not ship. */
const BINARY_TOOLS = ["decompile_module"];
/** Code readers that need nothing beyond the install. */
const BINARY_FREE_CODE_TOOLS = ["disassemble_module", "get_move_function", "diff_package_upgrade"];

/**
 * Whether `text` names a binary-only tool before any binary-free code reader.
 * Guidance must lead with the tools every install has.
 */
export function leadsWithBinaryTool(text: string): boolean {
  const first = (names: string[]) =>
    Math.min(...names.map((n) => text.search(new RegExp(`\\b${n}\\b`))).map((i) => (i < 0 ? Infinity : i)));
  const binary = first(BINARY_TOOLS);
  return binary !== Infinity && binary < first(BINARY_FREE_CODE_TOOLS);
}
