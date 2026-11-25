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

/** Test-only. */
export function resetPasCache(): void {
  namespaceCache.clear();
}

async function namespaceId(pkg: string): Promise<string | null> {
  const network = getNetwork();
  const cached = namespaceCache.get(network);
  if (cached) return cached;
  const d = await gqlQuery<{ objects?: { nodes?: Array<{ address?: string }> } }>(
    `query ($t: String!) { objects(filter: { type: $t }, first: 2) { nodes { address } } }`,
    { t: `${pkg}::namespace::Namespace` },
  );
  const nodes = d.objects?.nodes ?? [];
  // The standard creates exactly one; anything else is not the layout read here.
  if (nodes.length !== 1 || !nodes[0]!.address) return null;
  const id = normalizeSuiAddress(nodes[0]!.address);
  namespaceCache.set(network, id);
  return id;
}

/** Coin types read from a PAS account per request. */
const BALANCE_PAGE = 50;

const ACCOUNT_QUERY = `query ($a: SuiAddress!) {
  object(address: $a) { address }
  address(address: $a) {
    balances(first: ${BALANCE_PAGE}) {
      pageInfo { hasNextPage }
      nodes { coinType { repr } totalBalance addressBalance }
    }
  }
}`;

interface AccountResult {
  object?: { address?: string } | null;
  address?: {
    balances?: {
      pageInfo?: { hasNextPage?: boolean };
      nodes?: Array<{ coinType?: { repr?: string }; totalBalance?: string; addressBalance?: string | null }>;
    } | null;
  } | null;
}

export interface PasAccount {
  owner: string;
  account_address: string;
  /** Whether the shared `Account` object exists. Funds can sit at the address before it does. */
  account_created: boolean;
  balances: Array<{ coin_type: string; balance: string }>;
  /** More coin types than one page holds. */
  balances_truncated: boolean;
}

/**
 * The PAS account `owner` has, or would have, on the call's network, with
 * the balances at its address. Null when PAS is not deployed on the network
 * or its namespace could not be identified. A failed read throws.
 */
export async function readPasAccount(owner: string): Promise<PasAccount | null> {
  const pkg = PAS_PACKAGES[getNetwork()];
  if (!pkg) return null;
  const namespace = await namespaceId(pkg);
  if (!namespace) return null;
  const account = pasAccountAddress(pkg, namespace, owner);
  const d = await gqlQuery<AccountResult>(ACCOUNT_QUERY, { a: account });
  const conn = d.address?.balances;
  return {
    owner: normalizeSuiAddress(owner),
    account_address: account,
    account_created: Boolean(d.object?.address),
    balances: (conn?.nodes ?? [])
      .filter((n) => n.coinType?.repr && n.totalBalance && n.totalBalance !== "0")
      .map((n) => ({ coin_type: n.coinType!.repr!, balance: n.totalBalance! })),
    balances_truncated: Boolean(conn?.pageInfo?.hasNextPage),
  };
}

export const PAS_NOTE =
  "These balances sit in the owner's Permissioned Asset Standard (PAS) account, a shared object at an address derived from the owner, not at the owner's own address, so the owner's holdings do not include them. A PAS balance moves only through a transfer the asset issuer's policy approves, and the issuer may be able to claw it back, so it is not freely spendable the way the holdings are.";
