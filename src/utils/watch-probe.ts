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
  // Addresses whose delta came back FULL, so there is more than this poll saw.
  // Measured on a real mainnet address doing a transaction every two seconds:
  // it fills the cap on every poll, and without saying so the watch falls
  // permanently behind while reporting confidently.
  const saturated: string[] = [];
  let requests = 0;

  for (const batch of planBatches(entries)) {
    const query =
      "query{" +
      batch
        .map(
          (e, i) =>
            `a${i}:transactions(filter:{affectedAddress:"${e.address}",afterCheckpoint:${e.last_checkpoint}},first:${perAddress}){${DELTA_SELECTION}}`,
        )
        .join("") +
      "}";

    requests++;
    // A failed batch is not an empty one. Returning no deltas for these
    // addresses would advance nothing and report calm, so the error is left to
    // the caller rather than swallowed into a quiet poll.
    const data = await gqlQuery<Record<string, { nodes: DeltaNode[] }>>(query, {});

    batch.forEach((e, i) => {
      const nodes = data[`a${i}`]?.nodes ?? [];
      if (nodes.length >= perAddress) saturated.push(e.address);
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

/**
 * Phase two: balance changes for the digests that actually moved.
 *
 * Only reached when something happened, so a quiet watch never pays for it.
 * Batched over digests rather than addresses, because one transaction can
 * belong to several watched addresses and reading it twice would be waste.
 */
export async function fetchDeltaDetail(
  digests: string[],
): Promise<{ detail: Map<string, DeltaTx["balance_changes"]>; requests: number }> {
  const detail = new Map<string, DeltaTx["balance_changes"]>();
  let requests = 0;
  if (digests.length === 0) return { detail, requests };

  // Same alias mechanism, same caps. Balance changes are several nodes each, so
  // the batch is smaller than the delta batch above.
  for (const batch of planBatches([...new Set(digests)], 8)) {
    const query =
      "query{" +
      batch
        .map(
          (d, i) =>
            `t${i}:transaction(digest:"${d}"){effects{balanceChanges{nodes{amount owner{address} coinType{repr}}}}}`,
        )
        .join("") +
      "}";
    requests++;
    const data = await gqlQuery<
      Record<string, { effects?: { balanceChanges?: { nodes: BalanceNode[] } } } | null>
    >(query, {});
    batch.forEach((d, i) => {
      const nodes = data[`t${i}`]?.effects?.balanceChanges?.nodes ?? [];
      detail.set(
        d,
        nodes.map((n) => ({
          address: n.owner?.address ?? "",
          amount: n.amount ?? "0",
          coin_type: n.coinType?.repr ?? "",
        })),
      );
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
