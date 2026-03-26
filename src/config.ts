export type SuiNetwork = "mainnet" | "testnet" | "devnet";

const NETWORK_URLS: Record<SuiNetwork, { fullnode: string; graphql: string; archive: string | null }> = {
  mainnet: {
    fullnode: "https://fullnode.mainnet.sui.io",
    graphql: "https://graphql.mainnet.sui.io/graphql",
    archive: "archive.mainnet.sui.io:443",
  },
  testnet: {
    fullnode: "https://fullnode.testnet.sui.io",
    graphql: "https://graphql.testnet.sui.io/graphql",
    archive: null,
  },
  devnet: {
    fullnode: "https://fullnode.devnet.sui.io",
    graphql: "https://graphql.devnet.sui.io/graphql",
    archive: null,
  },
};

function resolveNetwork(): SuiNetwork {
  const env = process.env.SUI_NETWORK?.toLowerCase();
  if (env === "testnet" || env === "devnet") return env;
  return "mainnet";
}

export const SUI_NETWORK = resolveNetwork();

const urls = NETWORK_URLS[SUI_NETWORK];

export const FULLNODE_URL = process.env.SUI_FULLNODE_URL ?? urls.fullnode;
export const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? urls.graphql;
export const ARCHIVE_HOST = urls.archive;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 1000;

export const DECOMPILER_PATH = process.env.SUI_DECOMPILER_PATH ?? "move-decompiler";

export function suivisionPackageUrl(packageId: string): string {
  return `https://suivision.xyz/package/${packageId}?tab=Code`;
}
