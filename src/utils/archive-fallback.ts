import { sui, archive } from "../clients/grpc.js";
import { getNetworkConfig } from "../config.js";
import type { SuiGrpcClient } from "@mysten/sui/grpc";

/**
 * Run a ledger read against the fullnode, falling back to the archive node.
 *
 * Sui fullnodes prune old state. Measured against mainnet (2026-08), a pruned
 * or nonexistent object / transaction / checkpoint / epoch makes
 * `ledgerService` throw `NOT_FOUND` — it does **not** resolve with an empty
 * payload. So the throw path below is the one that actually carries pruning,
 * and it is why the archive is consulted at all.
 *
 * `isEmpty` covers the other shape — a successful response missing the field
 * the caller needs. No probe of mainnet has been able to make it fire for any
 * of the four current call sites, so treat it as defence in depth against
 * node-implementation differences rather than as a path known to be live. It
 * exists because the call sites this helper replaced each carried their own
 * version of it; dropping it would have been a silent behaviour change.
 *
 * Mainnet and testnet both have an archive. Devnet does not, so `archive` is the
 * same client as the fullnode there (see clients/grpc.ts) and both retries are
 * skipped: they would repeat an identical request against the identical node.
 * Note this gives up an incidental retry the previous inline code performed on
 * devnet, which could paper over a transient blip but also doubled latency on
 * the common NOT_FOUND path.
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
    // Archive is best-effort here — the fullnode already gave us a usable
    // (if empty) response, and failing the whole call would be a regression.
    return response;
  }
}
