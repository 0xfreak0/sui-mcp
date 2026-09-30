import { z } from "zod";
import { addressArg } from "./args.js";
import "../utils/valuers/index.js";
import { registeredValuers, valuePositions, type ValuedPosition } from "../utils/position-value.js";
import { capPayload, type ListCap } from "../utils/output-cap.js";
import { heldWalk } from "../utils/valuers/held-balances.js";
import { ownedCoverage } from "../utils/owned-coverage.js";
import { operatedLeadRow, operatedSharedObjects } from "../utils/operated-objects.js";
import { dollars, type HealthRatios } from "../utils/valuers/lending.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** NFTs are valued as estimates by get_wallet_overview, not listed as DeFi positions. */
const NON_DEFI_VALUERS = ["nft"];

export interface PositionRow {
  protocol: string | null;
  kind: ValuedPosition["kind"];
  object_id: string | null;
  usd: number | null;
  tier: ValuedPosition["tier"];
  method: string;
  assets: ValuedPosition["assets"];
  unpriced_reason?: string;
  health?: ValuedPosition["health"];
  health_basis?: string;
  detail?: Record<string, unknown>;
}

/** Positions as rows, most valuable first and unpriced last. */
export function positionRows(positions: ValuedPosition[]): PositionRow[] {
  return positions
    .map((p) => ({
      protocol: p.protocol,
      kind: p.kind,
      object_id: p.object_id,
      usd: p.usd_net === null ? null : Math.round(p.usd_net * 100) / 100,
      tier: p.tier,
      method: p.method,
      // Legs to the cent, as the row's own `usd` is.
      assets: p.assets.map((a) => (a.usd === null ? a : { ...a, usd: Math.round(a.usd * 100) / 100 })),
      ...(p.unpriced_reason ? { unpriced_reason: p.unpriced_reason } : {}),
      ...(p.health ? { health: p.health } : {}),
      ...(p.health_basis ? { health_basis: p.health_basis } : {}),
      ...(p.detail ? { detail: p.detail } : {}),
    }))
    .sort((a, b) => (b.usd ?? -Infinity) - (a.usd ?? -Infinity));
}

export interface PositionTotals {
  total_usd: number;
  priced_positions: number;
  unpriced_positions: number;
  by_protocol: Record<string, { count: number; usd: number; unpriced: number }>;
}

/**
 * Totals over every position: the priced sum, and per protocol (or kind,
 * for a generic reader) the count and priced sum. An unpriced position is
 * counted, never summed as zero.
 */
export function positionTotals(positions: ValuedPosition[]): PositionTotals {
  const by: Record<string, { count: number; usd: number; unpriced: number }> = {};
  let total = 0;
  let unpriced = 0;
  for (const p of positions) {
    const key = p.protocol ?? p.kind;
    const row = (by[key] ??= { count: 0, usd: 0, unpriced: 0 });
    row.count++;
    if (p.usd_net === null) {
      row.unpriced++;
      unpriced++;
    } else {
      row.usd += p.usd_net;
      total += p.usd_net;
    }
  }
  for (const row of Object.values(by)) row.usd = Math.round(row.usd * 100) / 100;
  return {
    total_usd: Math.round(total * 100) / 100,
    priced_positions: positions.length - unpriced,
    unpriced_positions: unpriced,
    by_protocol: by,
  };
}

/** Within this share of its borrow limit, a small price move or accrued interest takes a position to the limit. */
const NEAR_BORROW_LIMIT = 0.95;

/**
 * One lead per position at or past {@link NEAR_BORROW_LIMIT} of its borrow
 * limit, closest to its limit first, naming the figures each ratio is made
 * of (`detail.health_ratios`).
 */
export function healthLeads(positions: ValuedPosition[]): Array<{ object_id: string | null; protocol: string | null; borrow_limit_used: number; lead: string }> {
  const leads: Array<{ object_id: string | null; protocol: string | null; borrow_limit_used: number; lead: string }> = [];
  for (const p of positions) {
    const used = p.health?.borrow_limit_used;
    if (typeof used !== "number" || used < NEAR_BORROW_LIMIT) continue;
    const health = p.health!;
    const ratios = (p.detail?.health_ratios ?? {}) as HealthRatios;
    const figures = (name: keyof HealthRatios) => {
      const pair = ratios[name];
      if (!pair) return "";
      const shown = pair.map((key) => {
        const v = health[key];
        return `${key} ${typeof v === "number" ? (key.endsWith("_usd") ? dollars(v) : String(v)) : "unknown"}`;
      });
      return ` (${shown.join(" over ")})`;
    };
    const liq = health.liquidation_threshold_used;
    const who = `${p.protocol ?? p.kind} position ${p.object_id ?? "without an object id"}`;
    const limitText =
      used >= 1
        ? `${who} is past its borrow limit at ${(used * 100).toFixed(2)}%${figures("borrow_limit_used")}`
        : `${who} has used ${(used * 100).toFixed(2)}% of its borrow limit${figures("borrow_limit_used")}`;
    const liqText = typeof liq === "number" ? ` and ${(liq * 100).toFixed(2)}% of its liquidation threshold${figures("liquidation_threshold_used")}` : "";
    const outcome =
      used >= 1
        ? "it can borrow or withdraw no more, and a small price move or accrued interest moves it further toward liquidation"
        : "a small price move or accrued interest reaches the limit";
    const basis = p.health_basis ? " Its stored figures and its legs' market value disagree; see `health_basis`." : "";
    leads.push({ object_id: p.object_id, protocol: p.protocol, borrow_limit_used: used, lead: `${limitText}${liqText}, by the figures in \`health\`; ${outcome}.${basis}` });
  }
  return leads.sort((a, b) => b.borrow_limit_used - a.borrow_limit_used);
}

export function registerDefiTools(server: McpServer) {
  server.tool(
    "get_defi_positions",
    "Find and value a wallet's staked SUI with rewards, issuer-rate liquid-staking coins, CLMM/AMM liquidity, lending and balances inside owned objects. Positions include asset legs, valuation method and evidence tier; USD is null if any leg lacks a price, with unpriced_reason. Totals sum only priced positions. coverage lists unrecognised owned-object types and counts; unread lists failed reads. Lending includes protocol health ratios. leads flags near-borrow-limit positions and operated shared vaults with their holdings.",
    {
      address: addressArg().describe("Wallet address (0x...)"),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default): highest-value positions fitting about 30k characters, plus all unpriced ones; omitted counts the rest. 'full': every position."),
    },
    async ({ address, detail }) => {
      const only = registeredValuers().filter((name) => !NON_DEFI_VALUERS.includes(name));
      // One memo, so the readers and the coverage count share one walk of the owned objects.
      const ctx = { owner: address, memo: new Map<string, Promise<unknown>>() };
      const [valued, operated] = await Promise.all([
        valuePositions(ctx, only),
        operatedSharedObjects(address, ctx).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
      ]);
      const rows = positionRows(valued.positions);
      const unread = [...valued.unread];
      if (operated instanceof Error) unread.push({ what: "operated shared objects", reason: operated.message });
      const walk = heldWalk(ctx);
      const coverage = walk ? ownedCoverage(await walk, valued.positions, valued.unread, false) : null;
      const leads = [
        ...healthLeads(valued.positions).map((l) => ({ kind: "near_borrow_limit", ...l })),
        ...(operated instanceof Error ? [] : operated.leads.map(operatedLeadRow)),
      ];
      const output: Record<string, unknown> = {
        address,
        total_positions: rows.length,
        ...positionTotals(valued.positions),
        ...(coverage ? { coverage } : {}),
        ...(leads.length > 0 ? { leads } : {}),
        positions: rows,
        ...(unread.length > 0 ? { unread } : {}),
        readers: valued.valuers_run,
      };
      const { payload } = capPayload(
        "get_defi_positions",
        { address },
        output,
        {
          positions: {
            budget: 30_000,
            keep: (r: PositionRow) => r.usd === null,
            usd: (r: PositionRow) => r.usd,
            brief: (r: PositionRow) => ({ protocol: r.protocol, kind: r.kind, object_id: r.object_id, usd: r.usd }),
          } satisfies ListCap<PositionRow>,
          leads: {
            budget: 8_000,
            brief: (l: { kind: string; object_id: string | null }) => ({ kind: l.kind, object_id: l.object_id }),
          } satisfies ListCap<{ kind: string; object_id: string | null }>,
          "coverage.not_recognised_types": {
            budget: 6_000,
            brief: (g: { type: string; count: number }) => ({ type: g.type, count: g.count }),
          } satisfies ListCap<{ type: string; count: number }>,
        },
        { full: detail === "full", next_call: { tool: "get_defi_positions", repeat_with: { detail: "full" } } },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    },
  );
}
