#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources.js";

const require = createRequire(import.meta.url);

// Version comes from package.json rather than a literal here. The MCP registry
// rejects a server.json whose version doesn't match the published npm version,
// so every extra copy of the version string is one more thing to forget on
// release. Resolves to <pkg>/package.json from dist/index.js in both layouts
// (git clone and npm install) because dist/ sits directly under the root.
const { version } = require("../package.json") as { version: string };

const server = new McpServer({
  name: "sui-mcp",
  version,
});

registerAllTools(server);
registerAllResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
