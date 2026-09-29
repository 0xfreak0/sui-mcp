/**
 * Where `npm run sync:framework` reads the Sui framework sources from. It
 * vendors every non-test source into `test/fixtures/sui-framework/sources`,
 * so the completeness checks see every module; these are the files a claim
 * cites, which must exist at any ref synced.
 */

export const REPO = "MystenLabs/sui";
export const SOURCES_DIR = "crates/sui-framework/packages/sui-framework/sources";

/** Files a claim in `src/` cites, as paths under `SOURCES_DIR`. */
export const CITED_FILES = [
  "address_alias.move",
  "balance.move",
  "coin.move",
  "config.move",
  "deny_list.move",
  "display.move",
  "kiosk/transfer_policy.move",
  "object.move",
  "package.move",
  "party.move",
  "pay.move",
  "registries/coin_registry.move",
  "registries/display_registry.move",
  "sui.move",
  "token.move",
  "transfer.move",
];
