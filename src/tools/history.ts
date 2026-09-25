import { z } from "zod";
import { numArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { prefetchProtocolNames } from "../protocols/registry.js";
import { batchResolveNames } from "../utils/names.js";
import { adaptCommands, adaptBalanceChanges } from "../utils/gql-adapters.js";
import { ActivityLedger, lookalikeReport } from "../utils/address-lookalike.js";
import type { Appearance } from "../utils/address-lookalike.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "../utils/gql-adapters.js";
import {
  BALANCE_CHANGES_SELECTION,
  COMMANDS_SELECTION,
  completeTxConnections,
  type GqlConnection,
} from "../utils/tx-connections.js";
import {
  BOTH_WAYS_PAGE_INFO,
  orderedPage,
  orderedPageArgs,
  shownRange,
  type BothWaysPageInfo,
} from "../utils/pagination.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface GqlTransactionNode {
  digest: string;
  sender?: { address: string };
  effects?: {
    status: string;
    timestamp?: string;
    balanceChanges?: GqlConnection<GqlBalanceChangeNode>;
  };
  kind?: {
    commands?: GqlConnection<GqlCommandNode>;
  };
}

interface GqlTransactionsResponse {
  transactions: {
    nodes: GqlTransactionNode[];
    pageInfo: BothWaysPageInfo;
  };
}

const HISTORY_QUERY = `
  query($address: SuiAddress!, $first: Int, $after: String, $last: Int, $before: String) {
    transactions(filter: { affectedAddress: $address }, first: $first, after: $after, last: $last, before: $before) {
      nodes {
        digest
        sender { address }
        effects { status timestamp ${BALANCE_CHANGES_SELECTION} }
        kind { ... on ProgrammableTransaction { ${COMMANDS_SELECTION} } }
      }
      ${BOTH_WAYS_PAGE_INFO}
    }
  }
`;

export function registerHistoryTools(server: McpServer) {
  server.tool(
    "get_transaction_history",
    "(Recommended for wallet activity) Get decoded transaction history for a Sui wallet: protocol names (e.g. Cetus, Suilend), action descriptions (e.g. 'Swap USDC → SUI') and token flow for each transaction. Newest first by default; `order: 'oldest'` starts from the address's first transaction instead. Each page reports its `order` and the `oldest_shown`/`newest_shown` timestamps; pass `next_cursor` back as `cursor` with the same `order` to continue. Rows are decoded from each transaction's complete balance changes and commands. `address_poisoning` is checked over the page shown, so the default page covers recent activity. Each row's `subject_flow` is the queried address's own signed balance change per coin, with formatted amounts and coin_verified; `token_flow` is the transaction sender's, so on a transfer this address received it shows the sender's outflow. Prefer this over query_transactions when exploring what a wallet has been doing.",
    {
      address: z.string().describe("Sui wallet address (0x...)"),
      limit: numArg()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Number of transactions to return (default 10, max 50)"),
      order: z
        .enum(["newest", "oldest"])
        .optional()
        .describe("'newest' (default) starts at the most recent transaction and pages back in time; 'oldest' starts at the first and pages forward."),
      cursor: z
        .string()
        .optional()
        .describe("`next_cursor` from the previous page. Continues in the same direction; pass the same `order`."),
    },
    async ({ address, limit, order, cursor }) => {
      const direction = order ?? "newest";
      const variables: Record<string, unknown> = {
        address,
        ...orderedPageArgs(direction, limit, cursor),
      };

      const data = await gqlQuery<GqlTransactionsResponse>(HISTORY_QUERY, variables);
      const page = orderedPage(data.transactions.nodes, data.transactions.pageInfo, direction);
      // Balance changes and commands arrive 50 to a page. A transaction with
      // more is completed here, before anything is decoded from it.
      const completed = await completeTxConnections(
        page.nodes.map((node) => ({
          digest: node.digest,
          balanceChanges: node.effects?.balanceChanges,
          commands: node.kind?.commands,
        })),
      );

      // Resolve Move Registry names for every unknown package on this page in a
      // single request, before the synchronous decode pass below. Doing it
      // per-transaction inside the map would mean one round trip per tx.
      await prefetchProtocolNames(
        completed.flatMap((c) => collectPackageIds(adaptCommands(c.commands))),
      );

      // First pass: decode transactions and extract counterparty addresses
      const allCounterpartyAddresses = new Set<string>();

      // Every address that appears on this page, with how much of a footprint
      // it has here. Address poisoning is checked over this set rather than
      // over `allCounterpartyAddresses`, and the difference is the whole
      // finding: a poisoning wallet SENDS dust, so in the victim's history it
      // is the sender of its transaction and has a negative balance change.
      // The counterparty extraction below drops senders and negative changes,
      // which is right for "where did value go" and would have missed every
      // real case. Verified on mainnet: the lookalike was the sender.
      const ledger = new ActivityLedger();

      const decodedNodes = page.nodes.map((node, i) => {
        const sender = node.sender?.address;
        const commandNodes = completed[i].commands;
        const balanceChangeNodes = completed[i].balanceChanges;

        const commands = adaptCommands(commandNodes);
        const balanceChanges = adaptBalanceChanges(balanceChangeNodes);

        const decoded = decodeTransaction(commands, balanceChanges, sender);

        const appearances: Appearance[] = sender ? [{ address: sender }] : [];

        // Extract counterparties: addresses with positive balance changes that aren't the sender
        const counterpartyAddrs: string[] = [];
        for (const bc of balanceChangeNodes) {
          const addr = bc.owner?.address;
          const amount = bc.amount;
          if (addr) {
            let value = 0n;
            try {
              value = BigInt(amount ?? 0);
            } catch {
              // A malformed amount costs this address its received total, never
              // the whole call. `trace.ts` guards the same conversion.
            }
            appearances.push({ address: addr, amount: value });
          }
          if (addr && addr !== sender && amount && BigInt(amount) > 0n) {
            if (!counterpartyAddrs.includes(addr)) {
              counterpartyAddrs.push(addr);
              allCounterpartyAddresses.add(addr);
            }
          }
        }

        ledger.observe(appearances);

        return { node, sender, decoded, counterpartyAddrs };
      });

      // Batch-resolve SuiNS names for all counterparty addresses
      const nameMap = await batchResolveNames([...allCounterpartyAddresses]);

      // Second pass: build output with counterparties
      const transactions = decodedNodes.map(({ node, sender, decoded, counterpartyAddrs }) => ({
        digest: node.digest,
        timestamp: node.effects?.timestamp ?? null,
        sender: sender ?? null,
        status: node.effects?.status?.toLowerCase() === "success"
          ? "success"
          : (node.effects?.status?.toLowerCase() ?? "unknown"),
        protocols: decoded.protocols,
        actions: decoded.actions,
        token_flow: decoded.token_flow,
        counterparties: counterpartyAddrs.map((addr) => ({
          address: addr,
          name: nameMap.get(addr) ?? null,
        })),
      }));

      // The subject leads the comparison set because it is the address a
      // poisoner is most likely to be imitating — the victim's own, so that
      // a transfer between their wallets lands on the lookalike instead. Its
      // activity stays in the map: the subject appears in every transaction on
      // the page, so it reliably outweighs a lookalike of itself and gets named
      // as the established side rather than the suspect. Listing it explicitly
      // also covers a page where it took no balance change at all.
      const poisoning = lookalikeReport(ledger.addressesLedBy(address), ledger.activity, address);

      // A continuation read that failed leaves a row decoded from part of its
      // lists. Named here rather than dropped, so the row is not read as whole.
      const incomplete = page.nodes.flatMap((node, i) =>
        completed[i].balanceChangesTruncated || completed[i].commandsTruncated
          ? [
              {
                digest: node.digest,
                balance_changes_truncated: completed[i].balanceChangesTruncated,
                commands_truncated: completed[i].commandsTruncated,
              },
            ]
          : [],
      );

      const result = {
        address,
        order: direction,
        ...shownRange(page.nodes.map((n) => n.effects?.timestamp)),
        transactions,
        ...(incomplete.length
          ? {
              incomplete_transactions: incomplete,
              incomplete_note:
                "These rows were decoded from a partial list of balance changes or commands because a follow-up read failed. Read them with get_transaction before relying on them.",
            }
          : {}),
        ...(poisoning ? { address_poisoning: poisoning } : {}),
        has_next_page: page.has_next_page,
        next_cursor: page.next_cursor,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

}
