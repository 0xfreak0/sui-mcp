import { describe, it, expect, vi, beforeEach } from "vitest";
import { candidates, gqlTx, type HopSpec } from "./helpers/trace-shapes.js";
import { gqlPage } from "./helpers/service-shapes.js";

/**
 * find_flow_path at its default limits, on a laundering shape where a trunk
 * wallet pays many light wallets one level before the heavy lots that reach
 * a bridge. The node limit must go to the heavy lots.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/archive-fallback.js", () => ({ withArchiveFallback: async () => null }));
vi.mock("../src/utils/identity.js", () => ({ describeAddresses: async () => new Map(), identityNote: () => null }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false, labelProvenance: () => null }));
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
vi.mock("../src/utils/fanout.js", () => ({
  measureFanout: async () => ({ classification: "narrow", counterparty_count: 2, scanned_transactions: 5, truncated: false }),
}));
vi.mock("../src/utils/store.js", () => ({ getCachedTransaction: () => null, saveTransaction: () => {}, saveResult: () => null }));

const { registerFlowGraphTools } = await import("../src/tools/flow-graph.js");

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
let findFlowPath!: Handler;
registerFlowGraphTools({
  tool: (name: string, _d: string, _s: unknown, handler: Handler) => {
    if (name === "find_flow_path") findFlowPath = handler;
  },
} as never);

const addr = (prefix: string, i: number) => `0x${prefix}${i.toString(16).padStart(64 - prefix.length, "0")}`;
const START = addr("a", 1);
const TRUNK = addr("b", 1);
const TRUNK2 = addr("b", 2);
const LIGHTS = Array.from({ length: 25 }, (_, i) => addr("c", i));
const LOTS = Array.from({ length: 12 }, (_, i) => addr("d", i));
/** The Ethereum address the Sui Bridge deposit below pays. */
const ETH_DEST = "0xd6f05b19bf2c05c264a646b7757057d774661c5c";
const SUI_BRIDGE_DEPOSIT = "0x000000000000000000000000000000000000000000000000000000000000000b::bridge::TokenDepositedEvent";
const DEPOSIT = { seq_num: "1", source_chain: 0, sender_address: "xKRFS6UEKXM8q3C7Q0rJnXTSCnU0w9/Tux+m6Ts8SzI=", target_chain: 10, target_address: "1vBbGb8sBcJkpka3dXBX13RmHFw=", token_type: 4, amount: "75000000000" };

const CP = 1000;
const toTrunk: HopSpec = { digest: "0xtrunk", sender: START, checkpoint: CP, changes: [[START, "-1000000000000"], [TRUNK, "1000000000000"]] };
/** The trunk pays 25 light wallets 4 SUI each and passes 900 SUI on. */
const trunkPays: HopSpec = {
  digest: "0xtrunkpays",
  sender: TRUNK,
  checkpoint: CP + 1,
  changes: [[TRUNK, "-1000000000000"], [TRUNK2, "900000000000"], ...LIGHTS.map((l): [string, string] => [l, "4000000000"])],
};
/** The second trunk pays 12 lots of 75 SUI. */
const lots: HopSpec = {
  digest: "0xlots",
  sender: TRUNK2,
  checkpoint: CP + 2,
  changes: [[TRUNK2, "-900000000000"], ...LOTS.map((l): [string, string] => [l, "75000000000"])],
};
/** Each light wallet pays on; each lot bridges out, the last to the destination searched for. */
const lightOnward = LIGHTS.map((l, i): HopSpec => ({ digest: `0xlight${i}`, sender: l, checkpoint: CP + 10 + i, changes: [[l, "-4000000000"], [addr("e", i), "4000000000"]] }));
const lotExits = LOTS.map((l, i): HopSpec => ({ digest: `0xexit${i}`, sender: l, checkpoint: CP + 50 + i, changes: [[l, "-75000000000"]], events: i === 11 ? [SUI_BRIDGE_DEPOSIT] : [] }));

beforeEach(() => {
  const hops = [toTrunk, trunkPays, lots, ...lightOnward, ...lotExits];
  const all = new Map(hops.map((h) => [h.digest, h]));
  const sent = new Map<string, HopSpec[]>();
  for (const h of hops) sent.set(h.sender, [...(sent.get(h.sender) ?? []), h]);
  mockGqlQuery.mockReset();
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
    const q = String(query);
    if (q.includes("transactions(")) {
      return candidates(q.includes("sentAddress") ? (sent.get(String(vars.address)) ?? []) : [], q.includes("last:") ? "backward" : "forward");
    }
    if (q.includes("json")) {
      const h = all.get(String(vars.digest));
      return { transaction: { effects: { events: gqlPage((h?.events ?? []).map((repr) => ({ contents: { type: { repr }, json: DEPOSIT } }))) } } };
    }
    const h = all.get(String(vars.digest));
    return h ? gqlTx(h) : { transaction: null };
  });
});

describe("find_flow_path node budget", () => {
  it("reaches the bridge exit past a level of light branches at the default limits", async () => {
    const res = await findFlowPath({ from: START, to: ETH_DEST });
    const json = JSON.parse(res.content.map((c) => c.text).find((t) => t.trim().startsWith("{"))!);
    expect(json.found).toBe(true);
    expect(json.paths[0].steps.at(-1).digests).toContain("0xexit11");
  });
});

describe("find_flow_path route", () => {
  it("returns the shortest explored route when the heavier branch reached the exit's wallet by a longer one", async () => {
    // A pays B 90 and C 10; B passes the 90 through D to E, C pays E its 10,
    // and E bridges it all out. Only A > C > E > exit fits three transfers.
    const [A, B, C, D, E] = ["1", "2", "3", "4", "5"].map((c) => addr("f", Number(c)));
    const hops: HopSpec[] = [
      { digest: "0xab", sender: A, checkpoint: CP, changes: [[A, "-100000000000"], [B, "90000000000"], [C, "10000000000"]] },
      { digest: "0xbd", sender: B, checkpoint: CP + 1, changes: [[B, "-90000000000"], [D, "90000000000"]] },
      { digest: "0xce", sender: C, checkpoint: CP + 2, changes: [[C, "-10000000000"], [E, "10000000000"]] },
      { digest: "0xde", sender: D, checkpoint: CP + 3, changes: [[D, "-90000000000"], [E, "90000000000"]] },
      { digest: "0xex", sender: E, checkpoint: CP + 4, changes: [[E, "-100000000000"]], events: [SUI_BRIDGE_DEPOSIT] },
    ];
    const all = new Map(hops.map((h) => [h.digest, h]));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) {
        return candidates(q.includes("sentAddress") ? hops.filter((h) => h.sender === vars.address) : [], q.includes("last:") ? "backward" : "forward");
      }
      if (q.includes("json")) {
        const h = all.get(String(vars.digest));
        return { transaction: { effects: { events: gqlPage((h?.events ?? []).map((repr) => ({ contents: { type: { repr }, json: DEPOSIT } }))) } } };
      }
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });
    const res = await findFlowPath({ from: A, to: ETH_DEST, max_hops: 3 });
    const json = JSON.parse(res.content.map((c) => c.text).find((t) => t.trim().startsWith("{"))!);
    expect(json.found).toBe(true);
    expect(json.paths[0].steps.map((s: { digests: string[] }) => s.digests[0])).toEqual(["0xab", "0xce", "0xex"]);
  });
});

describe("find_flow_path node_limited", () => {
  it("reports each side's unexpanded share of its own value, once per node", async () => {
    // A pays B1 60 and B2 40; P1 pays T 70 and P2 pays T 30. One node per side.
    const [A, B1, B2, P1, P2, T] = ["1", "2", "3", "4", "5", "6"].map((c) => addr("7", Number(c)));
    const hops: HopSpec[] = [
      { digest: "0xa", sender: A, checkpoint: CP, changes: [[A, "-100000000000"], [B1, "60000000000"], [B2, "40000000000"]] },
      { digest: "0xp1", sender: P1, checkpoint: CP + 1, changes: [[P1, "-70000000000"], [T, "70000000000"]] },
      { digest: "0xp2", sender: P2, checkpoint: CP + 2, changes: [[P2, "-30000000000"], [T, "30000000000"]] },
    ];
    const all = new Map(hops.map((h) => [h.digest, h]));
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) {
        const list = q.includes("sentAddress")
          ? hops.filter((h) => h.sender === vars.address)
          : hops.filter((h) => h.changes.some(([a]) => a === vars.address));
        return candidates(list, q.includes("last:") ? "backward" : "forward");
      }
      const h = all.get(String(vars.digest));
      return h ? gqlTx(h) : { transaction: null };
    });
    const res = await findFlowPath({ from: A, to: T, max_nodes: 1 });
    const json = JSON.parse(res.content.map((c) => c.text).find((t) => t.trim().startsWith("{"))!);
    expect(json.found).toBe(false);
    const limited = json.explored.node_limited;
    expect(limited.forward).toMatchObject({ nodes_unexpanded: 2, share: 1 });
    expect(limited.backward).toMatchObject({ nodes_unexpanded: 2, share: 1 });
  });
});
