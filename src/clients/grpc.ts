import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";
import { type SuiNetwork, GRPC_TRANSPORT, getNetwork, getNetworkConfig } from "../config.js";
import { retryingFetch } from "./graphql.js";

interface NetworkClients {
  /** Fullnode client. */
  sui: SuiGrpcClient;
  /** Archive client (mainnet + testnet); falls back to the fullnode on devnet. */
  archive: SuiGrpcClient;
}

// One pair of clients per network, built on first use and reused thereafter.
// Switching networks per-call is cheap after the first hit — no reconnect.
const clientCache = new Map<SuiNetwork, NetworkClients>();

function buildClients(network: SuiNetwork): NetworkClients {
  const cfg = getNetworkConfig(network);
  const fullnode = new SuiGrpcClient({ network, baseUrl: cfg.fullnode });
  queueAndRetry(fullnode, cfg.fullnode);

  // Archive serves native gRPC (not gRPC-Web), so we use GrpcTransport instead
  // of the default GrpcWebFetchTransport. Mainnet and testnet have one; devnet
  // does not, so there archive points at the fullnode and callers' fallback
  // logic still type-checks and runs (withArchiveFallback skips the retry).
  const archive: SuiGrpcClient = cfg.archive
    ? new SuiGrpcClient({
        network,
        transport: new GrpcTransport({
          host: cfg.archive,
          channelCredentials: ChannelCredentials.createSsl(),
        }),
      })
    : fullnode;

  return { sui: fullnode, archive };
}

/**
 * Route the fullnode client's gRPC-web requests through {@link retryingFetch}:
 * at most `GRPC_TRANSPORT.concurrency` in flight, and a 429 or 5xx retried with
 * backoff. The SDK builds its `GrpcWebFetchTransport` itself and shares it
 * between every service, and protobuf-ts reads `fetch` from the transport's
 * `defaultOptions` on each call, so setting it there covers every `sui.*` call.
 * `test/grpc-client.test.ts` fails if the SDK stops exposing the transport.
 */
function queueAndRetry(client: SuiGrpcClient, endpoint: string): void {
  const service: object = client.ledgerService;
  if (!("_transport" in service)) return;
  const transport = service._transport;
  if (!transport || typeof transport !== "object" || !("defaultOptions" in transport)) return;
  const options = transport.defaultOptions;
  if (!options || typeof options !== "object") return;
  Object.assign(options, { fetch: retryingFetch(endpoint, { ...GRPC_TRANSPORT, service: "gRPC" }) });
}

/** Get the client pair for a network (defaults to the current call's network). */
export function getClients(network: SuiNetwork = getNetwork()): NetworkClients {
  let clients = clientCache.get(network);
  if (!clients) {
    clients = buildClients(network);
    clientCache.set(network, clients);
  }
  return clients;
}

/**
 * Build a stable proxy that forwards every access to the *current* call's
 * client. Tools import `sui` / `archive` once at module load, but each property
 * access re-resolves against `getNetwork()`, so the same imported reference
 * transparently targets whichever network the active tool call selected.
 *
 * Methods are bound to the real client so `this`-dependent calls (e.g.
 * `sui.getBalance(...)`) work; nested service objects (`sui.ledgerService`)
 * are returned as-is and dispatch on the real client themselves.
 */
function clientProxy(pick: (c: NetworkClients) => SuiGrpcClient): SuiGrpcClient {
  return new Proxy({} as SuiGrpcClient, {
    get(_target, prop) {
      const client = pick(getClients());
      const value = Reflect.get(client as object, prop, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

export const sui: SuiGrpcClient = clientProxy((c) => c.sui);
export const archive: SuiGrpcClient = clientProxy((c) => c.archive);
