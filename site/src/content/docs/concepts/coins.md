---
title: Coin identity and scale
description: How tools mark whether a coin is the one you meant, where its decimals came from, and whether an issuer froze an address.
sidebar:
  order: 1
---

## Verified coins

A symbol is not an identifier on Sui. Most coins on mainnet share their symbol
with another coin, and imitators are named to be mistaken.
`analyze_token` reports `verified`, and every balance change in a trace
carries `coin_verified`:

```
-850 MAGMA (unverified, assumed scale)     coin_verified=false
+202.361728 USDC                           coin_verified=true
```

These are two separate marks. `unverified` refers to which coin it is.
`assumed scale` refers to whether the amount is right: decimals for an unknown
coin are a guess, and some imitators declare a different scale from the coin
they imitate. Every tool that formats or values an amount reads the
coin's own `CoinMetadata` first, so an amount at the coin's real decimals
carries only `unverified`, and `assumed scale` means the coin has no
`CoinMetadata` to read or the read failed.

## Where the decimals came from

`analyze_token` narrows the guess by reading `0x2::coin_registry`, Sui's
canonical on-chain coin metadata, and `decimals_source` names where the scale
came from:

```
analyze_token(0xdba34672…::usdc::USDC)
  → decimals: 6, decimals_source: coin_metadata
    verified: true
    coin_registry: { registered: true, regulated: regulated, regulated_cap_id: 0x699b3162… }
```

Being in that registry is not a vouch. Anyone who can publish a coin can
register it, so an impostor's entry looks the same as the real asset's, and
`verified` still reports only what the curated list says. The registry
supplies chain-derived decimals, and whether an issuer holds a cap that can
freeze holders.

`decimals_source` is one of `coin_metadata`, `coin_registry`, `curated`,
`symbol_scan` or `assumed`. The last two carry a note saying what the scale
rests on.

## Ambiguous symbols

An ambiguous symbol returns candidates rather than a coin. `USDC` matches
several legitimate verified coins on Sui (Circle's, Wormhole's, Celer's), so
picking one would misreport which asset moved.

A symbol no curated list covers is looked up in a symbol index of every coin
on mainnet, synced from each `CoinMetadata` and coin registry entry by
`npm run sync:coin-symbols`. Many coins use `KONG`, so `analyze_token` returns
them as candidates, verified first and then by supply, and `search_token`
lists them. The index has a date, and every answer drawn from it names that
date: a coin published later is found only by a bounded live scan of on-chain
metadata, which says how far it got.

## Frozen addresses

`check_coin_restrictions` reads the on-chain deny list in two directions:
given a coin type, it lists the addresses frozen for that coin; given an
address, it lists the coins that freeze it. A frozen address usually holds
none of the coin that froze it, so the address check covers every coin type
with a deny list rather than the ones it holds. A freeze by
validators is node configuration, not chain state, and does not appear here.
