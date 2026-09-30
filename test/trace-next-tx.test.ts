import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { candidates, gqlTx, SUI, USDC, CETUS, type HopSpec } from "./helpers/trace-shapes.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
// A coin with no metadata, as the service answers for an unknown type.
vi.mock("../src/clients/grpc.js", () => ({
  sui: { stateService: { getCoinInfo: async () => Promise.reject(new Error("NOT_FOUND")) } },
  archive: {},
}));
// Without these the tool reaches the network for prices and SuiNS names, which
// makes the test depend on two live services and time out when either is slow.
// Only the GraphQL query shape is under test here.
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
vi.mock("../src/utils/recent-prices.js", () => ({ fetchRecentHistory: async () => ({ quotes: new Map(), unanswered: new Map() }) }));
vi.mock("../src/utils/names.js", () => ({
  batchResolveNames: async () => new Map(),
}));
const mockFanout = vi.fn();
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: mockFanout }));

const { registerTraceTools } = await import("../src/tools/trace.js");
const { addSessionLabel, removeSessionLabel } = await import("../src/utils/labels.js");

/**
 * findNextForward / findPriorInflow are not exported, so this drives them
 * through the registered tool and asserts on the GraphQL query they issue and
 * the hop they pick. The query *is* the contract (which filter and which
 * checkpoint bound), and the pure hop-selection tests do not cover it.
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
    // "The next transaction affecting R" includes anyone paying R. Following
    // that would attribute a third party's transaction to the subject.
    await run({ digest: START, direction: "forward", hops: 2 });

    const [query, vars] = nextTxCalls()[0];
    expect(query).toContain("sentAddress");
    expect(query).not.toContain("affectedAddress");
    expect(vars.address).toBe(RECIPIENT);
  });

  it("asks from cp-1 so a same-checkpoint spend is not skipped", async () => {
    // afterCheckpoint is exclusive. Same-checkpoint forwarding is what a
    // script does, and it is the adversarial case.
    await run({ digest: START, direction: "forward", hops: 2 });
    expect(nextTxCalls()[0][1].afterCheckpoint).toBe(CP - 1);
  });

  it("does not return the hop it is standing on", async () => {
    route([hop1, spend], (q) => (q.includes("sentAddress") ? [hop1, spend] : []));
    const data = await run({ digest: START, direction: "forward", hops: 2 });
    expect(data.hops.map((h: { digest: string }) => h.digest)).toEqual([START, "0xnext"]);
  });

  it("follows the next transaction that moves the tracked coin, not the next one sent", async () => {
    // The recipient's next transaction moves CETUS rather than the SUI it
    // received, so it does not continue the trace.
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
    mockFanout.mockResolvedValue({ classification: "distributor", sender_classification: "distributor", sender_count: 120, counterparty_count: 185, scanned_transactions: 200, truncated: true });
    route([hop1, spend], (q) => (q.includes("sentAddress") ? [spend] : []));
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.hop_count).toBe(1);
    expect(data.stop_reason).toMatch(/is a distributor/);
  });

  it("stops before a withdrawal when the recipient's hub check is unread", async () => {
    mockFanout.mockRejectedValue(new Error("Incomplete balance changes for synthetic-fanout"));
    route([hop1, spend], (q) => (q.includes("sentAddress") ? [spend] : []));
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.hops.map((h: { digest: string }) => h.digest)).toEqual([START]);
    expect(data.stop_reason).toContain("synthetic-fanout");
    expect(data.stop_reason).toMatch(/unread|incomplete/i);
  });

  it("follows an address paid by few senders that pays many: it passes on what it received", async () => {
    // A theft wallet or an operator's disperser: three payers, 211 payees.
    // Everything it pays out came from those three.
    mockFanout.mockResolvedValue({ classification: "distributor", sender_classification: "narrow", sender_count: 3, counterparty_count: 214, scanned_transactions: 200, truncated: true });
    route([hop1, spend], (q) => (q.includes("sentAddress") ? [spend] : []));
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.hops.map((h: { digest: string }) => h.digest)).toEqual([START, "0xnext"]);
  });

  it("follows a wallet labelled malicious however many parties pay into it", async () => {
    mockFanout.mockResolvedValue({ classification: "hub", sender_classification: "hub", sender_count: 1500, counterparty_count: 3000, scanned_transactions: 200, truncated: true });
    addSessionLabel(RECIPIENT, { label: "Drainer collector", category: "malicious" }, false);
    try {
      route([hop1, spend], (q) => (q.includes("sentAddress") ? [spend] : []));
      const data = await run({ digest: START, direction: "forward", hops: 3 });
      expect(data.hops.map((h: { digest: string }) => h.digest)).toEqual([START, "0xnext"]);
    } finally {
      removeSessionLabel(RECIPIENT);
    }
  });

  it("follows the largest of the spends that cover what arrived, listing the rest", async () => {
    // A 10 SUI top-up goes out first; the 990 SUI payment is where the funds went.
    const OTHER2 = `0xdd${"6".repeat(62)}`;
    const topUp: HopSpec = { digest: "0xtopup", sender: RECIPIENT, checkpoint: CP + 1, changes: [[RECIPIENT, "-10000000000"], [OTHER, "10000000000"]] };
    const bulk: HopSpec = { digest: "0xbulk", sender: RECIPIENT, checkpoint: CP + 2, changes: [[RECIPIENT, "-990000000000"], [OTHER2, "990000000000"]] };
    const funded: HopSpec = { ...hop1, changes: [[ACTOR, "-1000000000000"], [RECIPIENT, "1000000000000"]] };
    route([funded, topUp, bulk], (q, vars) => (q.includes("sentAddress") && vars.address === RECIPIENT ? [topUp, bulk] : []));
    const data = await run({ digest: START, direction: "forward", hops: 2 });
    expect(data.hops[1].digest).toBe("0xbulk");
    expect(data.hops[1].unfollowed_spends).toEqual([{ digest: "0xtopup", amount: "10000000000", coin_type: SUI }]);
  });

  it("follows the sweep that covered what arrived, not a later larger spend of other funds", async () => {
    // RELAY gets 100 SUI and sweeps it on, paying 0.002 SUI gas, so the sweep
    // moves 99.998. A later 5,000 SUI it forwards came from someone else.
    const NEXT = `0xdd${"7".repeat(62)}`;
    const LATER = `0xdd${"8".repeat(62)}`;
    const funded: HopSpec = { ...hop1, changes: [[ACTOR, "-100000000000"], [RECIPIENT, "100000000000"]] };
    const sweep: HopSpec = { digest: "0xsweep", sender: RECIPIENT, checkpoint: CP + 1, netGas: 2_000_000, changes: [[RECIPIENT, "-100000000000"], [NEXT, "99998000000"]] };
    const reuse: HopSpec = { digest: "0xreuse", sender: RECIPIENT, checkpoint: CP + 400, changes: [[RECIPIENT, "-5000000000000"], [LATER, "5000000000000"]] };
    route([funded, sweep, reuse], (q, vars) => (q.includes("sentAddress") && vars.address === RECIPIENT ? [sweep, reuse] : []));
    const data = await run({ digest: START, direction: "forward", hops: 2 });
    expect(data.hops[1].digest).toBe("0xsweep");
    expect(data.hops[1].unfollowed_spends).toBeUndefined();
  });

  it("does not follow a deposit that left the holder a share coin typed over what it put in", async () => {
    // The exploit credits the actor; its next SUI spend adds liquidity for an
    // LP<SUI, X> share and dust, and only then does it pay someone.
    const X = `0x${"7".repeat(64)}::meme::MEME`;
    const LP = `0x${"8".repeat(64)}::swap::LP<${SUI}, ${X}>`;
    const exploit: HopSpec = { digest: START, sender: ACTOR, checkpoint: CP, changes: [[ACTOR, "1000000000000"]] };
    const addLiquidity: HopSpec = {
      digest: "0xadd",
      sender: ACTOR,
      checkpoint: CP + 1,
      changes: [[ACTOR, "-1200000000000"], [ACTOR, "5000", X], [ACTOR, "900000000000", LP]],
    };
    const payout: HopSpec = { digest: "0xpayout", sender: ACTOR, checkpoint: CP + 2, changes: [[ACTOR, "-1500000000000"], [RECIPIENT, "1500000000000"]] };
    route([exploit, addLiquidity, payout], (q, vars) => (q.includes("sentAddress") && vars.address === ACTOR ? [addLiquidity, payout] : []));
    const data = await run({ digest: START, direction: "forward", hops: 3, coin_type: SUI });
    expect(data.hops[1].digest).toBe("0xpayout");
    expect(data.hops[1].kept_as_claim.map((k: { digest: string }) => k.digest)).toEqual(["0xadd"]);
  });

  it("follows a deposit whose claim coin the holder later passed to another wallet", async () => {
    // RECIPIENT deposits the 100 SUI for 95 MarketCoin<SUI>, then sends the
    // MarketCoin to Y: the value left with the claim.
    const Y = `0xdd${"9".repeat(62)}`;
    const MARKET = `0x${"6".repeat(64)}::reserve::MarketCoin<${SUI}>`;
    const funded: HopSpec = { ...hop1, changes: [[ACTOR, "-100000000000"], [RECIPIENT, "100000000000"]] };
    const deposit: HopSpec = { digest: "0xdeposit", sender: RECIPIENT, checkpoint: CP + 1, changes: [[RECIPIENT, "-100000000000"], [RECIPIENT, "95000000000", MARKET]] };
    const pass: HopSpec = { digest: "0xpass", sender: RECIPIENT, checkpoint: CP + 2, changes: [[RECIPIENT, "-95000000000", MARKET], [Y, "95000000000", MARKET]] };
    route([funded, deposit, pass], (q, vars) => (q.includes("sentAddress") && vars.address === RECIPIENT ? [deposit, pass] : []));
    const data = await run({ digest: START, direction: "forward", hops: 4 });
    expect(data.hops.map((h: { digest: string }) => h.digest)).toEqual([START, "0xdeposit", "0xpass"]);
    expect(data.hops[1].kept_as_claim).toBeUndefined();
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
    // The page is ascending, so its first element is the address's own older
    // outflow, and following that would report a false cycle.
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

  it("stops before earlier deposits when the payer's hub check is unread", async () => {
    mockFanout.mockRejectedValue(new Error("Incomplete balance changes for synthetic-fanout"));
    route([hop1, funding], () => [funding, hop1]);
    const data = await run({ digest: START, direction: "backward", hops: 3 });
    expect(data.hops.map((h: { digest: string }) => h.digest)).toEqual([START]);
    expect(data.stop_reason).toContain("synthetic-fanout");
    expect(data.stop_reason).toMatch(/unread|incomplete/i);
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
    // The hop's signature derives to a multisig other than the sender, so its
    // movements are not the sender's own.
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

  it("follows value into a wallet labelled malicious, and stops at an exchange", async () => {
    // The bundled labels name exploiters, and the attacker is the wallet whose
    // money is being followed, so a malicious label must not end the trace.
    route([hop1, spend], (q) => (q.includes("sentAddress") ? [spend] : []));
    addSessionLabel(RECIPIENT, { label: "Exploiter", category: "malicious" }, false);
    try {
      const followed = await run({ digest: START, direction: "forward", hops: 2 });
      expect(followed.hops.map((h: { digest: string }) => h.digest)).toEqual([START, "0xnext"]);

      addSessionLabel(RECIPIENT, { label: "Exchange", category: "cex" }, false);
      const stopped = await run({ digest: START, direction: "forward", hops: 2 });
      expect(stopped.hops).toHaveLength(1);
      expect(stopped.stop_reason).toMatch(/Exchange \(cex\) — a known sink/);
    } finally {
      removeSessionLabel(RECIPIENT);
    }
  });
  it("does not use the flow-graph's 'other arrival' wording for its own same-checkpoint revisit guard", async () => {
    // A pays B (D1), B pays it straight back to A in the same checkpoint
    // (D2). trace_funds' own hard-skip keeps A's forward search from
    // rediscovering D1 as "the next spend" a second time, and A has sent
    // nothing else, so the funds are unspent. There is no graph and no
    // other arrival for "already accounted for elsewhere" to point to.
    const back: HopSpec = {
      digest: "0xback",
      sender: RECIPIENT,
      checkpoint: CP,
      changes: [[RECIPIENT, "-1000000000"], [ACTOR, "1000000000"]],
    };
    route([hop1, back], (q, vars) => {
      if (!q.includes("sentAddress")) return [];
      if (vars.address === RECIPIENT) return [back];
      if (vars.address === ACTOR) return [hop1];
      return [];
    });
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.hops.map((h: { digest: string }) => h.digest)).toEqual([START, "0xback"]);
    // hop1 is the transfer that sent the funds away before they came back:
    // it predates the receipt and moved 1 SUI, so it is not counted as a
    // later transaction that "moved nothing".
    expect(data.stop_reason).toMatch(/has not sent a transaction since receiving the funds/);
    expect(data.stop_reason).toMatch(/The funds are still there/);
    expect(data.stop_reason).not.toMatch(/has sent 1 transaction/);
    expect(data.stop_reason).not.toMatch(/other arrival/);
    expect(data.stop_reason).not.toMatch(/already counted/);
  });

  it("still counts a later transaction the actor sent that moved nothing, beside the revisit guard", async () => {
    const back: HopSpec = {
      digest: "0xback",
      sender: RECIPIENT,
      checkpoint: CP,
      changes: [[RECIPIENT, "-1000000000"], [ACTOR, "1000000000"]],
    };
    // A later call ACTOR sent that moved no SUI beyond its own gas.
    const call: HopSpec = { digest: "0xcall", sender: ACTOR, checkpoint: CP + 1, netGas: 1_000_000, changes: [[ACTOR, "-1000000"]] };
    route([hop1, back, call], (q, vars) => {
      if (!q.includes("sentAddress")) return [];
      if (vars.address === RECIPIENT) return [back];
      if (vars.address === ACTOR) return [hop1, call];
      return [];
    });
    const data = await run({ digest: START, direction: "forward", hops: 3 });
    expect(data.stop_reason).toMatch(/has sent 1 transaction\(s\) since receiving the funds and none of them moved SUI/);
  });
});

describe("trace_funds — residual (received more than the followed hop moved)", () => {
  it("reports how much stayed at the holder when a hop moves only a slice of what it received", async () => {
    // RECIPIENT got 1000 (hop1) but only sent 100 on (hop2, 10%): the other
    // 900 stayed at RECIPIENT, and this trace does not follow it further.
    const partialSpend: HopSpec = {
      digest: "0xpartial",
      sender: RECIPIENT,
      checkpoint: CP,
      changes: [
        [RECIPIENT, "-100000000"],
        [OTHER, "100000000"],
      ],
    };
    route([hop1, partialSpend], (q) => (q.includes("sentAddress") ? [partialSpend] : []));
    const res = await traceFunds({ digest: START, direction: "forward", hops: 2 });
    const data = JSON.parse(res.content[1].text);

    expect(data.hops[1].residual).toEqual({
      coin_type: SUI,
      amount: "900000000",
      received: "1000000000",
      moved: "100000000",
      note: expect.stringContaining("stayed at"),
    });
    // In the prose summary as well as the structured payload: a residual
    // that only shows up in JSON is a warning nobody reads before concluding
    // "the trace stopped here" means "the money stopped here".
    expect(res.content[0].text).toMatch(/held back/);
    expect(res.content[0].text).toMatch(/not followed by this trace/);
  });

  it("does not flag a hop that moves everything it received", async () => {
    // The default fixture: RECIPIENT forwards its whole 1000 (minus gas) to
    // OTHER. Nothing should read as held back.
    route([hop1, spend], (q) => (q.includes("sentAddress") ? [spend] : []));
    const data = await run({ digest: START, direction: "forward", hops: 2 });
    expect(data.hops[1].residual).toBeUndefined();
  });
});
