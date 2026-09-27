import { z } from "zod";
import { ALIAS_AUTH_SAMPLE, aliasScanAsOfClause, findAliasSignedTransactions, type AliasSignedLookup } from "../utils/identity.js";
import { numArg, addressArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { addressFlow, collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { prefetchProtocolNames } from "../protocols/registry.js";
import { prefetchCoinScale } from "../utils/valuation.js";
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
import { foldRepeats } from "../utils/formatting.js";
import { capPayload, type ListCap } from "../utils/output-cap.js";

/**
 * Counterparties listed per row. A mass payout names every recipient as a
 * counterparty, and each listed address adds a SuiNS lookup and grows the page.
 * The row keeps the count and points at get_transaction, which lists every
 * balance change.
 */
const COUNTERPARTIES_PER_ROW = 25;

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
    "(Recommended for wallet activity) Get decoded transaction history for a Sui wallet: protocol names (e.g. Cetus, Suilend), action descriptions (e.g. 'Swap USDC → SUI') and token flow for each transaction. Newest first by default; `order: 'oldest'` starts from the address's first transaction instead. Each page reports its `order` and the `oldest_shown`/`newest_shown` timestamps; pass `next_cursor` back as `cursor` with the same `order` to continue. Rows are decoded from each transaction's complete balance changes and commands. `address_poisoning` is always present, with `addresses_compared` and the lookalike `pairs` found over the page shown, so the default page covers recent activity and an empty `pairs` clears nothing older. Each row's `subject_flow` is the queried address's own signed balance change per coin, with formatted amounts and coin_verified; `token_flow` is the transaction sender's, so on a transfer this address received it shows the sender's outflow; a row this address sent carries subject_flow alone, since the two are the same side. The page lists the rows that fit about 35k characters, keeping every failed row and every row a lookalike address took part in, and `omitted` states the rest; detail: 'full' lists every row. `counterparties` names up to 25 addresses that received value in the row, with `counterparty_count` when there were more. Prefer this over query_transactions when exploring what a wallet has been doing. `signed_as_alias`, when present, lists transactions this address signed as an 0x2::address_alias delegate for another wallet; the page above cannot show them, because their sender is the other wallet. Which wallets name this address comes from a scan reused for up to five minutes, and `alias_scan_as_of` says when it read the chain. `signed_as_alias_unavailable` marks a scan that did not finish, including beside rows it did find.",
    {
      address: addressArg().describe("Sui wallet address (0x...)"),
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
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default): the rows that fit about 35k characters, in page order, keeping every failed row and every row a lookalike address took part in; `omitted` states the rest. 'full': every row of the page."),
    },
    async ({ address, limit, order, cursor, detail }) => {
      const direction = order ?? "newest";
      const variables: Record<string, unknown> = {
        address,
        ...orderedPageArgs(direction, limit, cursor),
      };

      const [data, aliasLookup] = await Promise.all([
        gqlQuery<GqlTransactionsResponse>(HISTORY_QUERY, variables),
        // `affectedAddress` never surfaces a transaction this address only
        // signed for someone else through 0x2::address_alias: the sender in
        // it is the owner it acted for, and an alias signer need not be a
        // balance-change party. Read separately from the page above, and
        // never able to say it is exhaustive; the note below states the
        // bound. Same content on every page of the same address, so it only
        // runs on the first page rather than re-scanning every
        // `AddressAliases` object on each cursor page too.
        cursor
          ? Promise.resolve(null)
          : findAliasSignedTransactions([address]).catch(
              (): AliasSignedLookup => ({ matches: new Map(), delegateFor: new Map(), status: "failed" }),
            ),
      ]);
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
      // Coin scales too: the decode formats every amount at its coin's own
      // decimals, and a coin no curated list knows needs its CoinMetadata read.
      await Promise.all([
        prefetchProtocolNames(completed.flatMap((c) => collectPackageIds(adaptCommands(c.commands)))),
        prefetchCoinScale(completed.flatMap((c) => c.balanceChanges.flatMap((b) => (b.coinType?.repr ? [b.coinType.repr] : [])))),
      ]);

      // First pass: decode transactions and extract counterparty addresses
      const allCounterpartyAddresses = new Set<string>();

      // Every address that appears on this page, with how much of a footprint
      // it has here. Address poisoning is checked over this set rather than
      // over `allCounterpartyAddresses`: a poisoning wallet SENDS dust, so in
      // the victim's history it is the sender of its transaction and has a
      // negative balance change. The counterparty extraction below drops
      // senders and negative changes, which suits "where did value go" and
      // would hide the poisoner.
      const ledger = new ActivityLedger(address);

      const decodedNodes = page.nodes.map((node, i) => {
        const sender = node.sender?.address;
        const commandNodes = completed[i].commands;
        const balanceChangeNodes = completed[i].balanceChanges;

        const commands = adaptCommands(commandNodes);
        const balanceChanges = adaptBalanceChanges(balanceChangeNodes);

        const decoded = decodeTransaction(commands, balanceChanges, sender);

        const appearances: Appearance[] = sender ? [{ address: sender }] : [];

        // Counterparties: addresses other than the sender that gained value,
        // in the order of the balance changes.
        const received = new Set<string>();
        for (const bc of balanceChangeNodes) {
          const addr = bc.owner?.address;
          if (!addr) continue;
          let value = 0n;
          try {
            value = BigInt(bc.amount ?? 0);
          } catch {
            // A malformed amount costs this address its received total, never
            // the whole call. `trace.ts` guards the same conversion.
          }
          appearances.push({ address: addr, amount: value });
          if (addr !== sender && value > 0n) received.add(addr);
        }
        const counterpartyAddrs = [...received].slice(0, COUNTERPARTIES_PER_ROW);
        counterpartyAddrs.forEach((addr) => allCounterpartyAddresses.add(addr));

        ledger.observe(appearances, node.effects?.timestamp);

        return { node, sender, decoded, counterpartyAddrs, counterpartyCount: received.size, balanceChanges: balanceChangeNodes };
      });

      // Batch-resolve SuiNS names for all counterparty addresses
      const nameMap = await batchResolveNames([...allCounterpartyAddresses]);

      // Second pass: build output with counterparties
      const transactions = decodedNodes.map(({ node, sender, decoded, counterpartyAddrs, counterpartyCount, balanceChanges }) => ({
        digest: node.digest,
        timestamp: node.effects?.timestamp ?? null,
        sender: sender ?? null,
        status: node.effects?.status?.toLowerCase() === "success"
          ? "success"
          : (node.effects?.status?.toLowerCase() ?? "unknown"),
        protocols: decoded.protocols,
        actions: foldRepeats(decoded.actions),
        // token_flow is the sender's side; on a row the queried address sent
        // it is subject_flow's amounts again, and only subject_flow is kept.
        ...(sender === address ? {} : { token_flow: decoded.token_flow }),
        // The queried address's own side, which is what a row in its
        // history is about.
        subject_flow: addressFlow(adaptBalanceChanges(balanceChanges), address),
        counterparties: counterpartyAddrs.map((addr) => ({
          address: addr,
          name: nameMap.get(addr) ?? null,
        })),
        ...(counterpartyCount > counterpartyAddrs.length
          ? {
              counterparty_count: counterpartyCount,
              counterparties_note: `The first ${counterpartyAddrs.length} of ${counterpartyCount} addresses that received value, in balance-change order. get_transaction on this digest lists every balance change.`,
            }
          : {}),
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

      const aliasSignedRows = [...(aliasLookup?.matches.get(address) ?? [])].sort((a, b) =>
        (b.timestamp ?? "").localeCompare(a.timestamp ?? ""),
      );
      const aliasAsOf = aliasLookup?.scanReadAt !== undefined ? new Date(aliasLookup.scanReadAt).toISOString() : null;
      const aliasAsOfClause = aliasAsOf ? ` ${aliasScanAsOfClause(aliasAsOf)}` : "";
      const aliasScanPartial = aliasLookup !== null && aliasLookup.status !== "complete";

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
        address_poisoning: poisoning,
        ...(aliasSignedRows.length > 0
          ? {
              signed_as_alias: aliasSignedRows.map((a) => ({
                digest: a.digest,
                owner: a.owner,
                timestamp: a.timestamp ?? null,
                scheme: a.authentication.scheme,
              })),
              signed_as_alias_note: `Not part of the page above: this address is the transaction's signer through 0x2::address_alias, not its sender, so affectedAddress does not surface these. Found by checking the most recent ${ALIAS_AUTH_SAMPLE} sent transactions of ${aliasScanPartial ? "each owner the scan reached whose alias set names this address (see signed_as_alias_unavailable)" : "every owner whose alias set names this address"}; an owner with more sent transactions than that since delegating may have an earlier alias-signed transaction beyond this list. Use get_transaction on each digest for full detail.${aliasAsOfClause}`,
            }
          : {}),
        ...(aliasScanPartial
          ? {
              signed_as_alias_unavailable:
                aliasSignedRows.length === 0
                  ? `The scan for transactions this address signed as an address alias could not fully complete (a request failed, or the on-chain AddressAliases scan was capped), so the absence above is not proof it never signed one. Retry, or use identify_address for more detail.${aliasAsOfClause}`
                  : `The scan for transactions this address signed as an address alias could not fully complete (a request failed, or the on-chain AddressAliases scan was capped), so signed_as_alias may be incomplete: an owner the scan did not reach may hold more. Retry for the full list.${aliasAsOfClause}`,
            }
          : {}),
        ...(aliasAsOf && (aliasSignedRows.length > 0 || aliasScanPartial) ? { alias_scan_as_of: aliasAsOf } : {}),
        has_next_page: page.has_next_page,
        next_cursor: page.next_cursor,
      };

      // A page's rows fit the budget in page order; a failed row and a row a
      // lookalike address took part in survive it.
      const suspects = new Set(poisoning.pairs.flatMap((p) => [p.suspect.toLowerCase(), p.established.toLowerCase()]));
      type Row = (typeof transactions)[number];
      const { payload } = capPayload(
        "get_transaction_history",
        { address, limit, order, cursor },
        result,
        {
          transactions: {
            budget: 35_000,
            keepOrder: true,
            keep: (r: Row) =>
              r.status !== "success" || suspects.has((r.sender ?? "").toLowerCase()) || r.counterparties.some((c) => suspects.has(c.address.toLowerCase())),
            brief: (r: Row) => ({ digest: r.digest, timestamp: r.timestamp, actions: r.actions.slice(0, 3) }),
          } satisfies ListCap<Row>,
        },
        { full: detail === "full", next_call: { tool: "get_transaction_history", repeat_with: { detail: "full" } } },
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    }
  );

}
