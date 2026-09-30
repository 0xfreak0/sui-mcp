import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AttackBalanceChange, AttackTx } from "../../src/utils/attack-analysis.js";
import { canonicalId } from "../../src/utils/attack-analysis.js";
import type { ObjectMovement } from "../../src/utils/object-flow.js";
import { resetWindowPriceCache } from "../../src/utils/window-prices.js";

/**
 * Objects a transaction moved count in who gained and lost: a victim-signed
 * drain of valued objects names the recipient, not the signer.
 */

const { mockReadAttackTransactions, mockPriceUsdAtTime } = vi.hoisted(() => ({
  mockReadAttackTransactions: vi.fn(),
  mockPriceUsdAtTime: vi.fn(),
}));

vi.mock("../../src/utils/attack-read.js", () => ({ readAttackTransactions: mockReadAttackTransactions, digestsSentBy: vi.fn() }));
vi.mock("../../src/utils/valuation.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  priceUsdAtTime: mockPriceUsdAtTime,
}));
// The real readers are replaced by the synthetic one registered below, and
// object states come back as read.
vi.mock("../../src/utils/valuers/index.js", () => ({}));
vi.mock("../../src/utils/valuers/common.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prefetchCheckpoints: async () => undefined,
  readObjectVersions: async (keys: Array<{ object_id: string; version: string }>) =>
    new Map(keys.map((k) => [`${k.object_id}@${k.version}`, { object_id: k.object_id, version: k.version, type: "", json: {}, current: false }])),
}));

const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const UNLISTED = "0xnotoken::mytoken::MYTOKEN";
// A decoy coin from a package on the shipped wallet blocklist.
const DECOY = "0x9dfaaa9c382e379c6dd3b28228af0cf3200065ae4a567181b4fe69dfbc884b1a::srt::SRT";
const STAKE_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::StakedSui";

const V = canonicalId("0xa1")!;
const C = canonicalId("0xc1")!;
const D = canonicalId("0xd1")!;
const S1 = canonicalId("0x51")!;
const DIGEST1 = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const DIGEST2 = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

mockPriceUsdAtTime.mockImplementation(async (coinTypes: string[], at = 0) => ({
  points: new Map(coinTypes.filter((c) => c === SUI).map((c) => [c, { price: 1, publishTime: at, source: "defillama" as const, decimals: 9 }])),
  unpriced: coinTypes.filter((c) => c !== SUI).map((c) => ({ coin_type: c, code: "not_listed" as const, reason: "No price." })),
}));

// Imported after the mocks above, which the factories close over.
const { registerValuer } = await import("../../src/utils/position-value.js");
const { registerAttackTools } = await import("../../src/tools/attack.js");

let stakeUsd: number | null = 100;
/** Value by object version, for an object changed in place. */
let byVersion: Record<string, number> = {};
/** Raw SUI a version holds, when its price differs from $1. */
let amountByVersion: Record<string, number> = {};
registerValuer({
  name: "synthetic_stake",
  value: async () => ({ positions: [], unread: [] }),
  handles: (type) => type === STAKE_TYPE,
  valueObject: async (obj) => {
    const usd = obj.version && obj.version in byVersion ? byVersion[obj.version] : stakeUsd;
    return {
      positions: [
        {
          protocol: "Sui staking",
          kind: "staked_sui",
          object_id: obj.object_id,
          // SUI at $1 and 9 decimals, so amounts carry the value.
          assets: [{ coin_type: SUI, amount: String(obj.version && obj.version in amountByVersion ? amountByVersion[obj.version] : Math.round((usd ?? 1) * 1e9)), usd, side: "stake" }],
          usd_net: usd,
          method: "synthetic",
          tier: "price-provider",
        },
      ],
      unread: [],
    };
  },
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
registerAttackTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => (handlers[name] = h) } as never);
const payloadOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[r.content.length - 1].text);

const bc = (address: string, coinType: string, amount: string): AttackBalanceChange => ({ address, coinType, amount });
const move = (kind: ObjectMovement["kind"], from: string | null, to: string | null): ObjectMovement => ({
  object_id: S1,
  type: STAKE_TYPE,
  type_short: "staking_pool::StakedSui",
  kind,
  from: from ? { kind: "address", address: from } : null,
  to: to ? { kind: "address", address: to } : null,
  category: "defi-position",
  high_consequence: false,
});
const tx = (digest: string, sender: string, changes: AttackBalanceChange[], movements: ObjectMovement[]): AttackTx => ({
  digest,
  sender,
  success: true,
  timestampMs: Date.parse("2024-08-10T00:00:00Z"),
  checkpoint: "1000",
  commandKinds: [],
  bcs: null,
  movements,
  gas: null,
  calls: [],
  events: [],
  balanceChanges: changes,
  objects: [{ objectId: S1, objectType: STAKE_TYPE, shared: false, parent: null, inputVersion: "7", outputVersion: "8" }],
});
const read = (txs: AttackTx[]) => ({ txs, missing: [], served_by_archive: 0, events_undecoded: [] });
const drain = (victimGain: AttackBalanceChange) => tx(DIGEST1, V, [bc(V, SUI, "-1000000"), victimGain], [move("transferred", V, C)]);

beforeEach(() => {
  resetWindowPriceCache();
  stakeUsd = 100;
  byVersion = {};
  amountByVersion = {};
  mockReadAttackTransactions.mockReset();
});

describe("analyze_attack_tx weighs moved objects", () => {
  it("names the recipient of a victim-signed drain, with the objects as its gains", async () => {
    mockReadAttackTransactions.mockResolvedValue(read([drain(bc(V, DECOY, "404000000000"))]));
    const payload = payloadOf(await handlers.analyze_attack_tx({ digest: DIGEST1 }));

    expect(payload.profit.address).toBe(C);
    expect(payload.profit.usd_net).toBe(100);
    expect(payload.profit.gains).toEqual([expect.objectContaining({ object_id: S1, usd: 100 })]);
    expect(payload.profit.attacker_defaulted_from_sender.sender).toBe(V);
    expect(payload.addresses.map((a: { address: string }) => a.address)).toContain(C);
    expect(payload.addresses.find((a: { address: string }) => a.address === V).usd_net).toBeLessThan(-99);
  });

  it("lists the objects as the gains of a named attacker", async () => {
    mockReadAttackTransactions.mockResolvedValue(read([drain(bc(V, DECOY, "404000000000"))]));
    const payload = payloadOf(await handlers.analyze_attack_tx({ digest: DIGEST1, attacker: C }));

    expect(payload.profit.gains).toHaveLength(1);
    expect(payload.profit.usd_gained).toBe(100);
  });

  it("explains an unstake's payout by the stake it burned", async () => {
    mockReadAttackTransactions.mockResolvedValue(read([tx(DIGEST2, C, [bc(C, SUI, "100000000000")], [move("deleted", C, null)])]));
    const payload = payloadOf(await handlers.analyze_attack_tx({ digest: DIGEST2 }));

    expect(payload.value_reconciliation.unexplained_usd).toBe(0);
    expect(payload.value_reconciliation.positions_usd).toBe(100);
    expect(payload.anomalies.map((a: { code: string }) => a.code)).not.toContain("unreconciled-gain");
  });

  it("names the collector when another collector took an unpriced coin the signer paid", async () => {
    const t = tx(DIGEST1, V, [bc(V, SUI, "-1000000"), bc(V, DECOY, "404000000000"), bc(V, UNLISTED, "-5"), bc(D, UNLISTED, "5")], [move("transferred", V, C)]);
    mockReadAttackTransactions.mockResolvedValue(read([t]));
    const one = payloadOf(await handlers.analyze_attack_tx({ digest: DIGEST1 }));
    expect(one.profit.address).toBe(C);

    const many = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1] }));
    expect(many.attacker).toBe(C);
  });

  it("keeps the signer when it also took a coin of unknown value that no scam list flags", async () => {
    mockReadAttackTransactions.mockResolvedValue(read([drain(bc(V, UNLISTED, "5"))]));
    const payload = payloadOf(await handlers.analyze_attack_tx({ digest: DIGEST1 }));

    expect(payload.profit.address).toBe(V);
    expect(payload.profit.attacker_defaulted_from_sender).toBeUndefined();
  });

  it("counts the change in value of an object its holder kept", async () => {
    byVersion = { "7": 50, "8": 80 };
    const kept = { ...tx(DIGEST1, C, [bc(C, SUI, "-30000000000")], []), objects: [{ objectId: S1, objectType: STAKE_TYPE, inputVersion: "7", outputVersion: "8", heldBy: C }] };
    mockReadAttackTransactions.mockResolvedValue(read([kept]));
    const payload = payloadOf(await handlers.analyze_attack_tx({ digest: DIGEST1, attacker: C }));

    // 30 SUI at $1 went in, and the position it kept rose by $30.
    expect(payload.profit.usd_net).toBe(0);
    expect(payload.profit.gains).toEqual([expect.objectContaining({ object_id: S1, usd: 30, changed_in_place: true })]);
  });

  it("keeps the signer when the objects it gave away have no price", async () => {
    stakeUsd = null;
    mockReadAttackTransactions.mockResolvedValue(read([drain(bc(V, DECOY, "404000000000"))]));
    const payload = payloadOf(await handlers.analyze_attack_tx({ digest: DIGEST1 }));

    expect(payload.profit.address).toBe(V);
    expect(payload.addresses.find((a: { address: string }) => a.address === C).unpriced_objects).toBe(1);
  });
});

describe("summarize_incident_losses counts the attacker's objects", () => {
  it("defaults to the recipient of victim-signed drains and totals the objects it took", async () => {
    mockReadAttackTransactions.mockResolvedValue(read([drain(bc(V, DECOY, "404000000000"))]));
    const payload = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1] }));

    expect(payload.attacker).toBe(C);
    expect(payload.totals.usd_gained).toBe(100);
    expect(payload.objects).toEqual([expect.objectContaining({ object_id: S1, direction: "in", usd: 100 })]);
  });

  it("keeps an object the attacker hands on out of its totals", async () => {
    mockReadAttackTransactions.mockResolvedValue(
      read([drain(bc(V, DECOY, "404000000000")), tx(DIGEST2, C, [bc(C, SUI, "-1000000")], [move("transferred", C, D)])]),
    );
    const payload = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1, DIGEST2], attacker: C }));

    expect(payload.totals.objects_usd_gained).toBe(100);
    expect(payload.totals.objects_sent_on_usd).toBe(100);
    expect(payload.totals.usd_net).toBe(100);
  });


  it("nets historical object values against the coins paid when consumed", async () => {
    // Received worth $400, consumed worth $360, and the unstake coins worth $360.
    byVersion = { "8": 400, "7": 360 };
    amountByVersion = { "8": 100e9, "7": 100e9 };
    const received = drain(bc(V, DECOY, "404000000000"));
    const unstake = { ...tx(DIGEST2, C, [bc(C, SUI, "100000000000")], [move("deleted", C, null)]), objects: [{ objectId: S1, objectType: STAKE_TYPE, shared: false, parent: null, inputVersion: "7", outputVersion: null }] };
    mockReadAttackTransactions.mockResolvedValue(read([received, unstake]));
    mockPriceUsdAtTime.mockImplementationOnce(async (coinTypes: string[], at: number) => ({
      points: new Map(coinTypes.filter((c) => c === SUI).map((c) => [c, { price: 3.6, publishTime: at, source: "defillama", decimals: 9 }])),
      unpriced: [],
    }));
    const payload = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1, DIGEST2], attacker: C }));

    expect(payload.totals.objects_usd_gained).toBe(40);
    expect(payload.totals.usd_gained).toBe(400);
  });

  it("counts a stake received and later unstaked once, as the coins the unstake paid", async () => {
    mockReadAttackTransactions.mockResolvedValue(
      read([drain(bc(V, DECOY, "404000000000")), tx(DIGEST2, C, [bc(C, SUI, "100000000000")], [move("deleted", C, null)])]),
    );
    const payload = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST1, DIGEST2], attacker: C }));

    expect(payload.totals.usd_gained).toBe(100);
    expect(payload.totals.usd_net).toBe(100);
  });

  it("lists an object wrapped into another object without counting it", async () => {
    mockReadAttackTransactions.mockResolvedValue(read([tx(DIGEST2, C, [bc(C, SUI, "-1000000")], [move("wrapped", C, null)])]));
    const payload = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST2], attacker: C }));

    expect(payload.objects).toEqual([expect.objectContaining({ object_id: S1, direction: "custody" })]);
    expect(payload.totals.objects_usd_consumed ?? 0).toBe(0);
  });

  it("nets an object the attacker consumed against the coins it paid out", async () => {
    // Unstaking: the StakedSui is deleted and its SUI paid to the holder.
    mockReadAttackTransactions.mockResolvedValue(read([tx(DIGEST2, C, [bc(C, SUI, "100000000000")], [move("deleted", C, null)])]));
    const payload = payloadOf(await handlers.summarize_incident_losses({ digests: [DIGEST2], attacker: C }));

    expect(payload.totals.usd_net).toBe(0);
    expect(payload.objects).toEqual([expect.objectContaining({ direction: "consumed", usd: -100 })]);
  });
});
