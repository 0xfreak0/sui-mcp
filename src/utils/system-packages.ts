/**
 * Which system packages are plumbing.
 *
 * The Sui protocol publishes five packages at reserved addresses and upgrades
 * them in place: the Move standard library (0x1), the Sui framework (0x2), Sui
 * system (0x3), the Sui Bridge (0xb) and DeepBook v1 (0xdee9).
 * {@link SYSTEM_PACKAGE} matches all five; a call into any of
 * them is system code, never an unverified package.
 *
 * Plumbing is a narrower question: which calls to leave out when naming the
 * protocols a transaction moved value through, keeping its events, ordering
 * its calls or counting its legs. Only the first three: nearly every
 * transaction calls them. The bridge's treasury and DeepBook v1's pools hold
 * users' value in shared objects of their own, so a call into either is a leg
 * of the transaction like any protocol's.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";

/** Framework packages live at small reserved addresses (0x1, 0x2, 0x3, 0xb, 0xdee9). */
export const SYSTEM_PACKAGE = /^0x0{60}[0-9a-f]{4}$/;

const PLUMBING_PACKAGES: ReadonlySet<string> = new Set(["0x1", "0x2", "0x3"].map((p) => normalizeSuiAddress(p)));

/** The stdlib, the framework or Sui system, in any spelling of its address. */
export function isPlumbingPackage(pkg: string): boolean {
  return PLUMBING_PACKAGES.has(normalizeSuiAddress(pkg));
}
