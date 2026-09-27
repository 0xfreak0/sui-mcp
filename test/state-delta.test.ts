import { describe, it, expect } from "vitest";
import { compareStates, numericFields, stateAnomaly, type ObjectState, type StateSnapshot } from "../src/utils/state-delta.js";
import type { AttackBalanceChange, AttackInput } from "../src/utils/attack-analysis.js";

const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const balanceField = (coin: string) => `0x2::dynamic_field::Field<0x1::type_name::TypeName,0x2::balance::Balance<${coin}>>`;

const snap = (objects: ObjectState[]): StateSnapshot => ({ objects, skipped: [], unavailable: [], layout_unread: [] });
const shared = (objectId: string, objectType: string, before: unknown, after: unknown, balances: Record<string, string> = {}): ObjectState => ({
  objectId,
  objectType,
  role: "shared",
  parent: null,
  before,
  after,
  balances,
  supplies: {},
});
const holding = (objectId: string, parent: string, coin: string, before: string | null, after: string | null): ObjectState => ({
  objectId,
  objectType: balanceField(coin),
  role: "holding",
  parent,
  before: before === null ? null : { id: objectId, value: before },
  after: after === null ? null : { id: objectId, value: after },
  balances: { value: coin },
  supplies: {},
});
const tx = (balanceChanges: AttackBalanceChange[] = [], inputs: AttackInput[] = []) => ({ balanceChanges, inputs });

describe("numericFields", () => {
  it("reads nested numbers by path, but not list entries or two's-complement ints", () => {
    const f = numericFields({ price: "5", nested: { value: "7" }, list: ["1", "2"], tick: { bits: 4294967196 }, name: "x" });
    expect([...f]).toEqual([
      ["price", 5n],
      ["nested.value", 7n],
    ]);
  });
});

describe("compareStates", () => {
  // Nemo exploit 19Zkat1x…: PyState 0xc6840365…, index set to 30000 << 64 by
  // a u128 the caller passed to fixed_point64::create_from_raw_value.
  const PY = "0xc6840365f500bee8732a3a256344a11343936b864c144b7e9de5bb8c54224fbe";
  const PY_TYPE = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4::py::PyState<0x53a8c1ffcdac36d993ce3c454d001eca57224541d1953d827ef96ac6d7f8142e::sSUI::SSUI>";

  it("flags a stored index that jumps 100x or more, high when it equals a value the caller passed", () => {
    const state = snap([
      shared(PY, PY_TYPE, { py_index_stored: { value: "19906979018978642498" } }, { py_index_stored: { value: "553402322211286548480000" } }),
    ]);
    const caller = [{ objectId: null, bytes: 16, values: ["553402322211286548480000"] }];
    const f = compareStates(tx([], caller), state);
    expect(f.jumps).toEqual([expect.objectContaining({ object: PY, field: "py_index_stored.value", caller_value: true, source: "state" })]);
    expect(stateAnomaly(f, state)?.severity).toBe("high");
    expect(stateAnomaly(compareStates(tx(), state), state)?.severity).toBe("medium");
  });

  it("ignores ordinary moves, moves to or from zero, and signed values stored as two's complement", () => {
    // Aftermath's ClearingHouse spread_twap on 2ApEeAaQ… crosses zero as a
    // two's-complement u256; an LB pair's volatility accumulator resets.
    const state = snap([
      shared(
        "0xe1c5f5c6",
        "0xpkg::clearing_house::ClearingHouse",
        { spread_twap: "115792089237316195423570985008687907853269984665640564039457583210064804166828", volatility_accumulator: "16", price: "1000" },
        { spread_twap: "262748860576979", volatility_accumulator: "0", price: "1090" },
      ),
    ]);
    const f = compareStates(tx(), state);
    expect(f.jumps).toEqual([]);
    expect(stateAnomaly(f, state)).toBeNull();
  });

  it("flags a drained Balance<T> holding, high when addresses received most of what left", () => {
    // Scallop exploit 6WNDjCX3…: the RewardsPool's SUI balance field, and the
    // attacker's gain net of gas.
    const POOL = "0x162250ef72393a4ad3d46294c4e1bdfcb03f04c869d390e7efbfc995353a7ee9";
    const state = snap([
      shared(POOL, "0xe87f::rewards_pool::RewardsPool<0x2::sui::SUI>", { rewards: "0" }, { rewards: "0" }, { rewards: SUI }),
      holding("0xeb92a6590daf1b37666ce8b2e35d241741c323dee20a4c40abb49350ae658380", POOL, SUI, "150098061595978", "0"),
    ]);
    const attacker = "0x27bc7a3c4f406cfa91551c32490ad7f5029414578c0649ab4ddbd232e76ef44e";
    const f = compareStates(tx([{ address: attacker, coinType: SUI, amount: "150098051263289" }]), state);
    expect(f.drops).toEqual([expect.objectContaining({ holder: POOL, coin_type: SUI, before: "150098061595978", after: "0", paid_to: [attacker] })]);
    expect(stateAnomaly(f, state)?.severity).toBe("high");
  });

  it("grades a drained balance info when its holder took back in other coins nearly all it paid out, a rebalance", () => {
    // A667WCrJ…: a market-maker pool sold 1,332 USDC of its reserve for
    // 1,789 SUI; the keeper's wallet received the USDC.
    const POOL = "0x21167b2e981e2c0a693afcfe882a3a827d663118e19afcb92e45bfe43fe56278";
    const BAG = "0x22f7317320614f6d1820feeb0a4546dd96a0dac45b1aa3040fdca6d68e8d2e69";
    const state = snap([
      shared(POOL, "0xc872::pool::LiquidityPool<0x2::sui::SUI>", { base_reserve: "2287832378461", bag: { id: BAG } }, { base_reserve: "4077713808762", bag: { id: BAG } }, { base_reserve: SUI }),
      holding("0x08b84706b32409d5543ff7dad5d35ca7a79e30425bbb90985a3f148b91a8b2f1", BAG, USDC, "1332435473", "133244"),
    ]);
    const keeper = "0xbe04f5bf01bdaabf4ff5eaf18d78d3a393a4c7c5740401fd49110ad119ba5369";
    const paid = tx([{ address: keeper, coinType: USDC, amount: "1332302229" }]);
    const prices = new Map([
      [SUI, { price: 1, publishTime: 0, source: "defillama" as const, decimals: 9 }],
      [USDC, { price: 1, publishTime: 0, source: "defillama" as const, decimals: 6 }],
    ]);
    // Without prices the conversion cannot be told from a payout.
    expect(stateAnomaly(compareStates(paid, state), state)?.severity).toBe("high");
    const f = compareStates(paid, state, [], prices);
    expect(f.drops).toEqual([expect.objectContaining({ holder: POOL, coin_type: USDC, paid_to: [], offset_by: [SUI] })]);
    expect(stateAnomaly(f, state)?.severity).toBe("info");
  });

  const ETH = "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH";
  const PRICES = new Map([
    [SUI, { price: 1, publishTime: 0, source: "defillama" as const, decimals: 9 }],
    [USDC, { price: 1, publishTime: 0, source: "defillama" as const, decimals: 6 }],
    [ETH, { price: 1000, publishTime: 0, source: "defillama" as const, decimals: 8 }],
  ]);
  const ATTACKER = "0x27bc7a3c4f406cfa91551c32490ad7f5029414578c0649ab4ddbd232e76ef44e";
  const POOL = "0x98110aae0ffaf294259066380a2d35aba74e42860f1e87ee9c201f471eb3ba03";

  it("counts what a holder took back once across all its drained coins, and needs nearly all of it back to call it a conversion", () => {
    // $1,000 of USDC and $1,000 of ETH drained, $600 of SUI taken in.
    const state = snap([
      shared(POOL, "0xe279::lp_pool::LiquidityPool", {}, {}),
      holding(`0x${"a1".repeat(32)}`, POOL, USDC, "1000000000", "0"),
      holding(`0x${"a2".repeat(32)}`, POOL, ETH, "100000000", "0"),
      holding(`0x${"a3".repeat(32)}`, POOL, SUI, "1000000000", "601000000000"),
    ]);
    const paid = tx([
      { address: ATTACKER, coinType: USDC, amount: "1000000000" },
      { address: ATTACKER, coinType: ETH, amount: "100000000" },
      { address: ATTACKER, coinType: SUI, amount: "-600000000000" },
    ]);
    const f = compareStates(paid, state, [], PRICES);
    expect(f.drops.map((d) => [d.coin_type, d.offset_by ?? null, d.paid_to])).toEqual([
      [USDC, null, [ATTACKER]],
      [ETH, null, [ATTACKER]],
    ]);
    expect(stateAnomaly(f, state)?.severity).toBe("high");
  });

  it("counts a drain as paid out when addresses gained its value in another coin, a drain swapped inside the PTB", () => {
    // A vault's 5M USDC goes into another pool; the attacker ends with 5M
    // worth of SUI.
    const VAULT = `0x${"b1".repeat(32)}`;
    const state = snap([shared(VAULT, "0xv::vault::Vault", { usdc: "5000000000000" }, { usdc: "0" }, { usdc: USDC })]);
    const f = compareStates(tx([{ address: ATTACKER, coinType: SUI, amount: "5000000000000000" }]), state, [], PRICES);
    expect(f.drops).toEqual([expect.objectContaining({ holder: VAULT, paid_to: [ATTACKER] })]);
    expect(stateAnomaly(f, state)?.severity).toBe("high");
  });

  it("keeps a listed pool's dynamic-field holdings under the pool, not under the registry that lists it", () => {
    // S1 lists S2 by id and keeps its own USDC fees; S2's USDC field is drained.
    const S1 = `0x${"c1".repeat(32)}`;
    const S2 = `0x${"c2".repeat(32)}`;
    const registry = shared(S1, "0xr::registry::Registry", { pools: [S2], fees: "1000000000000" }, { pools: [S2], fees: "1000000000000" }, { fees: USDC });
    const pool = shared(S2, "0xr::pool::Pool", { id: S2 }, { id: S2 });
    const field = holding(`0x${"c3".repeat(32)}`, S2, USDC, "5000000000", "0");
    const paid = tx([{ address: ATTACKER, coinType: USDC, amount: "5000000000" }]);
    for (const order of [[registry, pool, field], [pool, registry, field]]) {
      const f = compareStates(paid, snap(order));
      expect(f.drops).toEqual([expect.objectContaining({ holder: S2, before: "5000000000", after: "0", paid_to: [ATTACKER] })]);
    }
  });

  it("grades a drained balance info when no address received it, the shape of a staking pool's buffer being staked", () => {
    // SpringSui's LiquidStakingInfo on DJNPS2Bv…: storage.sui_pool staked out
    // to validators while the route's user gained 20 SUI.
    const LST = "0x1adb343ab351458e151bc392fbf1558b3332467f23bda45ae67cd355a57fd5f5";
    const state = snap([
      shared(LST, "0xc35e::liquid_staking::LiquidStakingInfo<0xd1b7::x::X>", { storage: { sui_pool: "320127819358976" } }, { storage: { sui_pool: "684809" } }, { "storage.sui_pool": SUI }),
    ]);
    const f = compareStates(tx([{ address: "0xb9345655", coinType: SUI, amount: "20527931216" }]), state);
    expect(f.jumps).toEqual([]);
    expect(f.drops).toEqual([expect.objectContaining({ holder: LST, paid_to: [] })]);
    expect(stateAnomaly(f, state)?.severity).toBe("info");
  });

  it("nets a balance moved between two dynamic fields of the same object", () => {
    // Typus keeper delivery HLMewZq1…: a vault's USDC moved from one balance
    // field (emptied) to another (created) under the same owner.
    const OWNER = "0xb1b5da40";
    const state = snap([
      holding("0x49308c04", OWNER, USDC, "2018750783", "0"),
      holding("0x2a1fde97", OWNER, USDC, null, "2018750783"),
    ]);
    expect(compareStates(tx(), state).drops).toEqual([]);
  });

  it("flags a holder losing most of its priced value to addresses under the 100x factor, and not a partial withdrawal", () => {
    // Aftermath Perpetuals 531W14qr…: the ClearingHouse's USDC collateral fell
    // 282,160.999626 -> 20,393.806351 (13.8x, the accrued fees stayed) and the
    // attacker gained 261,652.224099.
    const CH = "0x95969906ca735c9d44e8a44b5b7791b4dacaddf70fbdfbda40ccd3f8a9fd4920";
    const ATTACKER_A = "0x1a65086c85114c1a3f8dc74140115c6e18438d48d33a21fd112311561112d41e";
    const vault = (after: string) =>
      snap([shared(CH, "0x21d0::clearing_house::ClearingHouse<USDC>", { vault: { collateral_balance: "282160999626" } }, { vault: { collateral_balance: after } }, { "vault.collateral_balance": USDC })]);
    const paid = (amount: string) => tx([{ address: ATTACKER_A, coinType: USDC, amount }]);
    const drained = vault("20393806351");
    const f = compareStates(paid("261652224099"), drained, [], PRICES);
    expect(f.drops).toEqual([expect.objectContaining({ holder: CH, paid_to: [ATTACKER_A], value_share_lost: 0.9277 })]);
    expect(stateAnomaly(f, drained)?.severity).toBe("high");
    // Unpriced, the share of value is unknown and the 100x factor alone applies.
    expect(compareStates(paid("261652224099"), drained).drops).toEqual([]);
    // Addresses gained less than half of what left: it moved into other objects.
    expect(compareStates(paid("100000000000"), drained, [], PRICES).drops).toEqual([]);
    // A withdrawal of 40% of the vault is ordinary.
    const partial = vault("169296599776");
    expect(compareStates(paid("112864399850"), partial, [], PRICES).drops).toEqual([]);
  });

  it("flags a value taken from an object other than the one it references", () => {
    // Scallop exploit 6WNDjCX3…: the new SpoolAccount belongs to the sSUI
    // spool (spool_id), but its index is the dormant sWETH spool's.
    const SSUI_SPOOL = "0x4f0ba970d3c11db05c8f40c64a15b6a33322db3702d634ced6536960ab6f3ee4";
    const DONOR = "0xeec40beccb07c575bebd842eeaabb835f77cd3dab73add433477e57f583a6787";
    const SPOOL = "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a::spool::Spool";
    const account: ObjectState = {
      objectId: "0x2a710b62bf4f905546489d6f9bc4428b0dfba92532a7c04be519e97cdc0fbda0",
      objectType: "0xe87f::spool_account::SpoolAccount<0xefe8::reserve::MarketCoin<0x2::sui::SUI>>",
      role: "created",
      parent: null,
      before: null,
      after: { index: "891301263052871", points: "11921828182319", spool_id: SSUI_SPOOL, stakes: "0" },
      balances: {},
      supplies: {},
    };
    const state = snap([
      shared(SSUI_SPOOL, SPOOL, { index: "1191219615" }, { index: "1191219615" }),
      shared(DONOR, SPOOL, { index: "891301263052871" }, { index: "891301263052871" }),
      account,
    ]);
    const f = compareStates(tx(), state);
    expect(f.wrong_source).toEqual([
      expect.objectContaining({ field: "index", value: "891301263052871", equals_field_of: DONOR, references: SSUI_SPOOL, references_value: "1191219615" }),
    ]);
    expect(stateAnomaly(f, state)?.severity).toBe("high");
    // Taken from the spool it references, the same value is ordinary.
    const bound = { ...account, after: { ...(account.after as object), spool_id: DONOR } };
    expect(compareStates(tx(), snap([...state.objects.slice(0, 2), bound])).wrong_source).toEqual([]);
  });
});
