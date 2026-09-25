import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sui } from "./clients/grpc.js";
import { formatOwner } from "./utils/formatting.js";
import { DEFAULT_NETWORK, isSuiNetwork, runWithNetwork, type SuiNetwork } from "./config.js";
import { renderCaseReport } from "./utils/case-report.js";
import { listCases, loadFindings, storeStatus } from "./utils/store.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Resource URI variables arrive as string | string[] | undefined.
type Vars = Record<string, string | string[] | undefined>;
type ResourceResult = {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
};
type ResourceHandler = (uri: URL, vars: Vars) => Promise<ResourceResult>;

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] : (v ?? "");
}

/** Resolve the network from a `{network}` URI segment, defaulting when absent/invalid. */
function pickNetwork(vars: Vars): SuiNetwork {
  const raw = first(vars.network);
  return isSuiNetwork(raw) ? raw : DEFAULT_NETWORK;
}

/**
 * Register a resource under two URIs backed by one handler:
 *   - `sui://<path>`            → the default network (SUI_NETWORK, else mainnet)
 *   - `sui://{network}/<path>`  → an explicit network (mainnet | testnet | devnet)
 *
 * The network-scoped variant runs the handler inside `runWithNetwork`, so the
 * shared `sui` client resolves to that network. `path` may contain `{var}`
 * placeholders; if it does, both URIs are templates.
 */
function registerNetworked(
  server: McpServer,
  name: string,
  path: string,
  description: string,
  handler: ResourceHandler,
): void {
  const templated = path.includes("{");
  const defaultUri = `sui://${path}`;
  const networkUri = `sui://{network}/${path}`;

  // Default variant — no `{network}` segment, so it uses DEFAULT_NETWORK.
  if (templated) {
    server.resource(name, new ResourceTemplate(defaultUri, { list: undefined }), { description }, (uri, vars) =>
      handler(uri, vars as Vars),
    );
  } else {
    server.resource(name, defaultUri, { description }, (uri) => handler(uri, {}));
  }

  // Network-scoped variant — `{network}` in the host selects the network.
  server.resource(
    `${name}-net`,
    new ResourceTemplate(networkUri, { list: undefined }),
    { description: `${description} — on an explicit network (mainnet, testnet, or devnet).` },
    (uri, vars) => runWithNetwork(pickNetwork(vars as Vars), () => handler(uri, vars as Vars)),
  );
}

async function chainInfo(uri: URL): Promise<ResourceResult> {
  const { response: res } = await sui.ledgerService.getServiceInfo({});
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            chain_id: res.chainId,
            epoch: res.epoch?.toString(),
            checkpoint_height: res.checkpointHeight?.toString(),
            timestamp: res.timestamp
              ? new Date(Number(res.timestamp.seconds) * 1000).toISOString()
              : undefined,
            lowest_available_checkpoint: res.lowestAvailableCheckpoint?.toString(),
            lowest_available_checkpoint_objects: res.lowestAvailableCheckpointObjects?.toString(),
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function objectById(uri: URL, vars: Vars): Promise<ResourceResult> {
  const objectId = first(vars.id);
  const { response: res } = await sui.ledgerService.getObject({
    objectId,
    readMask: {
      paths: ["object_id", "version", "digest", "object_type", "owner", "content"],
    },
  });
  const obj = res.object;
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            object_id: obj?.objectId,
            version: obj?.version?.toString(),
            digest: obj?.digest,
            type: obj?.objectType,
            owner: formatOwner(obj?.owner),
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function walletBalances(uri: URL, vars: Vars): Promise<ResourceResult> {
  const addr = first(vars.address);
  const res = await sui.listBalances({ owner: addr, limit: 100, cursor: null });
  const balances = res.balances.map((b) => ({ coin_type: b.coinType, balance: b.balance }));
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ address: addr, balances }, null, 2),
      },
    ],
  };
}

async function walletNfts(uri: URL, vars: Vars): Promise<ResourceResult> {
  const addr = first(vars.address);
  const res = await sui.listOwnedObjects({ owner: addr, limit: 50 });
  const objects = res.objects
    .filter((o) => !o.type?.includes("::coin::Coin<"))
    .map((o) => ({ object_id: o.objectId, type: o.type, version: o.version?.toString() }));
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ address: addr, count: objects.length, objects }, null, 2),
      },
    ],
  };
}

/**
 * A recorded case as its Markdown report, the same document `export_case`
 * renders. Cases live in the local store, so this is not per-network, and the
 * list is every case the store holds.
 */
async function caseReport(uri: URL, vars: Vars): Promise<ResourceResult> {
  const status = storeStatus();
  if (!status.enabled) {
    throw new Error(`Cases need the local store, which is off (${status.reason}). Set SUI_STORE_PATH and restart.`);
  }
  const caseName = decodeURIComponent(first(vars.name));
  const findings = loadFindings(caseName);
  if (findings.length === 0) {
    throw new Error(`No findings recorded for case '${caseName}'. list_findings with no arguments lists the cases.`);
  }
  return {
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderCaseReport({ caseName, findings }) }],
  };
}

export function registerAllResources(server: McpServer) {
  // Each resource is reachable as `sui://<path>` (default network) or
  // `sui://<network>/<path>` (mainnet | testnet | devnet).
  registerNetworked(
    server,
    "chain-info",
    "chain/info",
    "Current Sui chain info (chain ID, epoch, checkpoint)",
    chainInfo,
  );
  registerNetworked(server, "object", "object/{id}", "Sui object by ID", objectById);
  registerNetworked(
    server,
    "wallet-balances",
    "wallet/{address}/balances",
    "All token balances for a Sui wallet",
    walletBalances,
  );
  registerNetworked(
    server,
    "wallet-nfts",
    "wallet/{address}/nfts",
    "NFTs and non-coin objects for a Sui wallet",
    walletNfts,
  );
  server.resource(
    "case",
    new ResourceTemplate("sui://case/{name}", {
      list: async () => ({
        resources: storeStatus().enabled
          ? listCases().map((c) => ({
              uri: `sui://case/${encodeURIComponent(c.case_name)}`,
              name: c.case_name,
              description: `${c.finding_count} finding(s)`,
              mimeType: "text/markdown",
            }))
          : [],
      }),
    }),
    { description: "A recorded investigation case as a Markdown report, as export_case renders it", mimeType: "text/markdown" },
    (uri, vars) => caseReport(uri, vars as Vars),
  );
}
