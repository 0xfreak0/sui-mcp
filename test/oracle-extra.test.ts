import { afterEach, describe, expect, it, vi } from "vitest";
import { bcs } from "@mysten/sui/bcs";
import { extraOracles } from "../scripts/probe/lib/oracle-extra.mjs";

const addr = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const sui = `${addr(2)}::sui::SUI`;
const token = `${addr(13)}::token::T`;
const STAKED = `${addr(3)}::staking_pool::StakedSui`;
const UNSTAKE = `${addr(3)}::validator::UnstakingRequestEvent`;

type Gql = (q: string, vars: Record<string, unknown>) => unknown;
type Row = { id: string; status: string; detail: Record<string, unknown> };

function harness(opts: { gql?: Gql; grpc?: unknown; archive?: unknown; txs?: Record<string, unknown>; tool: (name: string, args: Record<string, unknown>) => unknown }) {
  const rows: Row[] = [];
  const skip = (id: string, _: number, __: string, reason: string) => rows.push({ id, status: "skip", detail: { reason } });
  const calls: Array<[string, Record<string, unknown>]> = [];
  const checks = extraOracles({
    gql: opts.gql ?? (() => { throw new Error("no GraphQL read expected"); }),
    grpc: opts.grpc,
    archive: opts.archive,
    rawTx: async (id: string) => opts.txs?.[id],
    callTool: async (name: string, args: Record<string, unknown>) => (calls.push([name, args]), opts.tool(name, args)),
    answerOf: (_: string, __: number, ___: string, response: unknown) => response,
    // As oracle-pass: a truth read that throws is a skip, never an answer.
    truthOf: async (id: string, key: number, subject: string, read: () => unknown) => {
      try {
        return await read();
      } catch (err) {
        return skip(id, key, subject, `truth unreadable: ${String(err)}`), null;
      }
    },
    record: (id: string, _: number, __: string, status: string, detail: Record<string, unknown>) => rows.push({ id, status, detail }),
    skip,
  });
  return { checks, rows, calls };
}

/** GraphQL for the funding oracle: the earliest transactions, then coin supply. */
const fundingGql = (digests: string[], supply: Record<string, string | null> = {}): Gql => (q, v) =>
  q.includes("coinMetadata")
    ? { coinMetadata: supply[v.t as string] === undefined ? null : { supply: supply[v.t as string] } }
    : { transactions: { nodes: digests.map((digest) => ({ digest })) } };

const prices = (quotes: Record<string, number>) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => Object.fromEntries(Object.entries(quotes).map(([k, price]) => [k, { price }])) } as Response);

afterEach(() => vi.restoreAllMocks());

describe("first funding", () => {
  it("chooses the first SUI inflow above the funding floor and its actual payer", async () => {
    const user = addr(31), payer = addr(32), sponsor = addr(33);
    const { checks, rows } = harness({
      gql: fundingGql(["dust", "fund"]),
      txs: {
        dust: { digest: "dust", balances: [{ owner: user, coin: sui, amount: 1n }] },
        fund: {
          digest: "fund", balances: [
            { owner: user, coin: sui, amount: 15_000_000n },
            { owner: payer, coin: sui, amount: -15_000_000n },
            { owner: sponsor, coin: sui, amount: -4_000_000n },
          ],
        },
      },
      tool: () => ({ chain: [{ funding_tx: "fund", funded_by: payer }] }),
    });
    await checks.funding(0, user);
    expect(rows).toMatchObject([{ id: "g", status: "agree" }]);
    expect(rows[0].detail.truth).toEqual({ funding_tx: "fund", funded_by: payer });
  });

  it("skips an unpriced inflow whose share of supply only the publisher or send shape can settle", async () => {
    prices({ [sui]: 1 });
    const user = addr(31);
    const { checks, rows, calls } = harness({
      gql: fundingGql(["first", "later"], { [token]: "1000000" }),
      txs: {
        first: { digest: "first", balances: [{ owner: user, coin: token, amount: 1_000n }, { owner: addr(32), coin: token, amount: -1_000n }] },
        later: { digest: "later", balances: [{ owner: user, coin: sui, amount: 50_000_000n }, { owner: addr(33), coin: sui, amount: -50_000_000n }] },
      },
      tool: () => ({ chain: [] }),
    });
    await checks.funding(0, user);
    expect(rows).toMatchObject([{ id: "g", status: "skip" }]);
    expect(rows[0].detail.reason).toMatch(/publisher and send shape/);
    expect(calls).toEqual([]);
  });

  it("passes over unpriced dust far below the targeted-send share and judges the next inflow", async () => {
    prices({ [sui]: 1 });
    const user = addr(31), payer = addr(33);
    const { checks, rows } = harness({
      gql: fundingGql(["spam", "fund"], { [token]: "1000000000000" }),
      txs: {
        spam: { digest: "spam", balances: [{ owner: user, coin: token, amount: 1_000n }, { owner: addr(32), coin: token, amount: -1_000n }] },
        fund: { digest: "fund", balances: [{ owner: user, coin: sui, amount: 50_000_000n }, { owner: payer, coin: sui, amount: -50_000_000n }] },
      },
      tool: () => ({ chain: [{ funding_tx: "spam", funded_by: addr(32) }] }),
    });
    await checks.funding(0, user);
    expect(rows).toMatchObject([{ id: "g", status: "disagree" }]);
    expect(rows[0].detail.truth).toEqual({ funding_tx: "fund", funded_by: payer });
  });

  it("lets a qualifying SUI inflow decide a transaction that also carries an unpriced coin", async () => {
    prices({ [sui]: 1 });
    const user = addr(31), payer = addr(32);
    const { checks, rows } = harness({
      gql: fundingGql(["fund"], { [token]: "1000" }),
      txs: {
        fund: {
          digest: "fund", balances: [
            { owner: user, coin: token, amount: 500n },
            { owner: user, coin: sui, amount: 20_000_000n },
            { owner: payer, coin: sui, amount: -20_000_000n },
          ],
        },
      },
      tool: () => ({ chain: [{ funding_tx: "fund", funded_by: payer }] }),
    });
    await checks.funding(0, user);
    expect(rows).toMatchObject([{ id: "g", status: "agree" }]);
  });

  it("requires no first hop when every inflow is below a floor", async () => {
    const user = addr(31);
    const run = async (tool: unknown) => {
      const { checks, rows } = harness({
        gql: fundingGql(["dust"]),
        txs: { dust: { digest: "dust", balances: [{ owner: user, coin: sui, amount: 9_999_999n }, { owner: addr(32), coin: sui, amount: -9_999_999n }] } },
        tool: () => tool,
      });
      await checks.funding(0, user);
      return rows[0].status;
    };
    expect(await run({ chain: [] })).toBe("agree");
    expect(await run({ chain: [{ funding_tx: "dust", funded_by: addr(32) }] })).toBe("disagree");
  });

  it("checks the funding transaction only when no address paid the coin", async () => {
    const user = addr(31);
    const { checks, rows } = harness({
      gql: fundingGql(["claim"]),
      txs: { claim: { digest: "claim", balances: [{ owner: user, coin: sui, amount: 20_000_000n }] } },
      tool: () => ({ chain: [{ funding_tx: "claim", funded_by: "unknown" }] }),
    });
    await checks.funding(0, user);
    expect(rows).toMatchObject([{ id: "g", status: "agree", detail: { funder_unchecked: expect.stringMatching(/no address paid/) } }]);
  });

  it("prices a non-SUI first inflow by live metadata and chooses its coin-specific payer", async () => {
    const user = addr(31), funder = addr(32), sponsor = addr(33);
    prices({ [sui]: 2, [token]: 1 });
    const grpc = { stateService: { getCoinInfo: vi.fn().mockResolvedValue({ response: { metadata: { decimals: 6 } } }) } };
    const { checks, rows } = harness({
      gql: fundingGql(["fund"]),
      grpc,
      txs: {
        fund: {
          digest: "fund", balances: [
            { owner: user, coin: token, amount: 1_000_000n },
            { owner: funder, coin: token, amount: -1_000_000n },
            { owner: user, coin: sui, amount: 15_000_000n },
            { owner: sponsor, coin: sui, amount: -15_000_000n },
          ],
        },
      },
      tool: () => ({ chain: [{ funding_tx: "fund", funded_by: funder }] }),
    });
    await checks.funding(0, user);
    expect(rows).toMatchObject([{ id: "g", status: "agree" }]);
    expect(grpc.stateService.getCoinInfo).toHaveBeenCalledWith({ coinType: token });
  });
});

describe("holder ranking", () => {
  const type = `${addr(7)}::coin::T`;
  const holder = addr(31);
  const walks = (coins: unknown[], balances: unknown[]): Gql => (_, v) => ({
    objects: { nodes: String(v.t).includes("::accumulator::") ? balances : coins, pageInfo: { hasNextPage: false } },
  });
  const coin = (owner: string | null, balance: string) => ({ owner: owner ? { __typename: "AddressOwner", address: { address: owner } } : { __typename: "ObjectOwner" }, asMoveObject: { contents: { json: { balance } } } });
  const ab = (owner: string, value: string) => ({ asMoveObject: { contents: { json: { name: { address: owner }, value: { value } } } } });
  const grpcBalance = (total: bigint) => ({ getBalance: vi.fn().mockResolvedValue({ balance: { balance: total } }) });

  it("sums the coin and accumulator walks before validating a complete ranking", async () => {
    const { checks, rows } = harness({
      gql: walks([coin(holder, "20")], [ab(holder, "30")]),
      grpc: grpcBalance(50n),
      tool: () => ({ complete_ranking: true, total_scanned: 2, unique_holders: 1, top_holders: [{ address: holder, balance: "50", coin_balance: "20", address_balance: "30" }] }),
    });
    await checks.holders(0, type);
    expect(rows).toMatchObject([{ id: "h", status: "agree" }]);
  });

  it("compares the tool's unresolved count with coins no address owns", async () => {
    const { checks, rows } = harness({
      gql: walks([coin(holder, "20"), coin(null, "5")], []),
      grpc: grpcBalance(20n),
      tool: () => ({ complete_ranking: true, total_scanned: 2, unique_holders: 1, top_holders: [{ address: holder, balance: "20", coin_balance: "20", address_balance: "0" }] }),
    });
    await checks.holders(0, type);
    expect(rows).toMatchObject([{ id: "h", status: "disagree" }]);
    expect(rows[0].detail.problems).toEqual([expect.objectContaining({ ours: expect.objectContaining({ unresolved_owners: 0 }) })]);
  });

  it("skips a holder whose gRPC balance moved away from the walk", async () => {
    const { checks, rows } = harness({
      gql: walks([coin(holder, "20")], []),
      grpc: grpcBalance(21n),
      tool: () => ({ complete_ranking: true, total_scanned: 1, unique_holders: 1, top_holders: [{ address: holder, balance: "20", coin_balance: "20", address_balance: "0" }] }),
    });
    await checks.holders(0, type);
    expect(rows).toMatchObject([{ id: "h", status: "skip" }]);
  });

  it("counts a ConsensusAddressOwner coin as its address's holding", async () => {
    const party = { owner: { __typename: "ConsensusAddressOwner", address: { address: holder } }, asMoveObject: { contents: { json: { balance: "20" } } } };
    const { checks, rows } = harness({
      gql: walks([party], []),
      grpc: grpcBalance(20n),
      tool: () => ({ complete_ranking: true, total_scanned: 1, unique_holders: 0, unresolved_owners: 1, top_holders: [] }),
    });
    await checks.holders(0, type);
    expect(rows).toMatchObject([{ id: "h", status: "disagree" }]);
  });

  it("does not compare incomplete holder scans as an absent ranking", async () => {
    const { checks, rows } = harness({
      gql: walks([coin(holder, "20")], []),
      tool: () => ({ complete_ranking: false, sampled_holders: [] }),
    });
    await checks.holders(0, type);
    expect(rows[0].status).toBe("skip");
  });
});

describe("staked SUI reward", () => {
  const owner = addr(31), pool = addr(12), stake = addr(40), inner = addr(41);
  const unstake = (reward: string) => ({
    sender: owner, checkpoint: 90,
    changes: new Map([
      [stake, { id: stake, deleted: true, input: { version: "5", type: STAKED } }],
      [inner, { id: inner, deleted: false, input: { version: "9", type: `${addr(2)}::dynamic_field::Field<u64, ${addr(3)}::sui_system_state_inner::SuiSystemStateInnerV2>` } }],
    ]),
    events: [{ type: UNSTAKE, json: { unstaking_epoch: "4", pool_id: pool, principal_amount: "100", reward_amount: reward, stake_activation_epoch: "2" } }],
  });
  const position = (reward: string) => ({ complete: true, positions: [{ object_id: stake, pool_id: pool, principal_mist: "100", estimated_reward_mist: reward, stake_activation_epoch: "2" }] });
  const gql = (rewardsPool: string): Gql => (q) =>
    q.includes("object(address")
      ? { object: { asMoveObject: { contents: { json: { validators: [{ staking_pool: { id: pool, rewards_pool: rewardsPool } }] } } } } }
      : { checkpoint: { epoch: { epochId: "4" } } };

  it("detects a stake reward below its executed withdrawal figure", async () => {
    const { checks, rows } = harness({ gql: gql("1000"), txs: { u: unstake("8") }, tool: () => position("7") });
    await checks.stakeValue(0, "u");
    expect(rows).toMatchObject([{ id: "i", status: "disagree" }]);
    expect(rows[0].detail.problems).toEqual([{ field: "reward", ours: "7", event: "8", pool_id: pool }]);
  });

  it("treats a lower payout as the rewards-pool cap only when it emptied the pool", async () => {
    const capped = harness({ gql: gql("6"), txs: { u: unstake("6") }, tool: () => position("7") });
    await capped.checks.stakeValue(0, "u");
    expect(capped.rows).toMatchObject([{ id: "i", status: "skip" }]);
    const over = harness({ gql: gql("1000"), txs: { u: unstake("6") }, tool: () => position("7") });
    await over.checks.stakeValue(0, "u");
    expect(over.rows).toMatchObject([{ id: "i", status: "disagree" }]);
  });

  it("matches the position by the StakedSui the withdrawal deleted", async () => {
    const other = { object_id: addr(42), pool_id: pool, principal_mist: "100", estimated_reward_mist: "8", stake_activation_epoch: "2" };
    const { checks, rows } = harness({ gql: gql("1000"), txs: { u: unstake("8") }, tool: () => ({ complete: true, positions: [other] }) });
    await checks.stakeValue(0, "u");
    expect(rows).toMatchObject([{ id: "i", status: "skip" }]);
  });
});

describe("native bridge", () => {
  const Deposited = bcs.struct("TokenDepositedEvent", {
    seq_num: bcs.u64(), source_chain: bcs.u8(), sender_address: bcs.vector(bcs.u8()), target_chain: bcs.u8(),
    target_address: bcs.vector(bcs.u8()), token_type: bcs.u8(), amount: bcs.u64(),
  });
  const event = (type: string, seq: number, target: string) => ({
    eventType: type,
    contents: {
      value: Deposited.serialize({
        seq_num: seq, source_chain: 0, sender_address: [...Buffer.from("11".repeat(32), "hex")], target_chain: 10,
        target_address: [...Buffer.from(target.repeat(20), "hex")], token_type: 2, amount: 1000,
      }).toBytes(),
    },
  });
  const grpcWith = (events: unknown[]) => ({ ledgerService: { getTransaction: vi.fn().mockResolvedValue({ response: { transaction: { events: { events } } } }) } });

  it("decodes the recipient, sender and amount from the event's BCS and ignores another package's event", async () => {
    const grpc = grpcWith([event(`${addr(10)}::bridge::TokenDepositedEvent`, 6, "cc"), event("0xb::bridge::TokenDepositedEvent", 7, "ab")]);
    const row = { transfer_id: "0/7", destination_address: `0x${"ab".repeat(20)}`, sender: `0x${"11".repeat(32)}`, amount: "1000" };
    const ok = harness({ grpc, tool: () => ({ sui_native_bridge: [row] }) });
    await ok.checks.bridge(0, "deposit");
    expect(ok.rows).toMatchObject([{ id: "j", status: "agree" }]);
    const wrong = harness({ grpc, tool: () => ({ sui_native_bridge: [{ ...row, amount: "999" }] }) });
    await wrong.checks.bridge(0, "deposit");
    expect(wrong.rows).toMatchObject([{ id: "j", status: "disagree" }]);
  });

  it("reads a transaction the fullnode pruned from the archive", async () => {
    const grpc = { ledgerService: { getTransaction: vi.fn().mockRejectedValue(new Error("Transaction X not found")) } };
    const archive = grpcWith([event("0xb::bridge::TokenDepositedEvent", 7, "ab")]);
    const { checks, rows } = harness({
      grpc, archive,
      tool: () => ({ sui_native_bridge: [{ transfer_id: "0/7", destination_address: `0x${"ab".repeat(20)}`, sender: `0x${"11".repeat(32)}`, amount: "1000" }] }),
    });
    await checks.bridge(0, "deposit");
    expect(rows).toMatchObject([{ id: "j", status: "agree" }]);
    expect(archive.ledgerService.getTransaction).toHaveBeenCalled();
  });
});

describe("historical balance", () => {
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

  it("skips when the anchor has left the consistent range", async () => {
    const { checks, rows, calls } = harness({ gql: () => ({ address: null }), tool: () => ({}) });
    await checks.historicalBalance(0, { address: addr(31), target: 50, anchor: 80 });
    expect(rows).toMatchObject([{ id: "k", status: "skip" }]);
    expect(calls).toEqual([]);
  });
});

describe("checkpoint", () => {
  const gql: Gql = () => ({
    c: { sequenceNumber: 40, digest: "D40", previousCheckpointDigest: "D39", timestamp: "2026-09-01T00:00:00.500Z", networkTotalTransactions: 900, epoch: { epochId: 100 } },
    p: { timestamp: "2026-09-01T00:00:00.100Z" },
  });
  const byNumber = { sequence_number: "40", digest: "D40", previous_digest: "D39", timestamp: "2026-09-01T00:00:00.500Z", epoch: "100", total_network_transactions: "900" };
  const byTime = (last: string) => ({ ...byNumber, resolved_from_timestamp: { last_before: { sequence_number: last }, first_at_or_after: { sequence_number: "40" } } });

  it("detects a checkpoint timestamp that disagrees with GraphQL", async () => {
    const { checks, rows } = harness({ gql, tool: (_, a) => (a.timestamp ? byTime("39") : { ...byNumber, timestamp: "2026-09-01T00:00:01.500Z" }) });
    await checks.checkpoint(0, 40);
    expect(rows).toMatchObject([{ id: "l", status: "disagree" }]);
    expect(rows[0].detail.problems).toEqual([{ field: "timestamp", ours: Date.parse("2026-09-01T00:00:01.500Z"), chain: Date.parse("2026-09-01T00:00:00.500Z") }]);
  });

  it("checks the edges a time resolves to", async () => {
    const good = harness({ gql, tool: (_, a) => (a.timestamp ? byTime("39") : byNumber) });
    await good.checks.checkpoint(0, 40);
    expect(good.rows).toMatchObject([{ id: "l", status: "agree" }]);
    const bad = harness({ gql, tool: (_, a) => (a.timestamp ? byTime("38") : byNumber) });
    await bad.checks.checkpoint(0, 40);
    expect(bad.rows[0].detail.problems).toEqual([{ field: "by_time.last_before", ours: "38", chain: "39" }]);
  });
});
