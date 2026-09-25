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
    tool(name: string, description: string, schema: Record<string, { description?: string }>) {
      const params = Object.values(schema ?? {})
        .map((s) => s?.description)
        .filter((d): d is string => typeof d === "string");
      out.push({ name, texts: [description, ...params] });
      return { enabled: true, enable() {}, disable() {} };
    },
  } as unknown as McpServer;
  registerAllTools(fake);
  return out;
}

/** Identifiers shaped like this server's tool names. */
const TOOL_LIKE =
  /\b(?:get|list|find|trace|analyze|resolve|check|query|identify|decode|diff|simulate|manage|save|export|delete|watch|poll|aggregate|search|decompile|disassemble|build|compare|mvr|enable)_[a-z0-9_]+\b/g;

/** Tool-shaped names in `text` that no registered tool answers to. */
export function unknownToolsIn(text: string, names: Set<string>): string[] {
  return [...new Set(text.match(TOOL_LIKE) ?? [])].filter((n) => !names.has(n));
}
