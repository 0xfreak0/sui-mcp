import type { GrpcTypes } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { withArchiveFallback } from "./archive-fallback.js";

/** `sui.rpc.v2.ChangedObject.IdOperation.DELETED` */
const ID_DELETED = 3;

/**
 * `ObjectDigest::OBJECT_DIGEST_WRAPPED` (32 bytes of 88), base58. gRPC renders
 * effects version 1 with `idOperation` DELETED for a wrapped object too; this
 * output digest is what marks it wrapped.
 */
const WRAPPED_DIGEST = "6ws1bVyu3F8wGy1fPHhrc2v8UyWiGbRAAuek8SwikKPD";

/** Whether a gRPC changed object was deleted, as opposed to wrapped. */
export function isDeletion(c: Pick<GrpcTypes.ChangedObject, "idOperation" | "outputDigest">): boolean {
  return c.idOperation === ID_DELETED && c.outputDigest !== WRAPPED_DIGEST;
}

/** The last transaction to touch an object, found even after it stops existing. */
const LAST_TOUCH_QUERY = `query ($id: SuiAddress!) {
  transactions(filter: { affectedObject: $id }, last: 1) {
    nodes { digest sender { address } effects { timestamp checkpoint { sequenceNumber } } }
  }
}`;

interface LastTouchResult {
  transactions: {
    nodes: Array<{
      digest: string;
      sender?: { address: string } | null;
      effects?: { timestamp?: string; checkpoint?: { sequenceNumber: number } };
    }>;
  };
}

export interface ObjectEnd {
  kind: "deleted" | "wrapped";
  tx: string;
  timestamp: string | null;
  checkpoint: number | null;
  sender: string | null;
}

/**
 * How an object that no longer exists at top level stopped existing. The last
 * transaction to touch it either deleted it or wrapped it inside another
 * object. gRPC's `changedObjects` states which in one read, where GraphQL's
 * `objectChanges` would need paging to find the same row: `idOperation`
 * DELETED with any output digest but the wrapped marker is a deletion. Null
 * when no transaction touched the id. Read failures throw, and so does a
 * transaction that does not list the id.
 */
export async function readObjectEnd(objectId: string): Promise<ObjectEnd | null> {
  const r = await gqlQuery<LastTouchResult>(LAST_TOUCH_QUERY, { id: objectId });
  const last = r.transactions.nodes[0];
  if (!last) return null;
  const res = await withArchiveFallback<GrpcTypes.GetTransactionResponse>(
    (client) => client.ledgerService.getTransaction({ digest: last.digest, readMask: { paths: ["effects"] } }),
    (x) => !x.transaction?.effects,
  );
  const want = normalizeSuiAddress(objectId);
  const change = res.transaction?.effects?.changedObjects?.find(
    (c) => c.objectId !== undefined && normalizeSuiAddress(c.objectId) === want,
  );
  if (!change) throw new Error(`transaction ${last.digest} does not list ${objectId} among its changed objects`);
  return {
    kind: isDeletion(change) ? "deleted" : "wrapped",
    tx: last.digest,
    timestamp: last.effects?.timestamp ?? null,
    checkpoint: last.effects?.checkpoint?.sequenceNumber ?? null,
    sender: last.sender?.address ?? null,
  };
}

const PUBLISH_COMMANDS_QUERY = `query ($d: String!, $after: String) {
  transaction(digest: $d) {
    kind {
      ... on ProgrammableTransaction {
        commands(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on MoveCallCommand { function { name module { name package { address } } } arguments { __typename ... on TxResult { cmd } } }
          }
        }
      }
    }
  }
}`;

interface CommandNode {
  __typename: string;
  function?: { name: string; module: { name: string; package: { address: string } } };
  arguments?: Array<{ __typename: string; cmd?: number | null }>;
}

interface PublishCommandsResult {
  transaction: {
    kind: {
      commands?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: CommandNode[] } | null;
    } | null;
  } | null;
}

/** Pages of 50 commands; a PTB holds at most 1,024. */
const MAX_COMMAND_PAGES = 21;

const FRAMEWORK = normalizeSuiAddress("0x2");

/**
 * Whether a publish transaction made its package immutable in the same PTB:
 * it has exactly one Publish command, and a Move call to
 * `0x2::package::make_immutable` takes that command's result, the new
 * UpgradeCap, which `make_immutable` takes by value and deletes. A cap
 * created and destroyed in one transaction appears in no object change, so
 * the effects alone cannot tell this package from one whose cap went
 * unrecorded. Read failures throw, and so does a command list that could
 * not be read to its end.
 */
export async function madeImmutableAtPublish(digest: string): Promise<boolean> {
  const nodes: CommandNode[] = [];
  let after: string | null = null;
  for (let page = 0; ; page++) {
    if (page === MAX_COMMAND_PAGES) throw new Error(`the commands of ${digest} run past ${MAX_COMMAND_PAGES} pages`);
    const r: PublishCommandsResult = await gqlQuery<PublishCommandsResult>(PUBLISH_COMMANDS_QUERY, { d: digest, after });
    if (!r.transaction) throw new Error(`GraphQL has no transaction ${digest}`);
    // A publish outside a programmable transaction (genesis) has no commands.
    const commands = r.transaction.kind?.commands;
    if (!commands) return false;
    nodes.push(...commands.nodes);
    if (!commands.pageInfo.hasNextPage) break;
    after = commands.pageInfo.endCursor;
    if (!after) throw new Error(`the commands of ${digest} could not be read to their end`);
  }
  const publishes = nodes.flatMap((n, i) => (n.__typename === "PublishCommand" ? [i] : []));
  if (publishes.length !== 1) return false;
  return nodes.some(
    (n) =>
      n.__typename === "MoveCallCommand" &&
      n.function?.name === "make_immutable" &&
      n.function.module.name === "package" &&
      normalizeSuiAddress(n.function.module.package.address) === FRAMEWORK &&
      n.arguments?.[0]?.__typename === "TxResult" &&
      n.arguments[0].cmd === publishes[0],
  );
}
