/**
 * Fund tracing through native allowances (0x2::allowance). A spend under an
 * allowance is sent and signed by the spender while the funder's address
 * balance pays, so the forward search finds it among the transactions in
 * which the funder's balance fell while another address signed, confirmed by
 * the transaction's FundsWithdrawal input (gRPC source 3).
 *
 * Shapes follow mainnet 8pk5uWZAv6Q25k7om8LSsoAAH7Dxf74iTLnaQSfuzwQY: sender
 * is the spender, the funder's SUI balance change is the debit, and the input
 * is `withdrawFrom: SenderAllowance { funder, allowance }`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlTx, searchPage, SUI, type HopSpec } from "./helpers/trace-shapes.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

/** digest -> FundsWithdrawal inputs, as gRPC returns them; "fail" makes the read throw. */
const grpcInputs = new Map<string, Array<Record<string, unknown>> | "fail">();
const grpcSender = new Map<string, string>();
const getTransaction = vi.fn(async ({ digest }: { digest: string }) => {
  const inputs = grpcInputs.get(digest);
  if (inputs === "fail") throw new Error("UNAVAILABLE");
  return {
    // GetTransactionResponse: ExecutedTransaction { transaction: Transaction }.
    response: {
      transaction: {
        digest,
        transaction: {
          sender: grpcSender.get(digest),
          kind: {
            data: {
              oneofKind: "programmableTransaction",
              programmableTransaction: { inputs: (inputs ?? []).map((w) => ({ fundsWithdrawal: w })) },
            },
          },
        },
      },
    },
  };
});
vi.mock("../src/clients/grpc.js", () => ({
  sui: {
    ledgerService: { getTransaction },
    stateService: { getCoinInfo: async () => Promise.reject(new Error("NOT_FOUND")) },
  },
  archive: { ledgerService: { getTransaction } },
}));
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
vi.mock("../src/utils/recent-prices.js", () => ({ fetchRecentHistory: async () => ({ quotes: new Map(), unanswered: new Map(), outOfRange: [] }) }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
const mockFanout = vi.fn();
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: mockFanout }));

const { registerTraceTools } = await import("../src/tools/trace.js");
const { resetAllowanceCapsCache, allowanceDrawsFrom } = await import("../src/utils/allowance-links.js");
const { mergeForwardScans } = await import("../src/utils/trace-read.js");

const tools = new Map<string, Function>();
registerTraceTools({
  tool: (name: string, _d: string, _s: unknown, handler: Function) => tools.set(name, handler),
} as never);
const traceFunds = tools.get("trace_funds")!;

const PAYER = `0xa1${"1".repeat(62)}`;
const FUNDER = `0xf8${"2".repeat(62)}`;
const SPENDER = `0xf4${"3".repeat(62)}`;
const PAYEE = `0xbb${"4".repeat(62)}`;
const OTHER = `0xcc${"5".repeat(62)}`;
const ALLOWANCE = `0x01${"9".repeat(62)}`;
const CAP = `0x02${"8".repeat(62)}`;

const draw = (funder = FUNDER) => ({ amount: 1_500_000_000n, coinType: SUI, source: 3, funder, allowance: ALLOWANCE });

/** PAYER funds FUNDER with 1 SUI. */
const fund: HopSpec = { digest: "0xfund", sender: PAYER, checkpoint: 100, changes: [[PAYER, "-1000000000"], [FUNDER, "1000000000"]] };
/** FUNDER's own unrelated transaction: it sends, but spends no SUI. */
const own: HopSpec = { digest: "0xown", sender: FUNDER, checkpoint: 101, gasPayer: OTHER, changes: [] };
/** SPENDER draws 1 SUI from FUNDER's address balance and pays PAYEE. */
const spend: HopSpec = {
  digest: "0xspend",
  sender: SPENDER,
  checkpoint: 102,
  changes: [[FUNDER, "-1000000000"], [PAYEE, "1000000000"]],
};

let world: HopSpec[] = [];
let holdsCaps: boolean | "fail" = true;

function route() {
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
    const q = String(query);
    if (q.includes("AllowanceCap")) {
      if (holdsCaps === "fail") throw new Error("429");
      return { address: { objects: { nodes: holdsCaps ? [{ address: CAP }] : [] } } };
    }
    if (q.includes("transactions(")) return searchPage(world, q, vars);
    const h = world.find((x) => x.digest === String(vars.digest));
    return h ? gqlTx(h) : { transaction: null };
  });
}

beforeEach(() => {
  mockGqlQuery.mockReset();
  getTransaction.mockClear();
  grpcInputs.clear();
  grpcSender.clear();
  resetAllowanceCapsCache();
  mockFanout.mockReset();
  mockFanout.mockResolvedValue({ classification: "narrow", sender_classification: "narrow", sender_count: 1, counterparty_count: 2, scanned_transactions: 10, truncated: false });
  holdsCaps = true;
  world = [fund, own, spend];
  grpcInputs.set("0xspend", [draw()]);
  grpcSender.set("0xspend", SPENDER);
  route();
});

async function run(args: Record<string, unknown>) {
  const res = await traceFunds(args);
  return JSON.parse(res.content[1].text);
}

describe("trace_funds forward through an allowance spend", () => {
  it("follows the funder's balance into a transaction its spender sent", async () => {
    const data = await run({ digest: "0xfund", direction: "forward", hops: 3 });
    expect(data.hops.map((h: { digest: string }) => h.digest)).toEqual(["0xfund", "0xspend"]);
    const hop = data.hops[1];
    expect(hop.reached_via).toBe("allowance-spend");
    expect(hop.allowance_spend).toMatchObject({ funder: FUNDER, spender: SPENDER, allowance_id: ALLOWANCE });
    // The spender sent it and signed it, so neither the custody check nor
    // the signer rule stops the trace there.
    expect(data.custody_break).toBeUndefined();
    expect(hop.signer_is_sender).toBeUndefined();
    expect(data.stop_reason).not.toMatch(/signed by|Chain of custody/);
    // The next hop is chosen from what the funder lost: PAYEE received it.
    expect(hop.basis).toBe("direct");
  });

  it("does not follow a balance fall another address signed without an allowance draw from the holder", async () => {
    grpcInputs.set("0xspend", [draw(OTHER)]);
    const data = await run({ digest: "0xfund", direction: "forward", hops: 3 });
    expect(data.hops.map((h: { digest: string }) => h.digest)).toEqual(["0xfund"]);
    expect(data.stop_reason).toMatch(/has sent 1 transaction\(s\) since receiving the funds and none of them moved/);
  });

  it("says when a candidate's inputs could not be read rather than reading it as no allowance", async () => {
    grpcInputs.set("0xspend", "fail");
    const data = await run({ digest: "0xfund", direction: "forward", hops: 3 });
    expect(data.hops).toHaveLength(1);
    expect(data.stop_reason).toMatch(/could not be read, so whether they spent it under an allowance is unknown/);
  });

  it("skips the search when the holder holds no AllowanceCap", async () => {
    holdsCaps = false;
    const data = await run({ digest: "0xfund", direction: "forward", hops: 3 });
    expect(data.hops).toHaveLength(1);
    const searches = mockGqlQuery.mock.calls.filter(([q, v]) => String(q).includes("affectedAddress") && v.address === FUNDER);
    expect(searches).toHaveLength(0);
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("still searches when the cap read fails", async () => {
    holdsCaps = "fail";
    const data = await run({ digest: "0xfund", direction: "forward", hops: 3 });
    expect(data.hops[1]?.reached_via).toBe("allowance-spend");
  });

  it("follows an allowance spend that came before the holder's own spend", async () => {
    const later: HopSpec = { digest: "0xlater", sender: FUNDER, checkpoint: 105, changes: [[FUNDER, "-400000000"], [OTHER, "400000000"]] };
    world = [fund, own, spend, later];
    const data = await run({ digest: "0xfund", direction: "forward", hops: 3 });
    expect(data.hops[1].digest).toBe("0xspend");
  });

  it("treats the start transaction's funder as the holder when the start is an allowance spend", async () => {
    world = [spend];
    const data = await run({ digest: "0xspend", direction: "forward", hops: 2 });
    expect(data.hops[0].allowance_spend).toMatchObject({ funder: FUNDER, spender: SPENDER });
    expect(data.hops[0].basis).toBe("direct");
  });
});

describe("trace_funds backward through an allowance spend", () => {
  it("names the funder as the payer and says the spender signed", async () => {
    const data = await run({ digest: "0xspend", direction: "backward", hops: 3 });
    expect(data.hops[0].allowance_spend).toMatchObject({ funder: FUNDER, spender: SPENDER, allowance_id: ALLOWANCE });
    expect(data.hops[0].note).toMatch(/paid here under allowance/);
    // The funder's earlier inflow is the next hop.
    expect(data.hops[1]?.digest).toBe("0xfund");
  });
});

describe("allowanceDrawsFrom", () => {
  const w = (funder: string, source: "sender_allowance" | "sender" = "sender_allowance") => ({
    amount: "5",
    coin_type: SUI,
    source,
    funder,
    allowance: ALLOWANCE,
  });
  it("keeps only allowance withdrawals from the funder", () => {
    expect(allowanceDrawsFrom([w(FUNDER), w(OTHER), w(FUNDER, "sender")], FUNDER, SPENDER)).toEqual([
      { funder: FUNDER, spender: SPENDER, allowance_id: ALLOWANCE, coin_type: SUI, max_amount: "5" },
    ]);
  });
  it("is empty when the funder sent the transaction itself", () => {
    expect(allowanceDrawsFrom([w(FUNDER)], FUNDER, FUNDER)).toEqual([]);
  });
});

describe("mergeForwardScans", () => {
  const tx = (digest: string, checkpoint: number) => ({ digest, sender: null, checkpoint, gas: { payer: null, net: null }, changes: [] });
  const scan = (spends: Array<[string, number, bigint]>, flags: { exhausted: boolean; satisfied: boolean; lastCheckpoint?: number }) => ({
    spends: spends.map(([d, cp, spent]) => ({ tx: tx(d, cp), via: "sent" as const, spent })),
    seen: spends.length,
    alreadyAllocated: 0,
    drainedBySelf: 0,
    passedOver: [],
    ...flags,
  });
  const upTo = (need: bigint) => (s: unknown[], covered: bigint) => covered >= need;

  it("orders spends from both searches by checkpoint and recuts at need", () => {
    const merged = mergeForwardScans(
      scan([["a", 10, 5n], ["c", 30, 5n]], { exhausted: true, satisfied: false }),
      scan([["b", 20, 5n]], { exhausted: true, satisfied: false }),
      upTo(10n),
    );
    expect(merged.spends.map((s) => s.tx.digest)).toEqual(["a", "b"]);
    expect(merged.satisfied).toBe(true);
    expect(merged.seen).toBe(2);
  });

  it("drops spends past the last checkpoint a page-limited search read", () => {
    const merged = mergeForwardScans(
      scan([["a", 10, 1n], ["c", 30, 1n]], { exhausted: true, satisfied: false }),
      scan([["b", 20, 1n]], { exhausted: false, satisfied: false, lastCheckpoint: 25 }),
      upTo(100n),
    );
    expect(merged.spends.map((s) => s.tx.digest)).toEqual(["a", "b"]);
    expect(merged.exhausted).toBe(false);
  });
});
