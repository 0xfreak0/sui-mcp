/**
 * Permissioned Asset Standard (PAS) accounts.
 *
 * PAS (MystenLabs/pas) holds an issuer's permissioned balances in one shared
 * `Account` per owner, at an address derived from the standard's single
 * `Namespace` object and `AccountKey(owner)`. The balances are address
 * balances of that account address, not of the owner, so a wallet's own
 * balance reads never show them. Funds can be sent to the derived address
 * before the account object is created, so balances are read whether or not
 * the object exists.
 *
 * A PAS balance moves only through a transfer request the asset's issuer
 * policy approves, and the issuer may claw it back, so it is reported apart
 * from the wallet's freely spendable holdings.
 *
 * The package ids come from the standard's own `Published.toml`. The
 * `Namespace` is found by its type once per network: there is only one, and
 * its id never changes. An `Account` is shared, and `derived_object::release`
 * refuses a shared object, so an owner's account address never passes to
 * another owner.
 */

import { bcs } from "@mysten/sui/bcs";
import { deriveObjectID, normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork, type SuiNetwork } from "../config.js";

/** PAS package per network, from MystenLabs/pas `packages/pas/Published.toml`. Devnet has none. */
export const PAS_PACKAGES: Partial<Record<SuiNetwork, string>> = {
  mainnet: "0xe2f75f77648329be3eac31d8455c81df95003dcb5ed50964102b7e1d44f82ad5",
  testnet: "0x7e77592474ea9759b46ca5c6515ed4840952cd80d60ee54a1614382811d46730",
};

/** The account address `namespace` derives for `owner`. Pure. */
export function pasAccountAddress(pkg: string, namespace: string, owner: string): string {
  return normalizeSuiAddress(
    deriveObjectID(namespace, `${pkg}::keys::AccountKey`, bcs.Address.serialize(normalizeSuiAddress(owner)).toBytes()),
  );
}

const namespaceCache = new Map<SuiNetwork, string>();
/** A failed identification, kept briefly so every call does not repeat the type query. */
const namespaceMisses = new Map<SuiNetwork, { at: number; reason: string }>();
const NAMESPACE_MISS_TTL_MS = 5 * 60 * 1000;

/** Test-only. */
export function resetPasCache(): void {
  namespaceCache.clear();
  namespaceMisses.clear();
}

/**
 * PAS is deployed on this network but its Namespace could not be identified,
 * so where owners' accounts sit is unknown. Never read as "no account".
 */
export class PasNamespaceUnavailable extends Error {}

async function namespaceId(pkg: string): Promise<string> {
  const network = getNetwork();
  const cached = namespaceCache.get(network);
  if (cached) return cached;
  const miss = namespaceMisses.get(network);
  if (miss && Date.now() - miss.at < NAMESPACE_MISS_TTL_MS) throw new PasNamespaceUnavailable(miss.reason);
  const d = await gqlQuery<{ objects?: { nodes?: Array<{ address?: string }> } }>(
    `query ($t: String!) { objects(filter: { type: $t }, first: 2) { nodes { address } } }`,
    { t: `${pkg}::namespace::Namespace` },
  );
  const nodes = d.objects?.nodes ?? [];
  // The standard creates exactly one; anything else is not the layout read here.
  if (nodes.length !== 1 || !nodes[0]!.address) {
    const reason = `the PAS Namespace was not identified (${nodes.length} found where the standard creates one)`;
    namespaceMisses.set(network, { at: Date.now(), reason });
    throw new PasNamespaceUnavailable(reason);
  }
  const id = normalizeSuiAddress(nodes[0]!.address);
  namespaceCache.set(network, id);
  return id;
}

/** `owner`'s derived account address, or null where PAS is not deployed. Throws when it cannot be placed. */
export async function pasAccountFor(owner: string): Promise<string | null> {
  const pkg = PAS_PACKAGES[getNetwork()];
  if (!pkg) return null;
  return pasAccountAddress(pkg, await namespaceId(pkg), owner);
}

/** Coin types read from a PAS account per request, and requests per call. */
const BALANCE_PAGE = 50;
export const PAS_BALANCE_PAGES = 4;

const ACCOUNT_QUERY = `query ($a: SuiAddress!, $after: String) {
  object(address: $a) { address }
  address(address: $a) {
    balances(first: ${BALANCE_PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { coinType { repr } totalBalance }
    }
  }
}`;

interface AccountResult {
  object?: { address?: string } | null;
  address?: {
    balances?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      nodes?: Array<{ coinType?: { repr?: string }; totalBalance?: string }>;
    } | null;
  } | null;
}

export interface PasAccount {
  owner: string;
  account_address: string;
  /** Whether the shared `Account` object exists. Funds can sit at the address before it does. */
  account_created: boolean;
  balances: Array<{ coin_type: string; balance: string }>;
  /** More coin types remain after the pages read. */
  balances_truncated: boolean;
  /** Reads the next coin types; null when none remain or the connection gave no advancing cursor. */
  next_cursor: string | null;
}

/**
 * The PAS account `owner` has, or would have, on the call's network, with
 * the balances at its address: up to `PAS_BALANCE_PAGES` pages from `after`.
 * Null when PAS is not deployed on the network. Throws on a failed read, and
 * with `PasNamespaceUnavailable` when the standard's Namespace cannot be
 * identified.
 */
export async function readPasAccount(owner: string, after: string | null = null): Promise<PasAccount | null> {
  const account = await pasAccountFor(owner);
  if (!account) return null;
  const balances: PasAccount["balances"] = [];
  let created = false;
  let cursor = after;
  let more = false;
  let next: string | null = null;
  for (let page = 0; page < PAS_BALANCE_PAGES; page++) {
    const d = await gqlQuery<AccountResult>(ACCOUNT_QUERY, { a: account, after: cursor });
    if (page === 0) created = Boolean(d.object?.address);
    const conn = d.address?.balances;
    for (const n of conn?.nodes ?? []) {
      if (n.coinType?.repr && n.totalBalance && n.totalBalance !== "0") {
        balances.push({ coin_type: n.coinType.repr, balance: n.totalBalance });
      }
    }
    more = Boolean(conn?.pageInfo?.hasNextPage);
    const end = conn?.pageInfo?.endCursor ?? null;
    // A page claiming more with no advancing cursor cannot be continued.
    next = more && end && end !== cursor ? end : null;
    if (!next) break;
    cursor = next;
  }
  return {
    owner: normalizeSuiAddress(owner),
    account_address: account,
    account_created: created,
    balances,
    balances_truncated: more,
    next_cursor: more ? next : null,
  };
}

const BALANCE_QUERY = `query ($a: SuiAddress!, $t: String!) {
  address(address: $a) { balance(coinType: $t) { totalBalance } }
}`;

/**
 * One coin's balance at `owner`'s PAS account, however many coin types the
 * account holds. Null where PAS is not deployed; throws like `readPasAccount`.
 */
export async function readPasBalance(
  owner: string,
  coinType: string,
): Promise<{ account_address: string; balance: string } | null> {
  const account = await pasAccountFor(owner);
  if (!account) return null;
  const d = await gqlQuery<{ address?: { balance?: { totalBalance?: string } | null } | null }>(BALANCE_QUERY, {
    a: account,
    t: coinType,
  });
  return { account_address: account, balance: d.address?.balance?.totalBalance ?? "0" };
}

export const PAS_NOTE =
  "These balances sit in the owner's Permissioned Asset Standard (PAS) account, a shared object at an address derived from the owner, not at the owner's own address, so the owner's holdings do not include them. A PAS balance moves only through a transfer the asset issuer's policy approves, and the issuer may be able to claw it back, so it is not freely spendable the way the holdings are.";
