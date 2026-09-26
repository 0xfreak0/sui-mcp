/**
 * The row encoding of `src/data/coin-symbols.json`. `src/utils/coin-symbols.ts`
 * decodes it, and `test/coin-symbols.test.ts` round-trips one through the
 * other, so the two cannot drift apart unnoticed.
 *
 * The file maps a symbol, trimmed and lower-cased, either to the coins that
 * use it or, above `MAX_ROWS_PER_SYMBOL`, to how many do. A row is
 * `[type, decimals, name?, symbol?]`:
 *
 *   - `type` drops the `0x`. It also drops the module when the module equals
 *     the symbol key, and the struct when the struct is the module upper-cased,
 *     which is the one-time-witness convention `coin::create_currency` imposes
 *     and nearly every coin follows. `0x<pkg>::kong::KONG` under the key `kong`
 *     is written as `<pkg>` alone. A type that fits neither rule, such as a
 *     generic LP coin, is written whole with its `0x`.
 *   - `name` is left out when it equals the symbol, and cut to
 *     `NAME_MAX_CHARS`. It is null when only `symbol` needs writing.
 *   - `symbol` is left out when it is the key upper-cased.
 */

/** Above this many coins a symbol keeps only its count: a list that long cannot identify a coin. */
export const MAX_ROWS_PER_SYMBOL = 100;
export const NAME_MAX_CHARS = 64;

export const symbolKey = (symbol) => symbol.trim().toLowerCase();

/** A coin type written as compactly as the key it sits under allows. */
export function encodeCoinType(coinType, key) {
  const parts = coinType.split("::");
  if (parts.length !== 3 || !/^0x[0-9a-f]{64}$/.test(parts[0])) return coinType;
  const [pkg, mod, struct] = parts;
  if (struct !== mod.toUpperCase()) return coinType;
  const hex = pkg.slice(2);
  return mod === key ? hex : `${hex}::${mod}`;
}

/**
 * `coins`: `{ coin_type, symbol, name, decimals }` with `coin_type` fully
 * padded. A coin whose CoinMetadata and registry entry disagree on the symbol
 * appears once per symbol. Returns the `symbols` object and its counts, keys
 * and rows sorted so a re-run over the same chain state writes the same bytes.
 */
export function buildSymbolIndex(coins, maxRows = MAX_ROWS_PER_SYMBOL) {
  const byKey = new Map();
  for (const c of coins) {
    const key = symbolKey(c.symbol);
    if (!key) continue;
    let list = byKey.get(key);
    if (!list) byKey.set(key, (list = []));
    list.push(c);
  }

  // No prototype: anyone can mint a coin whose symbol is "__proto__", and on a
  // plain object that key would set the prototype and vanish from the JSON.
  const symbols = Object.create(null);
  let rows = 0;
  let countOnly = 0;
  for (const key of [...byKey.keys()].sort()) {
    const list = byKey.get(key).sort((a, b) => (a.coin_type < b.coin_type ? -1 : a.coin_type > b.coin_type ? 1 : 0));
    if (list.length > maxRows) {
      symbols[key] = list.length;
      countOnly++;
      continue;
    }
    symbols[key] = list.map((c) => {
      const row = [encodeCoinType(c.coin_type, key), c.decimals];
      const name = c.name.slice(0, NAME_MAX_CHARS);
      const symbolOwn = c.symbol !== key.toUpperCase();
      if (name !== c.symbol) row.push(name);
      else if (symbolOwn) row.push(null);
      if (symbolOwn) row.push(c.symbol);
      return row;
    });
    rows += list.length;
  }
  return { symbols, rows, symbolCount: byKey.size, countOnly };
}
