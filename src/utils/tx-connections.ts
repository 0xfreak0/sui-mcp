import { gqlQuery } from "../clients/graphql.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "./gql-adapters.js";

/**
 * A transaction's balance changes and commands are GraphQL connections, and a
 * connection is a page, not a list.
 *
 * Selected without `first:`, `TransactionEffects.balanceChanges` and
 * `ProgrammableTransaction.commands` return the service's default page of 20
 * and say nothing about the rest unless `pageInfo` is also selected. An airdrop
 * with 202 balance changes read as 20, and the sender's debit, which sorts
 * past row 20, was missing entirely. Every read that draws a conclusion from
 * these lists selects them through the constants below and completes them with
 * `completeTxConnections` (a page of transactions) or the two `readAll*`
 * helpers (one transaction).
 *
 * Completion pages the same connection by digest. A transaction under 50 rows
 * costs nothing extra. A continuation read that fails leaves `truncated` set,
 * so a caller reports an incomplete list instead of presenting it as whole.
 */

/** GraphQL's maximum page size for a nested connection. */
export const NESTED_PAGE_SIZE = 50;

/** A connection as selected by the constants below. */
export interface GqlConnection<T> {
  nodes: T[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

export interface CompletedConnection<T> {
  nodes: T[];
  /** More rows exist than were read: a continuation read failed or hit the page cap. */
  truncated: boolean;
}

// Kept compact: the service rejects a query document over 5,000 bytes, and
// these are interpolated into queries that are already long.
const BALANCE_CHANGE_PAGE = "pageInfo { hasNextPage endCursor } nodes { coinType { repr } amount owner { address } }";
const COMMAND_PAGE =
  "pageInfo { hasNextPage endCursor } nodes { __typename ... on MoveCallCommand { function { name module { name package { address } } } } }";

/** Select inside `effects { }`. */
export const BALANCE_CHANGES_SELECTION = `balanceChanges(first: ${NESTED_PAGE_SIZE}) { ${BALANCE_CHANGE_PAGE} }`;

/** Select inside `... on ProgrammableTransaction { }` (or ProgrammableSystemTransaction). */
export const COMMANDS_SELECTION = `commands(first: ${NESTED_PAGE_SIZE}) { ${COMMAND_PAGE} }`;

const MORE_BALANCE_CHANGES = `query ($digest: String!, $after: String) {
  transactionEffects(digest: $digest) { balanceChanges(first: ${NESTED_PAGE_SIZE}, after: $after) { ${BALANCE_CHANGE_PAGE} } }
}`;

const MORE_COMMANDS = `query ($digest: String!, $after: String) {
  transaction(digest: $digest) { kind {
    ... on ProgrammableTransaction { commands(first: ${NESTED_PAGE_SIZE}, after: $after) { ${COMMAND_PAGE} } }
    ... on ProgrammableSystemTransaction { commands(first: ${NESTED_PAGE_SIZE}, after: $after) { ${COMMAND_PAGE} } }
  } }
}`;

/**
 * Page cap per connection. A PTB holds at most 1,024 commands, so this is a
 * guard against a cursor that never advances, not a budget a real transaction
 * reaches.
 */
const MAX_PAGES = 100;

/** Continuation reads in flight at once across a page of transactions. */
const CONCURRENCY = 4;

interface MoreBalanceChanges {
  transactionEffects: { balanceChanges: GqlConnection<GqlBalanceChangeNode> | null } | null;
}

interface MoreCommands {
  transaction: { kind: { commands?: GqlConnection<GqlCommandNode> | null } | null } | null;
}

async function drain<T, R>(
  digest: string,
  first: GqlConnection<T> | null | undefined,
  query: string,
  pick: (r: R) => GqlConnection<T> | null | undefined,
): Promise<CompletedConnection<T>> {
  const nodes = [...(first?.nodes ?? [])];
  // `more` and `cursor` are tracked apart: a connection can claim another page
  // and return a null cursor, and that list is still incomplete.
  let more = first?.pageInfo?.hasNextPage === true;
  let cursor = more ? first?.pageInfo?.endCursor : undefined;
  let pages = 1;
  while (more && cursor && pages < MAX_PAGES) {
    const next = await gqlQuery<R>(query, { digest, after: cursor }).catch(() => null);
    const conn = next ? pick(next) : null;
    if (!conn) break;
    nodes.push(...conn.nodes);
    pages++;
    more = conn.pageInfo?.hasNextPage === true;
    cursor = conn.pageInfo?.endCursor;
  }
  return { nodes, truncated: more };
}

/** Every balance change of one transaction, starting from the page already read. */
export function readAllBalanceChanges(
  digest: string,
  first: GqlConnection<GqlBalanceChangeNode> | null | undefined,
): Promise<CompletedConnection<GqlBalanceChangeNode>> {
  return drain(digest, first, MORE_BALANCE_CHANGES, (r: MoreBalanceChanges) => r.transactionEffects?.balanceChanges);
}

/** Every command of one transaction, starting from the page already read. */
export function readAllCommands(
  digest: string,
  first: GqlConnection<GqlCommandNode> | null | undefined,
): Promise<CompletedConnection<GqlCommandNode>> {
  return drain(digest, first, MORE_COMMANDS, (r: MoreCommands) => r.transaction?.kind?.commands);
}

export interface TxConnections {
  digest: string;
  balanceChanges?: GqlConnection<GqlBalanceChangeNode> | null;
  commands?: GqlConnection<GqlCommandNode> | null;
}

export interface CompletedTx {
  balanceChanges: GqlBalanceChangeNode[];
  commands: GqlCommandNode[];
  balanceChangesTruncated: boolean;
  commandsTruncated: boolean;
}

/**
 * Complete the balance changes and commands of a page of transactions, in
 * input order. Only transactions whose first page claimed more cost a request,
 * and at most `CONCURRENCY` of those run at once.
 */
export async function completeTxConnections(txs: TxConnections[]): Promise<CompletedTx[]> {
  const out: CompletedTx[] = txs.map((t) => ({
    balanceChanges: t.balanceChanges?.nodes ?? [],
    commands: t.commands?.nodes ?? [],
    balanceChangesTruncated: false,
    commandsTruncated: false,
  }));
  const pending = txs
    .map((t, i) => ({ t, i }))
    .filter(
      ({ t }) => t.balanceChanges?.pageInfo?.hasNextPage === true || t.commands?.pageInfo?.hasNextPage === true,
    );
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const { t, i } = pending[next++];
      const [bc, cmd] = await Promise.all([
        readAllBalanceChanges(t.digest, t.balanceChanges),
        readAllCommands(t.digest, t.commands),
      ]);
      out[i] = {
        balanceChanges: bc.nodes,
        commands: cmd.nodes,
        balanceChangesTruncated: bc.truncated,
        commandsTruncated: cmd.truncated,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  return out;
}
