/**
 * Reading the on-chain deny list. Pure interpretation lives in
 * `deny-list.ts`; this is the walking.
 *
 * Everything here is a **keyed lookup**, not a scan. Both levels of the deny
 * list are dynamic fields with structured keys, so a question about one coin
 * or one address is one or two requests. Paging the whole thing instead costs
 * about 5.5s — mainnet has ~1000 configured coin types — and answers a
 * question nobody asked.
 *
 * The keys are BCS-encoded by hand because they are tiny and fixed:
 * `ConfigKey` is a u64 plus a length-prefixed string, `AddressKey` is 32 raw
 * bytes, and `GlobalPauseKey` is empty.
 *
 * "Is this address frozen anywhere" still has no index. Callers answer it
 * against the coins that matter — the ones the address actually holds —
 * because being denied for a coin it has never touched is not a finding.
 */

import { gqlQuery } from "../clients/graphql.js";
import { sui } from "../clients/grpc.js";
import {
  ADDRESS_KEY,
  GLOBAL_PAUSE_KEY,
  coinTypeFromKey,
  effectiveSetting,
  isPending,
  type CoinRestrictions,
  type DeniedAddress,
  type RawSetting,
} from "./deny-list.js";

/** The shared DenyList object. Fixed by the framework. */
export const DENY_LIST_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000403";

const PAGE = 50;

const FIELDS = `query ($id: SuiAddress!, $cursor: String, $first: Int!) {
  object(address: $id) {
    dynamicFields(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name { type { repr } json }
        value {
          __typename
          ... on MoveValue { json }
          ... on MoveObject { address }
        }
      }
    }
  }
}`;

interface FieldsResult {
  object?: {
    dynamicFields?: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        name?: { type?: { repr?: string }; json?: unknown };
        value?: { __typename?: string; json?: unknown; address?: string };
      }>;
    };
  } | null;
}

async function page(id: string, cursor: string | null) {
  const r = await gqlQuery<FieldsResult>(FIELDS, { id, cursor, first: PAGE });
  return r.object?.dynamicFields ?? null;
}

/** Current epoch, which decides whether a recorded denial is in force. */
export async function currentEpoch(): Promise<number> {
  const { response } = await sui.ledgerService.getEpoch({
    epoch: undefined,
    readMask: { paths: ["epoch"] },
  });
  return Number(response.epoch?.epoch ?? 0);
}

/**
 * BCS for `ConfigKey { per_type_index: u64, per_type_key: vector<u8> }`.
 *
 * `per_type_index` is `COIN_INDEX` (0) — the deny list is generic over
 * "config kinds" and coins are kind 0. `per_type_key` is the coin's canonical
 * type string **without** the `0x`, which is how the framework writes it.
 */
export function configKeyBcs(coinType: string): string {
  const bytes = Buffer.from(coinType.replace(/^0x/, ""), "utf8");
  const index = Buffer.alloc(8); // u64 little-endian, COIN_INDEX = 0
  const len: number[] = [];
  let n = bytes.length;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    len.push(b);
  } while (n);
  return Buffer.concat([index, Buffer.from(len), bytes]).toString("base64");
}

/** BCS for `AddressKey(address)` — a newtype, so just the 32 raw bytes. */
export function addressKeyBcs(address: string): string {
  return Buffer.from(address.replace(/^0x/, "").padStart(64, "0"), "hex").toString("base64");
}

const CONFIG_FOR_COIN = `query ($id: SuiAddress!, $bcs: Base64!) {
  object(address: $id) {
    dynamicObjectField(name: { type: "0x2::deny_list::ConfigKey", bcs: $bcs }) {
      value { __typename ... on MoveObject { address } }
    }
  }
}`;

const SETTING_FOR_KEY = `query ($id: SuiAddress!, $type: String!, $bcs: Base64!) {
  object(address: $id) {
    dynamicField(name: { type: $type, bcs: $bcs }) {
      value { ... on MoveValue { json } }
    }
  }
}`;

/**
 * The config object holding a coin's deny state, or null if the coin has none.
 *
 * A keyed lookup rather than a walk. There are ~1000 configured coin types on
 * mainnet and paging them all costs about 5.5s, which is not a price to pay
 * for a question about one coin.
 *
 * Null means the coin is unregulated — no `DenyCap` has ever written state for
 * it — which is a real answer, not a failure.
 */
export async function findCoinConfig(coinType: string): Promise<string | null> {
  const r = await gqlQuery<{
    object?: { dynamicObjectField?: { value?: { address?: string } } | null } | null;
  }>(CONFIG_FOR_COIN, { id: DENY_LIST_ID, bcs: configKeyBcs(coinType) });
  return r.object?.dynamicObjectField?.value?.address ?? null;
}

/** Read one setting out of a coin's config by key. Null when absent. */
async function readSetting(configId: string, type: string, bcs: string): Promise<RawSetting | null> {
  const r = await gqlQuery<{
    object?: { dynamicField?: { value?: { json?: unknown } } | null } | null;
  }>(SETTING_FOR_KEY, { id: configId, type, bcs });
  return (r.object?.dynamicField?.value?.json as RawSetting | undefined) ?? null;
}

/**
 * Is one address frozen for one coin, right now.
 *
 * Two keyed lookups and no paging, so this is affordable per address per coin —
 * which is what makes checking a wallet against the coins it actually holds
 * practical.
 */
export async function checkAddress(
  coinType: string,
  address: string,
  epoch: number,
): Promise<{ coin_type: string; denied: boolean; pending: boolean; globally_paused: boolean | null } | null> {
  const configId = await findCoinConfig(coinType);
  if (!configId) return null;

  const [addrSetting, pauseSetting] = await Promise.all([
    readSetting(configId, "0x2::deny_list::AddressKey", addressKeyBcs(address)),
    // GlobalPauseKey() is an empty struct, so its BCS is zero bytes.
    readSetting(configId, "0x2::deny_list::GlobalPauseKey", ""),
  ]);

  return {
    coin_type: coinType,
    denied: addrSetting ? effectiveSetting(addrSetting, epoch) === true : false,
    pending: addrSetting ? isPending(addrSetting, epoch) : false,
    globally_paused: pauseSetting ? effectiveSetting(pauseSetting, epoch) : null,
  };
}

/**
 * Every coin type with a deny config, mapped to its config object.
 *
 * ~1000 entries on mainnet, so this pages and costs seconds. Only worth it for
 * "show me everything regulated" — a question about one coin should use
 * {@link findCoinConfig}, and one about one address {@link checkAddress}.
 */
export async function listConfiguredCoins(maxPages = 25): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const conn = await page(DENY_LIST_ID, cursor);
    if (!conn) break;
    for (const n of conn.nodes) {
      const key = (n.name?.json as { per_type_key?: string } | undefined)?.per_type_key;
      const config = n.value?.address;
      if (!key || !config) continue;
      const coin = coinTypeFromKey(key);
      if (coin) out.set(coin, config);
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

/**
 * Read one coin's deny state: who is frozen, and whether the coin is paused.
 *
 * `epoch` decides what is actually in force — see `effectiveSetting`. An entry
 * written this epoch is recorded but not yet active, and is reported as such
 * rather than as a freeze.
 */
export async function readCoinRestrictions(
  coinType: string,
  configId: string,
  epoch: number,
  maxPages = 20,
): Promise<CoinRestrictions> {
  const out: CoinRestrictions = {
    coin_type: coinType,
    config_id: configId,
    globally_paused: null,
    denied: [],
    truncated: false,
  };

  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const conn = await page(configId, cursor);
    if (!conn) break;
    for (const n of conn.nodes) {
      const type = n.name?.type?.repr ?? "";
      const setting = n.value?.json as RawSetting | undefined;
      if (!setting) continue;
      const value = effectiveSetting(setting, epoch);

      if (type.endsWith(GLOBAL_PAUSE_KEY)) {
        out.globally_paused = value;
        continue;
      }
      if (!type.endsWith(ADDRESS_KEY)) continue;

      const address = (n.name?.json as { pos0?: string } | undefined)?.pos0;
      if (!address) continue;
      const pending = isPending(setting, epoch);
      // A lifted denial stays in the table as `false`. Reporting it would name
      // someone the issuer has already un-frozen.
      if (value !== true && !pending) continue;
      const entry: DeniedAddress = { address, active: value === true };
      const at = Number(setting.data?.newer_value_epoch ?? NaN);
      if (Number.isFinite(at)) entry.effective_after_epoch = at;
      out.denied.push(entry);
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (i === maxPages - 1 && conn.pageInfo.hasNextPage) out.truncated = true;
  }
  return out;
}
