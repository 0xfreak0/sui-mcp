/**
 * The network half of watching. Pure logic is in `watch.ts`.
 *
 * Two phases, and the split is forced by the service before it is a choice.
 * A delta query per watched address is batched with aliases, and the selection
 * has to stay MINIMAL — digest and checkpoint only. Measured against mainnet:
 *
 *   20 aliases, digest + checkpoint          3,917 bytes   accepted
 *   30 aliases, digest + checkpoint          5,877 bytes   "Query payload too large: > 5000B"
 *   20 aliases, + balance changes            5,637 bytes   "Query has over 300 nodes"
 *
 * So phase one asks only what moved, and phase two reads the detail for the
 * handful of digests that came back. That is also the right shape for context:
 * the common answer is "nothing happened", and it costs one request and a few
 * dozen tokens to say.
 */

import { gqlQuery } from "../clients/graphql.js";
import { readObjectMovements, type GqlObjectChange } from "./object-flow.js";
import { planBatches, type DeltaTx, type WatchEntry } from "./watch.js";

/** Digest + checkpoint only. Anything richer breaks the 300-node limit at 20. */
const DELTA_SELECTION = "nodes{digest effects{timestamp checkpoint{sequenceNumber}}}";

interface DeltaNode {
  digest: string;
  effects?: { timestamp?: string | null; checkpoint?: { sequenceNumber: number | string } | null };
}

/**
 * Ask, for each address, what is new since its high-water checkpoint.
 *
 * `afterCheckpoint` is exclusive, so the address's own last-seen checkpoint is
 * passed directly and the result contains no overlap. Verified on a wallet
 * with no activity since January: after its last checkpoint returns nothing,
 * after the one before returns exactly one.
 */
export async function fetchDeltas(
  entries: WatchEntry[],
  perAddress = 10,
): Promise<{ deltas: Map<string, DeltaTx[]>; requests: number; saturated: string[] }> {
  const deltas = new Map<string, DeltaTx[]>();
  // Addresses with MORE than this poll reported. Measured on a real mainnet
  // address doing a transaction every two seconds: it fills the cap on every
  // poll, and without saying so the watch falls permanently behind while
  // reporting confidently.
  //
  // Proven by asking for one more than will be reported, the same bound-not-a-
  // count trick `probeRecipients` uses. A FULL page is not the same claim: at
  // `perAddress` 1 every non-empty page is full, so treating full as "there is
  // more" made a single new transaction look like a page cut in half and
  // stalled the cursor permanently.
  const saturated: string[] = [];
  let requests = 0;

  for (const batch of planBatches(entries)) {
    const query =
      "query{" +
      batch
        .map(
          (e, i) =>
            `a${i}:transactions(filter:{affectedAddress:"${e.address}",afterCheckpoint:${e.last_checkpoint}},first:${perAddress + 1}){${DELTA_SELECTION}}`,
        )
        .join("") +
      "}";

    requests++;
    // A failed batch is not an empty one. Returning no deltas for these
    // addresses would advance nothing and report calm, so the error is left to
    // the caller rather than swallowed into a quiet poll.
    const data = await gqlQuery<Record<string, { nodes: DeltaNode[] }>>(query, {});

    batch.forEach((e, i) => {
      const all = data[`a${i}`]?.nodes ?? [];
      // The extra node is proof, not payload: it is dropped rather than
      // reported, so the caller still gets exactly `perAddress`.
      const nodes = all.slice(0, perAddress);
      if (all.length > perAddress) saturated.push(e.address);
      deltas.set(
        e.address,
        nodes
          .map((n) => ({
            digest: n.digest,
            checkpoint: Number(n.effects?.checkpoint?.sequenceNumber ?? 0),
            timestamp: n.effects?.timestamp ?? null,
          }))
          .filter((t) => t.checkpoint > 0),
      );
    });
  }

  return { deltas, requests, saturated };
}

interface BalanceNode {
  amount?: string;
  owner?: { address?: string };
  coinType?: { repr?: string };
}

const OWNER_FRAGMENT =
  "owner{__typename ... on AddressOwner{address{address}} ... on ObjectOwner{address{address}} ... on ConsensusAddressOwner{address{address}}}";

const DETAIL_SELECTION =
  "effects{balanceChanges{nodes{amount owner{address} coinType{repr}}}" +
  `objectChanges(first:50){pageInfo{hasNextPage} nodes{address idCreated idDeleted ` +
  `inputState{asMoveObject{contents{type{repr}}} ${OWNER_FRAGMENT}} ` +
  `outputState{asMoveObject{contents{type{repr}}} ${OWNER_FRAGMENT}}}}}`;

/**
 * Digests per detail request.
 *
 * Five, not eight. Object changes are many nodes each, and the 300-node limit
 * binds long before the byte cap: measured, 8 digests is 4,767 bytes and
 * rejected as "over 300 nodes", while 5 is 2,982 bytes and accepted.
 */
const DETAIL_BATCH = 5;

/**
 * Phase two: balance changes for the digests that actually moved.
 *
 * Only reached when something happened, so a quiet watch never pays for it.
 * Batched over digests rather than addresses, because one transaction can
 * belong to several watched addresses and reading it twice would be waste.
 */
export interface DeltaDetail {
  balance_changes: NonNullable<DeltaTx["balance_changes"]>;
  object_movements: DeltaTx["object_movements"];
}

export async function fetchDeltaDetail(
  digests: string[],
): Promise<{ detail: Map<string, DeltaDetail>; requests: number }> {
  const detail = new Map<string, DeltaDetail>();
  let requests = 0;
  if (digests.length === 0) return { detail, requests };

  // Reached only when something already moved, so a quiet poll never pays for
  // any of this. Object changes come along because a capability or an NFT
  // changes hands WITHOUT a balance change, and a watch that reads only
  // balances is blind to exactly the transfers worth waking someone for.
  for (const batch of planBatches([...new Set(digests)], DETAIL_BATCH)) {
    const query =
      "query{" +
      batch.map((d, i) => `t${i}:transaction(digest:"${d}"){${DETAIL_SELECTION}}`).join("") +
      "}";
    requests++;
    const data = await gqlQuery<
      Record<
        string,
        {
          effects?: {
            balanceChanges?: { nodes: BalanceNode[] };
            objectChanges?: { nodes: GqlObjectChange[] };
          };
        } | null
      >
    >(query, {});
    batch.forEach((d, i) => {
      const fx = data[`t${i}`]?.effects;
      detail.set(d, {
        balance_changes: (fx?.balanceChanges?.nodes ?? []).map((n) => ({
          address: n.owner?.address ?? "",
          amount: n.amount ?? "0",
          coin_type: n.coinType?.repr ?? "",
        })),
        object_movements: readObjectMovements(fx?.objectChanges?.nodes ?? []),
      });
    });
  }

  return { detail, requests };
}

/** The chain's current checkpoint, used to seed a new watch. */
export async function currentCheckpoint(): Promise<number> {
  const data = await gqlQuery<{ checkpoint?: { sequenceNumber?: number | string } }>(
    `{ checkpoint { sequenceNumber } }`,
    {},
  );
  return Number(data.checkpoint?.sequenceNumber ?? 0);
}
