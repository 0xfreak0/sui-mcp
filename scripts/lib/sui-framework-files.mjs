/**
 * Which Sui framework sources `npm run sync:framework` vendors into
 * `test/fixtures/sui-framework/sources`, shared with the test that reads them.
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
  "package.move",
  "party.move",
  "pay.move",
  "registries/coin_registry.move",
  "registries/display_registry.move",
  "sui.move",
  "token.move",
  "transfer.move",
];

/**
 * The capability structs whose every callable use the rules must account
 * for. Any other framework source naming one of them is vendored too, so a
 * function added in a module no claim cites still reaches the completeness
 * check.
 */
export const CAPABILITY_STRUCTS = ["TreasuryCap", "UpgradeCap", "DenyCap", "DenyCapV2", "Publisher"];
