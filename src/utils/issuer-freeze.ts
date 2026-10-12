/** Chain-derived active issuer freezes, mapped from an existing DenyList scan. */

import { DENY_LIST_ID } from "./deny-list-probe.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One active (in-force) issuer freeze for a coin. */
export interface IssuerFreezeEntry {
 /** Full coin type, e.g. `0x2::sui::SUI`. */
 coin_type: string;
 /** The config object holding this coin's deny state. */
 config_id: string;
 /** The shared DenyList object (fixed at `0x…403`). */
 deny_list_id: string;
 /** Epoch at which the scan was run — decides what is "in force". */
 epoch: number;
 /** Always `true`: the entry is active at `epoch`. */
 active: true;
 /** On-chain provenance, not a third-party claim. */
 evidence_tier: "chain-derived";
}

/** The current, mutable on-chain freeze state for one address. */
export interface IssuerFreezeResult {
 /** Active entries with config-object provenance. */
 frozen_by_issuer: IssuerFreezeEntry[];
 coins_checked: number;
 /** False when enumeration, a chunk read, or a config lookup did not complete. */
 scan_complete: boolean;
 scan_note?: string;
 caveat: string;
}

/** The raw result shape `checkAddressAcrossCoins` returns. */
export interface RawScanResult {
 denied: string[];
 pending: string[];
 coins_checked: number;
 complete: boolean;
}

// ---------------------------------------------------------------------------
// Pure mapper — the integration point
// ---------------------------------------------------------------------------

/**
 * Map a raw `checkAddressAcrossCoins` result into a typed freeze result.
 *
 * This is **pure** over the given inputs: no network calls, no side effects.
 * Callers that already ran the scan (e.g. `check_coin_restrictions`) pass
 * their result here alongside the cached config map and the epoch they used.
 *
 * `configs` maps coin type to config id from the same scan; a denied coin
 * without a config id is omitted rather than given fabricated provenance.
 */
export function issuerFreezeFromScan(
 scan: RawScanResult,
 epoch: number,
 configs: Map<string, string>,
): IssuerFreezeResult {
 const frozen_by_issuer: IssuerFreezeEntry[] = [];
 const missingConfigs: string[] = [];

 for (const coinType of scan.denied) {
  const configId = configs.get(coinType);
  if (!configId) {
   missingConfigs.push(coinType);
   continue;
  }
  frozen_by_issuer.push({
   coin_type: coinType,
   config_id: configId,
   deny_list_id: DENY_LIST_ID,
   epoch,
   active: true,
   evidence_tier: "chain-derived",
  });
 }

 const parts: string[] = [];
 if (!scan.complete) parts.push("The coin-config enumeration or a deny-list chunk did not complete; unchecked coins may exist.");
 if (missingConfigs.length > 0) {
  parts.push(`${missingConfigs.length} denied coin type(s) omitted because their config id was not available.`);
 }

 return {
  frozen_by_issuer,
  coins_checked: scan.coins_checked,
  scan_complete: scan.complete && missingConfigs.length === 0,
  ...(parts.length ? { scan_note: parts.join(" ") } : {}),
  caveat:
   "Chain-derived from the DenyList object (0x…403). Freezes are issuer decisions recorded on chain, reversible by the DenyCap holder. Pending (scheduled but not yet active) entries are excluded. Off-chain validator transaction blocks cannot be read here.",
 };
}
