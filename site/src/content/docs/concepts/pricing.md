---
title: How USD values are calculated
description: Price times, missing quotes and how to report estimated USD totals.
sidebar:
  order: 4
---

USD valuations are estimates: token amounts multiplied by third-party price
quotes. The chain records token amounts, not these USD values, and a quote
does not establish the price anyone actually traded at.

[Price sources](/guides/configuration/#price-sources) explains Aftermath,
DefiLlama, the keyless CoinGecko and GeckoTerminal historical fallbacks, and
optional Pyth (`PYTH_API_KEY`, verified coins only). Sui Bridge tokens can be
priced as their Ethereum asset (`priced_as`). No key is needed for the default
providers.

## Recent-history fallbacks

DefiLlama is the default historical source. If it has no quote or its request
fails, CoinGecko is asked first, then GeckoTerminal. These fallbacks cover
recent history only; dates outside each public API's history range are skipped
before any request. They never substitute a current price.

CoinGecko resolves the full Sui coin type as a contract on its `sui` platform,
then reads its [USD history chart](https://docs.coingecko.com/demo/reference/contract-address-market-chart-range).
Chart timestamps are milliseconds and are
converted to seconds without rounding to the requested time. A package address
or a matching ticker does not identify a coin.

GeckoTerminal discovers pools on `sui-network` by full coin type and chooses
the matching pool with the greatest reported USD reserve across the public
API's available pages. Liquidity is measured when pools are discovered, not at
the historical date. A capped scan is stated as `market.pool_scan_complete:
false`; selection then covers only the returned pools. The quote is the
requested coin's USD close from a completed hourly candle, whether that coin
is the pool's base or quote token. The API timestamps candle starts in seconds;
the reported sample time is the candle end. Empty intervals are not filled.
`market` names the pool and both candle boundaries.

Both fallbacks accept only samples within an hour of the requested time.
Charts are grouped by coin and UTC day; discovery and charts share a bounded
cache, including concurrent requests. Failed reads are not cached as absent
prices. Non-JSON replies, provider errors and HTTP 429 responses are request
failures, distinct from an answered request with no historical quote.

## Which time is used?

| Tool or value | Price time |
|---|---|
| `get_token_prices` | Current by default; `at` requests one historical time. |
| `get_wallet_overview` with `include_prices`, `analyze_token`, `get_pool_info` | Current coin prices, even when looking at an address or pool involved in an old transaction. |
| `analyze_attack_tx` | The transaction's time. |
| `trace_funds` | Each hop's transaction time for reported USD; current prices help choose the next hop. |
| `trace_flow_graph`, `find_flow_path` | Historical quotes shared within each UTC hour, requested at the first transaction time priced in that hour. |
| `summarize_address_flows`, `summarize_incident_losses`, `aggregate_events` with `group_pnl` | Each coin's median movement time within each UTC hour, before summing. If the window needs too many quotes, each coin's median time within each UTC day is used instead. |
| `summarize_incident_losses` with `price_at` | One fixed price time for coins and objects. |
| `compare_oracle_price` | Pyth at each market candle's close, or the window's end for an open candle. |

For an even number of movements, the median is the later of the two middle
times. It is not rounded to the start of the hour or day. The window tools
leave movements with unknown times unpriced; attack and trace tools can use
current prices when a transaction time is unavailable.

Objects follow their own `method`. `get_defi_positions`, wallet positions,
`list_nfts` and `list_nft_collections` value current holdings. Transaction
analyses value moved objects at their transaction checkpoint and time unless
`price_at` overrides the price time. Staked SUI includes principal and rewards
under the validator's rules; positions use their underlying assets and debts;
NFT estimates use collection listings and past sales. Read the method for
state fallbacks and the price source. Protocol-reported health or event USD
figures are separate from these provider-based valuations.

## Why a total can differ

Prices can move between a transaction and its quote. Thinly traded or illiquid
coins can have sparse quotes, and providers can return errors or inaccurate
prices. Displayed USD is rounded. Two tools can price the same movement at
different times, so even their totals can differ slightly.

Window totals accept quotes up to two hours from the requested sample time;
quotes more than one hour away are marked stale. Older quotes, unknown
decimals and missing prices or timestamps are excluded, making the total
partial. A partial net can be too high as well as too low if missing amounts
include losses. A missing price does not mean a token is worth zero.

## Read the qualifications

- **`usd_basis` or the pricing block** states the method, sources and coverage.
  `hourly_utc` means hourly median samples, `daily_median_time` means daily
  median samples, and `fixed_time` means the requested `price_at`.
  `price_samples` names each coin's provider, requested time, sample time and
  signed `price_offset_sec`, with timestamps in Unix seconds.
  `priced_by_source` in raw amount coverage splits incoming and outgoing
  amounts by the provider that valued them, including stale priced amounts.
  Position asset legs keep their provider quote in `price_sample`.
- **`partial` and unpriced lists** identify excluded amounts. Check
  `missing_coin_samples`, `unpriced`, `unpriced_remainder` and object
  `unread` or `unpriced_reason` where present, alongside raw priced/unpriced
  coverage. `request_failed_samples` within a missing-coin row counts samples
  whose provider reads failed, rather than establishing that no quote exists.
  Scan coverage is separate from price coverage.
- **`stale_quotes`** lists each coin's largest signed quote offset in a window.
  **`price_offset_sec`** in `get_token_prices` and `analyze_attack_tx` is the
  quote time minus the requested time: negative means earlier, positive later.
  Their `stale` flag means more than one hour away; unlike window totals,
  these tools do not exclude a quote solely for being over two hours away.

Report raw token amounts, with their full coin types, as the exact figures
for the movements read; report USD as an estimate and say when it is partial.
Use `summarize_incident_losses` with `price_at` when one consistent valuation
time is needed. See [USD over a time window](/concepts/fund-flows/#usd-over-a-time-window)
for the coverage fields in detail.
