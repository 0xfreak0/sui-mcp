import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../src/tools/index.js";
import { registerAllPrompts } from "../src/prompts.js";
import { DEFAULT_PROFILES, PROFILES } from "../src/tools/profiles.js";
import { PROMPTS_PAGE, TOOLS_DIR, renderReference } from "../site/scripts/tool-reference.mjs";

/**
 * The docs site's tool and prompt reference is generated from the server's
 * tools/list and prompts/list and committed (site/scripts/gen-tools.mjs), so
 * the site builds without the server. A tool, parameter or description change
 * that is not regenerated would publish a reference that no longer matches
 * what clients receive.
 */

const DOCS = new URL("../site/src/content/docs/", import.meta.url);
const REGENERATE = "run `npm run build`, then `npm run gen:tools` in site/, and commit the result";

let pages: Map<string, string>;
const previousTools = process.env.SUI_TOOLS;

beforeAll(async () => {
  // gen-tools.mjs starts the server with every profile on; the enable_tools
  // description names the active profiles.
  process.env.SUI_TOOLS = "all";
  const server = new McpServer({ name: "test", version: "0" });
  registerAllTools(server);
  registerAllPrompts(server);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts();
  await client.close();
  pages = renderReference({ tools, prompts, profiles: PROFILES, defaultProfiles: DEFAULT_PROFILES });
});

afterAll(() => {
  if (previousTools === undefined) delete process.env.SUI_TOOLS;
  else process.env.SUI_TOOLS = previousTools;
});

describe("site tool reference", () => {
  it("matches the current tool and prompt lists", () => {
    const stale = [...pages].filter(([path, content]) => {
      let committed: string | undefined;
      try {
        committed = readFileSync(new URL(path, DOCS), "utf8");
      } catch {
        committed = undefined;
      }
      return committed !== content;
    });
    expect(stale.map(([path]) => path), `stale reference pages: ${REGENERATE}`).toEqual([]);
  });

  it("has no page for a tool group that no longer exists", () => {
    const committed = readdirSync(new URL(`${TOOLS_DIR}/`, DOCS)).map((f) => `${TOOLS_DIR}/${f}`);
    const expected = [...pages.keys()].filter((p) => p !== PROMPTS_PAGE);
    expect(committed.sort(), REGENERATE).toEqual(expected.sort());
  });
});
