import { registerChainTools } from "./chain.js";
import { registerObjectTools } from "./objects.js";
import { registerCoinTools } from "./coins.js";
import { registerTransactionTools } from "./transactions.js";
import { registerEventTools } from "./events.js";
import { registerPackageTools } from "./packages.js";
import { registerExecuteTools } from "./execute.js";
import { registerDecompilerTools } from "./decompiler.js";
import { registerDisassemblyTools } from "./disassembly.js";
import { registerAnalyzePackageTools } from "./analyze-package.js";
import { registerNameTools } from "./names.js";
import { registerWorkflowTools } from "./workflow.js";
import { registerPriceTools } from "./prices.js";
import { registerDefiTools } from "./defi.js";
import { registerNftTools } from "./nft.js";
import { registerPtbTools } from "./ptb.js";
import { registerStakingTools } from "./staking.js";
import { registerHistoryTools } from "./history.js";
import { registerTokenSearchTools } from "./token-search.js";
import { registerMonitorTools } from "./monitor.js";
import { registerHolderTools } from "./holders.js";
import { registerDecodeTools } from "./decode.js";
import { registerTraceTools } from "./trace.js";
import { registerPoolTools } from "./pools.js";
import { registerDependencyTools } from "./dependencies.js";
import { registerIdentifyTools } from "./identify.js";
import { registerAnalyzeTokenTools } from "./analyze-token.js";
import { registerMvrTools } from "./mvr.js";
import { registerLabelTools } from "./labels.js";
import { registerPackageAuditTools } from "./package-audit.js";
import { withNetworkParam } from "./with-network.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerAllTools(rawServer: McpServer) {
  // Every tool gets an optional per-call `network` arg and runs inside that
  // network's async context. See ./with-network.ts.
  const server = withNetworkParam(rawServer);

  registerChainTools(server);
  registerObjectTools(server);
  registerCoinTools(server);
  registerTransactionTools(server);
  registerEventTools(server);
  registerPackageTools(server);
  registerExecuteTools(server);
  registerDecompilerTools(server);
  registerDisassemblyTools(server);
  registerAnalyzePackageTools(server);
  registerNameTools(server);
  registerWorkflowTools(server);
  registerPriceTools(server);
  registerDefiTools(server);
  registerNftTools(server);
  registerPtbTools(server);
  registerStakingTools(server);
  registerHistoryTools(server);
  registerTokenSearchTools(server);
  registerMonitorTools(server);
  registerHolderTools(server);
  registerDecodeTools(server);
  registerTraceTools(server);
  registerPoolTools(server);
  registerDependencyTools(server);
  registerIdentifyTools(server);
  registerAnalyzeTokenTools(server);
  registerMvrTools(server);
  registerLabelTools(server);
  registerPackageAuditTools(server);
}
