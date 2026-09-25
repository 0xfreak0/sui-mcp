import { canonicalSuiAddress } from "../chain-id.js";

/**
 * Does an event type carry the marker?
 *
 * Type arguments are stripped first: a generic event such as
 * `events::InterchainTransfer<0x…::ink::INK>` ends in its type argument, so a
 * suffix test on the raw string never matches it.
 *
 * - `module::Name` matches on the whole `::module::Name` tail, so
 *   `xpublish_message::WormholeMessage` does not pass for
 *   `publish_message::WormholeMessage`.
 * - `0xpkg::module::Name` also pins the package. An event is typed at the
 *   package that defined it, which an upgrade does not change, so pinning is
 *   safe for events where it would not be for calls. Generic names such as
 *   `events::TokensSentEvent` are only safe pinned.
 */
export function matchesEvent(marker: string, eventType: string): boolean {
  const bare = eventType.split("<")[0];
  if (!marker.startsWith("0x")) return bare.endsWith(`::${marker}`);
  const m = marker.indexOf("::");
  const t = bare.indexOf("::");
  if (t < 0 || marker.slice(m) !== bare.slice(t)) return false;
  return canonicalSuiAddress(marker.slice(0, m)) === canonicalSuiAddress(bare.slice(0, t));
}
