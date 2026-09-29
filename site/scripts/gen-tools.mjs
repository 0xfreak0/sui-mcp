#!/usr/bin/env node
/**
 * Regenerate the tool and prompt reference under src/content/docs/reference/
 * from the server built at the repo root (../dist/index.js).
 *
 * Starts the server over stdio with SUI_TOOLS=all, reads tools/list and
 * prompts/list with the MCP SDK client installed at the repo root, and writes
 * one page per tool group, the tools index, the profile list partial that
 * guides/tool-profiles.mdx imports, and the prompts page. The output is
 * committed; test/site-tool-reference.test.ts fails when it is stale.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROMPTS_PAGE, TOOLS_DIR, renderReference } from "./tool-reference.mjs";

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(siteDir, "..");
const docsDir = join(siteDir, "src/content/docs");
const serverEntry = join(root, "dist/index.js");
const profilesModule = join(root, "dist/tools/profiles.js");

function fail(message) {
  console.error(`gen-tools: ${message}`);
  process.exit(1);
}

if (!existsSync(serverEntry) || !existsSync(profilesModule)) {
  fail(`${serverEntry} not found. Run \`npm run build\` at the repo root (${root}) first.`);
}

const require = createRequire(join(root, "package.json"));
let sdk;
try {
  sdk = {
    ...require("@modelcontextprotocol/sdk/client/index.js"),
    ...require("@modelcontextprotocol/sdk/client/stdio.js"),
  };
} catch {
  fail(`@modelcontextprotocol/sdk not found under ${root}/node_modules. Run \`npm install\` at the repo root first.`);
}
const { Client, StdioClientTransport, getDefaultEnvironment } = sdk;

async function listAll(fetchPage, key) {
  const items = [];
  let cursor;
  do {
    const page = await fetchPage(cursor ? { cursor } : undefined);
    items.push(...page[key]);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...getDefaultEnvironment(), SUI_TOOLS: "all" },
  stderr: "inherit",
});
const client = new Client({ name: "sui-mcp-docs-gen", version: "1" });
await client.connect(transport);
let tools;
let prompts;
try {
  tools = await listAll((params) => client.listTools(params), "tools");
  prompts = await listAll((params) => client.listPrompts(params), "prompts");
} finally {
  await client.close();
}

const { PROFILES, DEFAULT_PROFILES, PROFILE_SUMMARIES } = await import(pathToFileURL(profilesModule).href);
let pages;
try {
  pages = renderReference({
    tools,
    prompts,
    profiles: PROFILES,
    defaultProfiles: DEFAULT_PROFILES,
    profileSummaries: PROFILE_SUMMARIES,
  });
} catch (err) {
  fail(err.message);
}

rmSync(join(docsDir, TOOLS_DIR), { recursive: true, force: true });
rmSync(join(docsDir, PROMPTS_PAGE), { force: true });
for (const [path, content] of pages) {
  const file = join(docsDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
console.log(`gen-tools: ${tools.length} tools, ${prompts.length} prompts, ${pages.size} files written to ${docsDir}/reference/`);
