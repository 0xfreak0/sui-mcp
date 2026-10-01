import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { candidates, gqlTx, searchPage, CETUS, SUI, USDC, type HopSpec } from "./helpers/trace-shapes.js";
import { gqlPage, pagedTxConnection } from "./helpers/service-shapes.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
/** USD prices by coin type the mocked DefiLlama answers; empty means no prices. */
const mockPrices = new Map<string, number>();
/** Requests the mocked DefiLlama received. */
const llamaRequests = { count: 0 };
vi.mock("../src/utils/price-providers.js", () => ({
  withPriceProviderCall: (read: () => Promise<unknown>) => read(),
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async (coinTypes: string[]) => {
    llamaRequests.count++;
    return {
      quotes: new Map(coinTypes.filter((ct) => mockPrices.has(ct)).map((ct) => [ct, { price: mockPrices.get(ct)! }])),
      unanswered: new Set(),
      unsupported: new Set(),
    };
  },
}));
vi.mock("../src/utils/recent-prices.js", () => ({ fetchRecentHistory: async () => ({ quotes: new Map(), unanswered: new Map(), outOfRange: [] }) }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
const mockFanout = vi.fn();
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: mockFanout }));

// Imported after the mocks are registered, as the trace tests do.
const { FlowEngine } = await import("../src/utils/flow-engine.js");
const { findLookalikes } = await import("../src/utils/address-lookalike.js");
const { noSpendReason } = await import("../src/utils/trace-read.js");

const ATTACKER = `0xa1${"1".repeat(62)}`;
const B = `0xb2${"2".repeat(62)}`;
const C = `0xc3${"3".repeat(62)}`;
const D = `0xd4${"4".repeat(62)}`;
const SUI_BRIDGE_DEPOSIT = "0x000000000000000000000000000000000000000000000000000000000000000b::bridge::TokenDepositedEvent";

/** The exact payload of the TokenDepositedEvent in mainnet transaction 4xLuY6N68PgqBow9i4iawBvVw3eEkxKQNRQeSWFGwjJi. */
const REAL_DEPOSIT = {
  seq_num: "23371",
  source_chain: 0,
  sender_address: "xKRFS6UEKXM8q3C7Q0rJnXTSCnU0w9/Tux+m6Ts8SzI=",
  target_chain: 10,
  target_address: "1vBbGb8sBcJkpka3dXBX13RmHFw=",
  token_type: 4,
  amount: "130004100000",
};

const CP = 1000;
/** An exploit that credits only its sender. */
const exploit: HopSpec = { digest: "0xexploit", sender: ATTACKER, checkpoint: CP, changes: [[ATTACKER, "1000000000000"]] };
/** The attacker splits it 60/40. */
const split: HopSpec = {
  digest: "0xsplit",
  sender: ATTACKER,
  checkpoint: CP + 1,
  changes: [
    [ATTACKER, "-1000000000000"],
    [B, "600000000000"],
    [C, "400000000000"],
  ],
};
/** B bridges its share out through Sui's native bridge. */
const bridge: HopSpec = {
  digest: "0xbridge",
  sender: B,
  checkpoint: CP + 2,
  changes: [[B, "-600000000000"]],
  events: [SUI_BRIDGE_DEPOSIT],
};
/** C mixes in 600 SUI of its own and pays D 1,000. */
const mixed: HopSpec = {
  digest: "0xmixed",
  sender: C,
  checkpoint: CP + 3,
  changes: [
    [C, "-1000000000000"],
    [D, "1000000000000"],
  ],
};

function route(sent: Record<string, HopSpec[]>) {
  const all = new Map([exploit, split, bridge, mixed].map((h) => [h.digest, h]));
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
    const q = String(query);
    if (q.includes("transactions(")) {
      const list = q.includes("sentAddress") ? (sent[String(vars.address)] ?? []) : [];
      return candidates(list, q.includes("last:") ? "backward" : "forward");
    }
    if (q.includes("json")) {
      const h = all.get(String(vars.digest));
      return {
        transaction: {
          effects: {
            events: gqlPage((h?.events ?? []).map((repr) => ({ contents: { type: { repr }, json: REAL_DEPOSIT } }))),
          },
        },
      };
    }
    const h = all.get(String(vars.digest));
    return h ? gqlTx(h) : { transaction: null };
  });
}

const engine = () =>
  new FlowEngine({
    direction: "forward",
    coin: null,
    maxDepth: 4,
    maxNodes: 40,
    minShare: 0.01,
    minUsd: null,
    window: {},
    maxTxReads: 100,
  });

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockPrices.clear();
  mockFanout.mockReset();
  mockFanout.mockResolvedValue({ classification: "narrow", counterparty_count: 3, scanned_transactions: 10, truncated: false });
  route({ [ATTACKER]: [exploit, split], [B]: [bridge], [C]: [mixed] });
});

describe("unread hub gates", () => {
  it.each(["forward", "backward"] as const)("does not attribute value beyond an unread %s hub check", async (direction) => {
    const pay: HopSpec = { digest: "synthetic-pay", sender: ATTACKER, checkpoint: CP, changes: [[ATTACKER, "-1000000000"], [B, "1000000000"]] };
    const onward: HopSpec = { digest: "synthetic-onward", sender: B, checkpoint: CP + 1, changes: [[B, "-1000000000"], [C, "1000000000"]] };
    const all = new Map([pay, onward].map((h) => [h.digest, h]));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      if (query.includes("transactions(")) {
        const tx = direction === "forward" || vars.address === C ? onward : pay;
        return candidates([tx], direction === "backward" ? "backward" : "forward");
      }
      const tx = all.get(String(vars.digest));
      return tx ? gqlTx(tx) : { transaction: null };
    });
    mockFanout.mockRejectedValue(new Error("Incomplete balance changes for synthetic-fanout"));
    const e = new FlowEngine({ ...engine().opts, direction });
    if (direction === "forward") await e.startFromDigest(pay.digest);
    else e.startFromAddress(C);
    await e.run();

    expect(e.ledger.summary().map((g) => [g.code, g.share])).toEqual([["read_failed", 1]]);
    expect(e.truncated).toBe(true);
    const blocked = [...e.nodes.values()].find((n) => n.address === B)!;
    expect(blocked.stop).toMatchObject({ code: "read_failed", detail: expect.stringContaining("synthetic-fanout") });
    expect([...e.nodes.values()].some((n) => n.address === (direction === "forward" ? C : ATTACKER))).toBe(false);
  });
});

describe("FlowEngine forward", () => {
  it("accounts for every share of the traced value, by where it ended", async () => {
    const e = engine();
    await e.startFromDigest("0xexploit");
    await e.run();
    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.bridge_exit).toBeCloseTo(0.6);
    expect(byCode.unspent).toBeCloseTo(0.4);
    expect(e.ledger.total()).toBeCloseTo(1);
    expect(e.truncated).toBe(false);
  });

  it("names the far-side beneficiary of a bridge exit from the transaction's event", async () => {
    const e = engine();
    await e.startFromDigest("0xexploit");
    await e.run();
    const exit = [...e.nodes.values()].find((n) => n.kind === "bridge_exit")!;
    expect(exit.protocols).toEqual(["Sui Bridge"]);
    expect(exit.beneficiaries?.map((b) => b.address)).toEqual(["0xd6f05b19bf2c05c264a646b7757057d774661c5c"]);
  });

  it("carries only the traced part of a payment that mixes in other funds", async () => {
    // C received 400 of the traced SUI and paid D 1,000: D holds 400 of it.
    const e = engine();
    await e.startFromDigest("0xexploit");
    await e.run();
    const d = [...e.nodes.values()].find((n) => n.address === D)!;
    expect(d.traced).toBe(400000000000n);
    expect(d.share).toBeCloseTo(0.4);
    const edge = [...e.edges.values()].find((x) => e.nodes.get(x.to)?.address === D)!;
    expect(edge.amount).toBe(1000000000000n);
    expect(edge.traced).toBe(400000000000n);
  });

  it("stops at a hub instead of attributing its later payments to these funds", async () => {
    mockFanout.mockImplementation(async (address: string) =>
      address === C
        ? { classification: "hub", counterparty_count: 180, scanned_transactions: 200, truncated: true }
        : { classification: "narrow", counterparty_count: 3, scanned_transactions: 10, truncated: false },
    );
    const e = engine();
    await e.startFromDigest("0xexploit");
    await e.run();
    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.hub).toBeCloseTo(0.4);
    expect([...e.nodes.values()].some((n) => n.address === D)).toBe(false);
  });

  it("expands a wide address that few senders pay into, since it passes on what they sent", async () => {
    mockFanout.mockImplementation(async (address: string) =>
      address === C
        ? { classification: "distributor", sender_classification: "narrow", sender_count: 13, counterparty_count: 181, scanned_transactions: 200, truncated: true }
        : { classification: "narrow", counterparty_count: 3, scanned_transactions: 10, truncated: false },
    );
    const e = engine();
    await e.startFromDigest("0xexploit");
    await e.run();
    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.hub).toBeUndefined();
    expect([...e.nodes.values()].find((n) => n.address === D)?.share).toBeCloseTo(0.4);
  });

  it("reports a node limit as budget, never as the money stopping", async () => {
    const e = new FlowEngine({ ...engine().opts, maxNodes: 1 });
    await e.startFromDigest("0xexploit");
    await e.run();
    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.budget).toBeCloseTo(1);
    expect(e.truncated).toBe(true);
  });

  it("refuses an unreadable start rather than returning an empty graph", async () => {
    await expect(engine().startFromDigest("0xnothing")).rejects.toThrow(/not evidence that no funds moved/);
  });
  it("does not double-count a later spend of self-converted proceeds under an address-start root", async () => {
    // An address-start root (coin: null) finds every forward spend of
    // ATTACKER in one pass, including a "conversion" hop (SUI spent, USDC
    // gained) and a later bridge exit that spends that same USDC. The
    // conversion also spawns a child node for (ATTACKER, USDC), which
    // independently scans forward for USDC spends. The two nodes share which
    // digests were already allocated to this address, so the child does not
    // rediscover the same bridge exit and double-count it.
    const swap: HopSpec = {
      digest: "0xswap2",
      sender: ATTACKER,
      checkpoint: CP + 10,
      changes: [
        [ATTACKER, "-1000000000", SUI],
        [ATTACKER, "500000000", USDC],
      ],
    };
    const burn: HopSpec = {
      digest: "0xburn2",
      sender: ATTACKER,
      checkpoint: CP + 11,
      changes: [[ATTACKER, "-500000000", USDC]],
      events: [SUI_BRIDGE_DEPOSIT],
    };
    const all = new Map([swap, burn].map((h) => [h.digest, h]));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) return candidates([swap, burn], q.includes("last:") ? "backward" : "forward");
      if (q.includes("json")) {
        const h = all.get(String(vars.digest));
        return {
          transaction: {
            effects: { events: gqlPage((h?.events ?? []).map((repr) => ({ contents: { type: { repr }, json: REAL_DEPOSIT } }))) },
          },
        };
      }
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });

    const e = engine();
    e.startFromAddress(ATTACKER);
    await e.run();

    // The swap is a conversion at the start address: its USDC is what the
    // root's own burn spent, so the whole outflow is the bridge exit and no
    // share is left at a USDC node of the same address as a cycle.
    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.bridge_exit).toBeCloseTo(1);
    expect(byCode.cycle).toBeUndefined();
    expect(byCode.unspent).toBeUndefined();
    expect(e.ledger.total()).toBeCloseTo(1);
    expect([...e.nodes.values()].some((n) => n.address === ATTACKER && n.coin_type === USDC)).toBe(false);

    const exit = [...e.nodes.values()].find((n) => n.kind === "bridge_exit")!;
    const exitEdges = [...e.edges.values()].filter((x) => x.to === exit.id);
    expect(exitEdges).toHaveLength(1);
    expect(exitEdges[0].amount).toBe(500000000n);
    expect(exitEdges[0].digests).toEqual(["0xburn2"]);
  });

  it("backward: explains an address-start root's swapped proceeds by its real inflow, not a cycle", async () => {
    // P pays ATTACKER 1 SUI, which ATTACKER swaps for 0.5 USDC.
    const Ph = `0xcf${"c".repeat(62)}`;
    const pay: HopSpec = { digest: "0xpaysui", sender: Ph, checkpoint: CP + 10, changes: [[Ph, "-1000000000", SUI], [ATTACKER, "1000000000", SUI]] };
    const swap: HopSpec = {
      digest: "0xswapback",
      sender: ATTACKER,
      checkpoint: CP + 11,
      changes: [[ATTACKER, "-1000000000", SUI], [ATTACKER, "500000000", USDC]],
    };
    const all = new Map([pay, swap].map((h) => [h.digest, h]));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) return candidates([pay, swap], q.includes("last:") ? "backward" : "forward");
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });

    const e = new FlowEngine({ ...engine().opts, direction: "backward" });
    e.startFromAddress(ATTACKER);
    await e.run();

    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.cycle).toBeUndefined();
    expect(e.ledger.total()).toBeCloseTo(1);
    const p = [...e.nodes.values()].find((n) => n.address === Ph)!;
    expect(p.share).toBeCloseTo(1);
  });
  it("words a spend the address-start root claimed as counted from the start node", () => {
    const scan = { spends: [], phase: "sent" as const, seen: 1, exhausted: true, satisfied: false, alreadyAllocated: 1, drainedBySelf: 0 };
    expect(noSpendReason(ATTACKER, USDC, scan)).toBe(
      `${ATTACKER} spent USDC in 1 transaction(s) whose value was already counted from this address's start node elsewhere in this graph, so this branch's share is not counted a second time. It did move; see the start node's edges for where.`,
    );
  });

  it("follows the conversion when an address-start root only converted, and reports the proceeds held", async () => {
    const swap: HopSpec = { digest: "0xonlyswap", sender: ATTACKER, checkpoint: CP + 10, changes: [[ATTACKER, "-1000000000", SUI], [ATTACKER, "500000000", USDC]] };
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) return candidates([swap], q.includes("last:") ? "backward" : "forward");
      return String(vars.digest) === swap.digest ? gqlTx(swap) : { transaction: null };
    });
    const e = engine();
    e.startFromAddress(ATTACKER);
    await e.run();
    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode).toEqual({ unspent: expect.closeTo(1) });
    expect([...e.nodes.values()].find((n) => n.address === ATTACKER && n.coin_type === USDC)!.unspent).toBe(500000000n);
  });

  it("reports held funds as unspent, not cycle, when a same-node arrival finds only drained spends", async () => {
    // Exploit credits ATTACKER 1000 SUI, ATTACKER pays A 600 and B 400, B
    // pays A 400 (a second arrival at the same node A|SUI, after A, the
    // heavier branch, was expanded), and A's only spend is 600 to C. A never
    // spent the 400 SUI B routed to it, so it is still held.
    const A = `0xa5${"a".repeat(62)}`;
    const Bh = `0xb6${"b".repeat(62)}`;
    const Ch = `0xc7${"c".repeat(62)}`;
    const exploit2: HopSpec = { digest: "0xexploit2", sender: ATTACKER, checkpoint: CP, changes: [[ATTACKER, "1000"]] };
    const split2: HopSpec = {
      digest: "0xsplit2",
      sender: ATTACKER,
      checkpoint: CP + 1,
      changes: [[ATTACKER, "-1000"], [A, "600"], [Bh, "400"]],
    };
    const bPaysA: HopSpec = {
      digest: "0xbpaysa",
      sender: Bh,
      checkpoint: CP + 2,
      changes: [[Bh, "-400"], [A, "400"]],
    };
    const aPaysC: HopSpec = {
      digest: "0xapaysc",
      sender: A,
      checkpoint: CP + 3,
      changes: [[A, "-600"], [Ch, "600"]],
    };
    const all = new Map([exploit2, split2, bPaysA, aPaysC].map((h) => [h.digest, h]));
    const sent: Record<string, HopSpec[]> = { [ATTACKER]: [exploit2, split2], [Bh]: [bPaysA], [A]: [aPaysC] };
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) {
        const list = q.includes("sentAddress") ? (sent[String(vars.address)] ?? []) : [];
        return candidates(list, q.includes("last:") ? "backward" : "forward");
      }
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });

    const e = engine();
    await e.startFromDigest("0xexploit2");
    await e.run();

    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.cycle).toBeUndefined();
    expect(byCode.unspent).toBeCloseTo(1);
    expect(e.ledger.total()).toBeCloseTo(1);

    const aNode = [...e.nodes.values()].find((n) => n.address === A)!;
    expect(aNode.unspent).toBe(400n);
    // A's one later spend moved 600 SUI to C: the stop must say it is already
    // counted, not that A sent nothing that moved SUI.
    const aEntries = e.ledger.summary().flatMap((g) => g.entries).filter((x) => x.node === aNode.id);
    expect(aEntries.map((x) => x.detail)).toEqual([
      `${A}'s 1 later spend(s) of SUI are already counted against its earlier arrival(s) in this graph, so this arrival's share is still held.`,
    ]);
  });

  it("lists a holder reached by two paths once under unspent, with both arrivals' held amounts", async () => {
    // ATTACKER pays A 600 and B 400, B pays A 400, and A's only spend is 300
    // to C. A's first arrival keeps 300 and its second keeps all 400: two
    // unspent ends of one holder, reported as one entry of 0.7.
    const A = `0xa5${"a".repeat(62)}`;
    const Bh = `0xb6${"b".repeat(62)}`;
    const Ch = `0xc7${"c".repeat(62)}`;
    const exploit: HopSpec = { digest: "0xexploit3", sender: ATTACKER, checkpoint: CP, changes: [[ATTACKER, "1000"]] };
    const split: HopSpec = { digest: "0xsplit3", sender: ATTACKER, checkpoint: CP + 1, changes: [[ATTACKER, "-1000"], [A, "600"], [Bh, "400"]] };
    const bPaysA: HopSpec = { digest: "0xbpaysa3", sender: Bh, checkpoint: CP + 2, changes: [[Bh, "-400"], [A, "400"]] };
    const aPaysC: HopSpec = { digest: "0xapaysc3", sender: A, checkpoint: CP + 3, changes: [[A, "-300"], [Ch, "300"]] };
    const all = new Map([exploit, split, bPaysA, aPaysC].map((h) => [h.digest, h]));
    const sent: Record<string, HopSpec[]> = { [ATTACKER]: [exploit, split], [Bh]: [bPaysA], [A]: [aPaysC] };
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) {
        const list = q.includes("sentAddress") ? (sent[String(vars.address)] ?? []) : [];
        return candidates(list, q.includes("last:") ? "backward" : "forward");
      }
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });

    const e = engine();
    await e.startFromDigest("0xexploit3");
    await e.run();

    const aNode = [...e.nodes.values()].find((n) => n.address === A)!;
    expect(aNode.unspent).toBe(700n);
    const unspent = e.ledger.summary().find((g) => g.code === "unspent")!;
    const aEntries = unspent.entries.filter((x) => x.node === aNode.id);
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0].share).toBeCloseTo(0.7);
    // Both arrivals' reasons survive the merge.
    expect(aEntries[0].detail).toContain("moved only part");
    expect(aEntries[0].detail).toContain("already counted");
    expect(unspent.share).toBeCloseTo(unspent.entries.reduce((s, x) => s + x.share, 0));
    expect(e.ledger.total()).toBeCloseTo(1);
  });

  it("follows a second conversion into an already-expanded coin of the same address to the bridge exit, not a cycle", async () => {
    // ATTACKER swaps XAUm into USDC and into SUI, then that SUI into USDC, and
    // sends all the USDC out through a bridge. Its USDC node is expanded for
    // the first swap's USDC before the SUI node's swap reaches it. That
    // arrival is a conversion at the same address, so it follows the value
    // to the bridge exit instead of stopping as a cycle.
    const XAUM = CETUS;
    const drain: HopSpec = { digest: "0xdrain", sender: ATTACKER, checkpoint: CP, changes: [[ATTACKER, "1000", XAUM]] };
    const toUsdc: HopSpec = {
      digest: "0xxaum2usdc",
      sender: ATTACKER,
      checkpoint: CP + 1,
      changes: [[ATTACKER, "-800", XAUM], [ATTACKER, "8000", USDC]],
    };
    const toSui: HopSpec = {
      digest: "0xxaum2sui",
      sender: ATTACKER,
      checkpoint: CP + 2,
      changes: [[ATTACKER, "-200", XAUM], [ATTACKER, "2000", SUI]],
    };
    const suiToUsdc: HopSpec = {
      digest: "0xsui2usdc",
      sender: ATTACKER,
      checkpoint: CP + 3,
      changes: [[ATTACKER, "-2000", SUI], [ATTACKER, "2000", USDC]],
    };
    const burn: HopSpec = {
      digest: "0xburnall",
      sender: ATTACKER,
      checkpoint: CP + 4,
      changes: [[ATTACKER, "-10000", USDC]],
      events: [SUI_BRIDGE_DEPOSIT],
    };
    const hops = [drain, toUsdc, toSui, suiToUsdc, burn];
    const all = new Map(hops.map((h) => [h.digest, h]));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) return candidates(hops.slice(1), q.includes("last:") ? "backward" : "forward");
      if (q.includes("json")) {
        const h = all.get(String(vars.digest));
        return {
          transaction: {
            effects: { events: gqlPage((h?.events ?? []).map((repr) => ({ contents: { type: { repr }, json: REAL_DEPOSIT } }))) },
          },
        };
      }
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });

    const e = new FlowEngine({
      direction: "forward",
      coin: XAUM,
      maxDepth: 6,
      maxNodes: 40,
      minShare: 0.01,
      minUsd: null,
      window: {},
      maxTxReads: 100,
    });
    await e.startFromDigest("0xdrain");
    await e.run();

    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.cycle).toBeUndefined();
    expect(byCode.bridge_exit).toBeCloseTo(1);
    expect(e.ledger.total()).toBeCloseTo(1);
    const exitEdges = [...e.edges.values()].filter((x) => e.nodes.get(x.to)?.kind === "bridge_exit");
    expect(exitEdges.reduce((s, x) => s + x.traced, 0n)).toBe(10000n);
  });

  it("still calls value that left an address and came back a cycle", async () => {
    // ATTACKER pays B, B pays it back, and ATTACKER's node has already been
    // expanded: the value returned to an address it passed through.
    const drain: HopSpec = { digest: "0xdrain3", sender: ATTACKER, checkpoint: CP, changes: [[ATTACKER, "1000"]] };
    const toB: HopSpec = { digest: "0xtob", sender: ATTACKER, checkpoint: CP + 1, changes: [[ATTACKER, "-1000"], [B, "1000"]] };
    const back: HopSpec = { digest: "0xback", sender: B, checkpoint: CP + 2, changes: [[B, "-1000"], [ATTACKER, "1000"]] };
    const all = new Map([drain, toB, back].map((h) => [h.digest, h]));
    const sent: Record<string, HopSpec[]> = { [ATTACKER]: [toB], [B]: [back] };
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) {
        const list = q.includes("sentAddress") ? (sent[String(vars.address)] ?? []) : [];
        return candidates(list, q.includes("last:") ? "backward" : "forward");
      }
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });

    const e = engine();
    await e.startFromDigest("0xdrain3");
    await e.run();
    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.cycle).toBeCloseTo(1);
  });

  it("keys the address-start root's claim by the coin it followed, not a wildcard, so the non-dominant coin of a multi-coin spend is still traced", async () => {
    // Address start at A. A swaps 1000 SUI for 500 USDC (creating a
    // swap-follow child A|USDC), then one transaction pays B
    // 2000 SUI plus those same 500 USDC. The root's own scan (coin: null)
    // follows the dominant SUI leg of that payout; it must not wildcard-block
    // the USDC leg the A|USDC child needs to trace to B.
    const A = `0xa8${"a".repeat(62)}`;
    const Bh = `0xb9${"b".repeat(62)}`;
    const swap3: HopSpec = {
      digest: "0xswap3",
      sender: A,
      checkpoint: CP + 20,
      changes: [[A, "-1000", SUI], [A, "500", USDC]],
    };
    const payBoth: HopSpec = {
      digest: "0xpayboth",
      sender: A,
      checkpoint: CP + 21,
      changes: [[A, "-2000", SUI], [Bh, "2000", SUI], [A, "-500", USDC], [Bh, "500", USDC]],
    };
    const all = new Map([swap3, payBoth].map((h) => [h.digest, h]));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) return candidates([swap3, payBoth], q.includes("last:") ? "backward" : "forward");
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });

    const e = engine();
    e.startFromAddress(A);
    await e.run();

    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.cycle).toBeUndefined();

    const bUsdc = [...e.nodes.values()].find((n) => n.address === Bh && n.coin_type === USDC);
    expect(bUsdc).toBeDefined();
    expect(bUsdc!.traced).toBe(500n);
  });

  describe("an address-start root's claim on a multi-coin transaction whose largest raw amount is not the coin it followed", () => {
    // SUI's raw amount (9 decimals) beats a 6-decimal coin worth ten times
    // more, so the root's scan measures the SUI leg while splitSpend follows
    // the USD-dominant USDC leg. The root's claim must be recorded in USDC.
    const A = `0xaa${"a".repeat(62)}`;
    const Bh = `0xbb${"b".repeat(62)}`;
    const Ph = `0xcc${"c".repeat(62)}`;

    function serve(hops: HopSpec[]) {
      const all = new Map(hops.map((h) => [h.digest, h]));
      mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
        const q = String(query);
        if (q.includes("transactions(")) return candidates(hops, q.includes("last:") ? "backward" : "forward");
        const h = all.get(String(vars.digest));
        return h ? gqlTx(h) : { transaction: null };
      });
    }
    /** Traced USDC on every edge that touches `addr`'s USDC node, whichever way it points. */
    const usdcEdgesAt = (e: InstanceType<typeof FlowEngine>, addr: string) =>
      [...e.edges.values()].filter((x) =>
        [x.from, x.to].some((id) => e.nodes.get(id)?.address === addr && e.nodes.get(id)?.coin_type === USDC),
      );

    beforeEach(() => {
      mockPrices.set(SUI, 3);
      mockPrices.set(USDC, 1);
    });

    it("forward: traces the USDC payment once and the SUI leg beside it, with no cycle", async () => {
      // A swaps 1000 SUI for 3000 USDC, then one transaction pays B 100 SUI
      // ($300) and 3000 USDC.
      const swap: HopSpec = { digest: "0xfswap", sender: A, checkpoint: CP + 30, changes: [[A, "-1000000000000", SUI], [A, "3000000000", USDC]] };
      const pay: HopSpec = {
        digest: "0xfpay",
        sender: A,
        checkpoint: CP + 31,
        changes: [[A, "-100000000000", SUI], [Bh, "100000000000", SUI], [A, "-3000000000", USDC], [Bh, "3000000000", USDC]],
      };
      serve([swap, pay]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      const bUsdc = [...e.nodes.values()].find((n) => n.address === Bh && n.coin_type === USDC)!;
      expect(bUsdc.traced).toBe(3000000000n);
      expect(usdcEdgesAt(e, Bh).map((x) => x.traced)).toEqual([3000000000n]);
      expect(e.ledger.total()).toBeCloseTo(1);
      const bSui = [...e.nodes.values()].find((n) => n.address === Bh && n.coin_type === SUI)!;
      expect(bSui.traced).toBe(100000000000n);
      expect(bSui.share).toBeCloseTo(300 / 3300);
      expect(Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share])).cycle).toBeUndefined();
    });

    it("forward: when the SUI leg dominates, the USDC leg of the same payment is still traced once", async () => {
      const swap: HopSpec = { digest: "0xfswap2", sender: A, checkpoint: CP + 30, changes: [[A, "-1000000000000", SUI], [A, "500000000", USDC]] };
      const pay: HopSpec = {
        digest: "0xfpay2",
        sender: A,
        checkpoint: CP + 31,
        changes: [[A, "-2000000000000", SUI], [Bh, "2000000000000", SUI], [A, "-500000000", USDC], [Bh, "500000000", USDC]],
      };
      serve([swap, pay]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(usdcEdgesAt(e, Bh).map((x) => x.traced)).toEqual([500000000n]);
      const bSui = [...e.nodes.values()].find((n) => n.address === Bh && n.coin_type === SUI)!;
      expect(bSui.traced).toBe(2000000000000n);
      expect(Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share])).cycle).toBeUndefined();
    });

    it("backward: the USDC child does not explain its USDC with the payment the root already claimed", async () => {
      // P pays A 100 SUI and 3000 USDC in one transaction; A later swaps the
      // 3000 USDC for 1000 SUI.
      const pay: HopSpec = {
        digest: "0xbpay",
        sender: Ph,
        checkpoint: CP + 30,
        changes: [[Ph, "-100000000000", SUI], [A, "100000000000", SUI], [Ph, "-3000000000", USDC], [A, "3000000000", USDC]],
      };
      const swap: HopSpec = { digest: "0xbswap", sender: A, checkpoint: CP + 31, changes: [[A, "-3000000000", USDC], [A, "1000000000000", SUI]] };
      serve([pay, swap]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward" });
      e.startFromAddress(A);
      await e.run();

      const pUsdc = [...e.nodes.values()].find((n) => n.address === Ph && n.coin_type === USDC)!;
      expect(pUsdc.traced).toBe(3000000000n);
      expect(usdcEdgesAt(e, Ph).map((x) => x.traced)).toEqual([3000000000n]);
      expect(e.ledger.total()).toBeCloseTo(1);
    });
  });

  it("backward: says a same-node arrival's inflows already explain its other arrival, not that none paid in", async () => {
    // Z receives 600 from A and 400 from B in one transaction; B got its 400
    // from A; A's only inflow is 600 from P. A's first arrival (the heavier
    // branch, expanded first) draws that inflow, so its second finds it drained.
    const A = `0xa9${"a".repeat(62)}`;
    const Bh = `0xba${"b".repeat(62)}`;
    const Ph = `0xcd${"c".repeat(62)}`;
    const Z = `0xde${"d".repeat(62)}`;
    const pToA: HopSpec = { digest: "0xptoa", sender: Ph, checkpoint: CP + 1, changes: [[Ph, "-600"], [A, "600"]] };
    const aToB: HopSpec = { digest: "0xatob", sender: A, checkpoint: CP + 2, changes: [[A, "-400"], [Bh, "400"]] };
    const toZ: HopSpec = { digest: "0xtoz", sender: A, checkpoint: CP + 3, changes: [[A, "-600"], [Bh, "-400"], [Z, "1000"]] };
    const hops = [pToA, aToB, toZ];
    const all = new Map(hops.map((h) => [h.digest, h]));
    const affects = (addr: string) => hops.filter((h) => h.changes.some(([a]) => a === addr));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) return candidates(affects(String(vars.address)), q.includes("last:") ? "backward" : "forward");
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });

    const e = new FlowEngine({ ...engine().opts, direction: "backward" });
    await e.startFromDigest("0xtoz");
    await e.run();

    const aNode = [...e.nodes.values()].find((n) => n.address === A)!;
    const aEntries = e.ledger.summary().flatMap((g) => g.entries).filter((x) => x.node === aNode.id);
    expect(aEntries.map((x) => x.detail)).toEqual([
      `${A}'s 1 earlier inflow(s) of SUI already explain its other arrival(s) in this graph, and no other inflow explains this one: a mint, a withdrawal from a protocol it sent itself, or a transfer older than the history this server can read.`,
    ]);
  });
});

describe("FlowEngine address-start root", () => {
  const A = `0xae${"e".repeat(62)}`;
  const Bh = `0xbe${"f".repeat(62)}`;
  const Q = `0xce${"0".repeat(62)}`;

  /**
   * Each address search gets the hops it would find (see `searchPage`), with
   * the Sui Bridge event payload. A digest in `unreadable` is listed but its
   * full read returns no transaction.
   */
  function serve(hops: HopSpec[], unreadable: string[] = []) {
    const all = new Map(hops.map((h) => [h.digest, h]));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) return searchPage(hops, q, vars);
      if (q.includes("json")) {
        const h = all.get(String(vars.digest));
        return {
          transaction: {
            effects: { events: gqlPage((h?.events ?? []).map((repr) => ({ contents: { type: { repr }, json: REAL_DEPOSIT } }))) },
          },
        };
      }
      const h = all.get(String(vars.digest));
      return h && !unreadable.includes(h.digest) ? gqlTx(h) : { transaction: null };
    });
  }
  const byCode = (e: InstanceType<typeof FlowEngine>) => Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
  const nodeAt = (e: InstanceType<typeof FlowEngine>, addr: string, coin: string) =>
    [...e.nodes.values()].find((n) => n.address === addr && n.coin_type === coin);

  beforeEach(() => {
    mockPrices.set(SUI, 3);
    mockPrices.set(USDC, 1);
  });

  it("forward: keeps swap proceeds the address still holds as unspent there, beside its other outflows", async () => {
    // A swaps 1000 SUI ($3,000) for 3000 USDC and keeps it, then pays B 100 SUI ($300).
    const swap: HopSpec = { digest: "0xkeepswap", sender: A, checkpoint: CP + 40, changes: [[A, "-1000000000000", SUI], [A, "3000000000", USDC]] };
    const pay: HopSpec = { digest: "0xkeeppay", sender: A, checkpoint: CP + 41, changes: [[A, "-100000000000", SUI], [Bh, "100000000000", SUI]] };
    serve([swap, pay]);
    const e = engine();
    e.startFromAddress(A);
    await e.run();

    const held = nodeAt(e, A, USDC)!;
    expect(held.unspent).toBe(3000000000n);
    expect(held.share).toBeCloseTo(3000 / 3300);
    expect(e.ledger.codesFor(held.id)).toEqual(["unspent"]);
    expect(nodeAt(e, Bh, SUI)!.share).toBeCloseTo(300 / 3300);
    expect(e.ledger.total()).toBeCloseTo(1);
    expect(e.truncated).toBe(false);
  });

  it("backward: names coin held before the window as the source of a swap, beside a later payer", async () => {
    // A swaps 1000 SUI it held before the window for 3000 USDC, then Q pays it 1 SUI ($3).
    const swap: HopSpec = { digest: "0xoldswap", sender: A, checkpoint: CP + 40, changes: [[A, "-1000000000000", SUI], [A, "3000000000", USDC]] };
    const pay: HopSpec = { digest: "0xqpays", sender: Q, checkpoint: CP + 41, changes: [[Q, "-1000000000", SUI], [A, "1000000000", SUI]] };
    serve([swap, pay]);
    const e = new FlowEngine({ ...engine().opts, direction: "backward", minShare: 0 });
    e.startFromAddress(A);
    await e.run();

    const held = nodeAt(e, A, SUI)!;
    expect(held.share).toBeCloseTo(3000 / 3003);
    expect(e.ledger.codesFor(held.id)).toEqual(["source"]);
    expect(nodeAt(e, Q, SUI)!.share).toBeCloseTo(3 / 3003);
    expect(e.ledger.total()).toBeCloseTo(1);
  });

  it("forward: reports unspent swap proceeds as budget when the address's scan stopped at its move limit", async () => {
    // The swap and 101 later payments: the scan stops at 100 moves.
    const swap: HopSpec = { digest: "0xcapswap", sender: A, checkpoint: CP + 40, changes: [[A, "-1000000000000", SUI], [A, "3000000000", USDC]] };
    const pays = Array.from({ length: 101 }, (_, i): HopSpec => ({
      digest: `0xcappay${i}`,
      sender: A,
      checkpoint: CP + 41 + i,
      changes: [[A, "-1000000000", SUI], [Bh, "1000000000", SUI]],
    }));
    serve([swap, ...pays]);
    const e = engine();
    e.startFromAddress(A);
    await e.run();

    const held = nodeAt(e, A, USDC)!;
    expect(e.ledger.codesFor(held.id)).toEqual(["budget"]);
    expect(held.share).toBeCloseTo(3000 / (3000 + 99 * 3));
    expect(e.truncated).toBe(true);
    expect(e.ledger.total()).toBeCloseTo(1);
  });

  it("forward: passes on only what the holder spent of a coin its recipient also got from a swap", async () => {
    // One PTB swaps 1000 SUI for 3000 USDC, adds 100 USDC A held, and pays B 3100 USDC.
    const ptb: HopSpec = {
      digest: "0xtopup",
      sender: A,
      checkpoint: CP + 40,
      changes: [[A, "-1000000000000", SUI], [A, "-100000000", USDC], [Bh, "3100000000", USDC]],
    };
    serve([ptb]);
    const e = engine();
    e.startFromAddress(A);
    await e.run();

    const b = nodeAt(e, Bh, USDC)!;
    expect(b.traced).toBe(3100000000n);
    expect(b.usd).toBeCloseTo(3100);
    const edges = [...e.edges.values()].filter((x) => x.to === b.id);
    expect(edges.map((x) => [x.amount, x.traced])).toEqual([[3100000000n, 3100000000n]]);
    expect(e.ledger.total()).toBeCloseTo(1);
  });

  it("counts a bridge exit's beneficiary once when the address pays two coins into it", async () => {
    // One transaction burns 1,300.041 USDC and pays a 1 SUI fee that no address receives.
    const exit: HopSpec = {
      digest: "0xtwocoinexit",
      sender: A,
      checkpoint: CP + 40,
      changes: [[A, "-1300041000", USDC], [A, "-1000000000", SUI]],
      events: [SUI_BRIDGE_DEPOSIT],
    };
    serve([exit]);
    const e = engine();
    e.startFromAddress(A);
    await e.run();

    const node = [...e.nodes.values()].find((n) => n.kind === "bridge_exit")!;
    expect(node.beneficiaries?.map((b) => b.amount)).toEqual([REAL_DEPOSIT.amount]);
    expect(node.share).toBeCloseTo(1);
  });

  describe("a payer that swapped into the coin it paid", () => {
    const F = `0xde${"1".repeat(62)}`;
    const T = `0xdf${"2".repeat(62)}`;

    it("backward: traces the swapped part to the payer's input, beside its top-up", async () => {
      // P's PTB swaps 1000 SUI for 3000 USDC, adds 100 USDC it held, and pays A 3100 USDC.
      const pay: HopSpec = { digest: "0xpswap", sender: Q, checkpoint: CP + 40, changes: [[Q, "-1000000000000", SUI], [Q, "-100000000", USDC], [A, "3100000000", USDC]] };
      serve([pay]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward" });
      e.startFromAddress(A);
      await e.run();

      expect(nodeAt(e, Q, SUI)!.share).toBeCloseTo(3000 / 3100);
      expect(nodeAt(e, Q, USDC)!.share).toBeCloseTo(100 / 3100);
      expect([...e.nodes.values()].filter((n) => n.id.startsWith("source:"))).toEqual([]);
      expect(e.ledger.total()).toBeCloseTo(1);
    });

    it("backward: traces a swap that also paid a fee to a third party", async () => {
      const pay: HopSpec = {
        digest: "0xpswapfee",
        sender: Q,
        checkpoint: CP + 40,
        changes: [[Q, "-1000000000000", SUI], [Q, "-10000000", USDC], [A, "3000000000", USDC], [F, "10000000", USDC]],
      };
      serve([pay]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward", minShare: 0 });
      e.startFromAddress(A);
      await e.run();

      expect(nodeAt(e, Q, SUI)!.share).toBeCloseTo(2990 / 3000);
      expect(nodeAt(e, Q, USDC)!.share).toBeCloseTo(10 / 3000);
      expect([...e.nodes.values()].filter((n) => n.id.startsWith("source:"))).toEqual([]);
    });

    it("backward: traces it the same way from a node past the start", async () => {
      // A pays T what P's swap paid it; the graph starts at T.
      const pay: HopSpec = { digest: "0xpswap2", sender: Q, checkpoint: CP + 40, changes: [[Q, "-1000000000000", SUI], [Q, "-100000000", USDC], [A, "3100000000", USDC]] };
      const onward: HopSpec = { digest: "0xatot", sender: A, checkpoint: CP + 41, changes: [[A, "-3100000000", USDC], [T, "3100000000", USDC]] };
      serve([pay, onward]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward" });
      e.startFromAddress(T);
      await e.run();

      expect(nodeAt(e, Q, SUI)!.share).toBeCloseTo(3000 / 3100);
      expect([...e.nodes.values()].filter((n) => n.id.startsWith("source:"))).toEqual([]);
    });

    it("backward: ends value that came back out of the start address's own swap as a cycle, however small", async () => {
      // R pays B 900 USDC. A swaps 1000 SUI for 3000 USDC, keeps 2900 and
      // sends B 100. B pays A 1000 back, 100 of it from A's own swap.
      const R = `0xdb${"5".repeat(62)}`;
      const fund: HopSpec = { digest: "0xrfundb", sender: R, checkpoint: CP + 39, changes: [[R, "-900000000", USDC], [Bh, "900000000", USDC]] };
      const swap: HopSpec = {
        digest: "0xswapsend",
        sender: A,
        checkpoint: CP + 40,
        changes: [[A, "-1000000000000", SUI], [A, "2900000000", USDC], [Bh, "100000000", USDC]],
      };
      const back: HopSpec = { digest: "0xbback", sender: Bh, checkpoint: CP + 41, changes: [[Bh, "-1000000000", USDC], [A, "1000000000", USDC]] };
      serve([fund, swap, back]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward", minShare: 0.05 });
      e.startFromAddress(A);
      await e.run();

      const returned = e.ledger.summary().find((g) => g.code === "cycle")!.entries;
      expect(returned.map((x) => [x.node, x.share])).toEqual([[nodeAt(e, A, SUI)!.id, expect.closeTo(100 / 3900)]]);
      expect(e.pruned.filter((p) => p.address === A)).toEqual([]);
      expect(e.ledger.total()).toBeCloseTo(1);
    });
  });

  describe("a later leg the root could not read", () => {
    const C = `0xdc${"3".repeat(62)}`;

    it("forward: reports the proceeds it spent as read_failed, not as held", async () => {
      const swap: HopSpec = { digest: "0xrswap", sender: A, checkpoint: CP + 40, changes: [[A, "-1000000000000", SUI], [A, "3000000000", USDC]] };
      const lost: HopSpec = { digest: "0xrlost", sender: A, checkpoint: CP + 41, changes: [[A, "-3000000000", USDC], [Bh, "3000000000", USDC]] };
      const pay: HopSpec = { digest: "0xrpay", sender: A, checkpoint: CP + 42, changes: [[A, "-100000000000", SUI], [C, "100000000000", SUI]] };
      serve([swap, lost, pay], [lost.digest]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e)).toEqual({ read_failed: expect.closeTo(3000 / 3300), unspent: expect.closeTo(300 / 3300) });
      expect(nodeAt(e, A, USDC)).toBeUndefined();
      expect(nodeAt(e, C, SUI)!.share).toBeCloseTo(300 / 3300);
      expect(e.truncated).toBe(true);
    });

    it("backward: reports the swap's funding as read_failed, not as held before the window", async () => {
      const lost: HopSpec = { digest: "0xrfund", sender: Q, checkpoint: CP + 40, changes: [[Q, "-1000000000000", SUI], [A, "1000000000000", SUI]] };
      const swap: HopSpec = { digest: "0xrswapb", sender: A, checkpoint: CP + 41, changes: [[A, "-1000000000000", SUI], [A, "3000000000", USDC]] };
      serve([lost, swap], [lost.digest]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward" });
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e)).toEqual({ read_failed: expect.closeTo(1) });
      expect(e.truncated).toBe(true);
    });

    it("records an unreadable leg that carries no priced value and draws nothing", async () => {
      const pay: HopSpec = { digest: "0xrpay2", sender: A, checkpoint: CP + 40, changes: [[A, "-100000000000", SUI], [C, "100000000000", SUI]] };
      const lost: HopSpec = { digest: "0xrlost2", sender: A, checkpoint: CP + 41, changes: [[A, "-5000000000000", CETUS], [Bh, "5000000000000", CETUS]] };
      serve([pay, lost], [lost.digest]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(e.truncated).toBe(true);
      expect(nodeAt(e, C, SUI)!.share).toBeCloseTo(1);
    });
  });

  describe("a conversion with an unpriced side", () => {
    const C = `0xdd${"4".repeat(62)}`;

    it("forward: follows swap proceeds in an unpriced coin to where they were spent", async () => {
      const swap: HopSpec = { digest: "0xuswap", sender: A, checkpoint: CP + 40, changes: [[A, "-1000000000000", SUI], [A, "5000000000000", CETUS]] };
      const pay: HopSpec = { digest: "0xupay", sender: A, checkpoint: CP + 41, changes: [[A, "-5000000000000", CETUS], [Bh, "5000000000000", CETUS]] };
      serve([swap, pay]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(nodeAt(e, Bh, CETUS)!.share).toBeCloseTo(1);
      expect(nodeAt(e, A, CETUS)).toBeUndefined();
    });

    it("forward: weighs the unpriced proceeds' spend by the swap's value beside a priced payment", async () => {
      const swap: HopSpec = { digest: "0xuswap2", sender: A, checkpoint: CP + 40, changes: [[A, "-1000000000000", SUI], [A, "5000000000000", CETUS]] };
      const pay: HopSpec = { digest: "0xupay2", sender: A, checkpoint: CP + 41, changes: [[A, "-5000000000000", CETUS], [Bh, "5000000000000", CETUS]] };
      const sui: HopSpec = { digest: "0xupay3", sender: A, checkpoint: CP + 42, changes: [[A, "-100000000000", SUI], [C, "100000000000", SUI]] };
      serve([swap, pay, sui]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(nodeAt(e, Bh, CETUS)!.share).toBeCloseTo(3000 / 3300);
      expect(nodeAt(e, C, SUI)!.share).toBeCloseTo(300 / 3300);
    });

    it("forward: keeps priced proceeds of an unpriced coin held, beside a priced payment", async () => {
      const swap: HopSpec = { digest: "0xuswap3", sender: A, checkpoint: CP + 40, changes: [[A, "-5000000000000", CETUS], [A, "3000000000", USDC]] };
      const sui: HopSpec = { digest: "0xupay4", sender: A, checkpoint: CP + 41, changes: [[A, "-100000000000", SUI], [C, "100000000000", SUI]] };
      serve([swap, sui]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      const held = nodeAt(e, A, USDC)!;
      expect(held.unspent).toBe(3000000000n);
      expect(held.share).toBeCloseTo(3000 / 3300);
      expect(nodeAt(e, C, SUI)!.share).toBeCloseTo(300 / 3300);
    });
  });

  describe("a return to the start address the start node did not count", () => {
    const C = `0xd1${"6".repeat(62)}`;
    const P = `0xd2${"7".repeat(62)}`;
    const wide = () => new FlowEngine({ ...engine().opts, maxTxReads: 400 });

    it("forward from a coin_type start: follows value that came back in another coin", async () => {
      // A pays B 3000 USDC; B swaps it and pays A 1000 SUI; A pays C 1000 SUI.
      const pay: HopSpec = { digest: "0xct1", sender: A, checkpoint: CP + 40, changes: [[A, "-3000000000", USDC], [Bh, "3000000000", USDC]] };
      const back: HopSpec = { digest: "0xct2", sender: Bh, checkpoint: CP + 41, changes: [[Bh, "-3000000000", USDC], [A, "1000000000000", SUI]] };
      const on: HopSpec = { digest: "0xct3", sender: A, checkpoint: CP + 42, changes: [[A, "-1000000000000", SUI], [C, "1000000000000", SUI]] };
      serve([pay, back, on]);
      const e = new FlowEngine({ ...engine().opts, coin: USDC });
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).cycle).toBeUndefined();
      expect(nodeAt(e, C, SUI)!.share).toBeCloseTo(1);
    });

    it("backward from a coin_type start: finds who funded value that came back in another coin", async () => {
      // P pays A 1000 SUI; A pays B; B swaps it and pays A 3000 USDC.
      const fund: HopSpec = { digest: "0xcb1", sender: P, checkpoint: CP + 40, changes: [[P, "-1000000000000", SUI], [A, "1000000000000", SUI]] };
      const pay: HopSpec = { digest: "0xcb2", sender: A, checkpoint: CP + 41, changes: [[A, "-1000000000000", SUI], [Bh, "1000000000000", SUI]] };
      const back: HopSpec = { digest: "0xcb3", sender: Bh, checkpoint: CP + 42, changes: [[Bh, "-1000000000000", SUI], [A, "3000000000", USDC]] };
      serve([fund, pay, back]);
      const e = new FlowEngine({ ...engine().opts, coin: USDC, direction: "backward" });
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).cycle).toBeUndefined();
      expect(nodeAt(e, P, SUI)!.share).toBeCloseTo(1);
    });

    it("forward: follows a return past the start node's move limit to where it left", async () => {
      // A pays B 100 SUI and C 0.1 SUI 100 times; B pays the 100 back and A bridges it out.
      const toB: HopSpec = { digest: "0xml0", sender: A, checkpoint: CP + 40, changes: [[A, "-100000000000", SUI], [Bh, "100000000000", SUI]] };
      const small = Array.from({ length: 100 }, (_, i): HopSpec => ({
        digest: `0xmls${i}`,
        sender: A,
        checkpoint: CP + 41 + i,
        changes: [[A, "-100000000", SUI], [C, "100000000", SUI]],
      }));
      const back: HopSpec = { digest: "0xmlb", sender: Bh, checkpoint: CP + 200, changes: [[Bh, "-100000000000", SUI], [A, "100000000000", SUI]] };
      const exit: HopSpec = { digest: "0xmlx", sender: A, checkpoint: CP + 201, changes: [[A, "-100000000000", SUI]], events: [SUI_BRIDGE_DEPOSIT] };
      serve([toB, ...small, back, exit]);
      const e = wide();
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).cycle).toBeUndefined();
      expect(byCode(e).bridge_exit).toBeCloseTo(100 / 109.9);
    });

    it("backward: finds the payer of a return older than the start node's move limit", async () => {
      // P pays A 100 SUI and A pays it to B; C pays A 0.1 SUI 100 times; B pays the 100 back.
      const fund: HopSpec = { digest: "0xmbf", sender: P, checkpoint: CP + 38, changes: [[P, "-100000000000", SUI], [A, "100000000000", SUI]] };
      const toB: HopSpec = { digest: "0xmb0", sender: A, checkpoint: CP + 39, changes: [[A, "-100000000000", SUI], [Bh, "100000000000", SUI]] };
      const small = Array.from({ length: 100 }, (_, i): HopSpec => ({
        digest: `0xmbs${i}`,
        sender: C,
        checkpoint: CP + 40 + i,
        changes: [[C, "-100000000", SUI], [A, "100000000", SUI]],
      }));
      const back: HopSpec = { digest: "0xmbb", sender: Bh, checkpoint: CP + 200, changes: [[Bh, "-100000000000", SUI], [A, "100000000000", SUI]] };
      serve([fund, toB, ...small, back]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward", maxTxReads: 400 });
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).cycle).toBeUndefined();
      expect(nodeAt(e, P, SUI)!.share).toBeCloseTo(100 / 109.9);
    });
  });

  describe("a start node whose search stopped at its move limit", () => {
    const C = `0xd5${"a".repeat(62)}`;
    const P = `0xdb${"1".repeat(62)}`;
    const pays = (n: number, from: string, to: string): HopSpec[] =>
      Array.from({ length: n }, (_, i) => ({ digest: `0xlim${from.slice(2, 4)}${i}`, sender: from, checkpoint: CP + 40 + i, changes: [[from, "-1000000000", SUI], [to, "1000000000", SUI]] }));

    it("forward: marks the graph partial and says why, with no budget share", async () => {
      serve(pays(101, A, C));
      const e = new FlowEngine({ ...engine().opts, maxTxReads: 400 });
      e.startFromAddress(A);
      await e.run();

      expect(e.truncated).toBe(true);
      expect(e.partial).toHaveLength(1);
      expect(byCode(e)).toEqual({ unspent: expect.closeTo(1) });
    });

    it("backward: marks the graph partial and says why, with no budget share", async () => {
      serve(pays(101, C, A));
      const e = new FlowEngine({ ...engine().opts, direction: "backward", maxTxReads: 400 });
      e.startFromAddress(A);
      await e.run();

      expect(e.truncated).toBe(true);
      expect(e.partial).toHaveLength(1);
      expect(byCode(e)).toEqual({ source: expect.closeTo(1) });
    });

    it("leaves a start node whose last move was its hundredth complete", async () => {
      serve(pays(100, A, C));
      const e = new FlowEngine({ ...engine().opts, maxTxReads: 400 });
      e.startFromAddress(A);
      await e.run();

      expect(e.truncated).toBe(false);
      expect(e.partial).toEqual([]);
    });

    it("backward: marks the graph partial when the cap stops inside the oldest page, and finds the payer of a return", async () => {
      // 150 transactions touch A, 120 of them inflows: P funds A 100 SUI, A pays B, 118 small
      // inflows from C come in between 29 small payments A makes to C, and B pays the 100 back.
      const fund: HopSpec = { digest: "0xop0", sender: P, checkpoint: CP + 1, changes: [[P, "-100000000000", SUI], [A, "100000000000", SUI]] };
      const toB: HopSpec = { digest: "0xop1", sender: A, checkpoint: CP + 2, changes: [[A, "-100000000000", SUI], [Bh, "100000000000", SUI]] };
      const middle = Array.from({ length: 147 }, (_, i): HopSpec =>
        i % 5 === 4 && i < 145
          ? { digest: `0xopo${i}`, sender: A, checkpoint: CP + 3 + i, changes: [[A, "-10000000", SUI], [C, "10000000", SUI]] }
          : { digest: `0xopi${i}`, sender: C, checkpoint: CP + 3 + i, changes: [[C, "-100000000", SUI], [A, "100000000", SUI]] },
      );
      const back: HopSpec = { digest: "0xop2", sender: Bh, checkpoint: CP + 200, changes: [[Bh, "-100000000000", SUI], [A, "100000000000", SUI]] };
      const hops = [fund, toB, ...middle, back];
      expect(hops).toHaveLength(150);
      expect(hops.filter((h) => h.changes.some(([a, amt]) => a === A && BigInt(amt) > 0n))).toHaveLength(120);
      serve(hops);
      const e = new FlowEngine({ ...engine().opts, direction: "backward", maxTxReads: 400 });
      e.startFromAddress(A);
      await e.run();

      expect(e.truncated).toBe(true);
      expect(e.partial).toHaveLength(1);
      expect(byCode(e).cycle).toBeUndefined();
      expect(nodeAt(e, P, SUI)!.share).toBeCloseTo(100 / 109.9);
    });

    it("backward: ends a payer whose cap stopped inside its only page as budget, not source", async () => {
      // X paid A 100 SUI, and its 25 one-SUI inflows sit in one page; a node
      // reads 20. D paid A another 100, so X carries half and is not the trunk.
      const X = `0xd6${"b".repeat(62)}`;
      const ins = Array.from({ length: 25 }, (_, i): HopSpec => ({ digest: `0xxi${i}`, sender: C, checkpoint: CP + 1 + i, changes: [[C, "-1000000000", SUI], [X, "1000000000", SUI]] }));
      const pay: HopSpec = { digest: "0xxpay", sender: X, checkpoint: CP + 40, changes: [[X, "-100000000000", SUI], [A, "100000000000", SUI]] };
      const pay2: HopSpec = { digest: "0xxpay2", sender: D, checkpoint: CP + 41, changes: [[D, "-100000000000", SUI], [A, "100000000000", SUI]] };
      serve([...ins, pay, pay2]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward", maxTxReads: 400 });
      e.startFromAddress(A);
      await e.run();

      const x = nodeAt(e, X, SUI)!;
      expect(e.ledger.codesFor(x.id)).toEqual(["budget"]);
      expect(e.truncated).toBe(true);
    });

    it("forward from a coin_type start: follows a same-coin return past the move limit to where it left", async () => {
      const toB: HopSpec = { digest: "0xct0", sender: A, checkpoint: CP + 1, changes: [[A, "-100000000000", SUI], [Bh, "100000000000", SUI]] };
      const back: HopSpec = { digest: "0xctr", sender: Bh, checkpoint: CP + 300, changes: [[Bh, "-100000000000", SUI], [A, "100000000000", SUI]] };
      const exit: HopSpec = { digest: "0xctx", sender: A, checkpoint: CP + 301, changes: [[A, "-100000000000", SUI]], events: [SUI_BRIDGE_DEPOSIT] };
      serve([toB, ...pays(100, A, C).map((h) => ({ ...h, changes: [[A, "-100000000", SUI], [C, "100000000", SUI]] as HopSpec["changes"] })), back, exit]);
      const e = new FlowEngine({ ...engine().opts, coin: SUI, maxTxReads: 400 });
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).cycle).toBeUndefined();
      expect(byCode(e).bridge_exit).toBeCloseTo(100 / 109.9);
    });

    it("forward: follows a second return that reaches an expanded coin node past the move limit", async () => {
      // A pays B and D 100 SUI each; B pays it back, D passes it to E, which pays it back a level later.
      const D = `0xd7${"c".repeat(62)}`;
      const E = `0xd8${"d".repeat(62)}`;
      const toB: HopSpec = { digest: "0xtr0", sender: A, checkpoint: CP + 1, changes: [[A, "-100000000000", SUI], [Bh, "100000000000", SUI]] };
      const toD: HopSpec = { digest: "0xtr1", sender: A, checkpoint: CP + 2, changes: [[A, "-100000000000", SUI], [D, "100000000000", SUI]] };
      const small = pays(100, A, C).map((h) => ({ ...h, changes: [[A, "-100000000", SUI], [C, "100000000", SUI]] as HopSpec["changes"] }));
      const bBack: HopSpec = { digest: "0xtr2", sender: Bh, checkpoint: CP + 300, changes: [[Bh, "-100000000000", SUI], [A, "100000000000", SUI]] };
      const dToE: HopSpec = { digest: "0xtr3", sender: D, checkpoint: CP + 301, changes: [[D, "-100000000000", SUI], [E, "100000000000", SUI]] };
      const eBack: HopSpec = { digest: "0xtr4", sender: E, checkpoint: CP + 302, changes: [[E, "-100000000000", SUI], [A, "100000000000", SUI]] };
      const exit: HopSpec = { digest: "0xtr5", sender: A, checkpoint: CP + 303, changes: [[A, "-200000000000", SUI]], events: [SUI_BRIDGE_DEPOSIT] };
      serve([toB, toD, ...small, bBack, dToE, eBack, exit]);
      const e = new FlowEngine({ ...engine().opts, maxTxReads: 400 });
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).cycle).toBeUndefined();
      expect(byCode(e).bridge_exit).toBeCloseTo(200 / 209.8);
    });
  });

  describe("a leg's value beside a rate drawn from an earlier conversion", () => {
    const DEEP = "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";
    const C = `0xd9${"e".repeat(62)}`;

    it("forward: values a sale of an unpriced coin at its priced proceeds, not at an earlier buy's rate", async () => {
      // A buys 100 DEEP for 1 SUI, later sells 1,000,100 DEEP to B for 200,000 USDC, and pays C $50,000 of SUI.
      const buy: HopSpec = { digest: "0xrb1", sender: A, checkpoint: CP + 1, changes: [[A, "-1000000000", SUI], [A, "100000000", DEEP]] };
      const sell: HopSpec = { digest: "0xrb2", sender: A, checkpoint: CP + 2, changes: [[A, "-1000100000000", DEEP], [Bh, "200000000000", USDC]] };
      const pay: HopSpec = { digest: "0xrb3", sender: A, checkpoint: CP + 3, changes: [[A, "-16666666666667", SUI], [C, "16666666666667", SUI]] };
      serve([buy, sell, pay]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(nodeAt(e, Bh, USDC)!.share).toBeCloseTo(0.8);
      expect(nodeAt(e, C, SUI)!.share).toBeCloseTo(0.2);
    });

    it("forward: values removed liquidity at the coin it paid out, not at the rate the liquidity was added at", async () => {
      // A adds 1,000 SUI and an unpriced token for an unpriced LP coin, removes it paying B 30,000 SUI, and pays C 5,000 SUI.
      const add: HopSpec = { digest: "0xrl1", sender: A, checkpoint: CP + 1, changes: [[A, "-1000000000000", SUI], [A, "-5000000000000", CETUS], [A, "1000000000", DEEP]] };
      const remove: HopSpec = { digest: "0xrl2", sender: A, checkpoint: CP + 2, changes: [[A, "-1000000000", DEEP], [Bh, "30000000000000", SUI]] };
      const pay: HopSpec = { digest: "0xrl3", sender: A, checkpoint: CP + 3, changes: [[A, "-5000000000000", SUI], [C, "5000000000000", SUI]] };
      serve([add, remove, pay]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(nodeAt(e, Bh, SUI)!.share).toBeCloseTo(90000 / 105000);
      expect(nodeAt(e, C, SUI)!.share).toBeCloseTo(15000 / 105000);
    });
  });

  describe("a readable deposit that returns dust", () => {
    const C = `0xdc${"5".repeat(62)}`;

    /** The receipt a deposit hands its depositor, the claim on what it put in. */
    const receipt = (owner: string) => [{ id: `0x${"7e".repeat(32)}`, type: "0xabc::vault::Receipt", owner }];

    it("forward: reports the deposit as consumed and follows only the dust into the start address's later spend", async () => {
      // A deposits 1,000 SUI into a contract that returns 0.01 USDC and a receipt to A, then pays B 5,000 USDC.
      const deposit: HopSpec = { digest: "0xdd1", sender: A, checkpoint: CP + 1, changes: [[A, "-1000000000000", SUI], [A, "10000", USDC]], objects: receipt(A) };
      const pay: HopSpec = { digest: "0xdd2", sender: A, checkpoint: CP + 2, changes: [[A, "-5000000000", USDC], [Bh, "5000000000", USDC]] };
      serve([deposit, pay]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).consumed).toBeCloseTo(0.375, 4);
      expect(nodeAt(e, Bh, USDC)!.share).toBeCloseTo(0.625, 4);
    });

    it("forward: gives another address the dust a deposit returned to it, not the deposit", async () => {
      const deposit: HopSpec = { digest: "0xdd3", sender: A, checkpoint: CP + 1, changes: [[A, "-1000000000000", SUI], [C, "10000", USDC]], objects: receipt(A) };
      serve([deposit]);
      const e = new FlowEngine({ ...engine().opts, minShare: 0 });
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).consumed).toBeCloseTo(1, 4);
      expect(nodeAt(e, C, USDC)!.share).toBeLessThan(1e-5);
    });

    it("forward: still follows a swap whose proceeds are worth less than its input within price noise", async () => {
      // 1,000 SUI ($3,000) for 2,800 USDC.
      const swap: HopSpec = { digest: "0xdd4", sender: A, checkpoint: CP + 1, changes: [[A, "-1000000000000", SUI], [C, "2800000000", USDC]] };
      serve([swap]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).consumed).toBeUndefined();
      expect(nodeAt(e, C, USDC)!.share).toBeCloseTo(1);
    });

    it("forward: follows a sale far below the market price only for its proceeds, and leaves the rest with the pool", async () => {
      // A dumps 30,000 USDC ($30,000) through a pool swap for 100 SUI ($300), paid to C, and gets no receipt.
      const POOL = `0x${"9a".repeat(32)}`;
      const dump: HopSpec = {
        digest: "0xdd5",
        sender: A,
        checkpoint: CP + 1,
        calls: [["0xabc", "pool", "swap"]],
        changes: [[A, "-30000000000", USDC], [C, "100000000000", SUI]],
        objects: [{ id: POOL, type: "0xabc::pool::Pool<USDC, SUI>", shared: true }],
      };
      serve([dump]);
      const e = new FlowEngine({ ...engine().opts, minShare: 0 });
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).consumed).toBeUndefined();
      expect(nodeAt(e, C, SUI)!.share).toBeCloseTo(0.01, 4);
      expect(byCode(e).retained).toBeCloseTo(0.99, 4);
      const kept = [...e.nodes.values()].find((n) => n.kind === "retained")!;
      expect(kept.shared_objects?.map((o) => o.object_id)).toEqual([POOL]);
    });

    it("forward: leaves a sale far below the market price with the pool whatever its calls are named", async () => {
      const dump: HopSpec = { digest: "0xdd7", sender: A, checkpoint: CP + 1, calls: [["0xabc", "router", "route"]], changes: [[A, "-30000000000", USDC], [A, "100000000000", SUI]] };
      serve([dump]);
      const e = new FlowEngine({ ...engine().opts, minShare: 0 });
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).retained).toBeCloseTo(0.99, 4);
      // A kept the proceeds of an unnamed conversion: a swap by its values.
      expect([...e.edges.values()].find((x) => x.coin_type === SUI)?.basis).toBe("swap-follow");
    });

    it("forward: keeps a deposit into an existing position, or a table keyed by address, consumed", async () => {
      // 1,000 SUI of collateral into A's existing obligation, or into a vault's per-address table, with a
      // 100 USDC borrow: no new object reaches A, and A can still withdraw.
      const VAULT = `0x${"8b".repeat(32)}`;
      for (const objects of [
        [{ id: `0x${"7e".repeat(32)}`, type: "0xabc::lending::Obligation", owner: A, mutated: true as const }],
        [
          { id: VAULT, type: "0xabc::vault::Vault", shared: true as const },
          { id: `0x${"1e".repeat(32)}`, type: "0x0000000000000000000000000000000000000000000000000000000000000002::dynamic_field::Field<address, u64>", parent: VAULT },
        ],
      ]) {
        const deposit: HopSpec = { digest: "0xdd8", sender: A, checkpoint: CP + 1, changes: [[A, "-1000000000000", SUI], [A, "100000000", USDC]], objects };
        serve([deposit]);
        const e = new FlowEngine({ ...engine().opts, minShare: 0 });
        e.startFromAddress(A);
        await e.run();
        expect(byCode(e).retained).toBeUndefined();
        expect(byCode(e).consumed).toBeCloseTo(29 / 30, 4);
      }
    });

    it("forward: carries a cross-chain lead onto the value a counterparty kept", async () => {
      const dump: HopSpec = {
        digest: "0xdd9",
        sender: A,
        checkpoint: CP + 1,
        changes: [[A, "-30000000000", USDC], [A, "100000000000", SUI]],
        events: ["0x7a1e0000000000000000000000000000000000000000000000000000000000aa::gateway::Sent"],
      };
      serve([dump]);
      const e = new FlowEngine({ ...engine().opts, minShare: 0 });
      e.startFromAddress(A);
      await e.run();
      const kept = [...e.nodes.values()].find((n) => n.kind === "retained")!;
      expect(kept.cross_chain_leads?.map((l) => l.digest)).toEqual(["0xdd9"]);
    });

    it("forward: still reports a deposit that also swaps and returns dust as consumed", async () => {
      const both: HopSpec = { digest: "0xdd6", sender: A, checkpoint: CP + 1, calls: [["0xabc", "pool", "swap"], ["0xdef", "lending", "deposit"]], changes: [[A, "-30000000000", USDC], [C, "100000", SUI]], objects: receipt(A) };
      serve([both]);
      const e = new FlowEngine({ ...engine().opts, minShare: 0 });
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).consumed).toBeCloseTo(1, 4);
    });

    it("backward: reports a withdrawal that paid a small fee as a source, not as the fee coin", async () => {
      // A withdraws 1,000 USDC from a contract and pays a 0.01 SUI fee that no address takes.
      const withdraw: HopSpec = { digest: "0xdw1", sender: A, checkpoint: CP + 1, changes: [[A, "-10000000", SUI], [A, "1000000000", USDC]] };
      serve([withdraw]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward", minShare: 0 });
      e.startFromAddress(A);
      await e.run();

      const sources = e.ledger.summary().find((g) => g.code === "source")!.entries;
      expect(sources.find((x) => x.node.startsWith("source:"))!.share).toBeCloseTo(1, 4);
      expect(nodeAt(e, A, SUI)?.share ?? 0).toBeLessThan(1e-4);
    });

    it("backward: traces a fee a payer paid in its own withdrawal to the payer's coin only for the fee's worth", async () => {
      // C withdraws 1,000 USDC paying a 0.01 SUI fee and passes it to A in the same transaction.
      const withdraw: HopSpec = { digest: "0xdw2", sender: C, checkpoint: CP + 1, changes: [[C, "-10000000", SUI], [A, "1000000000", USDC]] };
      serve([withdraw]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward", minShare: 0 });
      e.startFromAddress(A);
      await e.run();

      expect(e.ledger.summary().find((g) => g.code === "source")!.entries.find((x) => x.node.startsWith("source:"))!.share).toBeCloseTo(1, 4);
      expect(nodeAt(e, C, SUI)?.share ?? 0).toBeLessThan(1e-4);
    });

    it("backward: still follows a swap whose inputs are worth less than its outputs within price noise", async () => {
      // A swaps 900 SUI ($2,700) for 3,000 USDC.
      const swap: HopSpec = { digest: "0xdw3", sender: A, checkpoint: CP + 1, changes: [[A, "-900000000000", SUI], [A, "3000000000", USDC]] };
      serve([swap]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward" });
      e.startFromAddress(A);
      await e.run();

      expect(nodeAt(e, A, SUI)!.share).toBeCloseTo(1);
    });
  });

  describe("an unreadable transaction split from its search row", () => {
    const P = `0xda${"f".repeat(62)}`;

    it("forward: converts only what a bridge PTB's dust is worth, and reports the rest as read_failed", async () => {
      // P pays A 5,000 USDC; A's unreadable PTB bridges 1,000 SUI out and leaves 0.01 USDC; A pays B 5,000 USDC.
      const fund: HopSpec = { digest: "0xds0", sender: P, checkpoint: CP + 1, changes: [[P, "-5000000000", USDC], [A, "5000000000", USDC]] };
      const ptb: HopSpec = { digest: "0xds1", sender: A, checkpoint: CP + 2, changes: [[A, "-1000000000000", SUI], [A, "10000", USDC]], events: [SUI_BRIDGE_DEPOSIT] };
      const pay: HopSpec = { digest: "0xds2", sender: A, checkpoint: CP + 3, changes: [[A, "-5000000000", USDC], [Bh, "5000000000", USDC]] };
      serve([fund, ptb, pay], [ptb.digest]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(byCode(e).read_failed).toBeCloseTo(0.375, 4);
      expect(nodeAt(e, Bh, USDC)!.share).toBeCloseTo(0.625, 4);
    });

    it("forward: reports a conversion a row with missing balance changes may have spent as read_failed, not held", async () => {
      // A swaps 1,000 SUI for 3,000 USDC; an unreadable PTB pays CETUS to 55 addresses and the USDC to B,
      // and its row's first page of balance changes lacks A's USDC line.
      const swap: HopSpec = { digest: "0xpr1", sender: A, checkpoint: CP + 1, changes: [[A, "-1000000000000", SUI], [A, "3000000000", USDC]] };
      const payees = Array.from({ length: 55 }, (_, i) => `0x${(0xe000 + i).toString(16)}${"0".repeat(60)}`);
      const ptb: HopSpec = {
        digest: "0xpr2",
        sender: A,
        checkpoint: CP + 2,
        changes: [[A, "-55000000000", CETUS], ...payees.map((p): [string, string, string] => [p, "1000000000", CETUS]), [A, "-3000000000", USDC], [Bh, "3000000000", USDC]],
      };
      const rows = (h: HopSpec) => h.changes.map(([address, amount, coin]) => ({ coinType: { repr: coin ?? SUI }, amount, owner: { address } }));
      mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
        const q = String(query);
        if (q.includes("transactionEffects")) throw new Error("continuation failed");
        if (q.includes("transactions(")) {
          const page = searchPage([swap, { ...ptb, changes: ptb.changes.slice(0, 50) }], q, vars);
          for (const node of page.transactions.nodes) {
            if (node.digest === ptb.digest) node.effects.balanceChanges = gqlPage(rows(ptb).slice(0, 50), { hasNextPage: true, endCursor: "bc" });
          }
          return page;
        }
        return String(vars.digest) === swap.digest ? gqlTx(swap) : { transaction: null };
      });
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      const held = nodeAt(e, A, USDC)!;
      expect(e.ledger.codesFor(held.id)).toEqual(["read_failed"]);
      expect(e.truncated).toBe(true);
    });
  });

  describe("a swap in a transaction that bridges out", () => {
    const T = `0xd3${"8".repeat(62)}`;
    const P = `0xd4${"9".repeat(62)}`;

    it("backward: explains the start address's kept proceeds by its own swap input", async () => {
      const fund: HopSpec = { digest: "0xbk1", sender: P, checkpoint: CP + 40, changes: [[P, "-1000000000000", SUI], [A, "1000000000000", SUI]] };
      const ptb: HopSpec = {
        digest: "0xbk2",
        sender: A,
        checkpoint: CP + 41,
        changes: [[A, "-1000000000000", SUI], [A, "1000000000", USDC]],
        events: [SUI_BRIDGE_DEPOSIT],
      };
      serve([fund, ptb]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward" });
      e.startFromAddress(A);
      await e.run();

      expect(nodeAt(e, P, SUI)!.share).toBeCloseTo(1);
      expect([...e.nodes.keys()].filter((id) => id.startsWith("entry:"))).toEqual([]);
    });

    it("backward: explains a payer's kept proceeds by its swap input", async () => {
      const fund: HopSpec = { digest: "0xbk3", sender: P, checkpoint: CP + 40, changes: [[P, "-1000000000000", SUI], [Bh, "1000000000000", SUI]] };
      const ptb: HopSpec = {
        digest: "0xbk4",
        sender: Bh,
        checkpoint: CP + 41,
        changes: [[Bh, "-1000000000000", SUI], [Bh, "1000000000", USDC]],
        events: [SUI_BRIDGE_DEPOSIT],
      };
      const pay: HopSpec = { digest: "0xbk5", sender: Bh, checkpoint: CP + 42, changes: [[Bh, "-1000000000", USDC], [T, "1000000000", USDC]] };
      serve([fund, ptb, pay]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward" });
      e.startFromAddress(T);
      await e.run();

      expect(nodeAt(e, P, SUI)!.share).toBeCloseTo(1);
      expect([...e.nodes.keys()].filter((id) => id.startsWith("entry:"))).toEqual([]);
    });

    it("backward: explains a fee the bridging PTB paid by the payer's swap input", async () => {
      const fund: HopSpec = { digest: "0xbk6", sender: P, checkpoint: CP + 40, changes: [[P, "-1000000000000", SUI], [Bh, "1000000000000", SUI]] };
      const ptb: HopSpec = {
        digest: "0xbk7",
        sender: Bh,
        checkpoint: CP + 41,
        changes: [[Bh, "-1000000000000", SUI], [T, "30000000", USDC]],
        events: [SUI_BRIDGE_DEPOSIT],
      };
      serve([fund, ptb]);
      const e = new FlowEngine({ ...engine().opts, direction: "backward" });
      e.startFromAddress(T);
      await e.run();

      expect(nodeAt(e, P, SUI)!.share).toBeCloseTo(1);
      expect([...e.nodes.keys()].filter((id) => id.startsWith("entry:"))).toEqual([]);
    });
  });

  describe("a conversion with no price on either side", () => {
    const DEEP = "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";
    const toCetus: HopSpec = { digest: "0xnp1", sender: A, checkpoint: CP + 40, changes: [[A, "-1000000000000", SUI], [A, "5000000000000", CETUS]] };
    const payDeep: HopSpec = { digest: "0xnp3", sender: A, checkpoint: CP + 42, changes: [[A, "-7000000000", DEEP], [Bh, "7000000000", DEEP]] };

    it("forward: values unpriced proceeds of unpriced swap proceeds at what the first swap was worth", async () => {
      // The 5000 CETUS become 7000 DEEP and 1000 USDC; the DEEP goes to B.
      const toDeep: HopSpec = {
        digest: "0xnp2",
        sender: A,
        checkpoint: CP + 41,
        changes: [[A, "-5000000000000", CETUS], [A, "7000000000", DEEP], [A, "1000000000", USDC]],
      };
      serve([toCetus, toDeep, payDeep]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(nodeAt(e, Bh, DEEP)!.share).toBeCloseTo(2 / 3);
      expect(nodeAt(e, A, USDC)!.share).toBeCloseTo(1 / 3);
      expect(nodeAt(e, A, USDC)!.unspent).toBe(1000000000n);
    });

    it("forward: follows unpriced proceeds bought with an unpriced and a priced input to where they went", async () => {
      // The 5000 CETUS and 1000 USDC become 7000 DEEP, all paid to B.
      const toDeep: HopSpec = {
        digest: "0xnp4",
        sender: A,
        checkpoint: CP + 41,
        changes: [[A, "-5000000000000", CETUS], [A, "-1000000000", USDC], [A, "7000000000", DEEP]],
      };
      serve([toCetus, toDeep, payDeep]);
      const e = engine();
      e.startFromAddress(A);
      await e.run();

      expect(nodeAt(e, Bh, DEEP)!.share).toBeCloseTo(1);
      expect(nodeAt(e, A, DEEP)).toBeUndefined();
    });
  });

  it("asks for a coin's price once for many transactions in the same hour", async () => {
    const pays = Array.from({ length: 40 }, (_, i): HopSpec => ({
      digest: `0xsamehour${i}`,
      sender: A,
      checkpoint: CP + 40 + i,
      changes: [[A, "-1000000000", SUI], [Bh, "1000000000", SUI]],
    }));
    serve(pays);
    llamaRequests.count = 0;
    const e = engine();
    e.startFromAddress(A);
    await e.run();

    expect(llamaRequests.count).toBe(1);
  });

  it("forward: follows swap proceeds an unreadable transaction swapped back to where they went", async () => {
    // A swaps 1000 SUI for 3000 USDC; an unreadable transaction swaps the USDC back to 1000 SUI; A pays B 1000 SUI.
    const swap: HopSpec = { digest: "0xur1", sender: A, checkpoint: CP + 40, changes: [[A, "-1000000000000", SUI], [A, "3000000000", USDC]] };
    const lost: HopSpec = { digest: "0xur2", sender: A, checkpoint: CP + 41, changes: [[A, "-3000000000", USDC], [A, "1000000000000", SUI]] };
    const pay: HopSpec = { digest: "0xur3", sender: A, checkpoint: CP + 42, changes: [[A, "-1000000000000", SUI], [Bh, "1000000000000", SUI]] };
    serve([swap, lost, pay], [lost.digest]);
    const e = engine();
    e.startFromAddress(A);
    await e.run();

    expect(nodeAt(e, Bh, SUI)!.share).toBeCloseTo(1);
    expect(e.truncated).toBe(true);
  });
});
describe("FlowEngine lookalike protection", () => {
  it("never prunes a branch to an address that renders like one the graph already reached", async () => {
    // Two mainnet addresses that share the first 4 and last 3 characters:
    // 0x6b74e92c… (the real recipient) and 0x6b745225… (the lookalike). A
    // large payment to the real recipient and a tiny (below min_share)
    // payment to the lookalike both come from the same address-start root.
    const REAL = "0x6b74e92cfc7890b7a4a48c933bb8da38bb2897f3962f33af20f5f7101d2d93cf";
    const LOOKALIKE = "0x6b745225460cf4aeebe5edb4e381474a58abf206aa34dd838eb6570edd67b3cf";
    const big: HopSpec = {
      digest: "0xbig",
      sender: ATTACKER,
      checkpoint: CP,
      changes: [[ATTACKER, "-1000000000000"], [REAL, "1000000000000"]],
    };
    const tiny: HopSpec = {
      digest: "0xtiny",
      sender: ATTACKER,
      checkpoint: CP + 1,
      changes: [[ATTACKER, "-1000000"], [LOOKALIKE, "1000000"]],
    };
    const all = new Map([big, tiny].map((h) => [h.digest, h]));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) return candidates([big, tiny], q.includes("last:") ? "backward" : "forward");
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });

    const e = engine();
    e.startFromAddress(ATTACKER);
    await e.run();

    expect(e.pruned.some((p) => p.address === LOOKALIKE)).toBe(false);
    expect([...e.nodes.values()].some((n) => n.address === LOOKALIKE)).toBe(true);
  });

  it("checks a 3,000-recipient batch payout for lookalikes without an all-pairs scan", async () => {
    // A batch payout (an airdrop or claim-farm start digest) names thousands
    // of distinct addresses at once. Comparing each new address against
    // every one already seen, re-normalizing both sides each time, is
    // quadratic synchronous CPU that blocks the server.
    const recipients = Array.from(
      { length: 3000 },
      (_, i) => `0x${createHash("sha256").update(`claimer-${i}`).digest("hex")}`,
    );
    // Random addresses collide at 3+3 about once per 3,000; this set does not,
    // so every branch below the floor must be pruned.
    expect(findLookalikes(recipients)).toEqual([]);
    const batch: HopSpec = {
      digest: "0xairdrop",
      sender: ATTACKER,
      checkpoint: CP,
      changes: [[ATTACKER, "-3000000000000"], ...recipients.map((r): [string, string] => [r, "1000000000"])],
    };
    // The service returns 50 balance changes inside the transaction and the
    // rest by digest and cursor.
    const rows = batch.changes.map(([address, amount]) => ({ coinType: { repr: SUI }, amount, owner: { address } }));
    const conn = pagedTxConnection(batch.digest, rows, "balanceChanges");
    const head = gqlTx({ ...batch, changes: [] });
    head.transaction.effects.balanceChanges = conn.first;
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      const page = conn.respond(q, vars);
      if (page) return page;
      if (q.includes("transactions(")) return candidates([], q.includes("last:") ? "backward" : "forward");
      return String(vars.digest) === batch.digest ? head : { transaction: null };
    });

    const e = engine();
    const started = performance.now();
    await e.startFromDigest(batch.digest);
    await e.run();
    const elapsed = performance.now() - started;

    // Each recipient's 1/3000 share is below min_share, and no pair of these
    // renders alike, so every branch is pruned.
    expect(e.pruned).toHaveLength(3000);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("FlowEngine trunk budget", () => {
  it("reads past the per-node limit at a node carrying most of the traced value", async () => {
    // B takes 90% and pays it out in 25 equal lots; the 20-move cap would
    // leave five of them, 18% of the value, unread.
    const lots = Array.from({ length: 25 }, (_, i) => `0xe${i.toString(16).padStart(63, "0")}`);
    const toB: HopSpec = { digest: "0xsplit90", sender: ATTACKER, checkpoint: CP + 1, changes: [[ATTACKER, "-1000000000000"], [B, "900000000000"], [C, "100000000000"]] };
    const payouts: HopSpec[] = lots.map((r, i) => ({ digest: `0xlot${i}`, sender: B, checkpoint: CP + 2 + i, changes: [[B, "-36000000000"], [r, "36000000000"]] }));
    const all = new Map([exploit, toB, ...payouts].map((h) => [h.digest, h]));
    const sent: Record<string, HopSpec[]> = { [ATTACKER]: [exploit, toB], [B]: payouts };
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) {
        return candidates(q.includes("sentAddress") ? (sent[String(vars.address)] ?? []) : [], q.includes("last:") ? "backward" : "forward");
      }
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });
    const e = engine();
    await e.startFromDigest("0xexploit");
    await e.run();
    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.budget).toBeUndefined();
    expect([...e.edges.values()].filter((x) => e.nodes.get(x.from)?.address === B)).toHaveLength(25);
  });
});

describe("FlowEngine expansion order", () => {
  it("merges five branches at their common wallet before expanding it", async () => {
    // S pays W1..W5 30/25/20/15/10 SUI, each passes it all to M, and M pays X.
    const S = `0xe3${"5".repeat(62)}`;
    const M = `0xe4${"6".repeat(62)}`;
    const X = `0xe5${"7".repeat(62)}`;
    const ws = Array.from({ length: 5 }, (_, i) => `0xe6${i.toString(16)}${"8".repeat(61)}`);
    const parts = [30, 25, 20, 15, 10].map((p) => `${p}000000000`);
    const fan: HopSpec = { digest: "0xs5", sender: S, checkpoint: CP, changes: [[S, "-100000000000"], ...ws.map((w, i): [string, string] => [w, parts[i]])] };
    const toM = ws.map((w, i): HopSpec => ({ digest: `0xw${i}m`, sender: w, checkpoint: CP + 1 + i, changes: [[w, `-${parts[i]}`], [M, parts[i]]] }));
    const out: HopSpec = { digest: "0xmx", sender: M, checkpoint: CP + 10, changes: [[M, "-100000000000"], [X, "100000000000"]] };
    const sent: Record<string, HopSpec[]> = { [S]: [fan], [M]: [out], ...Object.fromEntries(ws.map((w, i) => [w, [toM[i]]])) };
    const all = new Map([fan, out, ...toM].map((h) => [h.digest, h]));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) return candidates(q.includes("sentAddress") ? (sent[String(vars.address)] ?? []) : [], q.includes("last:") ? "backward" : "forward");
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });
    const e = new FlowEngine({ ...engine().opts, coin: SUI });
    e.startFromAddress(S);
    await e.run();
    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode).toEqual({ unspent: expect.closeTo(1) });
    expect(e.truncated).toBe(false);
  });

  it("spends the node limit on the heaviest branch, not on a shallower level's light ones", async () => {
    // ATTACKER pays H 900 and five wallets 20 each; each light wallet pays on,
    // and H passes its 900 to H2, which bridges it out. Three nodes are
    // enough to reach the exit only when the heaviest branch goes first.
    const H = `0xe1${"1".repeat(62)}`;
    const H2 = `0xe2${"2".repeat(62)}`;
    const lights = Array.from({ length: 5 }, (_, i) => `0xf${i}${"3".repeat(62)}`);
    const fan: HopSpec = { digest: "0xfan", sender: ATTACKER, checkpoint: CP + 1, changes: [[ATTACKER, "-1000"], [H, "900"], ...lights.map((l): [string, string] => [l, "20"])] };
    const toH2: HopSpec = { digest: "0xtoh2", sender: H, checkpoint: CP + 2, changes: [[H, "-900"], [H2, "900"]] };
    const exitH2: HopSpec = { digest: "0xexith2", sender: H2, checkpoint: CP + 3, changes: [[H2, "-900"]], events: [SUI_BRIDGE_DEPOSIT] };
    const onward = lights.map((l, i): HopSpec => ({ digest: `0xlight${i}`, sender: l, checkpoint: CP + 4 + i, changes: [[l, "-20"], [`0xd${i}${"4".repeat(62)}`, "20"]] }));
    const all = new Map([exploit, fan, toH2, exitH2, ...onward].map((h) => [h.digest, h]));
    const sent: Record<string, HopSpec[]> = { [ATTACKER]: [exploit, fan], [H]: [toH2], [H2]: [exitH2], ...Object.fromEntries(lights.map((l, i) => [l, [onward[i]]])) };
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) {
        return candidates(q.includes("sentAddress") ? (sent[String(vars.address)] ?? []) : [], q.includes("last:") ? "backward" : "forward");
      }
      if (q.includes("json")) {
        const h = all.get(String(vars.digest));
        return { transaction: { effects: { events: gqlPage((h?.events ?? []).map((repr) => ({ contents: { type: { repr }, json: REAL_DEPOSIT } }))) } } };
      }
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });
    const e = new FlowEngine({ ...engine().opts, maxNodes: 3 });
    e.startFromAddress(ATTACKER);
    await e.run();
    const byCode = Object.fromEntries(e.ledger.summary().map((g) => [g.code, g.share]));
    expect(byCode.bridge_exit).toBeCloseTo(0.9);
    expect(byCode.budget).toBeCloseTo(0.1);
  });
});
