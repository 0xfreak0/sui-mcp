import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildSymbolIndex } from "../scripts/lib/coin-symbols-encode.mjs";
import { createSymbolIndex, symbolIndex, type CoinSymbolsFile } from "../src/utils/coin-symbols.js";
import { runWithNetwork } from "../src/config.js";

const KONG_SUI = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG";
const KONG_DING_DONG = "0xcc345bb9b0d5ddd2d01a4e303a9fa4c00b6da760e4618ed31e303c585df962ca::kong::KONG";

/** Coins as the sync reads them from mainnet, one per encoding the rows use. */
const COINS = [
  { coin_type: KONG_SUI, symbol: "KONG", name: "KONG SUI", decimals: 1 },
  { coin_type: KONG_DING_DONG, symbol: "KONG", name: "Kong Ding Dong", decimals: 6 },
  // Module differs from the symbol key.
  { coin_type: "0x1c91c9215cc50558c28d25b2dfa187179f0477c557c4c3bfd9f3af17bf9d717a::c_1::C_1", symbol: "1", name: "1", decimals: 6 },
  // Mixed-case symbol, and a name equal to it.
  { coin_type: "0x0144b39cbd32decfe4985f32f6fc0636f3a5d254adc3192d506da022a4149a0b::suiwukong::SUIWUKONG", symbol: "Suiwukong", name: "Suiwukong", decimals: 6 },
  // Struct is not the module upper-cased, so the type is written whole.
  { coin_type: "0x3b87e7b4d77135866f33a7ccbb3d492ca269598294f4b597857cbb784c08ce28::Cetus::Cetus", symbol: "! Cetusairdrop com Cetus reward", name: "CetusAirdrop.com", decimals: 6 },
  // A generic coin type.
  {
    coin_type: "0xe73dbefa2da18eb4cb10e8c902896fa139159c05a3b7c042a028b4c3ee8d475e::blast_boost::BlastBoost<0xe9b3d42d4e4f6a97aaa43884b155c42abd8c2c62bba9a51e8847d7b05f3717ba::blast_boosts_products::NVDA_BULL_2X>",
    symbol: "\"NVDA2L\"",
    name: "\"NVDA 2x Bull\"",
    decimals: 9,
  },
  // Trailing space: the key is trimmed, the symbol is kept as written.
  { coin_type: "0x00035fc6dac8b502ad26291a180a03ec02ff218688aa619072119a334dcc4002::privatecoin::PRIVATECOIN", symbol: "USDC ", name: "Tatr U", decimals: 9 },
  { coin_type: "0x009f33ecca62cb3a6eff9df6517f4bc2cd3f879003e3c69454f5271f6674be26::yungog::YUNGOG", symbol: "YUNGOG", name: "Yung Kong Khan", decimals: 9 },
  // A symbol that is an object's prototype key. A plain `{}` in the encoder
  // takes it as the prototype, and the JSON loses it.
  { coin_type: "0x7e57000000000000000000000000000000000000000000000000000000000001::proto::PROTO", symbol: "__proto__", name: "__proto__", decimals: 9 },
];

function fileFor(coins: typeof COINS, maxRows = 100): CoinSymbolsFile {
  const built = buildSymbolIndex(coins, maxRows);
  return {
    synced_at: "2026-09-26",
    checkpoint: 190000000,
    counts: { coins: coins.length },
    max_rows_per_symbol: maxRows,
    symbols: built.symbols,
  };
}

describe("symbol index encoding", () => {
  // The sync script encodes and the server decodes; a change to one side
  // alone would hand analyze_token wrong coin types without any error.
  it("decodes every row back to the coin, symbol, name and decimals the sync read", () => {
    const file = JSON.parse(JSON.stringify(fileFor(COINS))) as CoinSymbolsFile;
    expect(Object.keys(file.symbols)).toHaveLength(buildSymbolIndex(COINS).symbolCount);
    const index = createSymbolIndex(file);
    for (const c of COINS) {
      const found = index.lookup(c.symbol);
      expect(found.status).toBe("listed");
      const coins = found.status === "listed" ? found.coins : [];
      expect(coins).toContainEqual({ coin_type: c.coin_type, symbol: c.symbol, name: c.name, decimals: c.decimals });
    }
  });

  it("looks a symbol up trimmed and case-insensitively, and lists every coin that uses it", () => {
    const index = createSymbolIndex(fileFor(COINS));
    const found = index.lookup(" kong ");
    expect(found.status === "listed" ? found.coins.map((c) => c.coin_type) : []).toEqual([KONG_SUI, KONG_DING_DONG]);
    expect(index.lookup("usdc").status).toBe("listed");
  });

  it("keeps only a count for a symbol more coins use than the row limit", () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      coin_type: `0x${(i + 1).toString(16).padStart(64, "0")}::fwp::FWP`,
      symbol: "FixWalletsPls",
      name: "spam",
      decimals: 9,
    }));
    const index = createSymbolIndex(fileFor([...many, COINS[0]], 2));
    expect(index.lookup("fixwalletspls")).toEqual({ status: "count_only", count: 3 });
    expect(index.lookup("KONG").status).toBe("listed");
  });

  it("returns a symbol too common to list when it contains the query, and only then", () => {
    const spam = (symbol: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ coin_type: `0x${(i + 1).toString(16).padStart(64, "0")}::fwp::FWP`, symbol, name: "spam", decimals: 9 }));
    const index = createSymbolIndex(fileFor([...spam("FixWalletsPls", 3), ...spam("FixWalletsNow", 4), ...COINS], 2));
    expect(index.search("fixwallets")).toMatchObject({
      exact: { status: "absent" },
      coins: [],
      unlisted: [
        { symbol: "fixwalletsnow", count: 4 },
        { symbol: "fixwalletspls", count: 3 },
      ],
    });
    expect(index.search("fixwalletspls")).toMatchObject({ exact: { status: "count_only", count: 3 }, unlisted: [] });
    expect(index.search("kong").unlisted).toEqual([]);
  });

  it("does not read a symbol like 'constructor' off the object prototype", () => {
    expect(createSymbolIndex(fileFor(COINS)).lookup("constructor")).toEqual({ status: "absent" });
  });

  it("searches symbols and names by substring, exact symbol first", () => {
    const index = createSymbolIndex(fileFor(COINS));
    const { exact, coins } = index.search("KONG");
    expect(exact.status).toBe("listed");
    expect(coins.slice(0, 2).map((c) => c.coin_type)).toEqual([KONG_SUI, KONG_DING_DONG]);
    // Symbol substring and name substring.
    expect(coins.map((c) => c.symbol)).toEqual(expect.arrayContaining(["Suiwukong", "YUNGOG"]));
  });
});

describe("shipped symbol index", () => {
  const file = JSON.parse(readFileSync(new URL("../src/data/coin-symbols.json", import.meta.url), "utf8")) as CoinSymbolsFile;

  it("decodes every row to a full coin type", () => {
    const index = createSymbolIndex(file);
    const malformed: string[] = [];
    for (const key of Object.keys(file.symbols)) {
      const found = index.lookup(key);
      if (found.status === "absent") malformed.push(`${key}: absent`);
      if (found.status !== "listed") continue;
      for (const c of found.coins) {
        if (!/^0x[0-9a-f]{64}::\w+::\w+/.test(c.coin_type) || !Number.isInteger(c.decimals)) malformed.push(`${key}: ${c.coin_type}`);
      }
    }
    expect(malformed).toEqual([]);
  });

  it("is consulted on mainnet only, since coin types embed per-network package IDs", () => {
    expect(runWithNetwork("testnet", () => symbolIndex())).toBeNull();
  });
});
