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
import { numArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { describeAddresses } from "../utils/identity.js";
import { restrictionNote } from "../utils/deny-list.js";
import {
  checkAddress,
  currentEpoch,
  findCoinConfig,
  readCoinRestrictions,
} from "../utils/deny-list-probe.js";
import { sui } from "../clients/grpc.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Coins checked for one address when the caller names none. */
const MAX_HELD_COINS = 25;

export function registerRestrictionTools(server: McpServer) {
  server.tool(
    "check_coin_restrictions",
    "(Incident investigation) Read a regulated coin's on-chain deny list: which addresses its issuer has frozen, and whether the whole coin is paused. Works in both directions — give a coin_type to list everyone frozen for it, or an address to check whether it is frozen for the coins it holds. A freeze is the issuer's own decision recorded on chain (chain-derived attribution), not a protocol rule, and whoever holds the DenyCap can reverse it. Use it when a traced address stops being able to move a token, or to check whether a counterparty is already known-bad to an issuer.",
    {
      coin_type: z
        .string()
        .optional()
        .describe("Full coin type (e.g. '0xabc::usdc::USDC'). Lists every address frozen for it."),
      address: z
        .string()
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

      // --- one address, across the coins it holds ---------------------------
      if (address && !coin_type) {
        let coins: string[] = [];
        try {
          const balances = await sui.listBalances({ owner: address, limit: 50, cursor: null });
          coins = (balances.balances ?? [])
            .filter((b) => b.balance !== "0")
            .map((b) => b.coinType ?? "")
            .filter(Boolean)
            .slice(0, MAX_HELD_COINS);
        } catch (err) {
          return errorResult(
            `Could not list ${address}'s balances (${err instanceof Error ? err.message : String(err)}), so there is no coin set to check against.`,
          );
        }

        const results = await Promise.all(
          coins.map((c) => checkAddress(c, address, epoch).catch(() => null)),
        );
        const regulated = results.filter((r): r is NonNullable<typeof r> => r !== null);
        const restricted = regulated.filter((r) => r.denied || r.pending);

        return json({
          address,
          epoch,
          coins_held_checked: coins.length,
          regulated_coins_held: regulated.length,
          restricted,
          restricted_count: restricted.length,
          ...(restricted.length === 0
            ? {
                result:
                  "Not frozen for any coin it currently holds. This checks held coins only — a freeze on a coin the address has never held would not appear, and neither would one on a coin below the check cap.",
              }
            : {}),
          caveat:
            "A freeze is an issuer decision recorded on chain, reversible by whoever holds the DenyCap. `pending: true` means the entry is recorded but NOT yet in force — a denial takes effect the epoch after it is written.",
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
