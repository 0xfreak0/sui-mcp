import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { formatStatus, formatGas, bigintToString, timestampToIso } from "../utils/formatting.js";
import { errorResult } from "../utils/errors.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { gqlQuery } from "../clients/graphql.js";
import { collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { prefetchProtocolNames } from "../protocols/registry.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerTransactionTools(server: McpServer) {
  server.tool(
    "get_transaction",
    "Get a Sui transaction by its digest. Returns sender, status, gas, events, balance changes, and protocol-aware decoded actions (e.g. 'swap on Cetus', 'deposit on Suilend').",
    {
      digest: z.string().describe("Transaction digest (Base58)"),
    },
    async ({ digest }) => {
      const req = {
        digest,
        readMask: {
          paths: [
            "digest", "transaction", "effects", "events",
            "checkpoint", "timestamp", "balance_changes",
          ],
        },
      };
      // Pruned digests come back as a NOT_FOUND throw, which the helper's catch
      // path routes to the archive. The emptiness predicate is belt-and-braces.
      const res: GrpcTypes.GetTransactionResponse = await withArchiveFallback(
        (client) => client.ledgerService.getTransaction(req),
        (r) => !r.transaction,
      );

      const tx = res.transaction;
      const effects = tx?.effects;
      const transaction = tx?.transaction;
      const kind = transaction?.kind;
      const sender = transaction?.sender;

      // Protocol-aware decoding
      let decoded;
      if (kind?.data.oneofKind === "programmableTransaction") {
        const ptb = kind.data.programmableTransaction;
        await prefetchProtocolNames(collectPackageIds(ptb.commands));
        decoded = decodeTransaction(ptb.commands, tx?.balanceChanges, sender);
      } else if (kind?.data.oneofKind) {
        decoded = {
          protocols: [] as string[],
          actions: [`System transaction: ${kind.data.oneofKind}`],
          token_flow: [] as { coin: string; amount: string; raw_type: string }[],
        };
      } else {
        decoded = {
          protocols: [] as string[],
          actions: [] as string[],
          token_flow: [] as { coin: string; amount: string; raw_type: string }[],
        };
      }

      const events = tx?.events?.events?.map((e: GrpcTypes.Event) => ({
        package_id: e.packageId,
        module: e.module,
        event_type: e.eventType,
        sender: e.sender,
      }));
      const balanceChanges = tx?.balanceChanges?.map((bc: GrpcTypes.BalanceChange) => ({
        address: bc.address,
        coin_type: bc.coinType,
        amount: bc.amount,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                digest: tx?.digest,
                sender,
                status: formatStatus(effects?.status),
                timestamp: timestampToIso(tx?.timestamp),
                protocols: decoded.protocols,
                actions: decoded.actions,
                token_flow: decoded.token_flow,
                gas: formatGas(effects?.gasUsed),
                epoch: bigintToString(effects?.epoch),
                checkpoint: bigintToString(tx?.checkpoint),
                event_count: events?.length ?? 0,
                events,
                balance_changes: balanceChanges,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "query_transactions",
    "Query raw Sui transactions with specific filters (sender, affected address/object, function, checkpoint range). Note: only ONE of affected_address, affected_object, or function can be used per query (Sui GraphQL limitation). For human-readable wallet activity, prefer get_transaction_history instead.\n\nATTRIBUTION WARNING: the `function` filter matches any transaction containing that call, including PTBs where it is one leg among several protocols. A transaction's balance changes cover the WHOLE PTB, so summing them per protocol over-attributes — a big Cetus swap in the same PTB will be counted as your protocol's volume. Set include_functions to see every Move call in each transaction, and prefer the protocol's own events (query_events) when measuring per-protocol flow.",
    {
      sender: z.string().optional().describe("Filter by sender address"),
      affected_address: z
        .string()
        .optional()
        .describe("Filter by affected address (sender, sponsor, or recipient). Mutually exclusive with affected_object and function."),
      affected_object: z
        .string()
        .optional()
        .describe("Filter by affected object ID. Mutually exclusive with affected_address and function."),
      function: z
        .string()
        .optional()
        .describe("Filter by Move function (e.g. 0x2::coin::transfer or 0x2::pay). Mutually exclusive with affected_address and affected_object."),
      after_checkpoint: z
        .string()
        .optional()
        .describe("Only transactions after this checkpoint"),
      before_checkpoint: z
        .string()
        .optional()
        .describe("Only transactions before this checkpoint"),
      limit: z.number().optional().describe("Max results (default 20)"),
      after: z.string().optional().describe("Pagination cursor"),
      include_functions: z
        .boolean()
        .optional()
        .describe(
          "Return every Move call in each transaction, so you can see whether the filtered package was the whole transaction or one leg of a multi-protocol PTB.",
        ),
    },
    async ({
      sender,
      affected_address,
      affected_object,
      function: fn,
      after_checkpoint,
      before_checkpoint,
      limit,
      after,
      include_functions,
    }) => {
      // Sui GraphQL only allows one of these per query
      const exclusiveFilters = [
        affected_address && "affected_address",
        affected_object && "affected_object",
        fn && "function",
      ].filter(Boolean);

      if (exclusiveFilters.length > 1) {
        return errorResult(
          `Only one of [affected_address, affected_object, function] can be specified per query. Got: ${exclusiveFilters.join(", ")}. Use separate queries for each filter.`
        );
      }

      const filterParts: Record<string, unknown> = {};
      if (sender) filterParts.sentAddress = sender;
      if (affected_address) filterParts.affectedAddress = affected_address;
      if (affected_object) filterParts.affectedObject = affected_object;
      if (fn) filterParts.function = fn;
      if (after_checkpoint)
        filterParts.afterCheckpoint = parseInt(after_checkpoint);
      if (before_checkpoint)
        filterParts.beforeCheckpoint = parseInt(before_checkpoint);

      // Commands are only selected on request: they multiply response size on
      // a page of 50, and most callers only want the digest list.
      const includeFns = include_functions
        ? `kind { ... on ProgrammableTransaction {
             commands(first: 25) { nodes { ... on MoveCallCommand {
               function { name module { name package { address } } }
             } } }
           } }`
        : "";

      const query = `
        query($filter: TransactionFilter, $first: Int, $after: String) {
          transactions(filter: $filter, first: $first, after: $after) {
            nodes {
              digest
              sender { address }
              gasInput { gasSponsor { address } }
              ${includeFns}
              effects {
                status
                gasEffects {
                  gasSummary {
                    computationCost
                    storageCost
                    storageRebate
                  }
                }
                checkpoint { sequenceNumber }
                timestamp
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;
      const variables = {
        filter: Object.keys(filterParts).length > 0 ? filterParts : undefined,
        first: limit ?? 20,
        after: after ?? undefined,
      };
      const data = await gqlQuery<{
        transactions: {
          nodes: Array<{
            digest: string;
            sender?: { address: string };
            gasInput?: { gasSponsor?: { address: string } | null };
            kind?: {
              commands?: {
                nodes: Array<{
                  function?: { name: string; module: { name: string; package: { address: string } } };
                }>;
              };
            };
            effects?: {
              status: string;
              gasEffects?: {
                gasSummary?: {
                  computationCost: string;
                  storageCost: string;
                  storageRebate: string;
                };
              };
              checkpoint?: { sequenceNumber: number };
              timestamp?: string;
            };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor?: string };
        };
      }>(query, variables);

      const transactions = data.transactions.nodes.map((n) => {
        const sponsor = n.gasInput?.gasSponsor?.address ?? null;
        const calls = (n.kind?.commands?.nodes ?? [])
          .filter((c) => c.function)
          .map((c) => `${c.function!.module.package.address}::${c.function!.module.name}::${c.function!.name}`);

        return {
          digest: n.digest,
          sender: n.sender?.address,
          status: n.effects?.status,
          checkpoint: n.effects?.checkpoint?.sequenceNumber,
          timestamp: n.effects?.timestamp,
          gas_sponsor: sponsor,
          // Sponsorship is one of the stronger coordination signals on Sui: a
          // swarm of wallets whose gas is paid by one address is not organic.
          // The sponsor equals the sender for ordinary self-paid transactions.
          gas_sponsored: sponsor !== null && sponsor !== n.sender?.address,
          ...(include_functions
            ? {
                move_calls: calls,
                // How much of this PTB belongs to the filtered package, so
                // over-attribution is visible instead of assumed.
                ...(fn
                  ? {
                      matched_calls: calls.filter((c) => c.startsWith(fn.split("::")[0])).length,
                      total_calls: calls.length,
                    }
                  : {}),
              }
            : {}),
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                transactions,
                has_next_page: data.transactions.pageInfo.hasNextPage,
                next_cursor: data.transactions.pageInfo.endCursor,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

}
