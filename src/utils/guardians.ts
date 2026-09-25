import { createRequire } from "node:module";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { getNetwork } from "../config.js";

const require = createRequire(import.meta.url);

/**
 * The Sui wallet blocklist (github.com/MystenLabs/wallet_blocklist), the list
 * Sui wallets use to hide scam coins, packages and NFT types.
 *
 * It is third-party and community-maintained, so a hit is a `flagged_by` note
 * with tier `third-party`. It is never an address label and never a
 * fund-tracing sink: being on a scam list says something about a coin or a
 * package, not about who holds it.
 *
 * Package-keyed, so mainnet-only, like coins.json and protocols.json. Off
 * mainnet there is nothing to report.
 */

export interface GuardiansFile {
  source_url: string;
  commit: string;
  retrieved_at: string;
  prefix_hex_digits: number;
  allowlist: { coins: string[]; packages: string[]; object_types: string[] };
  coins: string[];
  packages: string[];
  object_type_packages: string[];
}

export interface GuardiansFlag {
  list: "MystenLabs/wallet_blocklist";
  /** Which list matched. */
  kind: "coin" | "package" | "object-type-package";
  /** The coin type or package id that matched. */
  matched: string;
  tier: "third-party";
  source_url: string;
  commit: string;
  retrieved_at: string;
  note: string;
}

const KIND_NOTE: Record<GuardiansFlag["kind"], string> = {
  coin: "This coin type is on the scam coin blocklist Sui wallets use to hide tokens.",
  package: "This package is on the scam package blocklist Sui wallets use.",
  "object-type-package":
    "This package defines an object type on the scam object blocklist Sui wallets use to hide NFTs and objects (matched on the first 8 bytes of the package id).",
};
const NOT_A_SINK =
  " Third-party, community-maintained list: context for judging the asset, not attribution of any address, and not a reason to stop a trace.";

function safeStructTag(type: string): string | null {
  try {
    return normalizeStructTag(type);
  } catch {
    return null;
  }
}

export interface GuardiansIndex {
  forCoin(coinType: string): GuardiansFlag[];
  forPackage(packageId: string): GuardiansFlag[];
  /** An object's Move type: its defining package, and the coin inside a `Coin<T>`. */
  forObjectType(objectType: string): GuardiansFlag[];
}

export function createGuardiansIndex(file: GuardiansFile): GuardiansIndex {
  const digits = file.prefix_hex_digits;
  const coins = new Set(file.coins.map((c) => safeStructTag(c)).filter((c): c is string => !!c));
  const allowCoins = new Set(file.allowlist.coins.map((c) => safeStructTag(c)).filter((c): c is string => !!c));
  const allowObjectTypes = new Set(
    file.allowlist.object_types.map((c) => safeStructTag(c)).filter((c): c is string => !!c),
  );
  const objectPackages = new Set(file.object_type_packages);
  const packages = new Set(file.packages);
  const allowPackages = new Set(file.allowlist.packages);

  const flag = (kind: GuardiansFlag["kind"], matched: string): GuardiansFlag => ({
    list: "MystenLabs/wallet_blocklist",
    kind,
    matched,
    tier: "third-party",
    source_url: file.source_url,
    commit: file.commit,
    retrieved_at: file.retrieved_at,
    note: KIND_NOTE[kind] + NOT_A_SINK,
  });

  const forPackage = (packageId: string): GuardiansFlag[] => {
    const id = normalizeSuiAddress(packageId);
    const prefix = id.slice(2, 2 + digits);
    if (allowPackages.has(prefix)) return [];
    const out: GuardiansFlag[] = [];
    if (packages.has(prefix)) out.push(flag("package", id));
    if (objectPackages.has(prefix)) out.push(flag("object-type-package", id));
    return out;
  };

  const forCoin = (coinType: string): GuardiansFlag[] => {
    const tag = safeStructTag(coinType);
    if (!tag || allowCoins.has(tag)) return [];
    const out: GuardiansFlag[] = coins.has(tag) ? [flag("coin", tag)] : [];
    return [...out, ...forPackage(tag.split("::")[0]!)];
  };

  const forObjectType = (objectType: string): GuardiansFlag[] => {
    const tag = safeStructTag(objectType);
    if (!tag || allowObjectTypes.has(tag)) return [];
    const coin = /^0x0*2::coin::Coin<(.+)>$/.exec(tag)?.[1];
    if (coin) return forCoin(coin);
    return forPackage(tag.split("::")[0]!);
  };

  return { forCoin, forPackage, forObjectType };
}

let shipped: GuardiansIndex | null = null;

/**
 * The shipped list, loaded on first use: it is a few MB, and most sessions
 * never ask about a coin or a package.
 */
function index(): GuardiansIndex {
  shipped ??= createGuardiansIndex(require("../data/guardians-blocklist.json") as GuardiansFile);
  return shipped;
}

const onMainnet = () => getNetwork() === "mainnet";

export const guardiansFlagsForCoin = (coinType: string): GuardiansFlag[] =>
  onMainnet() ? index().forCoin(coinType) : [];
export const guardiansFlagsForPackage = (packageId: string): GuardiansFlag[] =>
  onMainnet() ? index().forPackage(packageId) : [];
export const guardiansFlagsForObjectType = (objectType: string): GuardiansFlag[] =>
  onMainnet() ? index().forObjectType(objectType) : [];
