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

`unverified` refers to which coin it is.
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

A symbol no curated list covers is searched live on mainnet: DexScreener is
queried for both the ticker and `ticker SUI`, so other chains do not crowd
Sui pairs out of its 30-pair response. GeckoTerminal is queried if those
results are missing, capped or unavailable; its public results also have a
20-pool cap. Candidate coin types are confirmed against on-chain metadata;
a DEX listing is a lead, not verification of the asset's identity.
`analyze_token` returns multiple matches as candidates rather than choosing
one. The search confirms at most 25 candidate coin types by pool liquidity;
only searches without provider or metadata failures are cached for 10 minutes.
Coins without an indexed pool cannot appear in live results. If no candidate
can be confirmed, a bounded CoinMetadata scan is the fallback, not a complete
inventory.

`search_token` accepts a name or symbol, such as `USDC`, `deep`, `cetus` or
`WAL`, or a full type such as `0x…::mod::TOKEN`. It returns full coin types,
verified types first and then exact symbol matches, for use with
`get_balance`, `get_coin_info` and `get_token_prices`. Verification vouches for
the exact type, since names and symbols can be copied.

Mainnet search reports provider availability, `partial` when provider result
caps may hide matches, and the number of candidates `unconfirmed` because their
own on-chain metadata could not be read. Neither a capped result nor a failed
metadata check establishes that a symbol is absent or unique. Candidate
liquidity, pool counts and 24-hour volume are indexer-reported; they do not
establish legitimacy or ownership. The indexers cover pools, not every coin,
and the top-25 confirmation limit and bounded scan leave some coins unread.
On testnet and devnet, discovery uses the bounded CoinMetadata scan instead
of mainnet DEX indexers. `discovery_scan_truncated` marks an unfinished scan;
`discovery_scan_failed` names a read error that stopped it.

`verify_onchain: true` additionally checks matches and includes total supply;
`limit` controls how many matches are displayed, not how many coins exist.


## Frozen addresses

`check_coin_restrictions` reads the on-chain deny list in two directions:
given a coin type, it lists the addresses frozen for that coin; given an
address, it lists the coins that freeze it. A frozen address usually holds
none of the coin that froze it, so the address check covers every coin type
with a deny list rather than the ones it holds. A freeze by
validators is node configuration, not chain state, and does not appear here.

The issuer's freeze is a chain-derived attribution, not a protocol rule:
whoever holds the `DenyCap` can reverse it. The tool also reports a pause
affecting the whole coin. Use it when a traced address cannot move a token or
to check whether an issuer has already frozen a counterparty.

With both `coin_type` and `address`, the tool checks that pair. Address-only
checks read many deny lists because holding none of a coin does not establish
that the address is unrestricted. For a coin's address list, `max_addresses`
defaults to 200, at most 1000.

## Liquidity pools

`find_pools` searches Cetus, DeepBook v2 and v3, Turbos and BlueMove v1 by
exact pool type, in both token orders. BlueMove v1 pools can be object-owned;
they are included without an address-owner filter. Pass `protocol: "bluemove"`
to restrict the search. A pool's presence does not establish tradable depth
or locked liquidity.

`analyze_token` does not discover pools or inspect LP custody. Metadata,
supply, holder concentration and mint authority cannot establish whether
liquidity is locked. For that question, find the pools, identify the position
objects or LP coins and read their custody at the relevant time with
`trace_object_history` or historical `get_balance`. Current ownership cannot
establish who could withdraw during a past incident.
