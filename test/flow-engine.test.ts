import { describe, it, expect, vi, beforeEach } from "vitest";
import { candidates, gqlTx, SUI, type HopSpec } from "./helpers/trace-shapes.js";
import { gqlPage } from "./helpers/service-shapes.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
const mockFanout = vi.fn();
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: mockFanout }));

// Imported after the mocks are registered, as the trace tests do.
const { FlowEngine } = await import("../src/utils/flow-engine.js");

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
  mockFanout.mockReset();
  mockFanout.mockResolvedValue({ classification: "narrow", counterparty_count: 3, scanned_transactions: 10, truncated: false });
  route({ [ATTACKER]: [exploit, split], [B]: [bridge], [C]: [mixed] });
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
});
