import { describe, it, expect, vi, beforeEach } from "vitest";
import { bcs } from "@mysten/sui/bcs";
import { deriveDynamicFieldID } from "@mysten/sui/utils";
import { createMockClient } from "./helpers/mock-grpc.js";

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const AFSUI = "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI";
const HASUI = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI";
const VSUI = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";
const SPRINGSUI_PKG = "0xb0575765166030556a6eafd3b1b970eba8183ff748860680245b9edd41c716e7";

// Issuer objects the valuer reads.
const AF_STATE = "0x55486449e41d89cfbdb20e005c1c5c1007858ad5b4d5d7c047d2b3b592fe8791";
const AF_SAFE = "0xeb685899830dd5837b47007809c76d91a098d52aabbf61e8ac467c59e5cc4610";
const HAEDAL = "0x47b224762220393057ebf4f70501b6e657c3e56684737568439a04f80849b2ca";
const VOLO_POOL = "0x2d914e23d82fedef1b5f56a32d5c64bdcc3087ccfea2b4d6ea51a71f587840e5";
const VOLO_NATIVE = "0x7fa2faa111b8c65bea48a23049bfd81ca8f971a262d981dcd9a17c3825cb5baf";
const VOLO_META = "0x680cd26af32b2bde8d3361e804c53ec1d1cfe24c7f039eb7f549e8dfde389a60";

// Synthetic SpringSui-framework LSTs and a plain coin.
const LST_A = "0x00000000000000000000000000000000000000000000000000000000000000a1::a_sui::A_SUI";
const LST_B = "0x00000000000000000000000000000000000000000000000000000000000000a2::b_sui::B_SUI";
const PLAIN = "0x00000000000000000000000000000000000000000000000000000000000000a3::plain::PLAIN";
const INFO_A = "0x00000000000000000000000000000000000000000000000000000000000000b1";
const INFO_B = "0x00000000000000000000000000000000000000000000000000000000000000b2";
const NATIVE_TABLE = "0x00000000000000000000000000000000000000000000000000000000000000c1";
const OWNER = "0x00000000000000000000000000000000000000000000000000000000000000d1";

const springInfo = (id: string, sui: string, lst: string, spread?: string) => ({
  id,
  lst_treasury_cap: { id: "0x1", total_supply: { value: lst } },
  ...(spread === undefined ? {} : { accrued_spread_fees: spread }),
  storage: { sui_pool: "0", total_sui_supply: sui, last_refresh_epoch: "1" },
});

/** Object states by id; `@<checkpoint>` entries answer reads at that checkpoint. */
let states: Record<string, Record<string, unknown> | null> = {};

const gqlQuery = vi.fn(async (query: string, vars: Record<string, unknown> = {}) => {
  if (query.includes("checkpoint(sequenceNumber")) {
    return { checkpoint: { timestamp: "2024-08-10T00:00:00.000Z", epoch: { epochId: 10 } } };
  }
  if (query.includes("objects(filter")) {
    // Two pages of LiquidStakingInfo objects.
    const first = vars.after === null || vars.after === undefined;
    const node = (id: string, coin: string) => ({ address: id, asMoveObject: { contents: { type: { repr: `${SPRINGSUI_PKG}::liquid_staking::LiquidStakingInfo<${coin}>` } } } });
    return {
      objects: first
        ? { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node(INFO_A, LST_A)] }
        : { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(INFO_B, LST_B)] },
    };
  }
  if (query.includes("multiGetObjects")) {
    const keys = vars.keys as Array<{ address: string; atCheckpoint?: number }>;
    return {
      multiGetObjects: keys.map((k) => {
        const json = k.atCheckpoint === undefined ? states[k.address] : states[`${k.address}@${k.atCheckpoint}`];
        return json ? { address: k.address, version: 1, asMoveObject: { contents: { type: { repr: "0x1::m::T" }, json } } } : null;
      }),
    };
  }
  throw new Error(`unexpected query: ${query}`);
});
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

const mockSui = createMockClient();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));

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
const lst = await import("../src/utils/valuers/lst.js");
const { valuePositions } = await import("../src/utils/position-value.js");

function balances(pages: Array<Array<[string, string]>>) {
  mockSui.listBalances.mockImplementation(async ({ cursor }: { cursor: string | null }) => {
    const i = cursor === null ? 0 : Number(cursor);
    return {
      balances: pages[i].map(([coinType, balance]) => ({ coinType, balance, coinBalance: balance, addressBalance: "0" })),
      hasNextPage: i + 1 < pages.length,
      cursor: i + 1 < pages.length ? String(i + 1) : null,
    };
  });
}

const byCoin = (r: { positions: Array<{ detail?: Record<string, unknown> }> }) =>
  Object.fromEntries(r.positions.map((p) => [p.detail!.lst_coin_type as string, p]));

describe("issuer rates", () => {
  it("SpringSui: amount x (total_sui_supply - accrued_spread_fees) / LST supply, rounded down", () => {
    const r = lst.springSuiRate(springInfo(INFO_A, "1100", "1000", "100"))!;
    expect(r.toSui(7n)).toBe(7n);
    expect(lst.springSuiRate(springInfo(INFO_A, "1100", "1000", "0"))!.toSui(7n)).toBe(7n); // 7.7 rounds down
    // An info object from before the spread field existed has no spread.
    expect(lst.springSuiRate(springInfo(INFO_A, "1500", "1000"))!.toSui(1000n)).toBe(1500n);
    // A zero LST supply makes the issuer abort, so there is no rate.
    expect(lst.springSuiRate(springInfo(INFO_A, "1500", "0"))).toBeNull();
  });

  it("Aftermath: rounds through a 1e18-scaled rate, not the direct ratio", () => {
    const r = lst.aftermathRate({ total_sui_amount: "10" }, { obj: { total_supply: { value: "3" } } })!;
    // rate = floor(10e18 / 3); 3 x rate / 1e18 = 9, where 3 x 10 / 3 would be 10.
    expect(r.toSui(3n)).toBe(9n);
    expect(lst.aftermathRate({ total_sui_amount: "0" }, { obj: { total_supply: { value: "3" } } })!.toSui(5n)).toBe(0n);
  });

  it("Haedal: total_staked + total_rewards - fees - uncollected fees - total_unstaked over stsui_supply", () => {
    const staking = {
      total_staked: "2000",
      total_rewards: "300",
      total_protocol_fees: "50",
      uncollected_protocol_fees: "50",
      total_unstaked: "400",
      stsui_supply: "1000",
    };
    const r = lst.haedalRate(staking)!;
    expect(r.total_sui).toBe(1800n);
    expect(r.toSui(1000n)).toBe(1800n);
    // A zero supply is 1:1.
    expect(lst.haedalRate({ ...staking, stsui_supply: "0" })!.toSui(123n)).toBe(123n);
  });

  it("Volo StakePool: subtracts accrued_reward_fees and the excluded CERT supply", () => {
    const pool = { validator_pool: { total_sui_supply: "3100" }, accrued_reward_fees: "100" };
    const meta = { total_supply: { value: (lst.VOLO_EXCLUDED_SUPPLY + 2000n).toString() } };
    expect(lst.voloStakePoolRate(pool, meta)!.toSui(1000n)).toBe(1500n);
  });

  it("Volo NativePool: from_shares over the whole CERT supply through a 1e18 ratio", () => {
    const pool = { pending: { balance: "5" }, total_rewards: "20", collected_rewards: "5", ticket_metadata: { total_supply: "5" } };
    const r = lst.voloNativePoolRate(pool, 100n, { total_supply: { value: "100" } })!;
    // total = 100 + 5 + 20 - 5 - 5.
    expect(r.total_sui).toBe(115n);
    expect(r.toSui(100n)).toBe(115n);
    // ratio = floor(3e18 / (1e18 + 1)) = 2, so 2 CERT is 2 x 1e18 / 2, far from the direct 2 x (1e18 + 1) / 3.
    const coarse = lst.voloNativePoolRate({ ...pool, total_rewards: "5" }, 10n ** 18n + 1n, { total_supply: { value: "3" } })!;
    expect(coarse.toSui(2n)).toBe(10n ** 18n);
  });
});

describe("lst valuer", () => {
  beforeEach(() => {
    suiPrice = 2;
    gqlQuery.mockClear();
    priceUsdAtTime.mockClear();
    lst.resetLstIssuers();
    states = {
      [INFO_A]: springInfo(INFO_A, "1500000000000", "1000000000000"),
      [INFO_B]: springInfo(INFO_B, "3000000000000", "1000000000000", "1000000000000"),
      [AF_STATE]: { total_sui_amount: "1100000000000" },
      [AF_SAFE]: { obj: { total_supply: { value: "1000000000000" } } },
      [HAEDAL]: {
        total_staked: "1200000000000",
        total_rewards: "0",
        total_protocol_fees: "0",
        uncollected_protocol_fees: "0",
        total_unstaked: "0",
        stsui_supply: "1000000000000",
      },
      [VOLO_POOL]: { validator_pool: { total_sui_supply: "1300000000000" }, accrued_reward_fees: "0" },
      [VOLO_META]: { total_supply: { value: (lst.VOLO_EXCLUDED_SUPPLY + 1000000000000n).toString() } },
    };
  });

  it("values every held LST at its issuer's rate across balance pages and ignores other coins", async () => {
    balances([
      [
        [SUI, "5000000000"],
        [AFSUI, "2000000000"],
        [PLAIN, "9000000000"],
      ],
      [
        [LST_B, "1000000000"],
        [HASUI, "0"],
        [VSUI, "1000000000"],
      ],
    ]);
    const r = await valuePositions({ owner: OWNER }, ["lst"]);
    expect(r.unread).toEqual([]);
    const p = byCoin(r);
    expect(Object.keys(p).sort()).toEqual([AFSUI, LST_B, VSUI].sort());
    expect(p[AFSUI]).toMatchObject({ protocol: "Aftermath", kind: "lst", object_id: null, assets: [{ coin_type: SUI, amount: "2200000000", side: "stake" }] });
    // Info B: (3000 - 1000) / 1000.
    expect(p[LST_B]).toMatchObject({ protocol: "SpringSui", assets: [{ amount: "2000000000" }] });
    expect(p[LST_B].detail).toMatchObject({ lst_amount: "1000000000", sui_per_lst: 2, issuer_object: INFO_B, receipt_coin_types: [LST_B] });
    expect(p[VSUI]).toMatchObject({ protocol: "Volo", assets: [{ amount: "1300000000" }] });
    expect((p[AFSUI] as { usd_net: number }).usd_net).toBeCloseTo(4.4);
  });

  it("reads issuers at the checkpoint and falls back to the Volo NativePool before the StakePool existed", async () => {
    balances([[[VSUI, "1000000000"], [LST_A, "1000000000"]]]);
    const entry = deriveDynamicFieldID(NATIVE_TABLE, "u64", bcs.u64().serialize(7n).toBytes());
    Object.assign(states, {
      [`${VOLO_META}@123`]: { total_supply: { value: "1000000000000" } },
      [`${VOLO_NATIVE}@123`]: {
        paused: false,
        staked_update_epoch: "7",
        total_staked: { id: NATIVE_TABLE },
        pending: { balance: "0" },
        total_rewards: "100000000000",
        collected_rewards: "0",
        ticket_metadata: { total_supply: "0" },
      },
      [`${entry}@123`]: { id: entry, name: "7", value: "1000000000000" },
      [`${INFO_A}@123`]: springInfo(INFO_A, "1200000000000", "1000000000000"),
    });
    const r = await valuePositions({ owner: OWNER, atCheckpoint: "123" }, ["lst"]);
    expect(r.unread).toEqual([]);
    const p = byCoin(r);
    // NativePool total 1100 over supply 1000, not the StakePool's latest 1.3.
    expect(p[VSUI].detail).toMatchObject({ issuer_object: VOLO_NATIVE });
    expect(p[VSUI].assets).toMatchObject([{ amount: "1100000000" }]);
    // SpringSui at the checkpoint's 1.2, not the latest 1.5.
    expect(p[LST_A].assets).toMatchObject([{ amount: "1200000000" }]);
    const reads = gqlQuery.mock.calls.filter(([q]) => q.includes("multiGetObjects")).flatMap(([, v]) => (v as { keys: Array<{ address: string; atCheckpoint?: number }> }).keys);
    expect(reads).toContainEqual({ address: INFO_A, atCheckpoint: 123 });
    expect(reads).toContainEqual({ address: entry, atCheckpoint: 123 });
    expect(priceUsdAtTime).toHaveBeenCalledWith([SUI], Date.parse("2024-08-10T00:00:00.000Z") / 1000);
  });

  it("uses the latest state and says so when an issuer cannot be read at the checkpoint", async () => {
    balances([[[HASUI, "1000000000"]]]);
    const r = await lst.suiPerLst(HASUI, "123");
    expect(r).toMatchObject({ sui_per_lst: 1.2, issuer: "Haedal", issuer_object: HAEDAL, current: true });
  });

  it("lists an unreadable issuer as unread and keeps the others", async () => {
    balances([[[HASUI, "1000000000"], [AFSUI, "1000000000"]]]);
    states[HAEDAL] = null;
    const r = await valuePositions({ owner: OWNER }, ["lst"]);
    expect(Object.keys(byCoin(r))).toEqual([AFSUI]);
    expect(r.unread).toHaveLength(1);
    expect(r.unread[0].what).toBe(HASUI);
  });

  it("leaves USD null with a reason when SUI has no price", async () => {
    suiPrice = null;
    balances([[[AFSUI, "1000000000"]]]);
    const r = await valuePositions({ owner: OWNER }, ["lst"]);
    expect(r.positions[0].usd_net).toBeNull();
    expect(r.positions[0].unpriced_reason).toBeTruthy();
    expect(r.positions[0].assets[0].amount).toBe("1100000000");
  });

  it("suiPerLst finds SpringSui LSTs and returns null for other coins", async () => {
    expect(await lst.suiPerLst(PLAIN)).toBeNull();
    expect(await lst.suiPerLst(LST_A)).toMatchObject({ sui_per_lst: 1.5, issuer: "SpringSui", issuer_object: INFO_A, current: false });
  });
});
