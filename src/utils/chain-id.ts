/**
 * Chain-qualified account identity (CAIP-2 / CAIP-10).
 *
 * This server was Sui-only, so an address was unambiguous on its own: a bare
 * `0x…` could key a label, name a finding, or terminate a trace with no
 * further context. Cross-chain investigation removes that guarantee. The same
 * hex string is a different entity on Ethereum than on Sui, and even the same
 * string on Sui mainnet and Sui testnet is two unrelated accounts.
 *
 * Everything that *stores* or *reports* an identity therefore carries a
 * {@link AccountId} — a CAIP-2 chain plus an address normalized under that
 * chain's rules. Callers that are still inherently Sui-scoped (a trace, a
 * balance read) keep passing bare strings; the boundary resolves them against
 * the network the call is running on.
 *
 * Normalization is deliberately per-chain rather than shared. The Sui rule
 * (left-pad to 32 bytes, lowercase) is actively wrong elsewhere: applied to a
 * 20-byte EVM address it invents a 32-byte address belonging to nobody, and
 * applied to a Solana address it destroys base58, which is case-significant.
 * A chain we cannot normalize for is rejected rather than passed through, so
 * an unnormalized identity never reaches storage where it would silently fail
 * to match its own canonical form.
 *
 * Format reference: CAIP-2 `namespace:reference`, CAIP-10
 * `namespace:reference:address`.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { getNetwork, type SuiNetwork } from "../config.js";

/** A CAIP-2 chain id, e.g. `sui:mainnet`, `eip155:1`. */
export type ChainId = string;

export const SUI_MAINNET = "sui:mainnet";
export const SUI_TESTNET = "sui:testnet";
export const SUI_DEVNET = "sui:devnet";
export const ETHEREUM = "eip155:1";
/** CAIP-2 for Solana mainnet-beta: the genesis hash truncated to 32 chars. */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** An address together with the chain it exists on. */
export interface AccountId {
  /** CAIP-2 chain id. */
  chain: ChainId;
  /** Chain-native address, normalized under that chain's rules. */
  address: string;
}

/**
 * How to normalize and validate an address for one namespace.
 *
 * Keyed on CAIP-2 *namespace*, not chain id, because every EVM chain shares
 * one address format — otherwise adding Base or Arbitrum would mean copying
 * the same rule again.
 */
type AddressRule = (address: string) => string;

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
// Base58 as Bitcoin/Solana define it: no 0, O, I or l, since those are the
// characters people misread.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

const ADDRESS_RULES: Record<string, AddressRule> = {
  sui: (a) => normalizeSuiAddress(a.toLowerCase()),

  eip155: (a) => {
    const lower = a.toLowerCase();
    if (!EVM_ADDRESS.test(lower)) {
      throw new Error(
        `not a 20-byte EVM address: ${a}. Expected 0x followed by 40 hex characters.`,
      );
    }
    // Canonical form is lowercase. EIP-55 checksum casing is a display
    // convention; storing it would make two spellings of one address fail to
    // compare equal.
    return lower;
  },

  solana: (a) => {
    // No case folding: base58 is case-significant, so lowercasing produces a
    // different (and almost certainly nonexistent) account.
    if (a.length < 32 || a.length > 44 || !BASE58.test(a)) {
      throw new Error(
        `not a base58 Solana address: ${a}. Expected 32-44 base58 characters.`,
      );
    }
    return a;
  },
};

interface ChainMeta {
  /** Human-readable name for reports. */
  name: string;
}

/**
 * Chains this server can normalize an address for.
 *
 * Membership is a claim about address handling only — it does not imply there
 * is a client that can query the chain. A chain can be identified and labeled
 * (which is what a cross-chain trace needs at a bridge boundary) long before
 * anything here can read from it.
 */
const CHAINS: Record<ChainId, ChainMeta> = {
  [SUI_MAINNET]: { name: "Sui" },
  [SUI_TESTNET]: { name: "Sui testnet" },
  [SUI_DEVNET]: { name: "Sui devnet" },
  [ETHEREUM]: { name: "Ethereum" },
  "eip155:10": { name: "Optimism" },
  "eip155:56": { name: "BNB Chain" },
  "eip155:137": { name: "Polygon" },
  "eip155:8453": { name: "Base" },
  "eip155:42161": { name: "Arbitrum One" },
  "eip155:43114": { name: "Avalanche" },
  [SOLANA_MAINNET]: { name: "Solana" },
};

export function isKnownChainId(chain: string): boolean {
  return Object.hasOwn(CHAINS, chain);
}

/** Every chain id this server can normalize for. */
export function knownChainIds(): ChainId[] {
  return Object.keys(CHAINS);
}

/** The CAIP-2 namespace of a chain id (`eip155` for `eip155:1`). */
export function namespaceOf(chain: ChainId): string {
  return chain.split(":")[0] ?? chain;
}

/**
 * Human-readable chain name for reports.
 *
 * Falls back to the raw chain id for anything unknown: a report must render
 * whatever it was given rather than fail on a chain we merely lack an address
 * rule for.
 */
export function chainDisplayName(chain: ChainId): string {
  return CHAINS[chain]?.name ?? chain;
}

/** The CAIP-2 chain id for a Sui network. Each network is its own chain. */
export function caip2ForSuiNetwork(network: SuiNetwork): ChainId {
  return `sui:${network}`;
}

/**
 * Normalize `address` under `chain`'s rules.
 *
 * Throws for an unknown chain rather than returning the input unchanged.
 * Passing it through would store a value that cannot be compared against its
 * own canonical form later — a silently missing label rather than an error.
 */
export function normalizeAddressForChain(chain: ChainId, address: string): string {
  const rule = ADDRESS_RULES[namespaceOf(chain)];
  if (!rule || !isKnownChainId(chain)) {
    throw new Error(
      `unknown chain '${chain}' — no address normalization rule. Known chains: ${knownChainIds().join(", ")}`,
    );
  }
  return rule(address.trim());
}

/**
 * Parse either a bare address or a full CAIP-10 account id.
 *
 * A bare address is assigned `defaultChain`, which is how Sui-scoped callers
 * keep working unchanged: the tool boundary passes the network the call is
 * running on. An explicit `namespace:reference:address` always wins over the
 * default, and is normalized under the chain it names — not under the
 * default's rules.
 */
export function parseAccountId(raw: string, defaultChain: ChainId): AccountId {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty account id");

  // Only a CAIP-10 has two colons; no chain's address format contains one.
  const parts = trimmed.split(":");
  if (parts.length === 1) {
    return { chain: defaultChain, address: normalizeAddressForChain(defaultChain, trimmed) };
  }
  if (parts.length !== 3 || parts.some((p) => p === "")) {
    throw new Error(
      `malformed account id '${raw}' — expected a bare address or 'namespace:reference:address'`,
    );
  }

  const chain = `${parts[0]}:${parts[1]}`;
  return { chain, address: normalizeAddressForChain(chain, parts[2]!) };
}

/** Render as a canonical CAIP-10 string. */
export function formatAccountId(account: AccountId): string {
  return `${account.chain}:${account.address}`;
}

/** True when two references — bare or qualified — name the same account. */
export function sameAccount(a: string, b: string, defaultChain: ChainId): boolean {
  return (
    formatAccountId(parseAccountId(a, defaultChain)) ===
    formatAccountId(parseAccountId(b, defaultChain))
  );
}

/**
 * The CAIP-2 chain for the network the current call is running on.
 *
 * This is the bridge that lets Sui-scoped callers stay bare-address-shaped:
 * they hand over a `0x…` and the identity layer qualifies it with whichever
 * network `runWithNetwork` selected for that call.
 */
export function currentSuiChain(): ChainId {
  return caip2ForSuiNetwork(getNetwork());
}

/**
 * Canonical CAIP-10 for a reference that may be bare or already qualified,
 * defaulting to the current call's Sui network.
 */
export function currentSuiAccount(reference: string): string {
  return formatAccountId(parseAccountId(reference, currentSuiChain()));
}
