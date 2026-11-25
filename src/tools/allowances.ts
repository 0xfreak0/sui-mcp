/**
 * Native allowances (`0x2::allowance`) an address has granted or been granted.
 *
 * As funder the answer is complete: every live allowance has an
 * `AllowanceCap` its funder holds and cannot transfer. As spender it rests on
 * a bounded scan of every `Allowance` object, since nothing indexes them by
 * spender.
 */

import { z } from "zod";
import { addressArg, numArg } from "./args.js";
import { errorResult, describeError } from "../utils/errors.js";
import { getNetwork } from "../config.js";
import { FUNDER_CAP_PAGES, SCAN_CAP, readFunderAllowances, readSpenderAllowances, spenderScanNote } from "../utils/allowance.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const NOTE =
  "An allowance lets its spender withdraw from the funder's address balance, up to its limits, in transactions the spender signs and the funder does not. A funder's loss in such a transaction is a delegated spend, not by itself a stolen key. `spendable_now` is the most the allowance's limits still permit; the funder's balance bounds it too. `status` and the rate-limit window are evaluated at `evaluated_at` against the allowance's current state. The funder ends an allowance by calling 0x2::allowance::revoke with the AllowanceCap in `cap_id` and the allowance. An app-bound allowance (`app` set) is spent through that app's package, and the app can rotate its spender.";

const MAX_CAP_PAGES = 200;
const MAX_SCAN = 100_000;

export function registerAllowanceTools(server: McpServer) {
  server.tool(
    "list_allowances",
    "List the native allowances (0x2::allowance) an address funds or can spend. An allowance lets a spender withdraw from the funder's address balance within a lifetime cap, rate limit and time window, signing alone; the funder never signs a spend. Use it when a wallet lost funds in a transaction it did not sign, before calling such a loss theft, and to see what a wallet can still lose. role 'funder' is complete, read from the funder's non-transferable AllowanceCaps, each row with the cap_id that revokes it; role 'spender' scans every allowance and states whether the scan finished. Rows give funder, spender, app (app-bound allowances, such as agent sessions), coin, limits, current spend, remaining amount, status and spendable_now.",
    {
      address: addressArg().describe("The address to look up (0x... or a SuiNS name)"),
      role: z
        .enum(["funder", "spender", "both"])
        .default("both")
        .describe("'funder': allowances this address granted; 'spender': allowances naming it as spender; 'both' (default)"),
      max_cap_pages: numArg()
        .int()
        .min(1)
        .max(MAX_CAP_PAGES)
        .optional()
        .describe(`AllowanceCap pages of 50 read for the funder side (default ${FUNDER_CAP_PAGES})`),
      max_scan: numArg()
        .int()
        .min(50)
        .max(MAX_SCAN)
        .optional()
        .describe(`Allowance objects read by the spender scan before it stops (default ${SCAN_CAP})`),
    },
    async ({ address, role, max_cap_pages, max_scan }) => {
      const capPages = max_cap_pages ?? FUNDER_CAP_PAGES;
      const scanBound = max_scan ?? SCAN_CAP;
      const network = getNetwork();
      const now = Date.now();
      const wantFunder = role !== "spender";
      const wantSpender = role !== "funder";
      const [f, s] = await Promise.allSettled([
        wantFunder ? readFunderAllowances(address, now, capPages) : Promise.resolve(null),
        wantSpender ? readSpenderAllowances(address, now, scanBound) : Promise.resolve(null),
      ]);
      const funder = f.status === "fulfilled" ? f.value : null;
      const funderError = f.status === "rejected" ? describeError(f.reason, network) : null;
      const spender = s.status === "fulfilled" ? s.value : null;
      const spenderError =
        s.status === "rejected" ? describeError(s.reason, network) : spender?.status === "failed" ? (spender.error ?? "the scan failed") : null;

      const funderFailed = wantFunder && !funder;
      const spenderFailed = wantSpender && spenderError !== null;
      if ((!wantSpender || spenderFailed) && (!wantFunder || funderFailed)) {
        return errorResult(`Could not read allowances for ${address}: ${funderError ?? spenderError}`);
      }

      const body: Record<string, unknown> = { address, role };
      if (wantFunder) {
        if (funder) {
          body.as_funder = {
            count: funder.allowances.length,
            complete: funder.complete,
            allowances: funder.allowances,
            ...(funder.caps_without_allowance.length
              ? {
                  caps_without_allowance: funder.caps_without_allowance,
                  caps_without_allowance_note:
                    "These AllowanceCaps name an allowance that could not be read as one now. revoke deletes a cap and its allowance together, so read the named id with get_object.",
                }
              : {}),
            ...(funder.complete
              ? {}
              : {
                  incomplete_note: `Stopped after ${funder.caps_read} AllowanceCaps with more remaining, so this is not every allowance the address funds.`,
                  ...(capPages < MAX_CAP_PAGES
                    ? { next_call: { tool: "list_allowances", args: { address, role: "funder", max_cap_pages: Math.min(MAX_CAP_PAGES, capPages * 4) } } }
                    : {}),
                }),
          };
        } else {
          body.as_funder = null;
          body.as_funder_unavailable = `The address's AllowanceCaps could not be read (${funderError}), so the allowances it granted are unknown.`;
        }
      }
      if (wantSpender) {
        if (spender && !spenderError) {
          body.as_spender = {
            count: spender.allowances.length,
            scan: { status: spender.status, scanned: spender.scanned, as_of: spender.as_of },
            allowances: spender.allowances,
            scan_note: spenderScanNote(spender),
            ...(spender.status === "truncated" && scanBound < MAX_SCAN
              ? { next_call: { tool: "list_allowances", args: { address, role: "spender", max_scan: Math.min(MAX_SCAN, scanBound * 4) } } }
              : {}),
          };
        } else {
          body.as_spender = null;
          body.as_spender_unavailable = `The allowance scan failed (${spenderError}), so allowances naming this address as spender are unknown.`;
        }
      }
      body.note = NOTE;
      return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
    },
  );
}
