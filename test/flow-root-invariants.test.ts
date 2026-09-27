import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlTx, searchPage, CETUS, SUI, USDC, type HopSpec } from "./helpers/trace-shapes.js";
import { gqlPage } from "./helpers/service-shapes.js";

/**
 * Randomized small ledgers around one start address, traced from the address
 * in both directions, against the invariants every address-start graph keeps:
 *
 *   1. The terminal shares, the pruned share included, add up to 1.
 *   2. No edge carries more than moved on chain: an address edge's `amount`
 *      is what that address gained (forward) or paid (backward) in the coin
 *      over the edge's digests, and `traced` never exceeds `amount`.
 *   3. Attribution: each unit of value leaves the start address to the party,
 *      coin and stop the ledger says it went to. A conversion made in place
 *      is either moved by a later move of the start address (forward: a spend
 *      of the proceeds; backward: an older inflow of the coin paid in) or
 *      held at the start address in that coin, never both. An unreadable move
 *      ends as read_failed with the value it moved, and leaves the graph
 *      truncated. A coin with no price carries the value of the conversion it
 *      came out of (forward) or went into (backward), and none otherwise.
 *      Forward, a sale whose proceeds are worth under a tenth of its input
 *      carries only what they are worth, whatever its calls are named, and
 *      the rest ends `retained` with the pool, or `consumed` when the start
 *      address received a receipt for it.
 *   4. A priced terminal's USD is its share of the value, and no `source`
 *      terminal sits on a transaction that paid something in that no address
 *      took, unless what it paid in is worth less than a tenth of what came
 *      out (a fee).
 *   5. A bridge exit's beneficiary amount counts each transaction once.
 *   6. The graph is truncated exactly when a move is unreadable or the start
 *      node's search stopped at its move limit, and says why in the second
 *      case. Past that limit, value paid back to the start address ends where
 *      it went next. Five or more branches that reconverge on one wallet
 *      reach it before it is expanded, so its expansion limit never cuts
 *      them off.
 *
 * Prices are fixed and swaps are fair, so every conversion keeps value.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
const mockPrices = new Map<string, number>();
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async (coinTypes: string[]) => ({
    quotes: new Map(coinTypes.filter((ct) => mockPrices.has(ct)).map((ct) => [ct, { price: mockPrices.get(ct)! }])),
    unanswered: new Set(),
    unsupported: new Set(),
  }),
}));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
const mockFanout = vi.fn();
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: mockFanout }));

// Imported after the mocks are registered, as the trace tests do.
const { FlowEngine } = await import("../src/utils/flow-engine.js");

const SUI_BRIDGE_DEPOSIT = "0x000000000000000000000000000000000000000000000000000000000000000b::bridge::TokenDepositedEvent";
/** The TokenDepositedEvent of mainnet transaction 4xLuY6N68PgqBow9i4iawBvVw3eEkxKQNRQeSWFGwjJi. */
const DEPOSIT = {
  seq_num: "23371",
  source_chain: 0,
  sender_address: "xKRFS6UEKXM8q3C7Q0rJnXTSCnU0w9/Tux+m6Ts8SzI=",
  target_chain: 10,
  target_address: "1vBbGb8sBcJkpka3dXBX13RmHFw=",
  token_type: 4,
  amount: "130004100000",
};

const START = `0xa0${"a".repeat(62)}`;
const OTHERS = ["b1", "c2", "d3", "e4"].map((p) => `0x${p}${p[1].repeat(62)}`);
const RELAYER = `0xf5${"5".repeat(62)}`;
/** Wallets that split the value and pass it all to one merge wallet. */
const BRANCHES = Array.from({ length: 8 }, (_, i) => `0x6${i}${"6".repeat(62)}`);
const MERGE = `0x8e${"8".repeat(62)}`;
/** A deposit's receipt, and the pool a sale below the market price leaves its value in. */
const RECEIPT = `0x7e${"7".repeat(62)}`;
const POOL = `0x9a${"9".repeat(62)}`;
/** An account entry a vault keeps in a table keyed by address. */
const LEDGER = `0x1e${"d".repeat(62)}`;
const DEEP = "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";
const EMOJI = "0x07ab9ba99abd9af0d687ae55079601192be5a12d1a21c8c4cd9f1a17519111e0::emoji::EMOJI";
const UPS = "0x0292295126a70b16516108f708e31f2d54ba67db42d7441416a735a340e7ad2b::ups::UPS";
/**
 * `usd` is what every swap trades at; the price source quotes only the
 * `priced` coins. EMOJI appears only in `chain` conversions, so a conversion
 * with no price on either side always spends proceeds of an earlier one. UPS
 * appears only in the `rate` kinds, which buy and sell it at rates of their
 * own, always for a priced coin.
 */
const COINS = [
  { type: SUI, usd: 3, decimals: 9, priced: true },
  { type: USDC, usd: 1, decimals: 6, priced: true },
  { type: CETUS, usd: 0.1, decimals: 9, priced: true },
  { type: DEEP, usd: 0.2, decimals: 6, priced: false },
  { type: EMOJI, usd: 0.5, decimals: 6, priced: false },
  { type: UPS, usd: 0.3, decimals: 6, priced: false },
];
type Coin = (typeof COINS)[number];
const coinOf = (type: string) => COINS.find((c) => c.type === type)!;
const rawFor = (coin: Coin, usd: number) => BigInt(Math.round((usd * 10 ** coin.decimals) / coin.usd));
const usdOf = (type: string, amount: bigint) => (Number(amount) / 10 ** coinOf(type).decimals) * coinOf(type).usd;

/** Deterministic PRNG, so a failing seed reproduces. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function netAt(h: HopSpec, address: string, coin: string): bigint {
  return h.changes.filter(([a, , c]) => a === address && (c ?? SUI) === coin).reduce((s, [, amt]) => s + BigInt(amt), 0n);
}

/**
 * Where one coin of one of the start address's moves went, as the generator
 * built it. `held:<coin>` is a conversion in place; its `pool` is the amount
 * a later leg of the start address can move again.
 */
interface Dest {
  key: string;
  usd: number;
  pool?: { coin: string; amount: bigint };
}
interface OracleLeg {
  coin: string;
  /** The start address's net move in `coin`. */
  amount: bigint;
  /** The leg's value is known from its own transaction: a priced coin, or the unpriced side of a conversion with a priced one. */
  known: boolean;
  dest: Dest[];
}
interface Ledger {
  hops: HopSpec[];
  legs: Map<string, OracleLeg[]>;
  unreadable: Set<string>;
  /** A move converted value it did not keep (a swap in a transaction that bridged the rest out), so USD is not conserved. */
  lossy?: boolean;
  /** The start address has more moves than its search reads, so the graph is partial. */
  capped?: boolean;
  /** Coin the graph starts from; null or absent starts from every coin. */
  coin?: string;
  /** For a ledger past the start node's move limit: the share one terminal code or node must end with. */
  expect?: { code?: string; node?: string; share: number };
}

const priced = (coin: string) => coinOf(coin).priced;
const leg = (coin: string, amount: bigint, known: boolean, dest: Dest[]): OracleLeg => ({ coin, amount, known, dest });
const to = (address: string, coin: string, usd: number): Dest => ({ key: `to:${address}|${coin}`, usd });
const held = (coin: string, amount: bigint, usd: number): Dest => ({ key: `held:${coin}`, usd, pool: { coin, amount } });

function builder(rand: () => number) {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const ledger: Ledger = { hops: [], legs: new Map(), unreadable: new Set() };
  let cp = 5000;
  return {
    pick,
    ledger,
    /** Three distinct coins and two distinct other parties, and a value in USD. */
    draw: () => {
      const [X, Y, Z] = COINS.filter((c) => c.type !== EMOJI && c.type !== UPS).sort(() => rand() - 0.5);
      const [P, Q] = [...OTHERS].sort(() => rand() - 0.5);
      return { X, Y, Z, P, Q, v: 10 + Math.floor(rand() * 4990) };
    },
    /** `lost` forces the move unreadable (true) or readable (false); by default about one in eight is unreadable. */
    add: (h: HopSpec, legs: OracleLeg[] = [], lost?: boolean) => {
      h.checkpoint = cp++;
      ledger.hops.push(h);
      if (legs.length > 0) {
        ledger.legs.set(h.digest, legs);
        if (lost ?? rand() < 0.12) ledger.unreadable.add(h.digest);
      }
    },
  };
}

/** Moves the start address sends, and recipients passing value on. */
function forwardLedger(rand: () => number): Ledger {
  const { pick, ledger, draw, add } = builder(rand);
  const receipts: Array<{ address: string; coin: string; amount: bigint }> = [];
  const count = 1 + Math.floor(rand() * 7);
  for (let i = 0; i < count; i++) {
    const { X, Y, Z, P: R, Q: S, v } = draw();
    const x = rawFor(X, v);
    const digest = `0xf${i}`;
    const kinds = ["pay", "multiPay", "swapHold", "consolidateSend", "swapPartSend", "swapIntoPay", "twoIn", "twoOut", "bridgeExit", "deposit", "chain", "rateSale", "bridgeDust", "depositDust", "dumpSale", "reconverge"];
    if (receipts.length > 0) kinds.push("relay", "relay");
    let h: HopSpec;
    let legs: OracleLeg[] = [];
    let spendLast: { coin: Coin; amount: bigint } | null = null;
    switch (pick(kinds)) {
      case "reconverge": {
        // X split across five to eight wallets, each passing its part to one merge wallet, which pays R.
        const ws = BRANCHES.slice(0, 5 + Math.floor(rand() * 4));
        const parts = ws.map(() => rawFor(X, 10 + Math.floor(rand() * 4000)));
        const total = parts.reduce((t, p) => t + p, 0n);
        add(
          { digest, sender: START, changes: [[START, `-${total}`, X.type], ...ws.map((w, k): [string, string, string] => [w, `${parts[k]}`, X.type])] },
          [leg(X.type, total, X.priced, ws.map((w, k) => to(w, X.type, usdOf(X.type, parts[k]))))],
        );
        ws.forEach((w, k) => add({ digest: `${digest}w${k}`, sender: w, changes: [[w, `-${parts[k]}`, X.type], [MERGE, `${parts[k]}`, X.type]] }));
        add({ digest: `${digest}m`, sender: MERGE, changes: [[MERGE, `-${total}`, X.type], [R, `${total}`, X.type]] });
        continue;
      }
      case "rateSale": {
        // UPS bought at one rate and sold for a priced coin at another.
        const X0 = pick(COINS.filter((c) => c.priced));
        const x0 = rawFor(X0, v);
        const u = rawFor(coinOf(UPS), v) * BigInt(1 + Math.floor(rand() * 20));
        add({ digest: `${digest}a`, sender: START, changes: [[START, `-${x0}`, X0.type], [START, `${u}`, UPS]] }, [leg(X0.type, x0, true, [held(UPS, u, v)])], false);
        const sold = rand() < 0.5 ? u : u / 2n;
        const vs = 10 + Math.floor(rand() * 4990);
        h = { digest, sender: START, changes: [[START, `-${sold}`, UPS], [R, `${rawFor(Y.priced ? Y : coinOf(USDC), vs)}`, Y.priced ? Y.type : USDC]] };
        legs = [leg(UPS, sold, true, [to(R, Y.priced ? Y.type : USDC, vs)])];
        ledger.lossy = true;
        add(h, legs, false);
        continue;
      }
      case "bridgeDust": {
        // An unreadable PTB bridges X out and leaves a little of Y at the start address, which a later payment spends.
        const [Xp, Yp] = COINS.filter((c) => c.priced).sort(() => rand() - 0.5);
        const xp = rawFor(Xp, v);
        const dust = rawFor(Yp, 0.01);
        const d = usdOf(Yp.type, dust);
        add(
          { digest: `${digest}a`, sender: START, changes: [[START, `-${xp}`, Xp.type], [START, `${dust}`, Yp.type]], events: [SUI_BRIDGE_DEPOSIT] },
          [leg(Xp.type, xp, true, [{ key: "bridge_exit", usd: v - d }, held(Yp.type, dust, d)])],
          true,
        );
        const vw = 10 + Math.floor(rand() * 4990);
        const w = rawFor(Yp, vw);
        h = { digest, sender: START, changes: [[START, `-${w}`, Yp.type], [R, `${w}`, Yp.type]] };
        legs = [leg(Yp.type, w, true, [to(R, Yp.type, vw)])];
        add(h, legs, false);
        continue;
      }
      case "depositDust": {
        // A readable deposit of X into a contract that returns a receipt and a little of Y to the start address,
        // which a later payment spends, or the Y to R.
        const [Xp, Yp] = COINS.filter((c) => c.priced).sort(() => rand() - 0.5);
        const xp = rawFor(Xp, v);
        const dust = rawFor(Yp, 0.01);
        const d = usdOf(Yp.type, dust);
        // The claim is a new receipt, the start address's existing position written in place, or an entry in a
        // table the vault keeps by address; none of them is a new object for the depositor in the last two.
        const objects = pick([
          [{ id: RECEIPT, type: "0xabc::vault::Receipt", owner: START }],
          [{ id: RECEIPT, type: "0xabc::lending::Obligation", owner: START, mutated: true as const }],
          [
            { id: POOL, type: "0xabc::vault::Vault", shared: true as const },
            { id: LEDGER, type: "0x0000000000000000000000000000000000000000000000000000000000000002::dynamic_field::Field<address, u64>", parent: POOL },
          ],
        ]);
        if (rand() < 0.5) {
          h = { digest, sender: START, changes: [[START, `-${xp}`, Xp.type], [R, `${dust}`, Yp.type]], objects };
          legs = [leg(Xp.type, xp, true, [{ key: "consumed", usd: v - d }, to(R, Yp.type, d)])];
          break;
        }
        add({ digest: `${digest}a`, sender: START, changes: [[START, `-${xp}`, Xp.type], [START, `${dust}`, Yp.type]], objects }, [leg(Xp.type, xp, true, [{ key: "consumed", usd: v - d }, held(Yp.type, dust, d)])], false);
        const vw = 10 + Math.floor(rand() * 4990);
        const w = rawFor(Yp, vw);
        h = { digest, sender: START, changes: [[START, `-${w}`, Yp.type], [R, `${w}`, Yp.type]] };
        legs = [leg(Yp.type, w, true, [to(R, Yp.type, vw)])];
        add(h, legs, false);
        continue;
      }
      case "dumpSale": {
        // A readable sale of X for a few percent of its value in Y, into a pool the start address gets no receipt
        // from, half the time through a call named swap. The Y goes to R, or stays for a later payment to spend.
        const [Xp, Yp] = COINS.filter((c) => c.priced).sort(() => rand() - 0.5);
        const xp = rawFor(Xp, v);
        const y = rawFor(Yp, v * (0.01 + 0.08 * rand()));
        const d = usdOf(Yp.type, y);
        const objects = [{ id: POOL, type: "0xabc::pool::Pool", shared: true as const }];
        const calls: Array<[string, string, string]> = rand() < 0.5 ? [["0xabc", "pool", "swap"]] : [];
        if (rand() < 0.5) {
          h = { digest, sender: START, changes: [[START, `-${xp}`, Xp.type], [R, `${y}`, Yp.type]], objects, calls };
          legs = [leg(Xp.type, xp, true, [{ key: "retained", usd: v - d }, to(R, Yp.type, d)])];
          break;
        }
        add({ digest: `${digest}a`, sender: START, changes: [[START, `-${xp}`, Xp.type], [START, `${y}`, Yp.type]], objects, calls }, [leg(Xp.type, xp, true, [{ key: "retained", usd: v - d }, held(Yp.type, y, d)])], false);
        const vw = 10 + Math.floor(rand() * 4990);
        const w = rawFor(Yp, vw);
        h = { digest, sender: START, changes: [[START, `-${w}`, Yp.type], [R, `${w}`, Yp.type]] };
        legs = [leg(Yp.type, w, true, [to(R, Yp.type, vw)])];
        add(h, legs, false);
        continue;
      }
      case "chain": {
        // A priced coin swapped into one unpriced coin, then that into the other.
        const [C1, C2] = rand() < 0.5 ? [coinOf(DEEP), coinOf(EMOJI)] : [coinOf(EMOJI), coinOf(DEEP)];
        const X0 = pick(COINS.filter((c) => c.priced));
        const [x0, c1] = [rawFor(X0, v), rawFor(C1, v)];
        add({ digest: `${digest}a`, sender: START, changes: [[START, `-${x0}`, X0.type], [START, `${c1}`, C1.type]] }, [leg(X0.type, x0, true, [held(C1.type, c1, v)])]);
        const vu = 1 + Math.floor(rand() * (v - 1));
        const u = rawFor(coinOf(USDC), vu);
        const variant = pick(["plain", "out", "in"]);
        if (variant === "plain") {
          const c2 = rawFor(C2, v);
          h = { digest, sender: START, changes: [[START, `-${c1}`, C1.type], [START, `${c2}`, C2.type]] };
          legs = [leg(C1.type, c1, false, [held(C2.type, c2, v)])];
          spendLast = { coin: C2, amount: c2 };
        } else if (variant === "out") {
          const c2 = rawFor(C2, v - vu);
          h = { digest, sender: START, changes: [[START, `-${c1}`, C1.type], [START, `${c2}`, C2.type], [START, `${u}`, USDC]] };
          legs = [leg(C1.type, c1, false, [held(C2.type, c2, v - vu), held(USDC, u, vu)])];
          spendLast = { coin: C2, amount: c2 };
        } else {
          const c2 = rawFor(C2, v + vu);
          h = { digest, sender: START, changes: [[START, `-${c1}`, C1.type], [START, `-${u}`, USDC], [START, `${c2}`, C2.type]] };
          legs = [leg(C1.type, c1, false, [held(C2.type, rawFor(C2, v), v)]), leg(USDC, u, true, [held(C2.type, rawFor(C2, vu), vu)])];
          spendLast = { coin: C2, amount: c2 };
        }
        break;
      }
      case "pay": {
        if (rand() < 0.5) {
          h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [R, `${x}`, X.type]] };
          legs = [leg(X.type, x, X.priced, [to(R, X.type, v)])];
        } else {
          const part = (x * BigInt(1 + Math.floor(rand() * 9))) / 10n;
          h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [R, `${part}`, X.type], [S, `${x - part}`, X.type]] };
          legs = [leg(X.type, x, X.priced, [to(R, X.type, usdOf(X.type, part)), to(S, X.type, usdOf(X.type, x - part))])];
        }
        break;
      }
      case "multiPay": {
        const y = rawFor(Y, 10 + Math.floor(rand() * 2000));
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [R, `${x}`, X.type], [START, `-${y}`, Y.type], [S, `${y}`, Y.type]] };
        legs = [leg(X.type, x, X.priced, [to(R, X.type, v)]), leg(Y.type, y, Y.priced, [to(S, Y.type, usdOf(Y.type, y))])];
        break;
      }
      case "swapHold": {
        const y = rawFor(Y, v);
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [START, `${y}`, Y.type]] };
        legs = [leg(X.type, x, true, [held(Y.type, y, v)])];
        break;
      }
      case "consolidateSend": {
        const own = rawFor(Y, 1 + Math.floor(rand() * 500));
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [START, `-${own}`, Y.type], [R, `${rawFor(Y, v) + own}`, Y.type]] };
        legs = [leg(X.type, x, true, [to(R, Y.type, v)]), leg(Y.type, own, Y.priced, [to(R, Y.type, usdOf(Y.type, own))])];
        break;
      }
      case "swapPartSend": {
        const kept = Math.floor(v * (0.1 + 0.8 * rand()));
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [START, `${rawFor(Y, kept)}`, Y.type], [R, `${rawFor(Y, v - kept)}`, Y.type]] };
        legs = [leg(X.type, x, true, [held(Y.type, rawFor(Y, kept), kept), to(R, Y.type, v - kept)])];
        break;
      }
      case "swapIntoPay":
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [R, `${rawFor(Y, v)}`, Y.type]] };
        legs = [leg(X.type, x, true, [to(R, Y.type, v)])];
        break;
      case "twoIn": {
        const vz = 10 + Math.floor(rand() * 2000);
        const z = rawFor(Z, vz);
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [START, `-${z}`, Z.type], [START, `${rawFor(Y, v + vz)}`, Y.type]] };
        legs = [leg(X.type, x, true, [held(Y.type, rawFor(Y, v), v)]), leg(Z.type, z, true, [held(Y.type, rawFor(Y, vz), vz)])];
        break;
      }
      case "twoOut": {
        const vy = Math.floor(v * (0.1 + 0.8 * rand()));
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [START, `${rawFor(Y, vy)}`, Y.type], [START, `${rawFor(Z, v - vy)}`, Z.type]] };
        legs = [leg(X.type, x, true, [held(Y.type, rawFor(Y, vy), vy), held(Z.type, rawFor(Z, v - vy), v - vy)])];
        break;
      }
      case "bridgeExit": {
        const fee = X.type !== SUI && rand() < 0.5 ? rawFor(coinOf(SUI), 3) : 0n;
        h = {
          digest,
          sender: START,
          changes: [[START, `-${x}`, X.type], ...(fee ? [[START, `-${fee}`, SUI] as [string, string, string]] : [])],
          events: [SUI_BRIDGE_DEPOSIT],
        };
        legs = [leg(X.type, x, X.priced, [{ key: "bridge_exit", usd: v }]), ...(fee ? [leg(SUI, fee, true, [{ key: "bridge_exit", usd: 3 }])] : [])];
        break;
      }
      case "deposit":
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type]] };
        legs = [leg(X.type, x, X.priced, [{ key: "consumed", usd: v }])];
        break;
      default: {
        const r = pick(receipts);
        const next = pick([...OTHERS.filter((o) => o !== r.address), START]);
        const amount = rand() < 0.5 ? r.amount : r.amount / 2n;
        h = { digest, sender: r.address, changes: [[r.address, `-${amount}`, r.coin], [next, `${amount}`, r.coin]] };
      }
    }
    add(h, legs);
    for (const [a, amt, c] of h.changes) if (a !== START && BigInt(amt) > 0n) receipts.push({ address: a, coin: c ?? SUI, amount: BigInt(amt) });
    if (spendLast && rand() < 0.7) {
      const amount = rand() < 0.5 ? spendLast.amount : spendLast.amount / 2n;
      const coin = spendLast.coin.type;
      add({ digest: `${digest}p`, sender: START, changes: [[START, `-${amount}`, coin], [R, `${amount}`, coin]] }, [leg(coin, amount, false, [to(R, coin, usdOf(coin, amount))])]);
    }
  }
  return ledger;
}

/** Moves into the start address: payments, its own swaps, a payer's swap, bridge entries and withdrawals. */
function backwardLedger(rand: () => number): Ledger {
  const { pick, ledger, draw, add } = builder(rand);
  const count = 1 + Math.floor(rand() * 7);
  for (let i = 0; i < count; i++) {
    const { X, Y, Z, P, Q, v } = draw();
    const x = rawFor(X, v);
    const digest = `0xb${i}`;
    let h: HopSpec;
    let legs: OracleLeg[] = [];
    switch (pick(["receive", "receive", "multiReceive", "swapHold", "consolidateReceive", "swapPartSend", "payerSwap", "twoIn", "twoOut", "bridgeKeep", "credit", "withdraw", "payOut", "returnReceive", "chain", "rateBuy", "withdrawFee", "reconverge"])) {
      case "reconverge": {
        // Q funds a merge wallet, which pays five to eight wallets that each pay their part to the start address.
        const ws = BRANCHES.slice(0, 5 + Math.floor(rand() * 4));
        const parts = ws.map(() => rawFor(X, 10 + Math.floor(rand() * 4000)));
        const total = parts.reduce((t, p) => t + p, 0n);
        add({ digest: `${digest}q`, sender: Q, changes: [[Q, `-${total}`, X.type], [MERGE, `${total}`, X.type]] });
        add({ digest: `${digest}m`, sender: MERGE, changes: [[MERGE, `-${total}`, X.type], ...ws.map((w, k): [string, string, string] => [w, `${parts[k]}`, X.type])] });
        ws.forEach((w, k) =>
          add({ digest: `${digest}w${k}`, sender: w, changes: [[w, `-${parts[k]}`, X.type], [START, `${parts[k]}`, X.type]] }, [leg(X.type, parts[k], X.priced, [to(w, X.type, usdOf(X.type, parts[k]))])]),
        );
        continue;
      }
      case "withdrawFee": {
        // A readable withdrawal of X that pays a little of Y no address takes, by the start address or by P, who
        // passes the X to it.
        const [Xp, Yp] = COINS.filter((c) => c.priced).sort(() => rand() - 0.5);
        const fee = rawFor(Yp, 0.01);
        const d = usdOf(Yp.type, fee);
        const by = rand() < 0.5 ? START : P;
        const xp = rawFor(Xp, v);
        h = { digest, sender: by, changes: [[by, `-${fee}`, Yp.type], [START, `${xp}`, Xp.type]] };
        legs = [leg(Xp.type, xp, true, [{ key: "source", usd: v - d }, by === START ? held(Yp.type, fee, d) : to(P, Yp.type, d)])];
        add(h, legs, false);
        continue;
      }
      case "rateBuy": {
        // UPS bought with a priced coin at one rate, then (newer) sold for USDC at another and kept.
        const X0 = pick(COINS.filter((c) => c.priced));
        const x0 = rawFor(X0, v);
        const u = rawFor(coinOf(UPS), v) * BigInt(1 + Math.floor(rand() * 20));
        add({ digest: `${digest}a`, sender: START, changes: [[START, `-${x0}`, X0.type], [START, `${u}`, UPS]] }, [leg(UPS, u, true, [held(X0.type, x0, v)])], false);
        const sold = rand() < 0.5 ? u : u / 2n;
        const vs = 10 + Math.floor(rand() * 4990);
        const got = rawFor(coinOf(USDC), vs);
        h = { digest, sender: START, changes: [[START, `-${sold}`, UPS], [START, `${got}`, USDC]] };
        legs = [leg(USDC, got, true, [held(UPS, sold, vs)])];
        ledger.lossy = true;
        add(h, legs, false);
        continue;
      }
      case "receive":
        if (rand() < 0.5) add({ digest: `${digest}f`, sender: Q, changes: [[Q, `-${x}`, X.type], [P, `${x}`, X.type]] });
        h = { digest, sender: P, changes: [[P, `-${x}`, X.type], [START, `${x}`, X.type]] };
        legs = [leg(X.type, x, X.priced, [to(P, X.type, v)])];
        break;
      case "multiReceive": {
        const y = rawFor(Y, 10 + Math.floor(rand() * 2000));
        const payer = rand() < 0.5 ? P : Q;
        h = { digest, sender: P, changes: [[P, `-${x}`, X.type], [START, `${x}`, X.type], [payer, `-${y}`, Y.type], [START, `${y}`, Y.type]] };
        legs = [leg(X.type, x, X.priced, [to(P, X.type, v)]), leg(Y.type, y, Y.priced, [to(payer, Y.type, usdOf(Y.type, y))])];
        break;
      }
      case "swapHold": {
        const y = rawFor(Y, v);
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [START, `${y}`, Y.type]] };
        legs = [leg(Y.type, y, true, [held(X.type, x, v)])];
        break;
      }
      case "consolidateReceive": {
        const paid = rawFor(Y, 1 + Math.floor(rand() * 500));
        const y = rawFor(Y, v) + paid;
        h = { digest, sender: START, changes: [[P, `-${paid}`, Y.type], [START, `${y}`, Y.type], [START, `-${x}`, X.type]] };
        legs = [leg(Y.type, y, true, [to(P, Y.type, usdOf(Y.type, paid)), held(X.type, x, v)])];
        break;
      }
      case "swapPartSend": {
        const kept = Math.floor(v * (0.1 + 0.8 * rand()));
        const y = rawFor(Y, kept);
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [START, `${y}`, Y.type], [P, `${rawFor(Y, v - kept)}`, Y.type]] };
        legs = [leg(Y.type, y, true, [held(X.type, rawFor(X, kept), kept)])];
        break;
      }
      case "payerSwap": {
        const top = rand() < 0.5 ? rawFor(Y, 1 + Math.floor(rand() * 500)) : 0n;
        const y = rawFor(Y, v) + top;
        h = { digest, sender: P, changes: [[P, `-${x}`, X.type], ...(top ? [[P, `-${top}`, Y.type] as [string, string, string]] : []), [START, `${y}`, Y.type]] };
        legs = [leg(Y.type, y, true, [to(P, X.type, v), ...(top ? [to(P, Y.type, usdOf(Y.type, top))] : [])])];
        break;
      }
      case "twoIn": {
        const vz = 10 + Math.floor(rand() * 2000);
        const z = rawFor(Z, vz);
        const y = rawFor(Y, v + vz);
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [START, `-${z}`, Z.type], [START, `${y}`, Y.type]] };
        legs = [leg(Y.type, y, true, [held(X.type, x, v), held(Z.type, z, vz)])];
        break;
      }
      case "twoOut": {
        const vy = Math.floor(v * (0.1 + 0.8 * rand()));
        const [y, z] = [rawFor(Y, vy), rawFor(Z, v - vy)];
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [START, `${y}`, Y.type], [START, `${z}`, Z.type]] };
        legs = [leg(Y.type, y, true, [held(X.type, rawFor(X, vy), vy)]), leg(Z.type, z, true, [held(X.type, rawFor(X, v - vy), v - vy)])];
        break;
      }
      case "bridgeKeep": {
        // The start address's own swap in a transaction that bridges the rest out. Both coins are
        // priced, so no later move takes this lossy conversion's rate as a coin's value.
        const [I, K] = COINS.filter((c) => c.priced).sort(() => rand() - 0.5);
        const i0 = rawFor(I, v);
        const kept = Math.floor(v * (0.1 + 0.8 * rand()));
        const k = rawFor(K, kept);
        h = { digest, sender: START, changes: [[START, `-${i0}`, I.type], [START, `${k}`, K.type]], events: [SUI_BRIDGE_DEPOSIT] };
        legs = [leg(K.type, k, true, [held(I.type, i0, kept)])];
        ledger.lossy = true;
        break;
      }
      case "credit":
        h = { digest, sender: RELAYER, changes: [[START, `${x}`, X.type]] };
        legs = [leg(X.type, x, X.priced, [{ key: "source", usd: v }])];
        break;
      case "returnReceive":
        add({ digest: `${digest}o`, sender: START, changes: [[START, `-${x}`, X.type], [P, `${x}`, X.type]] });
        h = { digest, sender: P, changes: [[P, `-${x}`, X.type], [START, `${x}`, X.type]] };
        legs = [leg(X.type, x, X.priced, [to(P, X.type, v)])];
        break;
      case "chain": {
        // A priced coin swapped into one unpriced coin, then that into the other.
        const [C1, C2] = rand() < 0.5 ? [coinOf(DEEP), coinOf(EMOJI)] : [coinOf(EMOJI), coinOf(DEEP)];
        const X0 = pick(COINS.filter((c) => c.priced));
        const [x0, c1, c2] = [rawFor(X0, v), rawFor(C1, v), rawFor(C2, v)];
        add({ digest: `${digest}a`, sender: START, changes: [[START, `-${x0}`, X0.type], [START, `${c1}`, C1.type]] }, [leg(C1.type, c1, true, [held(X0.type, x0, v)])]);
        h = { digest, sender: START, changes: [[START, `-${c1}`, C1.type], [START, `${c2}`, C2.type]] };
        legs = [leg(C2.type, c2, false, [held(C1.type, c1, v)])];
        break;
      }
      case "withdraw":
        h = { digest, sender: START, changes: [[START, `${x}`, X.type]] };
        legs = [leg(X.type, x, X.priced, [{ key: "source", usd: v }])];
        break;
      default:
        h = { digest, sender: START, changes: [[START, `-${x}`, X.type], [P, `${x}`, X.type]] };
    }
    add(h, legs);
  }
  return ledger;
}

/**
 * A payment to B, then 100 small moves, so the start node's search stops at
 * its move limit before B pays the value back. Forward, the start address
 * then bridges it out; backward, P funded the payment to B before the small
 * moves. The returned value is traced past the start node either way.
 *
 * Variants: a `coin_type` start in the traced coin; forward, a second payment
 * to D that comes back through E a level later; backward, small payments the
 * start address makes between the small inflows, so the search stops inside
 * its oldest page.
 */
function longLedger(rand: () => number, forward: boolean): Ledger {
  const X = COINS.filter((c) => c.priced)[Math.floor(rand() * 3)];
  const [P, B, C, D] = OTHERS;
  const E = RELAYER;
  const v = 1000 + Math.floor(rand() * 4000);
  const s = 1 + Math.floor(rand() * 4);
  const [x, xs] = [rawFor(X, v), rawFor(X, s)];
  const twoReturns = forward && rand() < 0.5;
  const midPage = !forward && rand() < 0.5;
  const hops: HopSpec[] = [];
  let cp = 5000;
  const add = (h: HopSpec) => hops.push({ ...h, checkpoint: cp++ });
  if (!forward) add({ digest: "0xlf", sender: P, changes: [[P, `-${x}`, X.type], [START, `${x}`, X.type]] });
  add({ digest: "0xlb", sender: START, changes: [[START, `-${x}`, X.type], [B, `${x}`, X.type]] });
  if (twoReturns) add({ digest: "0xld", sender: START, changes: [[START, `-${x}`, X.type], [D, `${x}`, X.type]] });
  const small = midPage ? 118 : 100;
  for (let i = 0, n = 0; n < small; i++) {
    if (midPage && i % 5 === 4 && i < 145) {
      add({ digest: `0xlo${i}`, sender: START, changes: [[START, `-${xs}`, X.type], [C, `${xs}`, X.type]] });
      continue;
    }
    n++;
    add(forward
      ? { digest: `0xls${i}`, sender: START, changes: [[START, `-${xs}`, X.type], [C, `${xs}`, X.type]] }
      : { digest: `0xls${i}`, sender: C, changes: [[C, `-${xs}`, X.type], [START, `${xs}`, X.type]] });
  }
  add({ digest: "0xlr", sender: B, changes: [[B, `-${x}`, X.type], [START, `${x}`, X.type]] });
  if (twoReturns) {
    add({ digest: "0xle", sender: D, changes: [[D, `-${x}`, X.type], [E, `${x}`, X.type]] });
    add({ digest: "0xlg", sender: E, changes: [[E, `-${x}`, X.type], [START, `${x}`, X.type]] });
  }
  const out = twoReturns ? 2n * x : x;
  if (forward) add({ digest: "0xlx", sender: START, changes: [[START, `-${out}`, X.type]], events: [SUI_BRIDGE_DEPOSIT] });
  const share = twoReturns ? (2 * v) / (2 * v + 98 * s) : v / (v + 99 * s);
  return {
    hops,
    legs: new Map(),
    unreadable: new Set(),
    capped: true,
    ...(rand() < 0.5 ? { coin: X.type } : {}),
    expect: forward ? { code: "bridge_exit", share } : { node: `${P}|${X.type}`, share },
  };
}

function serve(ledger: Ledger) {
  const { hops, unreadable } = ledger;
  const all = new Map(hops.map((h) => [h.digest, h]));
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
    const q = String(query);
    if (q.includes("transactions(")) return searchPage(hops, q, vars);
    if (q.includes("json")) {
      const h = all.get(String(vars.digest));
      return { transaction: { effects: { events: gqlPage((h?.events ?? []).map((repr) => ({ contents: { type: { repr }, json: DEPOSIT } }))) } } };
    }
    const h = all.get(String(vars.digest));
    return h && !unreadable.has(h.digest) ? gqlTx(h) : { transaction: null };
  });
}

/**
 * Where the start address's value went, in USD by destination, from the
 * generator's own account of each move. Moves are taken in the order the
 * start address's search meets them: forward oldest first, backward newest
 * first. A move in a coin first moves again what earlier conversions in place
 * left in that coin, oldest first; that part leaves the conversion's `held`
 * destination at the conversion's own rate. A move whose value its own
 * transaction does not give is worth what it moved again, at that rate. An
 * unreadable move ends as read_failed, and its conversions stay open to later
 * moves.
 */
function oracle(ledger: Ledger, forward: boolean): { usd: Map<string, number>; held: Map<string, bigint> } {
  const order = ledger.hops.filter((h) => ledger.legs.has(h.digest));
  if (!forward) order.reverse();
  // `usd` is null for a conversion whose value nothing gives: a later move takes no rate from it.
  const pools = new Map<string, Array<{ dest: Dest; left: bigint; amount: bigint; usd: number | null }>>();
  const legs: OracleLeg[] = [];
  for (const h of order) {
    const lost = ledger.unreadable.has(h.digest);
    const txLegs = ledger.legs.get(h.digest)!.map((l) => ({ ...l, dest: l.dest.map((d) => ({ ...d, ...(lost ? { key: "read_failed" } : {}) })) }));
    const unvalued = new Set<OracleLeg>();
    for (const l of txLegs) {
      let rest = l.amount;
      let drawnUsd = 0;
      let drawn = 0n;
      const queue = pools.get(l.coin) ?? [];
      while (queue.length > 0 && rest > 0n) {
        const head = queue[0];
        const take = head.left < rest ? head.left : rest;
        head.left -= take;
        rest -= take;
        if (head.usd !== null) {
          const usd = (head.usd * Number(take)) / Number(head.amount);
          head.dest.usd -= usd;
          drawnUsd += usd;
          drawn += take;
        }
        if (head.left === 0n) queue.shift();
      }
      if (!l.known) {
        if (drawn === 0n) unvalued.add(l);
        const value = drawn > 0n ? (drawnUsd * Number(l.amount)) / Number(drawn) : 0;
        const own = l.dest.reduce((s, d) => s + d.usd, 0);
        for (const d of l.dest) d.usd = own > 0 ? (d.usd * value) / own : 0;
      }
    }
    for (const l of txLegs) {
      for (const d of l.dest) {
        if (!d.pool || d.pool.amount === 0n) continue;
        const queue = pools.get(d.pool.coin) ?? [];
        queue.push({ dest: d, left: d.pool.amount, amount: d.pool.amount, usd: unvalued.has(l) ? null : d.usd });
        pools.set(d.pool.coin, queue);
      }
    }
    legs.push(...txLegs);
  }
  const usd = new Map<string, number>();
  for (const d of legs.flatMap((l) => l.dest)) usd.set(d.key, (usd.get(d.key) ?? 0) + Math.max(0, d.usd));
  const heldLeft = new Map<string, bigint>();
  // A conversion worth nothing carries no share, so nothing of it is reported held.
  for (const [coin, queue] of pools) heldLeft.set(coin, queue.filter((p) => p.dest.key.startsWith("held:") && (p.usd ?? 0) > 0).reduce((s, p) => s + p.left, 0n));
  return { usd, held: heldLeft };
}

/** Shares that left the start node, keyed as the oracle keys destinations. */
function rootAttribution(e: InstanceType<typeof FlowEngine>, forward: boolean): { share: Map<string, number>; held: Map<string, bigint> } {
  const root = `${START}|*`;
  const share = new Map<string, number>();
  const heldAmount = new Map<string, bigint>();
  const add = (key: string, s: number) => share.set(key, (share.get(key) ?? 0) + s);
  for (const edge of e.edges.values()) {
    const other = forward ? edge.from === root && edge.to : edge.to === root && edge.from;
    if (!other) continue;
    const n = e.nodes.get(other)!;
    if (n.kind === "address" && n.address === START) {
      add(`held:${n.coin_type}`, edge.share);
      heldAmount.set(n.coin_type!, (heldAmount.get(n.coin_type!) ?? 0n) + edge.traced);
    } else if (n.kind === "address") add(`to:${n.address}|${n.coin_type}`, edge.share);
    else if (n.kind === "bridge_exit") add("bridge_exit", edge.share);
    else if (n.kind === "consumed") add("consumed", edge.share);
    else if (n.kind === "retained") add("retained", edge.share);
    else add(n.id.startsWith("entry:") ? "bridge_entry" : "source", edge.share);
  }
  for (const g of e.ledger.summary()) for (const x of g.entries) if (g.code === "read_failed" && x.node === root) add("read_failed", x.share);
  return { share, held: heldAmount };
}

function checkInvariants(e: InstanceType<typeof FlowEngine>, ledger: Ledger, forward: boolean, attribution: boolean) {
  const byDigest = new Map(ledger.hops.map((h) => [h.digest, h]));
  const onChain = (address: string, coin: string, digests: string[]) =>
    digests.reduce((s, d) => {
      const net = netAt(byDigest.get(d)!, address, coin);
      return s + (net < 0n ? -net : net);
    }, 0n);

  // 1
  expect(e.ledger.total()).toBeCloseTo(1, 9);

  // 2
  for (const edge of e.edges.values()) {
    expect(edge.traced <= edge.amount, `${edge.id} traced ${edge.traced} > amount ${edge.amount}`).toBe(true);
    const party = e.nodes.get(forward ? edge.to : edge.from);
    const holder = e.nodes.get(forward ? edge.from : edge.to);
    if (party?.kind === "address") {
      expect(edge.amount, edge.id).toBe(onChain(party.address!, edge.coin_type, edge.digests));
    } else if (holder?.address) {
      expect(edge.amount <= onChain(holder.address, edge.coin_type, edge.digests), edge.id).toBe(true);
    }
  }

  // 3
  expect(e.truncated, "truncated").toBe(ledger.unreadable.size > 0 || ledger.capped === true);
  expect(e.partial.length > 0, "partial").toBe(ledger.capped === true);
  const expected = oracle(ledger, forward);
  const total = [...expected.usd.values()].reduce((s, v) => s + v, 0);
  const got = rootAttribution(e, forward);
  if (attribution && total > 0) {
    for (const key of new Set([...expected.usd.keys(), ...got.share.keys()])) {
      const want = (expected.usd.get(key) ?? 0) / total;
      expect(Math.abs((got.share.get(key) ?? 0) - want), `${key}: share ${got.share.get(key) ?? 0}, expected ${want}`).toBeLessThan(1e-6);
    }
    for (const coin of COINS) {
      const want = expected.held.get(coin.type) ?? 0n;
      const reported = got.held.get(coin.type) ?? 0n;
      const slack = want / 1_000_000n + 4n;
      expect(reported >= want - slack && reported <= want + slack, `held ${coin.type}: ${reported} vs ${want}`).toBe(true);
      const id = [...e.nodes.values()].find((n) => n.address === START && n.coin_type === coin.type)?.id;
      if (id) for (const code of e.ledger.codesFor(id)) expect(["cycle", forward ? "unspent" : "source"], `${coin.type} held as ${code}`).toContain(code);
    }
  }

  // 4. Exit, consumed and source nodes gather several coins, priced or not, so the USD check reads address nodes.
  const entries = e.ledger.summary().flatMap((g) => g.entries);
  if (attribution && total > 0 && !ledger.lossy) {
    for (const x of entries) {
      const coin = e.nodes.get(x.node)?.coin_type;
      if (x.usd === null || !coin || !priced(coin)) continue;
      expect(Math.abs(x.usd - x.share * total), `${x.node} usd ${x.usd} share ${x.share}`).toBeLessThan(0.05 + total * 1e-5);
    }
  }
  for (const edge of e.edges.values()) {
    if (!edge.from.startsWith("source:") && !edge.from.startsWith("entry:")) continue;
    for (const d of edge.digests) {
      const h = byDigest.get(d)!;
      // What went in that no address took, against what came out; a fee under a tenth of it is no source.
      let [consumed, produced] = [0, 0];
      for (const c of COINS) {
        const paid = h.changes.filter(([, amt, ct]) => (ct ?? SUI) === c.type && BigInt(amt) < 0n).reduce((s, [, amt]) => s - BigInt(amt), 0n);
        const received = h.changes.filter(([, amt, ct]) => (ct ?? SUI) === c.type && BigInt(amt) > 0n).reduce((s, [, amt]) => s + BigInt(amt), 0n);
        if (paid > received) consumed += usdOf(c.type, paid - received);
        else produced += usdOf(c.type, received - paid);
      }
      expect(consumed > 0 && consumed >= 0.1 * produced, `source or entry on ${d}, which paid in value no address took`).toBe(false);
    }
  }

  // 5
  for (const exit of [...e.nodes.values()].filter((n) => n.kind === "bridge_exit")) {
    const digests = new Set([...e.edges.values()].filter((x) => x.to === exit.id).flatMap((x) => x.digests));
    const amount = (exit.beneficiaries ?? []).reduce((s, b) => s + BigInt(b.amount ?? "0"), 0n);
    expect(amount).toBe(BigInt(DEPOSIT.amount) * BigInt(digests.size));
  }

  // A ledger past the move limit: where the value B paid back ended.
  if (ledger.expect) {
    const want = ledger.expect;
    const got = want.code
      ? (e.ledger.summary().find((g) => g.code === want.code)?.share ?? 0)
      : ([...e.nodes.values()].find((n) => `${n.address}|${n.coin_type}` === want.node)?.share ?? 0);
    expect(Math.abs(got - want.share), `${want.code ?? want.node}: ${got}, expected ${want.share}`).toBeLessThan(1e-6);
  }
}

const CASES = 500;
const LONG_CASES = 40;

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockPrices.clear();
  for (const c of COINS) if (c.priced) mockPrices.set(c.type, c.usd);
  mockFanout.mockReset();
  mockFanout.mockResolvedValue({ classification: "narrow", counterparty_count: 3, scanned_transactions: 10, truncated: false });
});

describe("address-start graph invariants over random ledgers", () => {
  for (const direction of ["forward", "backward"] as const) {
    it(`${direction}: ${CASES} ledgers keep shares, amounts, attribution, value and beneficiaries whole`, async () => {
      for (let seed = 1; seed <= CASES; seed++) {
        const rand = mulberry32(seed);
        const ledger = direction === "forward" ? forwardLedger(rand) : backwardLedger(rand);
        serve(ledger);
        // Attribution is checked on the unpruned runs, where every branch from the start node is kept.
        const unpruned = seed % 2 === 0;
        const e = new FlowEngine({
          direction,
          coin: null,
          maxDepth: 6,
          maxNodes: 60,
          minShare: unpruned ? 0 : 0.02,
          minUsd: null,
          window: {},
          maxTxReads: 200,
        });
        e.startFromAddress(START);
        await e.run();
        try {
          checkInvariants(e, ledger, direction === "forward", unpruned);
        } catch (err) {
          throw new Error(`seed ${seed}: ${(err as Error).message}\n${JSON.stringify(ledger.hops)} unreadable ${JSON.stringify([...ledger.unreadable])}`);
        }
      }
    });

    it(`${direction}: ${LONG_CASES} ledgers past the start node's move limit trace the value paid back to it`, async () => {
      for (let seed = 1; seed <= LONG_CASES; seed++) {
        const ledger = longLedger(mulberry32(seed), direction === "forward");
        serve(ledger);
        const e = new FlowEngine({ direction, coin: ledger.coin ?? null, maxDepth: 6, maxNodes: 60, minShare: 0.01, minUsd: null, window: {}, maxTxReads: 400 });
        e.startFromAddress(START);
        await e.run();
        try {
          checkInvariants(e, ledger, direction === "forward", false);
        } catch (err) {
          throw new Error(`seed ${seed}: ${(err as Error).message}`);
        }
      }
    });
  }
});
