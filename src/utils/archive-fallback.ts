import { sui, archive } from "../clients/grpc.js";
import { getNetworkConfig } from "../config.js";
import type { SuiGrpcClient } from "@mysten/sui/grpc";

/**
 * Run a ledger read against the fullnode, falling back to the archive node.
 *
 * Sui fullnodes prune old state. A pruned or nonexistent object / transaction /
 * checkpoint / epoch makes `ledgerService` throw `NOT_FOUND`; it does **not**
 * resolve with an empty payload. So the throw path below is the one that
 * carries pruning, and it is why the archive is consulted at all.
 *
 * `isEmpty` covers the other shape: a successful response missing the field
 * the caller needs. No current call site is known to reach it; it is defence in
 * depth against node-implementation differences.
 *
 * Mainnet and testnet both have an archive. Devnet does not, so `archive` is the
 * same client as the fullnode there (see clients/grpc.ts) and both retries are
 * skipped: they would repeat an identical request against the identical node.
 * Skipping them on devnet gives up a retry that could paper over a transient
 * blip, and avoids doubling latency on the common NOT_FOUND path.
 */
export async function withArchiveFallback<T>(
  // PromiseLike, not Promise: the SDK's service methods return `UnaryCall`,
  // which is awaitable but has no .catch/.finally.
  call: (client: SuiGrpcClient) => PromiseLike<{ response: T }>,
  isEmpty: (response: T) => boolean,
): Promise<T> {
  const hasArchive = getNetworkConfig().archive !== null;

  let response: T;
  try {
    ({ response } = await call(sui));
  } catch (err) {
    // Fullnode failed outright. With no separate archive there is nothing left
    // to try, so surface the original error rather than repeating the call.
    if (!hasArchive) throw err;
    ({ response } = await call(archive));
    return response;
  }

  if (!hasArchive || !isEmpty(response)) return response;

  try {
    const { response: archived } = await call(archive);
    // Only take the archive's answer if it actually has content. A pruned
    // fullnode and an archive miss can both be empty; preferring the archive
    // blindly would discard partial-but-real fullnode data.
    return isEmpty(archived) ? response : archived;
  } catch {
    // Archive is best-effort here: the fullnode already gave a usable (if
    // empty) response, so an archive failure does not fail the whole call.
    return response;
  }
}
