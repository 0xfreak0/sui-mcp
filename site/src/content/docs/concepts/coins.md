---
title: Coin identity and scale
description: How tools mark whether a coin is the one you meant, where its decimals came from, and whether an issuer froze an address.
sidebar:
  order: 1
---

## Verified coins

A symbol is not an identifier on Sui. Different coin types can declare the
same symbol.
`analyze_token` reports `verified`, and every balance change in a trace
carries `coin_verified`:

```
-850 MAGMA (unverified, assumed scale)     coin_verified=false
+202.361728 USDC                           coin_verified=true
```

`unverified` means the exact coin type is not on the curated list.
`assumed scale` refers to the decimals. Tools that format or value an amount
use the curated decimals first, then the coin's own `CoinMetadata`, and a USD
value may also use the decimals its price provider states. `assumed scale`
means none of these answered: the coin has no `CoinMetadata` or the read
failed, and the fallback may differ from the coin's declared decimals.

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
one. The search confirms at most 25 candidate coin types, verified types and
exact symbols first, then by pool liquidity. Results are cached for 10
minutes, capped ones included; a provider outage or a failed confirmation is
not cached and is retried on the next call. If no candidate can be confirmed,
a bounded CoinMetadata scan is the fallback. That scan can find coins without
an indexed pool, but it is not a complete inventory.

`search_token` accepts a name or symbol, such as `USDC`, `deep`, `cetus` or
`WAL`, or a full type such as `0x…::mod::TOKEN`. It returns full coin types,
verified types first and then exact symbol matches, for use with
`get_balance`, `get_coin_info` and `get_token_prices`. Verification vouches for
the exact type, since names and symbols can be copied.

Mainnet search reports provider availability, `partial` when a provider fails
or provider/local caps hide matches, and the number of candidates `unconfirmed`
because their own on-chain metadata could not be read. A successful fallback
does not clear another provider's cap. Neither a capped result nor a failed
metadata check establishes that a symbol is absent or unique. Candidate
liquidity, pool counts and 24-hour volume are indexer-reported; they do not
establish legitimacy or ownership. The indexers cover pools rather than every
coin, and the 25-candidate confirmation limit and the bounded scan leave some
coins unread.
On testnet and devnet, discovery uses the bounded CoinMetadata scan instead
of mainnet DEX indexers. `discovery_scan_truncated` marks an unfinished scan;
`discovery_scan_failed` names a read error that stopped it.

`verify_onchain: true` additionally checks matches and includes total supply;
`limit` controls how many matches are displayed, not how many coins exist.

Tools that need a single asset type, such as `find_pools`, accept only curated
symbols. Pass an explicit coin type for an unverified discovery lead.
`impostor_of` flags unverified symbol lookalikes ignoring case and surrounding
whitespace; it is a string for one verified type or an array when several
verified types share that symbol. It does not assert malicious intent, and
never supplies the lookalike's decimals.


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

`find_pools(token_a, token_b)` searches exact pool types in both token orders.
It reports the result of each venue separately. A failed or bounded venue read
leaves pool discovery incomplete; an empty result describes only the searched
pair and venues. `total` counts every pool found; the list pages at about 30k
characters, and `omitted.next_call` repeats the call with the next `offset`.
DeepBook is an order book, so its vault balances are not tradable depth. Use
`deepbook_orderbook` to read resting orders.

`analyze_token(query)` discovers pools paired with SUI and native USDC on
mainnet and inspects current LP ownership for up to three pools ranked by the
coin's current reserve. `pool_discovery.scope` states what was not searched:
other pairs and other venues. Each pool gives `reserve_coin_raw` and
`counterpart_reserve`; a drained pool can hold a large reserve of the queried
coin and almost none of the other.

- **Fungible LP coins** (BlueMove, FlowX v2, Aftermath, Kriya's LP token): the
  scan reads LP coin and address-balance holders, up to 1,000 objects and 100
  holders, and checks their balances against the pool's minted LP supply. LP
  the pool keeps is part of that check: `lp_locked_in_pool_raw` (minimum
  liquidity no one can withdraw) and BlueMove's `lp_protocol_fee_in_pool_raw`.
  `share` is a holder's share of the supply.
- **Cetus and Magma positions**: the scan reads the pool's own position
  table, up to 1,000 positions, then each position NFT's owner. A position
  that is not a top-level object, such as one wrapped in a farm or a burn
  certificate, is counted under `owner_unread` with its amounts and share;
  its holder is not known.
- **Other CLMM venues**: the scan reads the first 1,000 position NFTs of the
  venue's position type, which rarely reaches every position of one pool. A
  scan that reaches the end is checked against the pool's active liquidity,
  since a wrapped position is not listed.

Positions held by one address are grouped. A CLMM `share` is the holder's
fraction of the pool's withdrawable amount of the queried coin at the current
price, with a separate `counterpart_share` for the paired coin; fees and
rewards are excluded. Shares are null when the scan is incomplete, and so are
`publisher_liquidity_raw` and `burned_liquidity_raw` when no such holder was
observed. Each row's `kind` is `publisher`, `burned` (an unspendable address),
`wallet`, `kiosk`, `package`, `object` or `unknown`; an owner-kind read that
fails stays `unknown`. A position kept as a dynamic object field is listed
under the object holding the field, such as a kiosk, with
`held_as_dynamic_object_field`. A kiosk is controlled by its
`KioskOwnerCap` holder, which `get_object` on the kiosk names. No locker package is verified for this check. An object
holding an LP or position is not proof of a liquidity lock; inspect its code
and authority before saying it cannot withdraw.

```
analyze_token({ query: "0x…::coin::COIN", include_holders: false })
  → pool_discovery: { pairs_searched: […], venues: […], scope: "…" }
    liquidity_custody: { pool_limit: 3, pools: [
      { pool_id: "0x…", scan: { scanned: 12, incomplete: false },
        holders: [{ address: "0x…", kind: "publisher", share: 0.75 }] }
    ] }
```

`creation` names the pool's creation transaction, its initial position or LP
recipients, and the current owner, current liquidity and last affecting
transaction of each initial position. `burned_positions` counts initial
positions an unspendable address holds with liquidity still in them; an
emptied position sent there is counted under `burned_empty_positions`.
`recent_removals` lists the venue's own liquidity-removal events and LP coins
spent among the ten newest pool transactions. A removed position or burned
LP may no longer appear among live holders. Use `trace_object_history` on the
position or `get_balance(at_checkpoint)` on the LP coin holder to check the
incident time. `liquidity_custody.next_call` pages further pools. Each pool's
`omitted.next_call` binds `liquidity_holder_pool` to that pool and advances
its `liquidity_offset`, so pagination never skips another pool's holders.
