import { createRequire } from "node:module";
import { namespaceOf, parseAccountId, SUI_MAINNET } from "./chain-id.js";

const require = createRequire(import.meta.url);

/**
 * OFAC's SDN digital currency addresses, as synced by scripts/sync-sanctions.mjs.
 *
 * Matched by NAMESPACE and address, not by chain: OFAC lists a key under a
 * currency code (ETH, USDT, ARB, …), and the same 20-byte EVM key is the
 * sanctioned party's on every EVM chain. A Solana or Sui entry matches only its
 * own namespace.
 */

export interface SanctionsAccount {
  namespace: string;
  address: string;
  currencies: string[];
  sdn_name: string;
  sdn_entity_id: string | null;
  programs: string[];
}

export interface SanctionsFile {
  source_url: string;
  list: string;
  data_as_of: string | null;
  retrieved_at: string;
  total_digital_currency_addresses: number;
  by_currency: Record<string, number>;
  sui_address_count: number;
  accounts: SanctionsAccount[];
}

export interface SanctionsHit {
  list: string;
  sdn_name: string;
  sdn_entity_id: string | null;
  programs: string[];
  listed_as: string[];
  source_url: string;
  data_as_of: string | null;
  retrieved_at: string;
}

export interface SanctionsIndex {
  /** Hit for a CAIP-10 account (or a bare Sui address), or null. */
  match(account: string): SanctionsHit | null;
  coverage(): {
    list: string;
    source_url: string;
    data_as_of: string | null;
    retrieved_at: string;
    sui_addresses_listed: number;
    matchable_addresses: number;
    total_digital_currency_addresses: number;
  };
}

export function createSanctionsIndex(file: SanctionsFile): SanctionsIndex {
  const byKey = new Map(file.accounts.map((a) => [`${a.namespace}|${a.address}`, a]));
  return {
    match(reference) {
      let parsed;
      try {
        parsed = parseAccountId(reference, SUI_MAINNET);
      } catch {
        return null;
      }
      const hit = byKey.get(`${namespaceOf(parsed.chain)}|${parsed.address}`);
      if (!hit) return null;
      return {
        list: file.list,
        sdn_name: hit.sdn_name,
        sdn_entity_id: hit.sdn_entity_id,
        programs: hit.programs,
        listed_as: hit.currencies,
        source_url: file.source_url,
        data_as_of: file.data_as_of,
        retrieved_at: file.retrieved_at,
      };
    },
    coverage() {
      return {
        list: file.list,
        source_url: file.source_url,
        data_as_of: file.data_as_of,
        retrieved_at: file.retrieved_at,
        sui_addresses_listed: file.sui_address_count,
        matchable_addresses: file.accounts.length,
        total_digital_currency_addresses: file.total_digital_currency_addresses,
      };
    },
  };
}

let shipped: SanctionsIndex | null = null;

/** The shipped OFAC list, loaded on first use. */
export function sanctions(): SanctionsIndex {
  shipped ??= createSanctionsIndex(require("../data/sanctions.json") as SanctionsFile);
  return shipped;
}
