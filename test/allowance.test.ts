import { describe, it, expect, vi, beforeEach } from "vitest";
import { Transaction, Inputs } from "@mysten/sui/transactions";
import { createMockClient } from "./helpers/mock-grpc.js";

const mockGqlQuery = vi.fn();
const mockSui = createMockClient();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));

const { parseAllowance, allowanceCoinType, readFunderAllowances, readSpenderAllowances, resetAllowanceScanCache } =
  await import("../src/utils/allowance.js");
const { readFundsWithdrawals } = await import("../src/utils/address-balance.js");
const { allowanceSpends } = await import("../src/utils/allowance-spend.js");
const { resolvePtb, ptbDataFromBcs } = await import("../src/utils/ptb-resolve.js");
const { registerAllowanceTools } = await import("../src/tools/allowances.js");

const FUNDER = `0x${"f1".repeat(32)}`;
const SPENDER = `0x${"5e".repeat(32)}`;
const OTHER = `0x${"0e".repeat(32)}`;
const ALLOWANCE = `0x${"a1".repeat(32)}`;
const CAP = `0x${"c1".repeat(32)}`;
const ADDR2 = `0x${"0".repeat(63)}2`;
const SUI_ALLOWANCE = `${ADDR2}::allowance::Allowance<${ADDR2}::balance::Balance<${ADDR2}::sui::SUI>>`;

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1); // 2026-11-01

/** An allowance's JSON as GraphQL renders it: options as value-or-null, enums with `@variant`. */
function json(over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  return {
    id: ALLOWANCE,
    current_spend: "0",
    ...over,
    settings: {
      funder: FUNDER,
      spender: SPENDER,
      app: null,
      lifetime_cap: "1000",
      start_timestamp_ms: null,
      expiration_timestamp_ms: String(T0 + 30 * DAY),
      rate_limit: null,
      name: "bot",
      ...settings,
    },
  };
}

describe("parseAllowance", () => {
  it("reads funder, spender, coin and what a lifetime cap still permits", () => {
    const a = parseAllowance(ALLOWANCE, SUI_ALLOWANCE, json({ current_spend: "400" }), T0);
    expect(a).toMatchObject({
      allowance_id: ALLOWANCE,
      coin_type: `${ADDR2}::sui::SUI`,
      funder: FUNDER,
      spender: SPENDER,
      app: null,
      lifetime_cap: "1000",
      current_spend: "400",
      remaining_lifetime: "600",
      status: "active",
      spendable_now: "600",
    });
  });

  it("is expired at its exclusive expiration and not started before its inclusive start", () => {
    expect(parseAllowance(ALLOWANCE, SUI_ALLOWANCE, json(), T0 + 30 * DAY).status).toBe("expired");
    expect(parseAllowance(ALLOWANCE, SUI_ALLOWANCE, json(), T0 + 30 * DAY - 1).status).toBe("active");
    const later = json({}, { start_timestamp_ms: String(T0 + DAY) });
    expect(parseAllowance(ALLOWANCE, SUI_ALLOWANCE, later, T0)).toMatchObject({ status: "not_started", spendable_now: "0" });
    expect(parseAllowance(ALLOWANCE, SUI_ALLOWANCE, later, T0 + DAY).status).toBe("active");
  });

  it("is exhausted once the lifetime cap is spent", () => {
    expect(parseAllowance(ALLOWANCE, SUI_ALLOWANCE, json({ current_spend: "1000" }), T0)).toMatchObject({
      status: "exhausted",
      remaining_lifetime: "0",
      spendable_now: "0",
    });
  });

  it("resets a periodic window's spend once it has rolled over, as charge does", () => {
    const rate = {
      "@variant": "Windowed",
      limit: "100",
      spent: "80",
      anchor_ms: String(T0),
      index: "0",
      window: { "@variant": "PeriodicMs", pos0: String(DAY) },
    };
    const a = json({}, { lifetime_cap: null, rate_limit: rate });
    const inWindow = parseAllowance(ALLOWANCE, SUI_ALLOWANCE, a, T0 + DAY - 1);
    expect(inWindow.rate_limit).toMatchObject({
      window: { kind: "periodic", period_ms: String(DAY) },
      spent_in_current_window: "80",
      remaining_in_current_window: "20",
      current_window_ends: new Date(T0 + DAY).toISOString(),
    });
    expect(inWindow.spendable_now).toBe("20");
    const next = parseAllowance(ALLOWANCE, SUI_ALLOWANCE, a, T0 + DAY);
    expect(next.rate_limit).toMatchObject({ spent_in_current_window: "0", remaining_in_current_window: "100" });
    expect(next.spendable_now).toBe("100");
  });

  it("takes the tighter of the lifetime cap and the rate limit", () => {
    const rate = { "@variant": "Windowed", limit: "500", spent: "0", anchor_ms: null, index: "0", window: { "@variant": "PeriodicMs", pos0: String(DAY) } };
    const a = parseAllowance(ALLOWANCE, SUI_ALLOWANCE, json({ current_spend: "900" }, { rate_limit: rate }), T0);
    expect(a.spendable_now).toBe("100");
    expect(a.rate_limit?.current_window_ends).toBeNull();
  });

  it("counts calendar windows from the anchor's day, clamped to short months", () => {
    // Anchored Jan 31: the first window ends Feb 28, the next Mar 31.
    const anchor = Date.UTC(2027, 0, 31, 15);
    const rate = { "@variant": "Windowed", limit: "10", spent: "10", anchor_ms: String(anchor), index: "0", window: { "@variant": "CalendarMonths", pos0: 1 } };
    const a = json({}, { lifetime_cap: null, expiration_timestamp_ms: null, rate_limit: rate });
    const feb27 = parseAllowance(ALLOWANCE, SUI_ALLOWANCE, a, Date.UTC(2027, 1, 27, 23));
    expect(feb27.rate_limit).toMatchObject({ remaining_in_current_window: "0", current_window_ends: "2027-02-28T00:00:00.000Z" });
    expect(feb27.spendable_now).toBe("0");
    const feb28 = parseAllowance(ALLOWANCE, SUI_ALLOWANCE, a, Date.UTC(2027, 1, 28));
    expect(feb28.rate_limit).toMatchObject({ remaining_in_current_window: "10", current_window_ends: "2027-03-31T00:00:00.000Z" });
  });

  it("names an app-bound allowance's app with a 0x address, and accepts a vec-shaped option", () => {
    const app = { name: `${"ab".repeat(32)}::agent::Pass` };
    const a = parseAllowance(ALLOWANCE, SUI_ALLOWANCE, json({}, { app: { vec: [app] }, lifetime_cap: { vec: ["5"] } }), T0);
    expect(a.app).toBe(`0x${"ab".repeat(32)}::agent::Pass`);
    expect(a.lifetime_cap).toBe("5");
  });

  it("leaves spendable_now unknown when a set rate limit cannot be read", () => {
    const a = parseAllowance(ALLOWANCE, SUI_ALLOWANCE, json({}, { rate_limit: { "@variant": "Windowed", limit: "x" } }), T0);
    expect(a.rate_limit).toBeNull();
    expect(a.spendable_now).toBeNull();
  });

  it("reads the coin from Allowance and AllowanceCap types in short or padded form", () => {
    expect(allowanceCoinType("0x2::allowance::Allowance<0x2::balance::Balance<0xabc::usdc::USDC>>")).toBe("0xabc::usdc::USDC");
    expect(allowanceCoinType(`${ADDR2}::allowance::AllowanceCap<${ADDR2}::balance::Balance<0xabc::usdc::USDC>>`)).toBe("0xabc::usdc::USDC");
    expect(allowanceCoinType("0x2::allowance::Allowance<0xabc::m::T>")).toBeNull();
    expect(allowanceCoinType("0xabc::allowance::Allowance<0x2::balance::Balance<0x2::sui::SUI>>")).toBeNull();
  });
});

describe("allowance withdrawals in a transaction", () => {
  it("reads funder and allowance from a gRPC SENDER_ALLOWANCE input", () => {
    expect(
      readFundsWithdrawals([
        { fundsWithdrawal: { amount: 5n, coinType: "0x2::sui::SUI", source: 3, funder: FUNDER, allowance: ALLOWANCE } },
        { fundsWithdrawal: { amount: 1n, coinType: "0x2::sui::SUI", source: 1 } },
      ]),
    ).toEqual([
      { amount: "5", coin_type: "0x2::sui::SUI", source: "sender_allowance", funder: FUNDER, allowance: ALLOWANCE },
      { amount: "1", coin_type: "0x2::sui::SUI", source: "sender" },
    ]);
  });

  it("decodes a SenderAllowance withdrawal from the transaction's BCS", async () => {
    const tx = new Transaction();
    tx.setSender(SPENDER);
    tx.setGasPayment([]);
    tx.setGasPrice(1000);
    tx.setGasBudget(10_000_000);
    tx.setExpiration({ None: true });
    tx.transferObjects(
      [
        tx.moveCall({
          target: "0x2::coin::redeem_funds",
          typeArguments: ["0x2::sui::SUI"],
          arguments: [
            tx.object(
              Inputs.FundsWithdrawal({
                reservation: { $kind: "MaxAmountU64", MaxAmountU64: "250" },
                typeArg: { $kind: "Balance", Balance: "0x2::sui::SUI" },
                withdrawFrom: { $kind: "SenderAllowance", SenderAllowance: { funder: FUNDER, allowance: ALLOWANCE } },
              }),
            ),
          ],
        }),
      ],
      OTHER,
    );
    const bytes = await tx.build();
    mockSui.getMoveFunction.mockRejectedValue(new Error("not read"));
    const read = ptbDataFromBcs(bytes);
    expect(read.data).toBeTruthy();
    const { inputs } = await resolvePtb(read.data!);
    expect(inputs.find((i) => i.type === "FundsWithdrawal")).toMatchObject({
      amount: "250",
      withdraw_from: "SenderAllowance",
      funder: FUNDER,
      allowance: ALLOWANCE,
    });
  });
});

describe("allowanceSpends", () => {
  beforeEach(() => mockGqlQuery.mockReset());

  it("reports nothing when no withdrawal draws on an allowance", async () => {
    expect(await allowanceSpends([{ amount: "1", coin_type: null, source: "sender" }], SPENDER)).toEqual({});
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("names the funder and spender and attaches the allowance's current state", async () => {
    mockGqlQuery.mockResolvedValueOnce({
      multiGetObjects: [{ address: ALLOWANCE, asMoveObject: { contents: { type: { repr: SUI_ALLOWANCE }, json: json() } } }],
    });
    const out = await allowanceSpends(
      [{ amount: "250", coin_type: "0x2::sui::SUI", source: "sender_allowance", funder: FUNDER, allowance: ALLOWANCE }],
      SPENDER,
    );
    const rows = out.allowance_spends as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ allowance_id: ALLOWANCE, funder: FUNDER, spender: SPENDER, max_amount: "250" });
    expect(rows[0].allowance_now).toMatchObject({ spender: SPENDER, status: "active" });
    expect(String(out.allowance_spends_note)).toMatch(/did not sign/);
  });

  it("keeps the rows when the allowance read fails, and says the state is unknown", async () => {
    mockGqlQuery.mockRejectedValueOnce(new Error("boom"));
    const out = await allowanceSpends(
      [{ amount: "1", coin_type: null, source: "sender_allowance", funder: FUNDER, allowance: ALLOWANCE }],
      SPENDER,
    );
    expect((out.allowance_spends as Array<Record<string, unknown>>)[0].allowance_now).toBeNull();
    expect(out.allowance_state_unavailable).toMatch(/could not be read/);
  });
});

describe("reading allowances by funder and by spender", () => {
  beforeEach(() => {
    mockGqlQuery.mockReset();
    resetAllowanceScanCache();
  });

  it("reads a funder's allowances from its caps, each with the cap that revokes it", async () => {
    mockGqlQuery
      .mockResolvedValueOnce({
        address: {
          objects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { address: CAP, contents: { json: { id: CAP, allowance: ALLOWANCE } } },
              { address: OTHER, contents: { json: { id: OTHER, allowance: SPENDER } } },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        multiGetObjects: [{ address: ALLOWANCE, asMoveObject: { contents: { type: { repr: SUI_ALLOWANCE }, json: json() } } }, null],
      });
    const r = await readFunderAllowances(FUNDER, T0);
    expect(r.complete).toBe(true);
    expect(r.allowances).toHaveLength(1);
    expect(r.allowances[0]).toMatchObject({ allowance_id: ALLOWANCE, cap_id: CAP, spender: SPENDER });
    expect(r.caps_without_allowance).toEqual([{ cap_id: OTHER, allowance_id: SPENDER }]);
  });

  it("stops a cap walk that claims more pages without a cursor, and calls it incomplete", async () => {
    mockGqlQuery
      .mockResolvedValueOnce({ address: { objects: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } })
      .mockResolvedValueOnce({ multiGetObjects: [] });
    expect((await readFunderAllowances(FUNDER, T0)).complete).toBe(false);
  });

  it("finds a spender's allowances by scanning, and calls a cursorless scan truncated", async () => {
    mockGqlQuery.mockResolvedValueOnce({
      objects: {
        pageInfo: { hasNextPage: true, endCursor: null },
        nodes: [
          { address: ALLOWANCE, asMoveObject: { contents: { type: { repr: SUI_ALLOWANCE }, json: json() } } },
          { address: OTHER, asMoveObject: { contents: { type: { repr: SUI_ALLOWANCE }, json: json({}, { spender: OTHER }) } } },
        ],
      },
    });
    const r = await readSpenderAllowances(SPENDER.toUpperCase().replace("0X", "0x"), T0);
    expect(r.status).toBe("truncated");
    expect(r.scanned).toBe(2);
    expect(r.allowances.map((a) => a.allowance_id)).toEqual([ALLOWANCE]);
  });

  it("does not cache a failed scan", async () => {
    mockGqlQuery.mockRejectedValueOnce(new Error("429"));
    expect((await readSpenderAllowances(SPENDER, T0)).status).toBe("failed");
    mockGqlQuery.mockResolvedValueOnce({ objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } });
    expect((await readSpenderAllowances(SPENDER, T0)).status).toBe("complete");
  });
});

describe("list_allowances", () => {
  const tools = new Map<string, Function>();
  registerAllowanceTools({
    tool: (name: string, _d: string, _s: unknown, handler: Function) => tools.set(name, handler),
  } as unknown as Parameters<typeof registerAllowanceTools>[0]);

  beforeEach(() => {
    mockGqlQuery.mockReset();
    resetAllowanceScanCache();
  });

  it("keeps the funder side when the spender scan fails, and says the spender side is unknown", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("AllowanceCap")) {
        return { address: { objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      }
      if (query.includes("multiGetObjects")) return { multiGetObjects: [] };
      throw new Error("scan down");
    });
    const r = await tools.get("list_allowances")!({ address: FUNDER, role: "both" });
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.as_funder).toMatchObject({ count: 0, complete: true });
    expect(body.as_spender).toBeNull();
    expect(body.as_spender_unavailable).toMatch(/scan failed/);
  });

  it("is an error when the only side asked for cannot be read", async () => {
    mockGqlQuery.mockRejectedValue(new Error("down"));
    const r = await tools.get("list_allowances")!({ address: FUNDER, role: "funder" });
    expect(r.isError).toBe(true);
  });
});
