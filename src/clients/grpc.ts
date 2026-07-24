import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";
import { type SuiNetwork, getNetwork, getNetworkConfig } from "../config.js";

interface NetworkClients {
  /** Fullnode client. */
  sui: SuiGrpcClient;
  /** Archive client (mainnet only); falls back to the fullnode elsewhere. */
  archive: SuiGrpcClient;
}

// One pair of clients per network, built on first use and reused thereafter.
// Switching networks per-call is cheap after the first hit — no reconnect.
const clientCache = new Map<SuiNetwork, NetworkClients>();

function buildClients(network: SuiNetwork): NetworkClients {
  const cfg = getNetworkConfig(network);
  const fullnode = new SuiGrpcClient({ network, baseUrl: cfg.fullnode });

  // Archive serves native gRPC (not gRPC-Web), so we use GrpcTransport instead
  // of the default GrpcWebFetchTransport. Archive is only available on mainnet;
  // elsewhere we point archive at the fullnode so callers' fallback logic works.
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
