---
title: Kiosk-held NFTs
description: Who holds a kiosk-stored NFT, how get_nft_sales learns kiosk owners, and how kiosk_cap_holder resolves one kiosk.
sidebar:
  order: 8
---

## Listing a wallet's NFTs

`list_nfts` walks the wallet's kiosks, then its directly owned objects. Each
response contains a page-local `collection_types` array of complete Move
struct types. An NFT's numeric `collection_ref` is a zero-based index into
that array: `collection_types[nft.collection_ref]` gives its exact type,
including package addresses and generic arguments.

For example, this excerpt shows two synthetic objects of the same type:

```json
{
  "collection_types": [
    "0x00000000000000000000000000000000000000000000000000000000000000aa::art::Item"
  ],
  "nfts": [
    {
      "object_id": "0x0000000000000000000000000000000000000000000000000000000000000010",
      "collection_ref": 0
    },
    {
      "object_id": "0x0000000000000000000000000000000000000000000000000000000000000011",
      "collection_ref": 0
    }
  ]
}
```

References are local to one response, not stable collection identifiers.
Pass `next_cursor` as the next call's `cursor`, and use that response's own
table to resolve its rows. Every page includes all its referenced types,
even with `value: false` or `detail: "full"`. Kiosk-held rows keep `kiosk_id`;
object IDs, display fields and per-item values remain on each row.

Collection estimates under `valuation.nft_estimates.collections`, including
any estimate named under `omitted`, use the same table. `est_usd` is a
heuristic estimate from collection market evidence; objects handled by
another valuation reader carry `value_usd` and its tier instead.
`detail: "full"` adds raw Move contents and valuation evidence, while
`value: false` skips valuation.

`list_nft_collections` keeps the exact type in `collection`, since it already
returns one row per type. The wallet overview's NFT section lists compact
valuation summaries; use `list_nft_collections` for their collection details.

## The kiosk owner field

A kiosk-held NFT is owned by the Kiosk object. Its `owner` field is written
by `set_owner` and remains unchanged when the `KioskOwnerCap` moves, so it
can name a former cap holder. In a holder ranking, several kiosks declaring
one address may inflate that address's apparent NFT holdings.

## Owners learned from sales

`get_nft_sales` reads marketplace sales that name both buyer and buyer's
kiosk, establishing the kiosk's holder at that sale's checkpoint:

```json
{"hours":24}
```

The result reports `sales`, `volume_sui`, `kiosk_owners_learned` and `requests`
for the requested window.

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

`collection_type` narrows sales only for marketplaces whose event names the
collection. Sales without a named type are counted in
`unattributable_sales`; a filtered result can miss trades from those
marketplaces.
