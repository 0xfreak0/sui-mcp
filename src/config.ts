import { AsyncLocalStorage } from "node:async_hooks";

export type SuiNetwork = "mainnet" | "testnet" | "devnet";

export const SUI_NETWORKS: readonly SuiNetwork[] = ["mainnet", "testnet", "devnet"];

export interface NetworkConfig {
  network: SuiNetwork;
  fullnode: string;
  graphql: string;
  /**
   * Archive gRPC target as `host:port`, or null on networks without an archive.
   * Mainnet and testnet both run one; devnet does not. Archives serve state the
   * fullnodes have pruned — a fullnode answers `NOT_FOUND` for an old epoch or
   * transaction the archive still has.
   *
   * Deliberately not an `https://` URL like the other endpoints: the archives
   * speak native gRPC, not gRPC-Web, so they are passed to `GrpcTransport`,
   * which takes `host:port`. A gRPC-Web client aimed at
   * `https://archive.mainnet.sui.io` gets a 404.
   */
  archive: string | null;
  /** Move Registry base URL, or null on networks without MVR (devnet). */
  mvr: string | null;
  /**
   * DeepBook v3 indexer base URL, or null where none runs (devnet).
   *
   * Serves the order book, fills and OHLCV candles that cannot be reconstructed
   * from chain reads without indexing every fill yourself. Unauthenticated.
   */
  deepbookIndexer: string | null;
}

const NETWORK_URLS: Record<SuiNetwork, Omit<NetworkConfig, "network">> = {
  mainnet: {
    fullnode: "https://fullnode.mainnet.sui.io",
    graphql: "https://graphql.mainnet.sui.io/graphql",
    archive: "archive.mainnet.sui.io:443",
    mvr: "https://mainnet.mvr.mystenlabs.com/v1",
    deepbookIndexer: "https://deepbook-indexer.mainnet.mystenlabs.com",
  },
  testnet: {
    fullnode: "https://fullnode.testnet.sui.io",
    graphql: "https://graphql.testnet.sui.io/graphql",
    archive: "archive.testnet.sui.io:443",
    mvr: "https://testnet.mvr.mystenlabs.com/v1",
    deepbookIndexer: "https://deepbook-indexer.testnet.mystenlabs.com",
  },
  devnet: {
    fullnode: "https://fullnode.devnet.sui.io",
    graphql: "https://graphql.devnet.sui.io/graphql",
    archive: null,
    mvr: null,
    deepbookIndexer: null,
  },
};

export function isSuiNetwork(value: unknown): value is SuiNetwork {
  return typeof value === "string" && (SUI_NETWORKS as readonly string[]).includes(value);
}

/**
 * The network used when a call doesn't specify one. Taken from `SUI_NETWORK`
 * (mainnet if unset or unrecognized). Individual tool calls override this
 * per-call via their `network` argument — nothing is bound at startup.
 */
export const DEFAULT_NETWORK: SuiNetwork = (() => {
  const env = process.env.SUI_NETWORK?.toLowerCase();
  return isSuiNetwork(env) ? env : "mainnet";
})();

/**
 * Per-call network context. Each tool invocation runs inside
 * {@link runWithNetwork}, so `getNetwork()` returns whatever that specific call
 * asked for. Using AsyncLocalStorage (not a mutable global) keeps concurrent
 * calls isolated — a parallel mainnet query and testnet query each see their
 * own network, which is the whole point of per-call selection.
 */
const networkContext = new AsyncLocalStorage<SuiNetwork>();

/** Run `fn` with `network` as the active network for its entire async chain. */
export function runWithNetwork<T>(network: SuiNetwork, fn: () => T): T {
  return networkContext.run(network, fn);
}

/** The network for the current call, or {@link DEFAULT_NETWORK} outside a call. */
export function getNetwork(): SuiNetwork {
  return networkContext.getStore() ?? DEFAULT_NETWORK;
}

/**
 * Resolve endpoint config for a network (defaults to the active one).
 *
 * `SUI_FULLNODE_URL` / `SUI_GRAPHQL_URL` / `SUI_MVR_URL` env overrides apply
 * ONLY to {@link DEFAULT_NETWORK}. A call that targets a different network gets
 * that network's canonical public endpoints — a custom mainnet fullnode URL
 * must not silently be reused as the "testnet" endpoint.
 */
export function getNetworkConfig(network: SuiNetwork = getNetwork()): NetworkConfig {
  const urls = NETWORK_URLS[network];
  const isDefault = network === DEFAULT_NETWORK;
  return {
    network,
    fullnode: (isDefault ? process.env.SUI_FULLNODE_URL : undefined) ?? urls.fullnode,
    graphql: (isDefault ? process.env.SUI_GRAPHQL_URL : undefined) ?? urls.graphql,
    archive: urls.archive,
    mvr: (isDefault ? process.env.SUI_MVR_URL : undefined) ?? urls.mvr,
    deepbookIndexer: urls.deepbookIndexer,
  };
}

/** Move Registry base URL for the active network, or null if unavailable. */
export function getMvrUrl(): string | null {
  return getNetworkConfig().mvr;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 1000;

/**
 * Timeout for calls to non-Sui HTTP services (Aftermath, Pyth, MVR).
 *
 * These are third-party endpoints on the critical path of a tool call, and
 * `fetch` has no default timeout — an unresponsive host would otherwise hang
 * the call until undici's ~300s header timeout, long past the point any client
 * still cares. One constant so every external call fails on the same clock.
 * gRPC and GraphQL are not covered here; their clients carry their own deadlines.
 */
export const EXTERNAL_HTTP_TIMEOUT_MS = 10_000;

export const DECOMPILER_PATH = process.env.SUI_DECOMPILER_PATH ?? "move-decompiler";

export function suivisionPackageUrl(packageId: string): string {
  return `https://suivision.xyz/package/${packageId}?tab=Code`;
}

export function moveRegistryUrl(name: string): string {
  return `https://www.moveregistry.com/package/${name}`;
}
