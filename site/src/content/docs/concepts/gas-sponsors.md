---
title: Gas sponsors
description: How get_address_fanout classifies an address that pays other people's gas, and which classes are proven.
sidebar:
  order: 5
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
