#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources.js";

const server = new McpServer({
  name: "sui-mcp",
  version: "0.1.0",
});

registerAllTools(server);
registerAllResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
