/**
 * LayerZero Scan: the delivery side of a packet sent from Sui.
 *
 * The packet's GUID, destination and (for an OFT) recipient are read from Sui.
 * Whether it was delivered, and in which destination transaction, is only
 * known to the destination chain, so that half comes from LayerZero's public
 * index and is `indexer-attested`, like Wormholescan's redemption.
 *
 * Mainnet only: the index is keyed by source transaction, and there is no
 * verified testnet counterpart. An empty answer elsewhere would read as
 * "never delivered".
 */

import { EXTERNAL_HTTP_TIMEOUT_MS, type SuiNetwork } from "../../config.js";

const API = "https://scan.layerzero-api.com/v1";

export function layerZeroScanAvailable(network: SuiNetwork): boolean {
  return network === "mainnet";
}

export interface LayerZeroScanMessage {
  guid: string;
  /** LayerZero's overall status, e.g. `DELIVERED`, `INFLIGHT`. */
  status: string | null;
  sourceStatus: string | null;
  destination: {
    status: string | null;
    txHash: string | null;
    /** ISO-8601. */
    timestamp: string | null;
  } | null;
  /** LayerZero's name for the sending application, e.g. `wBTC`. */
  appName: string | null;
  receiver: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Exported for tests. Tolerates missing sections, which the index omits while a message is in flight. */
export function parseScanMessage(raw: unknown): LayerZeroScanMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, any>;
  const guid = str(m.guid);
  if (!guid) return null;
  const dest = m.destination && typeof m.destination === "object" ? m.destination : null;
  const ts = dest?.tx?.blockTimestamp;
  return {
    guid: guid.toLowerCase(),
    status: str(m.status?.name),
    sourceStatus: str(m.source?.status),
    destination: dest
      ? {
          status: str(dest.status),
          txHash: str(dest.tx?.txHash),
          timestamp: typeof ts === "number" ? new Date(ts * 1000).toISOString() : null,
        }
      : null,
    appName: str(m.pathway?.sender?.name),
    receiver: str(m.pathway?.receiver?.address),
  };
}

/** Messages LayerZero Scan associates with a Sui transaction. A 404 is an empty answer, not a failure. */
export async function layerZeroMessagesByTx(digest: string): Promise<LayerZeroScanMessage[]> {
  // fetch has no default timeout; without this a hung indexer hangs the tool.
  const res = await fetch(`${API}/messages/tx/${encodeURIComponent(digest)}`, {
    signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`LayerZero Scan ${res.status}: ${res.statusText}`);
  const body = (await res.json()) as { data?: unknown[] };
  return (body?.data ?? []).map(parseScanMessage).filter((m): m is LayerZeroScanMessage => m !== null);
}
