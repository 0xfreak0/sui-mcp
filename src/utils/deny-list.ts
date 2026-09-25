/**
 * Coin deny lists: which addresses an issuer has frozen, and which coins are
 * globally paused.
 *
 * A regulated coin on Sui carries a `DenyCap`, and its holder can block
 * specific addresses from transacting the asset or pause the coin entirely.
 * That state lives in the shared `DenyList` object at `0x403`:
 *
 * ```
 * 0x403  DenyList
 *   └─ ConfigKey{ per_type_index, per_type_key }   -> Config        (one per coin type)
 *        ├─ AddressKey(addr)                       -> Setting<bool> (this address denied)
 *        └─ GlobalPauseKey()                       -> Setting<bool> (whole coin paused)
 * ```
 *
 * `analyze_package` already reports that a package *has* denylist authority.
 * This is the runtime state: who was actually frozen. That is attribution —
 * an issuer's off-chain decision, recorded on chain — and it is a different
 * claim from anything the code surface can tell you.
 *
 * Everything here is pure. The caller does the walking.
 */

/**
 * A `config::Setting<bool>` as it comes back over GraphQL.
 *
 * Settings are epoch-scheduled rather than immediate, which is the whole
 * reason this needs interpreting at all.
 */
export interface RawSetting {
  data?: {
    newer_value_epoch?: string | number | null;
    newer_value?: boolean | null;
    older_value_opt?: boolean | null;
  } | null;
}

/**
 * The value a setting actually has right now.
 *
 * From `config.move`:
 *
 * ```
 * if (current_epoch > data.newer_value_epoch) newer_value else older_value_opt
 * ```
 *
 * Note the comparison is **strictly greater than**. A denial written during
 * epoch N does not take effect until epoch N+1, so for one full epoch the
 * stored `newer_value: true` is not yet in force. Reading `newer_value`
 * directly — the obvious thing to do — reports that address as frozen when it
 * can still transact.
 *
 * Returns null when the setting has no effective value, which is what a
 * scheduled-but-not-yet-active entry with no prior value looks like.
 */
export function effectiveSetting(setting: RawSetting, currentEpoch: number): boolean | null {
  const d = setting?.data;
  if (!d) return null;
  const epoch = Number(d.newer_value_epoch ?? NaN);
  if (!Number.isFinite(epoch)) return d.newer_value ?? null;
  if (currentEpoch > epoch) return d.newer_value ?? null;
  return d.older_value_opt ?? null;
}

/** True when a setting is scheduled to change but has not taken effect yet. */
export function isPending(setting: RawSetting, currentEpoch: number): boolean {
  const d = setting?.data;
  if (!d) return false;
  const epoch = Number(d.newer_value_epoch ?? NaN);
  if (!Number.isFinite(epoch)) return false;
  return currentEpoch <= epoch && (d.newer_value ?? null) !== (d.older_value_opt ?? null);
}

/**
 * Decode the coin type a `ConfigKey` names.
 *
 * `per_type_key` is the type's canonical string as raw bytes, base64 over
 * GraphQL, and **without** the leading `0x` — e.g.
 * `abc…::usdc::USDC`. The prefix is restored so the result compares equal to
 * every other coin type this server handles.
 */
export function coinTypeFromKey(perTypeKey: string): string | null {
  try {
    const decoded = Buffer.from(perTypeKey, "base64").toString("utf8");
    if (!decoded.includes("::")) return null;
    return decoded.startsWith("0x") ? decoded : `0x${decoded}`;
  } catch {
    return null;
  }
}

/** One address an issuer has frozen for a coin. */
export interface DeniedAddress {
  address: string;
  /** In force now. False means recorded but not yet effective. */
  active: boolean;
  /** Epoch the current value took, or takes, effect after. */
  effective_after_epoch?: number;
}

export interface CoinRestrictions {
  coin_type: string;
  /** The `Config` object holding this coin's deny state. */
  config_id: string;
  /** Whole-coin pause. False when the coin never set one; null when the deny list was not read to the end. */
  globally_paused: boolean | null;
  denied: DeniedAddress[];
  /** True when the address page was cut short. */
  truncated: boolean;
}

/** Key type suffixes as they appear in a dynamic field's type. */
export const ADDRESS_KEY = "deny_list::AddressKey";
export const GLOBAL_PAUSE_KEY = "deny_list::GlobalPauseKey";

/**
 * A reading for someone who asked whether an address is frozen.
 *
 * The distinction that matters: a global pause says nothing about the address.
 * Reporting "restricted" for both would attach an issuer's blanket decision to
 * a specific party as though it were about them.
 */
export function restrictionNote(r: CoinRestrictions, address?: string): string | undefined {
  const hit = address ? r.denied.find((d) => d.address === address) : undefined;
  if (hit) {
    return hit.active
      ? `The issuer of ${r.coin_type} has frozen this address: it cannot send or receive that coin. This is the issuer's own decision recorded on chain, not a protocol rule, and it can be reversed by whoever holds the DenyCap. It is attribution — somebody with authority over this asset concluded something about this address.`
      : `This address is recorded on ${r.coin_type}'s deny list but the entry is NOT yet in force — a denial takes effect the epoch after it is written. It can still transact the coin right now.`;
  }
  if (r.globally_paused) {
    return `${r.coin_type} is globally paused by its issuer, so no address can transact it. This says nothing about any particular holder.`;
  }
  return undefined;
}
