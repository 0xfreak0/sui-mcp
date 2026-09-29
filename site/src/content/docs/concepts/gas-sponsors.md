---
title: Gas sponsors
description: How get_address_fanout classifies an address that pays other people's gas, and which classes are proven.
sidebar:
  order: 6
---

`get_address_fanout` reports `sponsor_shape` for an address that pays other
people's gas. This is invisible to value fan-out, since sponsoring moves none
of the sponsor's own money.

A sponsor that also sent a coin to at least half the addresses it sponsors
(`sponsored_and_paid_count`) is an `operator` running those wallets, the
relationship `build_wallet_edges` links. A public relayer pays gas for
strangers it never funded.

An operator that funds from one address and sponsors from another also reads
`relayer` here; `build_wallet_edges` tests for that split by the first funders
of the wallets the sponsor serves.

`relayer` and `operator` are proven. `private_sponsor` off a truncated scan is
flagged provisional, since breadth only grows with the window.

`build_wallet_edges` needs complete balance changes before choosing a first
funder. If a transaction's remaining rows cannot be read, the lookup is unread:
no first funder is chosen or cached, and no funding edge rests on that lookup.
The result reports `truncated: true` and explains the unread lookup in `notes`.
This also applies to the first-funder checks used for expansion and for a
sponsor/funder split. An unread lookup does not mean the wallet had no funder.

For recent seed activity, an incomplete balance-change list supplies neither
co-appearance nor payment evidence. Missing parties could hide a mass action,
and partial payments cannot establish reciprocal flow or a sponsor/operator
relationship. `notes` identifies the unread transactions; a failed history
page identifies the unread seed scan. Both set `truncated: true`. Complete
transactions still contribute signals, and gas sponsorship remains usable
because it is read independently of balance changes.

The small unpriced-coin grant check uses a bounded send window. If that window
or any transaction's balance changes exceed one page, the send cannot qualify
as a targeted grant. A partial recipient count is never proof of a small send.
