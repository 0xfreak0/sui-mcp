---
title: Fund flows
description: How trace_flow_graph allocates traced value across branches, how terminals are grouped, and how find_flow_path joins two addresses.
sidebar:
  order: 3
---

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
`consumed`, `retained`, `signer_not_sender`, `budget`), and
`coverage.truncated` says whether a limit cut the graph short.

A sale whose proceeds are worth under a tenth of what went in carries only
what they are worth, whatever its calls are named. The rest is `consumed`
when the seller holds a receipt or position for it, new or existing, or may
hold an account in a table the transaction wrote, and `retained` by the shared
objects the transaction wrote only when the object changes show it holds
nothing.

A labelled attacker is followed rather than treated as a sink.

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

## Diagrams and exports

`trace_flow_graph`, `find_flow_path`, `trace_funds` and `build_wallet_edges`
take `format: "mermaid"` (a fenced diagram that renders in a markdown viewer),
`"graph_json"` or `"csv"`. `export_case` with `format: "mermaid"` appends a
fund-flow diagram of the transfers in the case's cited transactions.
