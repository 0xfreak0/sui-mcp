---
title: Kiosk-held NFTs
description: Who holds a kiosk-stored NFT, how get_nft_sales learns kiosk owners, and how kiosk_cap_holder resolves one kiosk.
sidebar:
  order: 8
---

## The kiosk owner field

A kiosk-held NFT is owned by the Kiosk object, and a kiosk carries an `owner`
field that `set_owner` writes. That field does not follow the
`KioskOwnerCap`, so it names whoever set it last. On mainnet it often
disagrees with the real cap holder, and a single address can be declared by
many kiosks, which is enough to invent a top holder out of a platform address.

## Owners learned from sales

`get_nft_sales` closes that gap. A marketplace sale names the buyer and the
buyer's kiosk in one record, so any kiosk seen trading has a chain-derived
owner:

```
get_nft_sales({ hours: 24 })
{ "sales": 237, "volume_sui": "5982.3007", "kiosk_owners_learned": 249, "requests": 13 }
```

Those mappings are stored, and `get_top_holders` uses them. `holder_kind`
names how each holder was arrived at, weakest evidence first:
`kiosk_declared` from the kiosk's own field, `kiosk_resolved` from a sale
record, `wallet` read from the object itself, and `mixed` when one address
holds NFTs by more than one route. A sale-derived owner is chain-derived but a
snapshot at that checkpoint, and a kiosk can be sold afterwards, so it is not
reported as `wallet`. `from_kiosk_owner_field` and `from_sale_records` carry
the split.

The window is bounded because `events` has no collection filter, so all-time
volume would be unbounded paging. It reads TradePort, BlueMove and OriginByte,
and requires `SUI_STORE_PATH` to keep what it learns.

## One kiosk: `kiosk_cap_holder`

For one kiosk you already have the id of, `get_object`, `identify_address`
and `trace_object_history` answer this directly with `kiosk_cap_holder`: read
from the cap's own current owner, found via the kiosk's creation transaction
(which `kiosk::new()` always creates alongside the cap) rather than a scan.

`get_object`'s version only applies to the latest snapshot: a past `version`
skips the lookup, since today's cap holder is not who controlled a prior
state. `trace_object_history` attaches it only to `current`, never to
`created`, a `history` row or an `owner_changes` endpoint even when they share
the same kiosk: the cap's holder today is not who controlled the kiosk then.

A cap wrapped inside another object (a personal kiosk's `PersonalKioskCap`,
including one created in the same transaction as the kiosk) resolves to the
owner of the outermost wrapper, with `kiosk_cap_wrapped_in` listing the
wrappers from the cap outwards. A wrapper is named only while its current
contents still hold the cap; when the cap has moved to another container, the
lookup follows it there. A chain that cannot be followed, or a failed read (in
`trace_object_history`, also the walk from an item up to its kiosk), gives
`kiosk_cap_holder_note` and the rest of the answer.

`get_top_holders`'s sale-derived resolution above is for ranking many kiosks
at once, where reading each one's creation transaction is not practical.

## Filtering by collection

`collection_type` narrows the result, but only for marketplaces that name the
collection in the event, and most sales carry no collection type at all.
Those are counted in
`unattributable_sales` rather than filtered out quietly, so a small number of
matches is never mistaken for a collection that did not trade.
