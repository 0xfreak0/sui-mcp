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
import { registerDeepBookTools } from "./deepbook.js";
import { registerAggregateTools } from "./aggregate.js";
import { registerFindingsTools } from "./findings.js";
import { registerDependencyTools } from "./dependencies.js";
import { registerIdentifyTools } from "./identify.js";
import { registerAnalyzeTokenTools } from "./analyze-token.js";
import { registerMvrTools } from "./mvr.js";
import { registerLabelTools } from "./labels.js";
import { registerPackageAuditTools } from "./package-audit.js";
import { registerFundingTools } from "./funding.js";
import { registerTimelineTools } from "./timeline.js";
import { registerObjectHistoryTools } from "./object-history.js";
import { withNetworkParam } from "./with-network.js";
import {
  applyProfiles,
  collectToolHandles,
  registerToolsetTool,
  startupProfiles,
  type ToolHandles,
} from "./toolset.js";
import { allProfiledTools, PROFILE_NAMES } from "./profiles.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerAllTools(rawServer: McpServer) {
  // Two layers of proxy, both transparent to the tool files:
  //   withNetworkParam  — injects the per-call `network` arg (./with-network.ts)
  //   collectToolHandles — records each registration so profiles can toggle it
  const handles: ToolHandles = new Map();
  const server = collectToolHandles(withNetworkParam(rawServer), handles);

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
  registerDeepBookTools(server);
  registerAggregateTools(server);
  registerFindingsTools(server);
  registerDependencyTools(server);
  registerIdentifyTools(server);
  registerAnalyzeTokenTools(server);
  registerMvrTools(server);
  registerLabelTools(server);
  registerPackageAuditTools(server);
  registerFundingTools(server);
  registerTimelineTools(server);
  registerObjectHistoryTools(server);

  // Apply the startup profile, then register the switch that expands it.
  // `enable_tools` goes on the raw server so it is never itself gated — it is
  // the only way back to the tools the profile turned off.
  const profiles = startupProfiles();
  applyProfiles(handles, profiles, allProfiledTools());
  registerToolsetTool(rawServer, handles, {
    active: new Set(profiles ?? PROFILE_NAMES),
  });
}
