---
title: What a result tells you about itself
description: How tools qualify their own answers, and where each qualification is described.
sidebar:
  order: 0
---

Several tools qualify their own answers rather than returning a number that
looks more certain than it is. The pages in this section describe those
qualifications, and the security model of the server.

| Page | Covers |
|---|---|
| [Coin identity and scale](/concepts/coins/) | `verified`, `coin_verified`, assumed decimals, ambiguous symbols, deny-list freezes |
| [Reading a transaction](/concepts/transactions/) | abort codes, objects that are not coins, transactions with no commands, address balances |
| [Fund flows](/concepts/fund-flows/) | `trace_flow_graph` terminals and first-in-first-out allocation, `find_flow_path`, export formats |
| [Lookalike addresses](/concepts/address-poisoning/) | `address_poisoning` pairs and which side is the impostor |
| [Gas sponsors](/concepts/gas-sponsors/) | `sponsor_shape` from `get_address_fanout` |
| [Historical balances and top holders](/concepts/balances-and-holders/) | `get_balance` at a past moment, `complete_ranking` in `get_top_holders` |
| [Kiosk-held NFTs](/concepts/nft-ownership/) | `holder_kind`, `kiosk_cap_holder`, sale-derived owners |
| [Packages and upgrade authority](/concepts/packages/) | publisher, UpgradeCap holder status, capability and mint-authority audit, bytecode leads |
| [Truncated lists](/concepts/truncation/) | `truncated`, `omitted` and `next_call` |
| [Security model](/concepts/security/) | what the process can and cannot do |
