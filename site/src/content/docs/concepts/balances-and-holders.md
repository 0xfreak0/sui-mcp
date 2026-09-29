---
title: Historical balances and top holders
description: How get_balance reconstructs a balance at a past moment, and when get_top_holders returns a real ranking.
sidebar:
  order: 6
---

## Balance at a past moment

`get_balance` takes `at` (ISO 8601) or `at_checkpoint`. GraphQL reads a
balance directly only inside its consistent range, about the last hour
(`method: consistent_read`). An older point is reconstructed
(`method: reconstructed`): the balance at a recent anchor checkpoint, minus
the owner's balance changes in that coin in every transaction after the
requested checkpoint up to the anchor. Balance changes include address-balance
deposits and withdrawals, so the result is exact when `complete` is true.

```
get_balance(owner: 0x01229b3c…c724, at: 2025-09-07T16:00:00Z)
  → method: reconstructed, at_checkpoint: 187414630, complete: true,
    balance: 78.654856875 SUI, transactions_scanned: 30,
    anchor: { checkpoint: 326856716, balance: 93.696806819 SUI, … }
```

The scan reads at most `max_transactions` (default 1,000, max 10,000). When
that runs out, `complete` is false, `balance` is null, and
`reached_checkpoint` is the oldest checkpoint the scan got back to: every
transaction after it was read. A reconstructed balance has no coin/address
split, so `coin_balance` and `address_balance` are null and `anchor` carries
the split at the anchor.

## Top holders

`get_top_holders` returns a ranking only when `complete_ranking` is true. It
walks two things in object-id order, which is unrelated to balance:
`Coin<T>` objects, and address balances (funds credited to an owner's address
rather than held as a coin object). A scan that stops early returns the
largest holder it happened to see. On SUI the reported top holder goes from
66 SUI at `max_scan` 200 to 3,454 at 800, with no overlap in the top five.

A truncated scan therefore returns `sampled_holders`, without a rank or a
percentage of supply, along with a caveat naming which walk stopped. Raise
`max_scan` (applied to each walk) until `truncated` is false to get a real
ranking; that is only practical for coins with few enough objects to
enumerate. A scan also stops at 35s, marked `time_budget_reached`, and the
caveat reports how far the scan got and whether a retry or a smaller
`max_scan` would help.

In a sample, each holder's `balance` is read directly for that address, since
the walk saw only some of its coins, and `balance_in_sample` is the walk's own
sum. Each holder carries `coin_balance` and `address_balance` beside the
total, and `owner_kind`, because an address balance can belong to an object
such as a bridge's liquidity bank. `analyze_token` reports the same
distinction.

For NFT collections, `holder_kind` says how each holder was found; see
[Kiosk-held NFTs](/concepts/nft-ownership/).
