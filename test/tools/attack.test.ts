import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AttackBalanceChange, AttackTx } from "../../src/utils/attack-analysis.js";
import { canonicalId } from "../../src/utils/attack-analysis.js";
import { resetWindowPriceCache } from "../../src/utils/window-prices.js";

/**
 * Tool-level coverage for the gas-only / largest-gainer default in
 * analyze_attack_tx and summarize_incident_losses: the sender-mode `attacker`
 * field, offsetting flows, unpriced beneficiaries and coin rows.
 */

interface PricePointLike {
  price: number;
  publishTime: number;
  source: "defillama";
  decimals?: number;
}

const { mockReadAttackTransactions, mockDigestsSentBy, mockPriceUsdAtTime, priceMapRef } = vi.hoisted(() => ({
  mockReadAttackTransactions: vi.fn(),
  mockDigestsSentBy: vi.fn(),
  mockPriceUsdAtTime: vi.fn(),
  priceMapRef: { current: {} as Record<string, { price: number; decimals?: number }> },
}));

vi.mock("../../src/utils/attack-read.js", () => ({
  readAttackTransactions: mockReadAttackTransactions,
  digestsSentBy: mockDigestsSentBy,
}));
vi.mock("../../src/utils/valuation.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  priceUsdAtTime: mockPriceUsdAtTime,
}));
vi.mock("../../src/utils/price-providers.js", async (original) => ({
  ...(await original<object>()),
  pythApiKey: () => null,
  fetchDefiLlamaHistory: async (requests: Map<string, number[]>) => new Map([...requests].map(([coin, times]) => [
    coin, new Map(times.filter((at) => at !== Date.parse("2025-09-01") / 1000).map((at) => [at, {
      price: at < Date.parse("2025-06-01") / 1000 ? 4 : 2, at, source: "defillama", decimals: 9,
    }])),
  ])),
}));

mockPriceUsdAtTime.mockImplementation(async (coinTypes: string[], at = 0) => {
  const points = new Map<string, PricePointLike>();
  const unpriced: Array<{ coin_type: string; code: "not_listed"; reason: string }> = [];
  for (const c of new Set(coinTypes)) {
    const p = priceMapRef.current[c];
    if (p) points.set(c, { price: p.price, publishTime: at, source: "defillama", decimals: p.decimals });
    else unpriced.push({ coin_type: c, code: "not_listed", reason: "No price." });
  }
  return { points, unpriced };
});

const { registerAttackTools } = await import("../../src/tools/attack.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlers: Record<string, Handler> = {};
registerAttackTools({
  tool: (name: string, _d: string, _s: unknown, h: Handler) => {
    handlers[name] = h;
  },
} as never);

const payloadOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[r.content.length - 1].text);

const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const USDC = "0xusdc::usdc::USDC";
const USDT = "0xusdt::usdt::USDT";
const UNLISTED = "0xnotoken::mytoken::MYTOKEN";

const A = "0xa1";
const D = "0xd1";
const F = "0xf1";
const B = "0xb1";
const X = "0xc1";
const VAULT = "0x1";
const DIGEST1 = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const DIGEST2 = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

const bc = (address: string, coinType: string, amount: string): AttackBalanceChange => ({ address, coinType, amount });

const tx = (digest: string, sender: string, success: boolean, changes: AttackBalanceChange[]): AttackTx => ({
  digest,
  sender,
  success,
  timestampMs: Date.parse("2025-06-01T00:00:00Z"),
  checkpoint: "1000",
  commandKinds: [],
  calls: [],
  events: [],
  balanceChanges: changes,
  objects: [],
});

const emptyRead = (txs: AttackTx[]) => ({ txs, missing: [], served_by_archive: 0, events_undecoded: [] });

beforeEach(() => {
  resetWindowPriceCache();
  priceMapRef.current = {};
  mockReadAttackTransactions.mockReset();
  mockDigestsSentBy.mockReset();
});

describe("summarize_incident_losses: sender mode reports the beneficiary, not the sender", () => {
  it("names the defaulted gainer as `attacker`, not the operator key", async () => {
    // Key-compromise shape: sender A is an operator key that pays only gas;
    // the vault's 1,000 USDC goes straight to D in the same transaction.
    mockDigestsSentBy.mockResolvedValue({ digests: [DIGEST1], truncated: false });
    mockReadAttackTransactions.mockResolvedValue(
      emptyRead([
        tx(DIGEST1, A, true, [
          bc(A, SUI, "-1000000"),
          bc(VAULT, USDC, "-1000000000"),
          bc(D, USDC, "1000000000"),
        ]),
      ]),
    );
    priceMapRef.current = { [USDC]: { price: 1, decimals: 6 } };

    const r = await handlers.summarize_incident_losses({ sender: A, start: 100, end: 200 });
    const payload = payloadOf(r);

    expect(payload.attacker).toBe(canonicalId(D));
    expect(payload.attacker).not.toBe(canonicalId(A));
    expect(payload.totals.usd_gained).toBeCloseTo(1000, 2);
    expect(payload.attacker_defaulted_from_sender.senders).toEqual([canonicalId(A)]);
  });
});

describe("gas-only is decided from the sender's own coins, not the netted USD", () => {
  it("analyze_attack_tx: an offsetting swap plus a fee is not gas-only, even at ~$0 net", async () => {
    // Sender A swaps 1,000 USDT for 1,000 USDC (net $0) inside the same
    // transaction a fee wallet F is paid $2. Read from netted USD, A would
    // look gas-only and F would be named "the largest gainer"; A moved real
    // coins.
    mockReadAttackTransactions.mockResolvedValue(
      emptyRead([
        tx(DIGEST1, A, true, [
          bc(A, USDT, "-1000000000"),
          bc(A, USDC, "1000000000"),
          bc(A, SUI, "-1000000"),
          bc(F, USDC, "2000000"),
        ]),
      ]),
    );
    priceMapRef.current = {
      [USDT]: { price: 1, decimals: 6 },
      [USDC]: { price: 1, decimals: 6 },
      [SUI]: { price: 1, decimals: 9 },
    };

    const r = await handlers.analyze_attack_tx({ digest: DIGEST1 });
    const payload = payloadOf(r);

    expect(payload.profit.address).toBe(canonicalId(A));
    expect(payload.attacker_defaulted_from_sender).toBeUndefined();
  });

  it("summarize_incident_losses: a drain followed by a forward is not gas-only, and the forward is not a loss", async () => {
    // Two transactions from the same sender A: tx1 drains 1,000 USDC from a
    // vault, tx2 forwards the same 1,000 USDC to D. A moved real USDC in tx1,
    // and tx2 only moved it on between addresses.
    mockReadAttackTransactions.mockResolvedValue(
      emptyRead([
        tx(DIGEST1, A, true, [bc(VAULT, USDC, "-1000000000"), bc(A, USDC, "1000000000")]),
        tx(DIGEST2, A, true, [bc(A, USDC, "-1000000000"), bc(D, USDC, "1000000000")]),
      ]),
    );
    priceMapRef.current = { [USDC]: { price: 1, decimals: 6 } };

    const r = await handlers.summarize_incident_losses({ digests: [DIGEST1, DIGEST2] });
    const payload = payloadOf(r);

    expect(payload.attacker).toBe("each transaction's sender");
    expect(payload.attacker_defaulted_from_sender).toBeUndefined();
    expect(payload.totals.usd_net).toBe(1000);
    expect(payload.transfers_out).toEqual([
      expect.objectContaining({ to: [{ address: canonicalId(D), amount: "1000000000" }], amount_raw: "1000000000", usd: 1000, transactions: [DIGEST2] }),
    ]);
  });

  it("summarize_incident_losses: a coin some object took in or paid out is not a transfer", async () => {
    // A pays 1,000 USDC: 600 to D and 400 into an object (no address gains
    // it), so USDC did not move only between addresses and the whole outflow
    // stays in the totals.
    mockReadAttackTransactions.mockResolvedValue(
      emptyRead([tx(DIGEST1, A, true, [bc(A, USDC, "-1000000000"), bc(D, USDC, "600000000")])]),
    );
    priceMapRef.current = { [USDC]: { price: 1, decimals: 6 } };

    const payload = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1] }));

    expect(payload.totals.usd_net).toBe(-1000);
    expect(payload.transfers_out).toBeUndefined();
  });

  it("summarize_incident_losses: a SUI transfer keeps the sender's gas in the totals", async () => {
    // A sends 5 SUI to D and pays 0.01 SUI of gas: only the 5 SUI moved on.
    const t = { ...tx(DIGEST1, A, true, [bc(A, SUI, "-5010000000"), bc(D, SUI, "5000000000")]), gas: { payer: A, net: 10_000_000n } };
    mockReadAttackTransactions.mockResolvedValue(emptyRead([t]));
    priceMapRef.current = { [SUI]: { price: 2, decimals: 9 } };

    const payload = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1], attacker: A }));

    expect(payload.priced_coins[0].attacker_net_raw).toBe("-10000000");
    expect(payload.transfers_out[0]).toMatchObject({ amount_raw: "5000000000", usd: 10 });
  });
});

describe("a beneficiary whose gain is unpriced is not passed over", () => {
  it("analyze_attack_tx: keeps the sender and lists the unpriced candidate instead of naming a small priced fee wallet", async () => {
    mockReadAttackTransactions.mockResolvedValue(
      emptyRead([
        tx(DIGEST1, A, true, [
          bc(A, SUI, "-1000"),
          bc(B, UNLISTED, "5000000"),
          bc(F, USDC, "2000000"),
        ]),
      ]),
    );
    priceMapRef.current = { [USDC]: { price: 1, decimals: 6 } };

    const r = await handlers.analyze_attack_tx({ digest: DIGEST1 });
    const payload = payloadOf(r);

    expect(payload.profit.address).toBe(canonicalId(A));
    expect(payload.attacker_defaulted_from_sender).toBeUndefined();
    expect(payload.unpriced_gain_candidates).toEqual([
      expect.objectContaining({ address: canonicalId(B) }),
    ]);
  });

  /**
   * Only another gainer's unpriced coin blocks the default; the top priced
   * gainer's own does not. A multi-asset drain's beneficiary B, which also
   * receives an LP coin with no price, is named over the gas-only signer A at
   * -$0.01.
   */
  const LP = "0xlp::lp::LP";
  const drainWithLp = (extra: AttackBalanceChange[] = []) =>
    emptyRead([
      tx(DIGEST1, A, true, [
        bc(A, SUI, "-1000"),
        bc(VAULT, USDC, "-5000000000"),
        bc(B, USDC, "5000000000"),
        bc(B, LP, "123000"),
        bc(F, USDC, "2000000"),
        ...extra,
      ]),
    ]);

  it("analyze_attack_tx: defaults to the top priced gainer when the only unpriced gain is its own, as a partial figure", async () => {
    mockReadAttackTransactions.mockResolvedValue(drainWithLp());
    priceMapRef.current = { [USDC]: { price: 1, decimals: 6 } };

    const payload = payloadOf(await handlers.analyze_attack_tx({ digest: DIGEST1 }));

    expect(payload.profit.address).toBe(canonicalId(B));
    expect(payload.profit.attacker_defaulted_from_sender.sender).toBe(canonicalId(A));
    expect(payload.profit.usd_net).toBeCloseTo(5000, 2);
    expect(payload.profit.unpriced_coins).toContain(LP);
    expect(payload.profit.partial_note).toBeDefined();
    expect(payload.unpriced_gain_candidates).toBeUndefined();
  });

  it("analyze_attack_tx: still keeps the sender when a smaller gainer's unpriced coin would be passed over", async () => {
    mockReadAttackTransactions.mockResolvedValue(drainWithLp([bc(F, UNLISTED, "9000000")]));
    priceMapRef.current = { [USDC]: { price: 1, decimals: 6 } };

    const payload = payloadOf(await handlers.analyze_attack_tx({ digest: DIGEST1 }));

    expect(payload.profit.address).toBe(canonicalId(A));
    expect(payload.profit.attacker_defaulted_from_sender).toBeUndefined();
    expect(payload.unpriced_gain_candidates).toEqual([expect.objectContaining({ address: canonicalId(F) })]);
  });

  it("summarize_incident_losses: defaults to the top priced gainer whose own gain includes an unpriced coin", async () => {
    mockReadAttackTransactions.mockResolvedValue(drainWithLp());
    priceMapRef.current = { [USDC]: { price: 1, decimals: 6 } };

    const payload = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1] }));

    expect(payload.attacker).toBe(canonicalId(B));
    expect(payload.attacker_defaulted_from_sender.senders).toEqual([canonicalId(A)]);
    expect(payload.unpriced_gain_candidates).toBeUndefined();
    expect(payload.totals.usd_gained).toBeCloseTo(5000, 2);
    expect(payload.totals.partial).toBe(true);
  });

  it("summarize_incident_losses: still keeps the senders when a smaller gainer's unpriced coin would be passed over", async () => {
    mockReadAttackTransactions.mockResolvedValue(drainWithLp([bc(F, UNLISTED, "9000000")]));
    priceMapRef.current = { [USDC]: { price: 1, decimals: 6 } };

    const payload = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1] }));

    expect(payload.attacker).toBe("each transaction's sender");
    expect(payload.attacker_defaulted_from_sender).toBeUndefined();
    expect(payload.unpriced_gain_candidates).toEqual([expect.objectContaining({ address: canonicalId(F) })]);
  });
});

describe("incident totals cover the attacker's coins and pools", () => {
  it("keeps unrelated third-party unpriced coins out of the totals' coverage", async () => {
    mockReadAttackTransactions.mockResolvedValue(
      emptyRead([
        tx(DIGEST1, VAULT, true, [
          bc(A, USDC, "1000000000"),
          bc(X, UNLISTED, "777000"),
        ]),
      ]),
    );
    priceMapRef.current = { [USDC]: { price: 1, decimals: 6 } };

    const r = await handlers.summarize_incident_losses({ digests: [DIGEST1], attacker: A });
    const payload = payloadOf(r);

    expect(payload.totals.coins).toBe(1);
    expect(payload.totals.partial).toBe(false);
    expect(payload.unpriced_remainder).toEqual([]);
  });
});

describe("incident historical coin legs", () => {
  it("prices gains and forwarded amounts on their respective days", async () => {
    const take = tx(DIGEST1, A, true, [bc(A, SUI, "10000000000")]);
    take.timestampMs = Date.parse("2025-01-01");
    const send = tx(DIGEST2, A, true, [bc(A, SUI, "-10000000000"), bc(D, SUI, "10000000000")]);
    send.timestampMs = Date.parse("2025-07-01");
    send.gas = { payer: A, net: 0n };
    mockReadAttackTransactions.mockResolvedValue(emptyRead([take, send]));
    const result = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1, DIGEST2], attacker: A }));
    expect(result.totals).toMatchObject({ usd_gained: 40, usd_net: 40, transfers_out_usd: 20, approximate: true, partial: false });
    expect(result.transfers_out[0]).toMatchObject({ usd: 20, amount: 10 });
    expect(result.usd_basis).toMatchObject({ method: "daily_utc", priced_coin_days: 2 });
  });

  it("retains an explicitly requested fixed-time valuation", async () => {
    const first = tx(DIGEST1, A, true, [bc(A, SUI, "10000000000")]);
    first.timestampMs = Date.parse("2025-01-01");
    const last = tx(DIGEST2, A, true, [bc(A, SUI, "-10000000000")]);
    last.timestampMs = Date.parse("2025-07-01");
    priceMapRef.current = { [SUI]: { price: 3, decimals: 9 } };
    mockReadAttackTransactions.mockResolvedValue(emptyRead([first, last]));
    const result = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1, DIGEST2], attacker: A, price_at: "2025-03-01" }));
    expect(result.totals.usd_net).toBe(0);
    expect(result.usd_basis).toMatchObject({ method: "fixed_time", priced_coin_days: 1 });
  });

  it("does not hide an unpriced debit behind a priced credit in the same coin", async () => {
    const first = tx(DIGEST1, A, true, [bc(A, SUI, "10000000000")]);
    first.timestampMs = Date.parse("2025-01-01");
    const last = tx(DIGEST2, A, true, [bc(A, SUI, "-10000000000")]);
    last.timestampMs = Date.parse("2025-09-01");
    mockReadAttackTransactions.mockResolvedValue(emptyRead([first, last]));
    const result = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1, DIGEST2], attacker: A }));
    expect(result.totals).toMatchObject({ usd_net: 40, partial: true });
    expect(result.unpriced_remainder[0]).toMatchObject({ attacker_net_raw: "0", unpriced_raw: { in: "0", out: "10000000000" } });
  });
});
