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
DefiLlama and optional Pyth (`PYTH_API_KEY`, verified coins only), including
Sui Bridge tokens priced as their Ethereum asset (`priced_as`). No key is
needed for the default providers.

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
- **`partial` and unpriced lists** identify excluded amounts. Check
  `missing_coin_samples`, `unpriced`, `unpriced_remainder` and object
  `unread` or `unpriced_reason` where present, alongside raw priced/unpriced
  coverage. Scan coverage is separate from price coverage.
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
