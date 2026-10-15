import { afterEach, describe, expect, it, vi } from "vitest";
import { extraOracles } from "../scripts/probe/lib/oracle-extra.mjs";

const addr = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const sui = `${addr(2)}::sui::SUI`;

function harness(opts: { gql: (q: string, vars: Record<string, unknown>) => unknown; grpc?: unknown; txs?: Record<string, unknown>; tool: (name: string, args: Record<string, unknown>) => unknown }) {
  const rows: Array<{ id: string; status: string; detail: Record<string, unknown> }> = [];
  const checks = extraOracles({
    gql: opts.gql,
    grpc: opts.grpc,
    rawTx: async (id: string) => opts.txs?.[id],
    callTool: async (name: string, args: Record<string, unknown>) => opts.tool(name, args),
    answerOf: (_: string, __: number, ___: string, response: unknown) => response,
    truthOf: async (_: string, __: number, ___: string, read: () => unknown) => read(),
    record: (id: string, _: number, __: string, status: string, detail: Record<string, unknown>) => rows.push({ id, status, detail }),
    skip: (id: string, _: number, __: string, reason: string) => rows.push({ id, status: "skip", detail: { reason } }),
  });
  return { checks, rows };
}

afterEach(() => vi.restoreAllMocks());

describe("independent oracle comparisons", () => {
  it("chooses the first SUI inflow above the funding floor and its actual payer", async () => {
    const user = addr(31), payer = addr(32), sponsor = addr(33);
    const { checks, rows } = harness({
      gql: () => ({ transactions: { nodes: [{ digest: "dust" }, { digest: "fund" }] } }),
      txs: {
        dust: { digest: "dust", balances: [{ owner: user, coin: sui, amount: 1n }] },
        fund: {
          digest: "fund", balances: [
            { owner: user, coin: sui, amount: 15_000_000n },
            { owner: payer, coin: sui, amount: -15_000_000n },
            { owner: sponsor, coin: sui, amount: -4_000_000n },
          ]
        },
      },
      tool: () => ({ chain: [{ funding_tx: "fund", funded_by: payer }] }),
    });
    await checks.funding(0, user);
    expect(rows).toMatchObject([{ id: "g", status: "agree" }]);
    expect(rows[0].detail.truth).toEqual({ funding_tx: "fund", funded_by: payer });
  });

  it("refuses a funding verdict when a preceding non-SUI inflow needs pricing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ [sui]: { price: 1 } }) } as Response);
    const user = addr(31);
    const { checks, rows } = harness({
      gql: () => ({ transactions: { nodes: [{ digest: "first" }] } }),
      txs: { first: { balances: [{ owner: user, coin: `${addr(13)}::token::T`, amount: 1n }] } },
      tool: () => { throw new Error("funding tool must not be called before the ambiguity is settled"); },
    });
    await checks.funding(0, user);
    expect(rows[0].status).toBe("skip");
  });


  it("prices a non-SUI first inflow by live metadata and chooses its coin-specific payer", async () => {
    const user = addr(31), funder = addr(32), sponsor = addr(33), token = `${addr(13)}::token::T`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true, json: async () => ({
        [sui]: { price: 2 }, [token]: { price: 1 },
      })
    } as Response);
    const grpc = { stateService: { getCoinInfo: vi.fn().mockResolvedValue({ response: { metadata: { decimals: 6 } } }) } };
    const { checks, rows } = harness({
      gql: () => ({ transactions: { nodes: [{ digest: "fund" }] } }),
      grpc,
      txs: {
        fund: {
          digest: "fund", balances: [
            { owner: user, coin: token, amount: 1_000_000n },
            { owner: funder, coin: token, amount: -1_000_000n },
            { owner: user, coin: sui, amount: 15_000_000n },
            { owner: sponsor, coin: sui, amount: -15_000_000n },
          ]
        }
      },
      tool: () => ({ chain: [{ funding_tx: "fund", funded_by: funder }] }),
    });
    await checks.funding(0, user);
    expect(rows).toMatchObject([{ id: "g", status: "agree" }]);
    expect(grpc.stateService.getCoinInfo).toHaveBeenCalledWith({ coinType: token });
  });
  it("sums the coin and accumulator walks before validating a complete ranking", async () => {
    const type = `${addr(7)}::coin::T`;
    const holder = addr(31);
    const { checks, rows } = harness({
      gql: (_, v) => ({
        objects: v.t?.toString().includes("::accumulator::")
          ? { nodes: [{ asMoveObject: { contents: { json: { name: { address: holder }, value: { value: "30" } } } } }], pageInfo: { hasNextPage: false } }
          : { nodes: [{ owner: { address: { address: holder } }, asMoveObject: { contents: { json: { balance: "20" } } } }], pageInfo: { hasNextPage: false } }
      }),
      tool: () => ({ complete_ranking: true, total_scanned: 2, unique_holders: 1, top_holders: [{ address: holder, balance: "50", coin_balance: "20", address_balance: "30" }] }),
    });
    await checks.holders(0, type);
    expect(rows).toMatchObject([{ id: "h", status: "agree" }]);
  });

  it("does not compare incomplete holder scans as an absent ranking", async () => {
    const holder = addr(31), type = `${addr(7)}::coin::T`;
    const { checks, rows } = harness({
      gql: (_, v) => ({ objects: { nodes: v.t?.toString().includes("::accumulator::") ? [] : [{ owner: { address: { address: holder } }, asMoveObject: { contents: { json: { balance: "20" } } } }], pageInfo: { hasNextPage: false } } }),
      tool: () => ({ complete_ranking: false, sampled_holders: [] }),
    });
    await checks.holders(0, type);
    expect(rows[0].status).toBe("skip");
  });

  it("detects a stake reward below its executed withdrawal figure", async () => {
    const owner = addr(31), pool = addr(12);
    const { checks, rows } = harness({
      gql: () => ({ checkpoint: { epoch: { epochId: "4" } } }),
      txs: {
        unstake: {
          sender: owner, checkpoint: 90, events: [{
            type: `${addr(3)}::validator::UnstakingRequestEvent`,
            json: { unstaking_epoch: "4", pool_id: pool, principal_amount: "100", reward_amount: "8", stake_activation_epoch: "2" },
          }]
        }
      },
      tool: () => ({ complete: true, positions: [{ pool_id: pool, principal_mist: "100", estimated_reward_mist: "7", stake_activation_epoch: "2" }] }),
    });
    await checks.stakeValue(0, "unstake");
    expect(rows).toMatchObject([{ id: "i", status: "disagree" }]);
    expect(rows[0].detail.problems).toEqual([{ field: "reward", ours: "7", event: "8" }]);
  });

  it("decodes a native bridge recipient from the actual event bytes", async () => {
    const target = `0x${"ab".repeat(20)}`;
    const { checks, rows } = harness({
      gql: () => { throw new Error("bridge truth must come from raw effects"); },
      txs: {
        deposit: {
          events: [
            { type: `${addr(10)}::bridge::TokenDepositedEvent`, json: { source_chain: 0, seq_num: "6", target_chain: 10, target_address: Buffer.from("cc".repeat(20), "hex").toString("base64") } },
            { type: `${addr(11)}::bridge::TokenDepositedEvent`, json: { source_chain: 0, seq_num: "7", target_chain: 10, target_address: Buffer.from("ab".repeat(20), "hex").toString("base64") } },
          ]
        }
      },
      tool: () => ({ sui_native_bridge: [{ transfer_id: "0/7", destination_address: target }] }),
    });
    await checks.bridge(0, "deposit");
    expect(rows).toMatchObject([{ id: "j", status: "agree" }]);
  });

  it("subtracts all balance changes after the target from one pinned anchor", async () => {
    const holder = addr(31);
    const { checks, rows } = harness({
      gql: (q) => q.includes("atCheckpoint") ? { address: { balance: { totalBalance: "100" } } } : { transactions: { nodes: [{ digest: "one" }, { digest: "two" }], pageInfo: { hasNextPage: false } } },
      txs: {
        one: { balances: [{ owner: holder, coin: sui, amount: 20n }] },
        two: { balances: [{ owner: holder, coin: sui, amount: -5n }] },
      },
      tool: () => ({ complete: true, method: "reconstructed", balance: "85" }),
    });
    await checks.historicalBalance(0, { address: holder, target: 50, anchor: 80 });
    expect(rows).toMatchObject([{ id: "k", status: "agree" }]);
    expect(rows[0].detail.truth).toEqual({ balance: "85", transactions: 2 });
  });
  it("detects a checkpoint timestamp that disagrees with GraphQL", async () => {
    const { checks, rows } = harness({
      gql: () => ({ checkpoint: { sequenceNumber: "40", timestamp: "2026-09-01T00:00:00Z", epoch: { epochId: "100" } } }),
      tool: () => ({ sequence_number: "40", timestamp: "2026-09-01T00:00:01Z", epoch: "100" }),
    });
    await checks.checkpoint(0, 40);
    expect(rows).toMatchObject([{ id: "l", status: "disagree" }]);
    expect(rows[0].detail.problems).toEqual([{ field: "timestamp", ours: "2026-09-01T00:00:01Z", chain: "2026-09-01T00:00:00Z" }]);
  });

});
