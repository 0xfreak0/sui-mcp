import { z } from "zod";
import { numArg, addressArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { prefetchProtocolNames } from "../protocols/registry.js";
import { batchResolveNames } from "../utils/names.js";
import { adaptCommands, adaptBalanceChanges } from "../utils/gql-adapters.js";
import { ActivityLedger, lookalikeReport } from "../utils/address-lookalike.js";
import type { Appearance } from "../utils/address-lookalike.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "../utils/gql-adapters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface GqlTransactionNode {
  digest: string;
  sender?: { address: string };
  effects?: {
    status: string;
    timestamp?: string;
    balanceChanges?: {
      nodes: GqlBalanceChangeNode[];
    };
  };
  kind?: {
    commands?: {
      nodes: GqlCommandNode[];
    };
  };
}

interface GqlTransactionsResponse {
  transactions: {
    nodes: GqlTransactionNode[];
    pageInfo: {
      hasNextPage: boolean;
      endCursor?: string;
    };
  };
}

const HISTORY_QUERY = `
  query($address: SuiAddress!, $first: Int, $after: String) {
    transactions(filter: { affectedAddress: $address }, first: $first, after: $after) {
      nodes {
        digest
        sender { address }
        effects {
          status
          timestamp
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
                ... on TransferObjectsCommand {
                  __typename
                }
                ... on SplitCoinsCommand {
                  __typename
                }
                ... on MergeCoinsCommand {
                  __typename
                }
                ... on PublishCommand {
                  __typename
                }
                ... on UpgradeCommand {
                  __typename
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export function registerHistoryTools(server: McpServer) {
  server.tool(
    "get_transaction_history",
    "(Recommended for wallet activity) Get decoded transaction history for a Sui wallet. Returns a human-readable activity feed with protocol names (e.g. Cetus, Suilend), action descriptions (e.g. 'Swap USDC → SUI'), and token flow. Prefer this over query_transactions when exploring what a wallet has been doing.",
    {
      address: addressArg().describe("Sui wallet address (0x...)"),
      limit: numArg()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Number of transactions to return (default 10, max 50)"),
      after: z
        .string()
        .optional()
        .describe("Pagination cursor for next page"),
    },
    async ({ address, limit, after }) => {
      const variables: Record<string, unknown> = {
        address,
        first: limit,
        after: after ?? undefined,
      };

      const data = await gqlQuery<GqlTransactionsResponse>(HISTORY_QUERY, variables);

      // Resolve Move Registry names for every unknown package on this page in a
      // single request, before the synchronous decode pass below. Doing it
      // per-transaction inside the map would mean one round trip per tx.
      await prefetchProtocolNames(
        data.transactions.nodes.flatMap((node) =>
          collectPackageIds(adaptCommands(node.kind?.commands?.nodes ?? [])),
        ),
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

      const decodedNodes = data.transactions.nodes.map((node) => {
        const sender = node.sender?.address;
        const commandNodes = node.kind?.commands?.nodes ?? [];
        const balanceChangeNodes = node.effects?.balanceChanges?.nodes ?? [];

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

      const result = {
        address,
        transactions,
        ...(poisoning ? { address_poisoning: poisoning } : {}),
        has_next_page: data.transactions.pageInfo.hasNextPage,
        next_cursor: data.transactions.pageInfo.endCursor ?? null,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

}
