import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { batchResolveNames } from "../utils/names.js";
import { lookupProtocol } from "../protocols/registry.js";
import { decodeTransaction } from "../protocols/decoder.js";
import { adaptCommands, adaptBalanceChanges } from "../utils/gql-adapters.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "../utils/gql-adapters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface BalanceChangeInfo {
  address: string;
  coin_type: string;
  amount: string;
}

interface HopResult {
  hop: number;
  digest: string;
  sender: string | null;
  balance_changes: BalanceChangeInfo[];
  timestamp: string | null;
  checkpoint: string | null;
  protocols: string[];
  actions: string[];
  token_flow: { coin: string; amount: string; raw_type: string }[];
}

const TX_QUERY = `
  query($digest: String!) {
    transaction(digest: $digest) {
      digest
      sender { address }
      effects {
        status
        timestamp
        checkpoint { sequenceNumber }
        balanceChanges {
          nodes {
            coinType { repr }
            amount
            owner { address }
          }
        }
      }
      kind {
        ... on ProgrammableTransaction {
          commands {
            nodes {
              ... on MoveCallCommand {
                __typename
                function {
                  name
                  module {
                    name
                    package { address }
                  }
                }
              }
              ... on TransferObjectsCommand { __typename }
              ... on SplitCoinsCommand { __typename }
              ... on MergeCoinsCommand { __typename }
              ... on PublishCommand { __typename }
              ... on UpgradeCommand { __typename }
            }
          }
        }
      }
    }
  }
`;

interface GqlTxResult {
  transaction: {
    digest: string;
    sender?: { address: string };
    effects?: {
      status: string;
      timestamp?: string;
      checkpoint?: { sequenceNumber: number };
      balanceChanges?: {
        nodes: GqlBalanceChangeNode[];
      };
    };
    kind?: {
      commands?: {
        nodes: GqlCommandNode[];
      };
    };
  } | null;
}

interface FetchedTx {
  sender: string | null;
  balanceChanges: BalanceChangeInfo[];
  balanceChangeNodes: GqlBalanceChangeNode[];
  commandNodes: GqlCommandNode[];
  timestamp: string | null;
  checkpoint: number | null;
}

async function fetchTx(digest: string): Promise<FetchedTx | null> {
  const data = await gqlQuery<GqlTxResult>(TX_QUERY, { digest });
  const tx = data.transaction;
  if (!tx) return null;

  const bcNodes = tx.effects?.balanceChanges?.nodes ?? [];
  const balanceChanges = bcNodes.map((n) => ({
    address: n.owner?.address ?? "",
    coin_type: n.coinType?.repr ?? "",
    amount: n.amount ?? "0",
  }));

  return {
    sender: tx.sender?.address ?? null,
    balanceChanges,
    balanceChangeNodes: bcNodes,
    commandNodes: tx.kind?.commands?.nodes ?? [],
    timestamp: tx.effects?.timestamp ?? null,
    checkpoint: tx.effects?.checkpoint?.sequenceNumber ?? null,
  };
}

interface TxQueryPage {
  transactions: {
    nodes: Array<{
      digest: string;
      effects?: {
        checkpoint?: { sequenceNumber: number };
        timestamp?: string;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

async function findNextTx(
  address: string,
  afterCheckpoint?: number,
  direction: "forward" | "backward" = "forward",
): Promise<string | null> {
  const isForward = direction === "forward";
  const query = isForward
    ? `query($address: SuiAddress!, $first: Int, $afterCheckpoint: Int) {
        transactions(
          filter: { affectedAddress: $address, afterCheckpoint: $afterCheckpoint }
          first: $first
        ) {
          nodes { digest effects { checkpoint { sequenceNumber } timestamp } }
          pageInfo { hasNextPage endCursor }
        }
      }`
    : `query($address: SuiAddress!, $last: Int, $beforeCheckpoint: Int) {
        transactions(
          filter: { affectedAddress: $address, beforeCheckpoint: $beforeCheckpoint }
          last: $last
        ) {
          nodes { digest effects { checkpoint { sequenceNumber } timestamp } }
          pageInfo { hasNextPage endCursor }
        }
      }`;

  const variables: Record<string, unknown> = { address };
  if (isForward) {
    variables.first = 1;
    variables.afterCheckpoint = afterCheckpoint;
  } else {
    variables.last = 1;
    variables.beforeCheckpoint = afterCheckpoint;
  }

  const data = await gqlQuery<TxQueryPage>(query, variables);
  const node = data.transactions.nodes[0];
  return node?.digest ?? null;
}

function shortCoinType(coinType: string): string {
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
}

function formatAmount(amount: string, coinType: string): string {
  const val = BigInt(amount);
  const coin = shortCoinType(coinType);
  const abs = val < 0n ? -val : val;
  const sign = val < 0n ? "-" : "+";

  // Known decimals for common coins
  const KNOWN_DECIMALS: Record<string, number> = {
    SUI: 9, USDC: 6, USDT: 6, DEEP: 6, CETUS: 9, NS: 6,
    WAL: 9, BUCK: 9, NAVX: 9, SCA: 9, BLUE: 9, WETH: 8,
    WBTC: 8, IKA: 9, UP: 6,
  };
  const decimals = KNOWN_DECIMALS[coin];

  if (decimals !== undefined) {
    const divisor = 10n ** BigInt(decimals);
    const whole = abs / divisor;
    const frac = abs % divisor;
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    const formatted = fracStr ? `${whole}.${fracStr}` : whole.toString();
    return `${sign}${formatted} ${coin}`;
  }

  return `${sign}${abs} ${coin} (raw)`;
}

function addrLabel(addr: string, nameMap: Map<string, string>): string {
  return nameMap.get(addr) ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatTimeSpan(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "< 1 minute";
  if (min < 60) return `${min} minute${min !== 1 ? "s" : ""}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr !== 1 ? "s" : ""}`;
  const days = Math.round(hr / 24);
  return `${days} day${days !== 1 ? "s" : ""}`;
}

function buildSummary(
  hops: HopResult[],
  direction: string,
  nameMap: Map<string, string>,
): string {
  if (hops.length === 0) return "No hops traced.";

  const lines: string[] = [];
  const first = hops[0];
  const last = hops[hops.length - 1];

  // Header
  lines.push(`FUND TRACE — ${direction.toUpperCase()}`);
  lines.push(`Starting tx: ${first.digest}`);

  // Time range
  if (first.timestamp && last.timestamp && hops.length > 1) {
    const diffMs = Math.abs(new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime());
    lines.push(`Time span: ${formatTimeSpan(diffMs)} across ${hops.length} hops`);
  } else {
    lines.push(`Hops: ${hops.length}`);
  }

  // Protocols
  const allProtocols = new Set<string>();
  for (const hop of hops) for (const p of hop.protocols) allProtocols.add(p);
  if (allProtocols.size > 0) {
    lines.push(`Protocols: ${[...allProtocols].join(", ")}`);
  }

  lines.push("");

  // Per-hop breakdown
  for (const hop of hops) {
    const sender = hop.sender ? addrLabel(hop.sender, nameMap) : "unknown";
    const ts = hop.timestamp ? new Date(hop.timestamp).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "";

    lines.push(`--- Hop ${hop.hop} ${ts ? `(${ts})` : ""} ---`);
    lines.push(`Tx:     ${hop.digest}`);
    lines.push(`Sender: ${sender}`);

    if (hop.actions.length > 0) {
      lines.push(`Action: ${hop.actions.join(", ")}`);
    }

    // Balance changes — separate significant from gas
    const significant: typeof hop.balance_changes = [];
    const gasOnly: typeof hop.balance_changes = [];
    for (const bc of hop.balance_changes) {
      const abs = BigInt(bc.amount) < 0n ? -BigInt(bc.amount) : BigInt(bc.amount);
      if (abs > 1_000_000n) {
        significant.push(bc);
      } else {
        gasOnly.push(bc);
      }
    }

    if (significant.length > 0) {
      lines.push("Flows:");
      for (const bc of significant) {
        const who = addrLabel(bc.address, nameMap);
        lines.push(`  ${who}: ${formatAmount(bc.amount, bc.coin_type)}`);
      }
    }

    if (gasOnly.length > 0 && significant.length === 0) {
      lines.push("Flows:  gas only");
    }

    lines.push("");
  }

  // End-state summary
  const lastHop = hops[hops.length - 1];
  const allCoinsTraced = new Set<string>();
  for (const hop of hops) {
    for (const bc of hop.balance_changes) {
      const abs = BigInt(bc.amount) < 0n ? -BigInt(bc.amount) : BigInt(bc.amount);
      if (abs > 1_000_000n) allCoinsTraced.add(shortCoinType(bc.coin_type));
    }
  }
  if (allCoinsTraced.size > 0) {
    lines.push(`Coins involved: ${[...allCoinsTraced].join(", ")}`);
  }
  if (lastHop.actions.length > 0) {
    lines.push(`Final action: ${lastHop.actions.join(", ")}`);
  }

  return lines.join("\n");
}

export function registerTraceTools(server: McpServer) {
  server.tool(
    "trace_funds",
    "(Advanced — multi-hop) Trace fund flow from a transaction. Follow money forward to recipients or backward to the sender's funding source. Returns protocol-decoded actions and human-readable summary. Makes sequential API calls per hop (up to 10).",
    {
      digest: z.string().describe("Starting transaction digest (Base58)"),
      direction: z
        .enum(["forward", "backward"])
        .describe("Direction to trace: 'forward' follows recipients, 'backward' follows sender"),
      hops: z
        .number()
        .optional()
        .describe("Max hops to follow (default 3, max 10)"),
      coin_type: z
        .string()
        .optional()
        .describe("Filter by coin type (e.g. 0x2::sui::SUI). If omitted, traces all coins."),
    },
    async ({ digest, direction, hops, coin_type }) => {
      const maxHops = Math.min(hops ?? 3, 10);
      const traceHops: HopResult[] = [];
      let currentDigest: string | null = digest;

      for (let hop = 0; hop < maxHops && currentDigest; hop++) {
        const tx = await fetchTx(currentDigest);
        if (!tx) break;

        const sender = tx.sender;
        let changes = tx.balanceChanges;

        if (coin_type) {
          changes = changes.filter((c) => c.coin_type === coin_type);
        }

        const checkpointNum = tx.checkpoint ?? undefined;

        // Decode protocol actions
        const commands = adaptCommands(tx.commandNodes);
        const grpcBc = adaptBalanceChanges(tx.balanceChangeNodes);
        const decoded = decodeTransaction(commands, grpcBc, sender ?? undefined);

        traceHops.push({
          hop: hop + 1,
          digest: currentDigest,
          sender,
          balance_changes: changes,
          timestamp: tx.timestamp,
          checkpoint: tx.checkpoint?.toString() ?? null,
          protocols: decoded.protocols,
          actions: decoded.actions,
          token_flow: decoded.token_flow,
        });

        // Determine next address to follow
        let nextAddress: string | null = null;
        if (direction === "forward") {
          for (const c of changes) {
            if (c.address !== sender && BigInt(c.amount) > 0n) {
              nextAddress = c.address;
              break;
            }
          }
        } else {
          nextAddress = sender;
        }

        if (!nextAddress) break;

        currentDigest = await findNextTx(
          nextAddress,
          checkpointNum,
          direction,
        );
      }

      // Collect all unique addresses from hops
      const allAddresses = new Set<string>();
      for (const hop of traceHops) {
        if (hop.sender) allAddresses.add(hop.sender);
        for (const bc of hop.balance_changes) {
          if (bc.address) allAddresses.add(bc.address);
        }
      }

      // Batch-resolve SuiNS names
      const nameMap = await batchResolveNames([...allAddresses]);

      // Build protocol labels from known package IDs in balance change coin types
      const addressLabels: Record<string, { name?: string; protocol?: string }> = {};
      for (const addr of allAddresses) {
        const label: { name?: string; protocol?: string } = {};
        const name = nameMap.get(addr);
        if (name) label.name = name;
        const proto = lookupProtocol(addr);
        if (proto) label.protocol = proto.name;
        if (label.name || label.protocol) {
          addressLabels[addr] = label;
        }
      }

      // Enrich hops with names, protocol labels, and formatted amounts
      const enrichedHops = traceHops.map((hop) => ({
        ...hop,
        sender_name: hop.sender ? nameMap.get(hop.sender) ?? null : null,
        balance_changes: hop.balance_changes.map((bc) => ({
          ...bc,
          formatted: formatAmount(bc.amount, bc.coin_type),
          name: nameMap.get(bc.address) ?? null,
          protocol: lookupProtocol(bc.address)?.name ?? null,
        })),
      }));

      const summary = buildSummary(traceHops, direction, nameMap);

      const fullData = {
        starting_digest: digest,
        direction,
        coin_type: coin_type ?? "all",
        hop_count: enrichedHops.length,
        hops: enrichedHops,
        address_labels: addressLabels,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: summary,
          },
          {
            type: "text" as const,
            text: JSON.stringify(fullData, null, 2),
          },
        ],
      };
    }
  );
}
