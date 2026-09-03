/**
 * Wormholescan lookup: the destination side of a transfer.
 *
 * Sui can prove a VAA was *emitted* — the core bridge event carries its
 * identity. It cannot know whether that VAA was redeemed, or on which chain,
 * because the redemption happens somewhere else entirely. Something has to
 * index both sides, and Wormholescan is the public index that does.
 *
 * This is a genuine change of posture for this server, which otherwise reads
 * only from the chain, so it is contained here and every value it produces is
 * marked `indexer-attested`. Treat the destination transaction as a strong
 * lead to confirm on the destination chain, not as something this server
 * verified.
 */

import { EXTERNAL_HTTP_TIMEOUT_MS, getNetwork, type SuiNetwork } from "../../config.js";

/**
 * Wormholescan runs a separate index per environment. Devnet has none, and
 * there is nothing to fall back to: querying the mainnet index with a devnet
 * digest returns an empty result that reads as "never redeemed" rather than
 * "not indexed here", which is the wrong conclusion to hand an investigator.
 */
const API_BY_NETWORK: Partial<Record<SuiNetwork, string>> = {
  mainnet: "https://api.wormholescan.io/api/v1",
  testnet: "https://api.testnet.wormholescan.io/api/v1",
};

/** True when Wormholescan indexes the network this call is running against. */
export function wormholescanAvailable(network: SuiNetwork = getNetwork()): boolean {
  return API_BY_NETWORK[network] !== undefined;
}

function apiBase(): string {
  const base = API_BY_NETWORK[getNetwork()];
  if (!base) {
    throw new Error(
      `Wormholescan does not index ${getNetwork()}, so the redemption side cannot be looked up there.`,
    );
  }
  return base;
}

/** The subset of an operation this server uses. */
export interface WormholescanOperation {
  /** `emitterChain/emitterAddress/sequence`. */
  id: string;
  emitterChain: number | null;
  emitterAddress: string | null;
  sequence: string | null;
  sourceTxHash: string | null;
  sourceAddress: string | null;
  /** Null until the VAA is redeemed — an unredeemed transfer is in flight. */
  destination: {
    wormholeChain: number | null;
    txHash: string | null;
    /** The receiving address as the destination chain writes it. */
    to: string | null;
    status: string | null;
    timestamp: string | null;
  } | null;
  /** Standardised transfer properties. Frequently absent; never assume. */
  transfer: {
    fromChain: number | null;
    fromAddress: string | null;
    toChain: number | null;
    toAddress: string | null;
    tokenChain: number | null;
    tokenAddress: string | null;
    amount: string | null;
  } | null;
  /** Protocols the indexer attributes the operation to, e.g. `CCTP_V1`. */
  appIds: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * Exported for tests: the response shape varies more than its docs suggest,
 * and pinning that variance down is worth more than testing the fetch.
 *
 * Wormholescan reports a fully-populated `targetChain` for some operations and
 * a fully-populated `standarizedProperties` for others — observed on mainnet,
 * where one real transfer had an empty `standarizedProperties` while its
 * `targetChain` was complete. Both are therefore optional and read
 * independently; neither may be used to decide the other is absent.
 */
export function parseOperation(raw: unknown): WormholescanOperation | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;

  const target = o.targetChain && typeof o.targetChain === "object" ? o.targetChain : null;
  // An empty object means "not redeemed yet", which is different from
  // "redeemed somewhere we failed to parse" — only a chain id makes it real.
  const hasTarget = target !== null && num(target.chainId) !== null;

  const sp =
    o.content && typeof o.content === "object" && o.content.standarizedProperties
      ? o.content.standarizedProperties
      : null;
  const hasTransfer = sp !== null && typeof sp === "object" && num(sp.fromChain);

  return {
    id: str(o.id) ?? "",
    emitterChain: num(o.emitterChain),
    emitterAddress: str(o.emitterAddress?.hex),
    sequence: o.sequence === undefined || o.sequence === null ? null : String(o.sequence),
    sourceTxHash: str(o.sourceChain?.transaction?.txHash),
    sourceAddress: str(o.sourceChain?.from),
    destination: hasTarget
      ? {
          wormholeChain: num(target.chainId),
          txHash: str(target.transaction?.txHash),
          to: str(target.to),
          status: str(target.status),
          timestamp: str(target.timestamp),
        }
      : null,
    transfer: hasTransfer
      ? {
          fromChain: num(sp.fromChain),
          fromAddress: str(sp.fromAddress),
          toChain: num(sp.toChain),
          toAddress: str(sp.toAddress),
          tokenChain: num(sp.tokenChain),
          tokenAddress: str(sp.tokenAddress),
          amount: str(sp.amount),
        }
      : null,
    appIds: Array.isArray(sp?.appIds) ? sp.appIds.filter((a: unknown) => typeof a === "string") : [],
  };
}

async function get(path: string): Promise<unknown> {
  // fetch has no default timeout; without this a hung indexer hangs the tool.
  const res = await fetch(`${apiBase()}${path}`, {
    signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Wormholescan ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

/** Operations Wormholescan associates with a source transaction hash. */
export async function operationsByTxHash(txHash: string): Promise<WormholescanOperation[]> {
  const body = (await get(`/operations?txHash=${encodeURIComponent(txHash)}`)) as {
    operations?: unknown[];
  };
  return (body?.operations ?? [])
    .map(parseOperation)
    .filter((o): o is WormholescanOperation => o !== null);
}

/**
 * One operation by its VAA triple.
 *
 * The fallback for a source-transaction lookup that comes back empty. The VAA
 * identity is read from chain data, so it is the more reliable key of the two:
 * the indexer may not associate a transaction hash the way we spell it, but
 * the triple is what the guardians sign and what every chain quotes back.
 *
 * Returns null on 404 — a VAA the indexer has not seen is an ordinary answer
 * ("in flight", "too recent"), not a failure worth losing the chain-derived
 * half over.
 */
export async function operationByVaa(
  emitterChain: number,
  emitter: string,
  sequence: string,
): Promise<WormholescanOperation | null> {
  let body: unknown;
  try {
    body = await get(
      `/operations/${emitterChain}/${encodeURIComponent(emitter)}/${encodeURIComponent(sequence)}`,
    );
  } catch (err) {
    if ((err as Error).message.includes("404")) return null;
    throw err;
  }
  // This endpoint returns the operation directly, unlike the list endpoint.
  return parseOperation(body);
}
