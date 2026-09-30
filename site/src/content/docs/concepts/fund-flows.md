---
title: Fund flows
description: How trace_flow_graph allocates traced value across branches, how terminals are grouped, and how find_flow_path joins two addresses.
sidebar:
  order: 3
---

## Historical object flows

`summarize_address_flows` lists valued objects a transaction deleted or wrapped,
including transactions from before about March 2024, when effects did not record
their owners. It reads the holder at the version the transaction read and values
the object for the address that held it. An object whose holder cannot be read
is listed under `objects_unread`.

A stake withdrawal has a `StakedSui` row with direction `out` and a separate SUI
inflow in the same digest. Both legs remain separate in the output.

## Following every branch

`trace_funds` follows one branch. `trace_flow_graph` follows every branch and
says what share of the traced value ended where. From the Nemo exploit
transaction:

```
trace_flow_graph(digest: "19Zkat1xArMTMvPCB4e4QtM5HstpYiKvgPjbvkLUAw9")
  → 144,835.8 SUI credited to the attacker, swapped to 492,236.5 USDC in 3
    transactions, then burned through Circle CCTP in 3 more
    terminals: bridge_exit 99.9% ($492.1K) → beneficiary eip155:1:0x135477aa…
               below_threshold 0.07%
```

## How traced value is allocated

A node's traced amount is spent first in, first out: an address that pays out
more than it received from these funds is treated as paying these funds first,
and its payment carries only the traced part (`traced_amount`) onward. That is
a convention, not something the chain records.

Terminals are grouped by reason (`bridge_exit`, `sink`, `hub`, `unspent`,
`consumed`, `retained`, `signer_not_sender`, `budget`, `read_failed`), and
`coverage.truncated` says whether limits or unread evidence cut the graph short.

A sale whose proceeds are worth under a tenth of what went in carries only
what the proceeds are worth, whatever its calls are named. The rest ends in
one of two terminals:

- `retained`: the counterparty kept it. This needs the transaction's object
  changes read in full, and they must show that the seller was left owning no
  object from the transaction other than coins and that no dynamic field was
  written. The node names the shared objects the transaction wrote.
- `consumed`: every other case. The seller was left owning a receipt or
  position, new or existing, or the transaction wrote a dynamic field, where a
  table keyed by address can hold the seller's account unseen, or the object
  changes were not read in full.

A labelled attacker is followed rather than treated as a sink.

Before following a new party, the trace checks whether its funds are pooled
with other people's. An unread fan-out check stops that branch without
attributing further flows. `trace_funds` gives the reason in `stop_reason`;
`trace_flow_graph` uses a `read_failed` terminal and sets `coverage.truncated`.

## Resolving value arriving through a bridge

`resolve_bridge_transfer` reports solver-style inbound transfers in
`fulfilment_inbound`. It reads every balance-change page before matching an
event's amount and coin to a credited beneficiary, including credits after
the first 50 rows. `paid_to` and `released_from` also use the complete set.

If a balance continuation cannot be read, the result includes
`balance_changes_incomplete` and omits `fulfilment_inbound`. Its absence then
does not rule out an inbound transfer. Other bridge sections derived from
events or message inputs remain available.

## Paths between two addresses

`find_flow_path(from, to)` asks whether any path connects two addresses. It
searches forward from `from` and backward from `to` and joins them where the
money arrived before it moved on. `to` may also be an account on another
chain, which a path reaches through a bridge exit that pays it:

```
find_flow_path(from: <Cetus attacker>, to: "eip155:1:0x89012a55…",
               window_start: "2025-05-22T10:30:00Z")
  → 5 one-hop paths: Mayan MCTP (55 txs, 54.4M USDC), CCTP (7 txs),
    Wormhole, Sui Bridge
```

If an unread branch prevents the search from establishing a path, the result
is `search incomplete`, not a complete negative. `explored.terminals` retains
the `read_failed` entries and their reasons. Raising the limits does not
repair a failed read.

## Diagrams and exports

`trace_flow_graph`, `find_flow_path`, `trace_funds` and `build_wallet_edges`
take `format: "mermaid"` (a fenced diagram that renders in a markdown viewer),
`"graph_json"` or `"csv"`. `export_case` with `format: "mermaid"` appends a
fund-flow diagram of the transfers in the case's cited transactions.

Graph JSON retains terminal reasons and coverage (`explored` for
`find_flow_path`). Mermaid and CSV responses state unread reasons in the
accompanying summary, without adding them to the diagram or CSV data.
