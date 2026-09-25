import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { candidates, gqlTx, SUI, USDC, CETUS, type HopSpec } from "./helpers/trace-shapes.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
// Without these the tool reaches the network for prices and SuiNS names, which
// makes the test depend on two live services and time out when either is slow.
// Only the GraphQL query shape is under test here.
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
}));
vi.mock("../src/utils/names.js", () => ({
  batchResolveNames: async () => new Map(),
}));
const mockFanout = vi.fn();
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: mockFanout }));

const { registerTraceTools } = await import("../src/tools/trace.js");

/**
 * findNextForward / findPriorInflow are not exported, so this drives them
 * through the registered tool and asserts on the GraphQL query they issue and
 * the hop they pick. The query *is* the contract — which filter and which
 * checkpoint bound — and three bugs lived in exactly that contract while the
 * pure hop-selection function was fully tested.
 */
const tools = new Map<string, Function>();
registerTraceTools({
  tool: (name: string, _d: string, _s: unknown, handler: Function) => tools.set(name, handler),
} as never);
const traceFunds = tools.get("trace_funds")!;

const CP = 500;
const START = "0xstart";
const ACTOR = `0xac${"1".repeat(62)}`;
const RECIPIENT = `0xbe${"2".repeat(62)}`;
const OTHER = `0xcc${"3".repeat(62)}`;

/** A hop whose sender pays RECIPIENT, so the trace wants to follow them. */
const hop1: HopSpec = {
  digest: START,
  sender: ACTOR,
  checkpoint: CP,
  changes: [
    [ACTOR, "-1000000000"],
    [RECIPIENT, "1000000000"],
  ],
};

/** RECIPIENT passing the SUI on. */
const spend: HopSpec = {
  digest: "0xnext",
  sender: RECIPIENT,
  checkpoint: CP,
  netGas: 2_000_000,
  changes: [
    [RECIPIENT, "-1002000000"],
    [OTHER, "1000000000"],
  ],
};

const byDigest = (hops: HopSpec[]) => new Map(hops.map((h) => [h.digest, h]));

/** Route single-transaction reads by digest and candidate pages by the query. */
function route(hops: HopSpec[], pages: (query: string, vars: Record<string, unknown>) => HopSpec[]) {
  const all = byDigest(hops);
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
    const q = String(query);
    if (q.includes("transactions(")) {
      return candidates(pages(q, vars), q.includes("last:") ? "backward" : "forward");
    }
    const h = all.get(String(vars.digest));
    return h ? gqlTx(h) : { transaction: null };
  });
}

/** Calls captured against the candidate query, i.e. the hop searches. */
function nextTxCalls() {
  return mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("transactions("));
}

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockFanout.mockReset();
  mockFanout.mockResolvedValue({ classification: "narrow", counterparty_count: 3, scanned_transactions: 10, truncated: false });
  route([hop1, spend], () => []);
});

async function run(args: Record<string, unknown>) {
  const res = await traceFunds(args);
  return JSON.parse(res.content[1].text);
}

describe("findNextForward", () => {
  it("filters on sentAddress, not affectedAddress", async () => {
    // "The next transaction AFFECTING R" includes anyone paying R. Following
    // that attributed a third party's transaction to the subject.
    await run({ digest: START, direction: "forward", hops: 2 });

    const [query, vars] = nextTxCalls()[0];
    expect(query).toContain("sentAddress");
    expect(query).not.toContain("affectedAddress");
    expect(vars.address).toBe(RECIPIENT);
  });

  it("asks from cp-1 so a same-checkpoint spend is not skipped", async () => {
    // afterCheckpoint is exclusive — verified against mainnet. Same-checkpoint
    // forwarding is what a script does: the adversarial case.
    await run({ digest: START, direction: "forward", hops: 2 });
    expect(nextTxCalls()[0][1].afterCheckpoint).toBe(CP - 1);
  });

  it("does not return the hop it is standing on", async () => {
    route([hop1, spend], (q) => (q.includes("sentAddress") ? [hop1, spend] : []));
    const data = await run({ digest: START, direction: "forward", hops: 2 });
    expect(data.hops.map((h: { digest: string }) => h.digest)).toEqual([START, "0xnext"]);
  });

  it("follows the next transaction that moves the tracked coin, not the next one sent", async () => {
    // A Binance hot wallet's next transaction moved 2.7M CETUS, and the trace
    // reported it as the continuation of the SUI it had received.
    const unrelated: HopSpec = {
      digest: "0xcetus",
      sender: RECIPIENT,
      checkpoint: CP + 1,
      netGas: 2_000_000,
      changes: [
        [RECIPIENT, "-2000000", SUI],
        [RECIPIENT, "-5000000000", CETUS],
        [OTHER, "5000000000", CETUS],
      ],
    };
    route([hop1, unrelated, spend], (q) => (q.includes("sentAddress") ? [unrelated, spend] : []));
    const data = await run({ digest: START, direction: "forward", hops: 2 });
    expect(data.hops[1].digest).toBe("0xnext");
  });

  it("says why it stopped when the recipient has not spent the coin", async () => {
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.stop_reason).toMatch(/has not sent a transaction since receiving the funds/);
    expect(data.hop_count).toBe(1);
  });

  it("follows value out of an object that cannot send", async () => {
    // A zkSend link's bag (2N1WX… → Dxhhx2…): the claim is sent by the link
    // key, and the coin leaves the object id the funds were sent to.
    const claim: HopSpec = {
      digest: "0xclaim",
      sender: OTHER,
      checkpoint: CP + 3,
      changes: [
        [RECIPIENT, "-1000000000"],
        [ACTOR.replace("ac", "dd"), "1000000000"],
      ],
    };
    route([hop1, claim], (q) => (q.includes("affectedAddress") ? [hop1, claim] : []));
    const data = await run({ digest: START, direction: "forward", hops: 2 });
    expect(data.hops[1].digest).toBe("0xclaim");
    expect(data.hops[1].reached_via).toBe("released-from-object");
    expect(data.custody_break).toBeUndefined();
  });

  it("stops at a hub instead of following its next withdrawal", async () => {
    mockFanout.mockResolvedValue({ classification: "distributor", counterparty_count: 185, scanned_transactions: 200, truncated: true });
    route([hop1, spend], (q) => (q.includes("sentAddress") ? [spend] : []));
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.hop_count).toBe(1);
    expect(data.stop_reason).toMatch(/is a distributor/);
  });
});

describe("findPriorInflow", () => {
  const FUNDER = `0xfd${"4".repeat(62)}`;
  const STRANGER = `0xee${"5".repeat(62)}`;
  // ACTOR's history before START, ascending as GraphQL returns a `last` page:
  // an old outflow of its own, then the inflow that funded it.
  const ownOutflow: HopSpec = {
    digest: "0xold-outflow",
    sender: ACTOR,
    checkpoint: CP - 9,
    changes: [
      [ACTOR, "-3000000000"],
      [STRANGER, "3000000000"],
    ],
  };
  const funding: HopSpec = {
    digest: "0xfunding",
    sender: FUNDER,
    checkpoint: CP - 2,
    changes: [
      [FUNDER, "-1500000000"],
      [ACTOR, "1500000000"],
    ],
  };

  it("keeps affectedAddress, because a funder is by definition someone else", async () => {
    route([hop1, ownOutflow, funding], () => [ownOutflow, funding, hop1]);
    await run({ digest: START, direction: "backward", hops: 2 });
    const [query] = nextTxCalls()[0];
    expect(query).toContain("affectedAddress");
    expect(query).not.toContain("sentAddress");
  });

  it("takes the most recent inflow, not the oldest transaction in the window", async () => {
    // The old code took the first element of an ascending `last: 5` page: the
    // address's own outflow, whose sender is the address itself, which then
    // reported a false cycle. FjkAur… on mainnet.
    route([hop1, ownOutflow, funding], () => [ownOutflow, funding, hop1]);
    const data = await run({ digest: START, direction: "backward", hops: 3 });
    expect(data.hops[1].digest).toBe("0xfunding");
    expect(data.stop_reason).not.toMatch(/Cycle/);
  });

  it("stops at a hub, whose earlier inflows are strangers' deposits", async () => {
    mockFanout.mockResolvedValue({ classification: "distributor", counterparty_count: 114, scanned_transactions: 200, truncated: true });
    route([hop1, ownOutflow, funding], () => [ownOutflow, funding, hop1]);
    const data = await run({ digest: START, direction: "backward", hops: 3 });
    expect(data.hop_count).toBe(1);
    expect(data.stop_reason).toMatch(/earlier inflows are other parties' money/);
  });
});

describe("trace_funds — how a hop ends", () => {
  const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/signatures.json", import.meta.url), "utf8"));

  it("follows an exploit's caller past a hop that credited only itself", async () => {
    const exploit: HopSpec = {
      digest: START,
      sender: ACTOR,
      checkpoint: CP,
      calls: [["0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb", "pool", "flash_swap"]],
      changes: [[ACTOR, "5000000000000", USDC]],
    };
    const swapOut: HopSpec = {
      digest: "0xspend",
      sender: ACTOR,
      checkpoint: CP + 5,
      changes: [
        [ACTOR, "-5000000000000", USDC],
        [RECIPIENT, "5000000000000", USDC],
      ],
    };
    route([exploit, swapOut], (q) => (q.includes("sentAddress") ? [swapOut] : []));
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.hops[0].basis).toBe("self-credit");
    expect(data.hops[1].digest).toBe("0xspend");
  });

  it("stops, and says so, at a transaction its sender did not sign", async () => {
    // B2eGLFo… moved 24M SUI out of a Cetus attacker address under a 31-of-64
    // multisig's signature; the trace attributed the recovery to the attacker.
    const signer = FIXTURES.ms_2of3;
    const recovery: HopSpec = { ...hop1, signatures: signer.signatures };
    route([recovery], () => []);
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.hops[0].signer_is_sender).toBe(false);
    expect(data.hops[0].authorized_by).toEqual([signer.address]);
    expect(data.stop_reason).toMatch(/signed by/);
  });

  it("names the protocol a deposit went into", async () => {
    const deposit: HopSpec = {
      digest: START,
      sender: ACTOR,
      checkpoint: CP,
      netGas: 19_338_032,
      calls: [
        ["0x99de5c967d8206ef4b75c0afab3df2a59eb02b05c282821db803831008ac25b4", "vaa", "parse_and_verify"],
        ["0x512f2826", "incentive_v3", "entry_deposit"],
      ],
      changes: [[ACTOR, "-400019338032"]],
    };
    route([deposit], () => []);
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.bridge_exits).toBeUndefined();
    expect(data.stop_reason).toMatch(/incentive_v3::entry_deposit/);
    expect(data.stop_reason).toMatch(/holds the claim/);
  });

  it("stops at a bridge exit reached through a wrapper, from its events", async () => {
    const exit: HopSpec = {
      ...hop1,
      calls: [["0xb5bd3599", "bridge_with_fee", "prepare_bridge_with_fee"]],
      events: ["0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e::deposit_for_burn::DepositForBurn"],
    };
    route([exit], () => []);
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.bridge_exits[0].protocols[0].protocol).toBe("Circle CCTP");
  });

  it("matches coin_type in its short form", async () => {
    const data = await run({ digest: START, direction: "forward", hops: 1, coin_type: "0x2::sui::SUI" });
    expect(data.hops[0].balance_changes).toHaveLength(2);
    expect(data.coin_type).toBe(SUI);
  });

  it("shows a sub-dollar USDC flow as a flow, not as gas", async () => {
    const small: HopSpec = {
      ...hop1,
      changes: [
        [ACTOR, "-500000", USDC],
        [RECIPIENT, "500000", USDC],
      ],
    };
    route([small], () => []);
    const res = await traceFunds({ digest: START, direction: "forward", hops: 1 });
    expect(res.content[0].text).toMatch(/\+0\.5 USDC/);
  });
});
