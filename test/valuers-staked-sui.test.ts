import { describe, it, expect, vi, beforeEach } from "vitest";

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const STAKED = "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::StakedSui";
const FUNGIBLE = "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::FungibleStakedSui";

// Synthetic system: pool a1 active, pool b2 inactive since epoch 8,
// pool c3 pending, pool d4 unknown to the system.
const POOL_ACTIVE = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const POOL_INACTIVE = "0x00000000000000000000000000000000000000000000000000000000000000b2";
const POOL_PENDING = "0x00000000000000000000000000000000000000000000000000000000000000c3";
const POOL_UNKNOWN = "0x00000000000000000000000000000000000000000000000000000000000000d4";
const RATES_A = "0x00000000000000000000000000000000000000000000000000000000000000e1";
const RATES_B = "0x00000000000000000000000000000000000000000000000000000000000000e2";
const INACTIVE_TABLE = "0x00000000000000000000000000000000000000000000000000000000000000f1";
const MAPPINGS_TABLE = "0x00000000000000000000000000000000000000000000000000000000000000f2";
const WRAPPER_INNER = "0x00000000000000000000000000000000000000000000000000000000000000f3";

/** Epoch -> [sui_amount, pool_token_amount]. Pool a1 has no entry at epoch 10. */
const RATES: Record<string, Record<number, [bigint, bigint]>> = {
  [RATES_A]: { 5: [1000n, 1000n], 9: [1200n, 1000n], 11: [1300n, 1000n] },
  [RATES_B]: { 2: [1000n, 1000n], 8: [1500n, 1000n], 10: [9000n, 1000n] },
};

const u64 = (bcs: string) => Number(Buffer.from(bcs, "base64").readBigUInt64LE());
const id = (bcs: string) => `0x${Buffer.from(bcs, "base64").toString("hex")}`;

const gqlQuery = vi.fn(async (query: string, vars: Record<string, unknown> = {}) => {
  if (query.includes("checkpoint(sequenceNumber")) {
    return { checkpoint: { timestamp: "2024-08-10T00:00:00.000Z", epoch: { epochId: 10 } } };
  }
  if (query.includes("validatorSet")) {
    return {
      epoch: {
        validatorSet: {
          contents: {
            json: {
              active_validators: [
                { staking_pool: { id: POOL_ACTIVE, activation_epoch: "0", deactivation_epoch: null, exchange_rates: { id: RATES_A } } },
              ],
              inactive_validators: { id: INACTIVE_TABLE },
              staking_pool_mappings: { id: MAPPINGS_TABLE },
            },
          },
        },
      },
    };
  }
  if (query.includes("multiGetDynamicFields")) {
    const table = RATES[vars.id as string] ?? {};
    return {
      address: {
        multiGetDynamicFields: (vars.keys as Array<{ bcs: string }>).map((k) => {
          const r = table[u64(k.bcs)];
          return r ? { value: { json: { sui_amount: r[0].toString(), pool_token_amount: r[1].toString() } } } : null;
        }),
      },
    };
  }
  if (query.includes("dynamicField(name")) {
    const key = vars.k as { type: string; bcs: string };
    let json: unknown = null;
    if (vars.id === INACTIVE_TABLE && id(key.bcs) === POOL_INACTIVE) json = { inner: { id: WRAPPER_INNER, version: "1" } };
    if (vars.id === WRAPPER_INNER && u64(key.bcs) === 1) {
      json = { staking_pool: { id: POOL_INACTIVE, activation_epoch: "2", deactivation_epoch: "8", exchange_rates: { id: RATES_B } } };
    }
    if (vars.id === MAPPINGS_TABLE && id(key.bcs) === POOL_PENDING) json = "0x0000000000000000000000000000000000000000000000000000000000000abc";
    return { address: { dynamicField: json === null ? null : { value: { json } } } };
  }
  if (query.includes("epoch { epochId }")) return { epoch: { epochId: 11 } };
  throw new Error(`unexpected query: ${query}`);
});
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

let suiPrice: number | null = 2;
const priceUsdAtTime = vi.fn(async (types: string[], at?: number) => ({
  points: new Map(suiPrice === null ? [] : types.map((t) => [t, { price: suiPrice!, publishTime: at ?? 0, source: "defillama" as const }])),
  unpriced: suiPrice === null ? types.map((t) => ({ coin_type: t, code: "not_listed" as const, reason: "no price" })) : [],
}));
vi.mock("../src/utils/valuation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/valuation.js")>()),
  priceUsdAtTime,
  prefetchCoinScale: async () => undefined,
}));

// Imported after the mocks above, which the factories close over.
const { stakeWorth, estimateStakedSuiRewards } = await import("../src/utils/valuers/staked-sui.js");
const { valueObjects } = await import("../src/utils/position-value.js");

const stake = (pool: string, principal: string, activation: string) => ({
  object_id: "0x00000000000000000000000000000000000000000000000000000000000005a1",
  type: STAKED,
  json: { pool_id: pool, principal, stake_activation_epoch: activation },
});

const legs = (p: { assets: Array<{ side: string; amount: string }> }) => Object.fromEntries(p.assets.map((a) => [a.side, a.amount]));

describe("stakeWorth", () => {
  it("converts the principal to pool tokens at activation and back at the epoch, rounding down each step", () => {
    // 1000 SUI at 3:2 is 666 tokens; 666 tokens at 2:1 is 1332 SUI.
    const r = stakeWorth(1000n, 5, 9, { sui_amount: 3n, pool_token_amount: 2n }, { sui_amount: 2n, pool_token_amount: 1n });
    expect(r).toEqual({ principal: 1000n, reward: 332n });
  });

  it("gives no reward to a stake that activates after the epoch", () => {
    expect(stakeWorth(1000n, 12, 11, { sui_amount: 1n, pool_token_amount: 1n }, { sui_amount: 5n, pool_token_amount: 1n }).reward).toBe(0n);
  });

  it("never gives a negative reward", () => {
    expect(stakeWorth(1000n, 5, 9, { sui_amount: 2n, pool_token_amount: 1n }, { sui_amount: 1n, pool_token_amount: 1n }).reward).toBe(0n);
  });
});

describe("historical stake rewards", () => {
  const position = (pool = POOL_ACTIVE, activation = "5") => ({
    object_id: "0xstake", pool_id: pool, principal_mist: "1000", stake_activation_epoch: activation,
  });

  it("uses the requested epoch's rate rather than a later rate", async () => {
    const rewards = await estimateStakedSuiRewards([position()], 9);
    expect(rewards.get("0xstake")).toBe("200");
  });

  it("leaves a missing historical rate unknown rather than using the latest", async () => {
    const rewards = await estimateStakedSuiRewards([position()], 10);
    expect(rewards.get("0xstake")).toBeNull();
  });

  it("clamps inactive pools to their deactivation epoch", async () => {
    const rewards = await estimateStakedSuiRewards([position(POOL_INACTIVE, "2")], 10);
    expect(rewards.get("0xstake")).toBe("500");
  });

  it("assigns zero rewards before activation without a future rate", async () => {
    const rewards = await estimateStakedSuiRewards([position(POOL_ACTIVE, "12")], 9);
    expect(rewards.get("0xstake")).toBe("0");
  });
});

describe("staked_sui valuer", () => {
  beforeEach(() => {
    suiPrice = 2;
    priceUsdAtTime.mockClear();
  });

  it("values a stake at a checkpoint's epoch, taking the latest rate at or below it", async () => {
    const r = await valueObjects([stake(POOL_ACTIVE, "1000000000000", "5")], { owner: "0x1", atCheckpoint: "100" });
    // Epoch 10 has no entry, so epoch 9's 1.2 applies, not epoch 11's.
    expect(legs(r.positions[0])).toEqual({ stake: "1000000000000", reward: "200000000000" });
    expect(r.positions[0].usd_net).toBeCloseTo(2400);
    // The SUI price is asked for at the checkpoint's time.
    expect(priceUsdAtTime).toHaveBeenCalledWith([SUI], Date.parse("2024-08-10T00:00:00.000Z") / 1000);
  });

  it("values at the current epoch when no checkpoint is given", async () => {
    const r = await valueObjects([stake(POOL_ACTIVE, "1000000000000", "5")], { owner: "0x1" });
    expect(legs(r.positions[0]).reward).toBe("300000000000");
  });

  it("clamps an inactive validator's rate to its deactivation epoch", async () => {
    const r = await valueObjects([stake(POOL_INACTIVE, "1000000000000", "2")], { owner: "0x1", atCheckpoint: "100" });
    expect(legs(r.positions[0])).toEqual({ stake: "1000000000000", reward: "500000000000" });
  });

  it("values a pending validator's stake at its principal", async () => {
    const r = await valueObjects([stake(POOL_PENDING, "7000000000", "11")], { owner: "0x1", atCheckpoint: "100" });
    expect(r.positions[0].assets.reduce((s, a) => s + BigInt(a.amount), 0n)).toBe(7000000000n);
  });

  it("lists a stake whose pool the system does not know as unread", async () => {
    const r = await valueObjects([stake(POOL_UNKNOWN, "1000", "5")], { owner: "0x1", atCheckpoint: "100" });
    expect(r.positions).toEqual([]);
    expect(r.unread.map((u) => u.what)).toEqual(["0x00000000000000000000000000000000000000000000000000000000000005a1"]);
  });

  it("converts fungible staked SUI's pool tokens at the epoch rate", async () => {
    const r = await valueObjects(
      [{ object_id: "0x00000000000000000000000000000000000000000000000000000000000005a2", type: FUNGIBLE, json: { pool_id: POOL_ACTIVE, value: "1000" } }],
      { owner: "0x1", atCheckpoint: "100" },
    );
    expect(legs(r.positions[0])).toEqual({ stake: "1200" });
  });

  it("leaves the net unpriced, with a reason, when SUI has no price", async () => {
    suiPrice = null;
    const r = await valueObjects([stake(POOL_ACTIVE, "1000000000000", "5")], { owner: "0x1", atCheckpoint: "100" });
    expect(r.positions[0].usd_net).toBeNull();
    expect(r.positions[0].unpriced_reason).toBeTruthy();
  });
});
