---
title: How to read results
description: How tools qualify their own answers, and where each qualification is described.
sidebar:
  label: Overview
  order: 0
---

These pages explain the limits and evidence behind tool results: when a list
is partial, where a label came from, and which amounts have a usable price.

| Page | Covers |
|---|---|
| [Coin identity and scale](/concepts/coins/) | `verified`, coin discovery, decimals, issuer freezes and liquidity custody |
| [Reading a transaction](/concepts/transactions/) | event filters and emitters, swap labels, abort codes and object custody |
| [Fund flows](/concepts/fund-flows/) | `trace_funds` branch selection, valued object edges, `find_flow_path` and label provenance |
| [How USD values are calculated](/concepts/pricing/) | current and historical prices, provider estimates, stale quotes and partial totals |
| [Lookalike addresses](/concepts/address-poisoning/) | `address_poisoning` pairs and which side is the impostor |
| [Shared funders](/concepts/shared-funders/) | `get_address_fanout` breadth and shape, and consolidation and other wallet-edge signals |
| [Gas sponsors](/concepts/gas-sponsors/) | `sponsor_shape` from `get_address_fanout` |
| [Historical balances and top holders](/concepts/balances-and-holders/) | historical balances and stakes, `complete_ranking`, and `list_objects_by_type` sums |
| [Kiosk-held NFTs](/concepts/nft-ownership/) | `holder_kind`, `kiosk_cap_holder`, sale-derived owners |
| [Packages and upgrade authority](/concepts/packages/) | publisher, UpgradeCap holder status, capability and mint-authority audit, bytecode leads |
| [Truncated lists](/concepts/truncation/) | `truncated`, `omitted` and `next_call` |
| [Security model](/concepts/security/) | process capabilities and the `untrusted_text` boundary |
