import { registerChainTools } from "./chain.js";
import { registerObjectTools } from "./objects.js";
import { registerCoinTools } from "./coins.js";
import { registerTransactionTools } from "./transactions.js";
import { registerEventTools } from "./events.js";
import { registerPackageTools } from "./packages.js";
import { registerExecuteTools } from "./execute.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerAllTools(server: McpServer) {
  registerChainTools(server);
  registerObjectTools(server);
  registerCoinTools(server);
  registerTransactionTools(server);
  registerEventTools(server);
  registerPackageTools(server);
  registerExecuteTools(server);
}
