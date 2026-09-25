/**
 * Coin deny lists: who an issuer has frozen.
 *
 * `analyze_package` reports that a package *has* denylist authority, and
 * `analyze_token` now reports whether a coin has any deny state. This tool is
 * the runtime detail — which addresses, and whether the freeze is in force.
 *
 * It earns its own surface because "who is frozen" is a question about people,
 * not about a token. It answers in both directions, and they cost differently:
 * by coin is a lookup plus a page, by address is two lookups per coin.
 */

import { z } from "zod";
import { numArg, addressArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { describeAddresses } from "../utils/identity.js";
import { restrictionNote } from "../utils/deny-list.js";
import {
  checkAddressAcrossCoins,
  currentEpoch,
  findCoinConfig,
  readCoinRestrictions,
} from "../utils/deny-list-probe.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerRestrictionTools(server: McpServer) {
  server.tool(
    "check_coin_restrictions",
    "(Incident investigation) Read a regulated coin's on-chain deny list: which addresses its issuer has frozen, and whether the whole coin is paused. Works in both directions — give a coin_type to list everyone frozen for it, or an address to check it against EVERY coin type with a deny list (~1,250 on mainnet, about 65 requests — a frozen address usually holds none of the coin that froze it, so checking only its balances misses most restrictions). A freeze is the issuer's own decision recorded on chain (chain-derived attribution), not a protocol rule, and whoever holds the DenyCap can reverse it. Use it when a traced address stops being able to move a token, or to check whether a counterparty is already known-bad to an issuer.",
    {
      coin_type: z
        .string()
        .optional()
        .describe("Full coin type (e.g. '0xabc::usdc::USDC'). Lists every address frozen for it."),
      address: addressArg()
        .optional()
        .describe(
          "Address to check. Without coin_type, checks the coins this address actually holds — being frozen for a coin it has never touched is not a finding.",
        ),
      max_addresses: numArg()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Cap on denied addresses returned for a coin (default 200)."),
    },
    async ({ coin_type, address, max_addresses }) => {
      if (!coin_type && !address) {
        return errorResult("Give a coin_type, an address, or both.");
      }

      let epoch: number;
      try {
        epoch = await currentEpoch();
      } catch (err) {
        // The epoch decides what is in force. Guessing it would turn a
        // scheduled denial into a reported freeze.
        return errorResult(
          `Could not read the current epoch (${err instanceof Error ? err.message : String(err)}), and without it a recorded denial cannot be told from an active one.`,
        );
      }

      // --- one address, across every configured coin -----------------------
      if (address && !coin_type) {
        // Exhaustive by default. Checking only the coins an address holds does
        // not work, and the reason is structural: freezing and holding are
        // ANTI-CORRELATED. An issuer freezes an address and it ends up holding
        // none of that coin. Measured on a real denied address, held-coins
        // found 11 restrictions where the full scan found 58 — missing 81%,
        // including the coin that led us to the address in the first place.
        const scan = await checkAddressAcrossCoins(address, epoch).catch(() => null);
        if (!scan) {
          return errorResult(
            `Could not read the deny list for ${address}. This is not evidence it is unrestricted.`,
          );
        }

        const identities = await describeAddresses([address]).catch(() => new Map());
        const id = identities.get(address);

        return json({
          address,
          epoch,
          ...(id?.name ? { name: id.name } : {}),
          ...(id?.label ? { label: id.label, category: id.label_category } : {}),
          coins_checked: scan.coins_checked,
          scan_complete: scan.complete,
          denied_by_count: scan.denied.length,
          denied_by: scan.denied,
          ...(scan.pending.length ? { pending: scan.pending } : {}),
          ...(scan.denied.length === 0 && scan.complete
            ? {
                result:
                  "No issuer has frozen this address, across every coin type with a deny list configured.",
              }
            : {}),
          ...(scan.complete
            ? {}
            : {
                incomplete_note:
                  "Part of the scan failed, so some coins were never checked. A short list here is not evidence of a short list on chain.",
              }),
          caveat:
            "A freeze is the issuer's own decision recorded on chain, reversible by whoever holds the DenyCap. Note that a frozen address usually holds NONE of the coin that froze it — being denied and holding are anti-correlated — so the absence of a balance says nothing either way.",
        });
      }

      // --- one coin, every address frozen for it ----------------------------
      const configId = await findCoinConfig(coin_type!);
      if (!configId) {
        return json({
          coin_type,
          regulated: false,
          result:
            "This coin has no deny list state at all, so no address is frozen for it and it cannot be paused. That usually means it is not a regulated coin.",
        });
      }

      const restrictions = await readCoinRestrictions(coin_type!, configId, epoch);
      const cap = max_addresses ?? 200;
      const shown = restrictions.denied.slice(0, cap);

      // Name the frozen addresses where we can. An issuer freezing a labelled
      // exchange deposit reads very differently from freezing a fresh wallet.
      const identities = await describeAddresses(shown.map((d) => d.address)).catch(
        () => new Map(),
      );

      const target = address ? restrictions.denied.find((d) => d.address === address) : undefined;

      return json({
        coin_type,
        regulated: true,
        epoch,
        config_id: configId,
        globally_paused: restrictions.globally_paused,
        denied_count: restrictions.denied.length,
        denied_truncated: restrictions.truncated || restrictions.denied.length > cap,
        denied: shown.map((d) => {
          const id = identities.get(d.address);
          return {
            ...d,
            ...(id?.name ? { name: id.name } : {}),
            ...(id?.label ? { label: id.label, category: id.label_category } : {}),
          };
        }),
        ...(address ? { queried_address_denied: Boolean(target?.active) } : {}),
        ...(address && restrictionNote(restrictions, address)
          ? { note: restrictionNote(restrictions, address) }
          : {}),
        caveat:
          "Chain-derived: this is what the DenyList object records. It is the issuer's own decision, not a protocol rule, and reversible by whoever holds the DenyCap. An entry with `active: false` is recorded but not yet in force.",
      });
    },
  );
}

function json(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}
