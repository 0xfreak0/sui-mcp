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

## Resolving a bridge transfer

`resolve_bridge_transfer` takes a Sui transaction digest and reads every
supported bridge transfer in it. Cross-chain message identities are quoted
on both chains, so follow-up compares identifiers rather than guessing from
amounts and timing.

| Protocol | Identity and destination data |
|---|---|
| Wormhole | VAA emitter chain, emitter address and sequence; destination transaction where Wormholescan has indexed a redemption |
| Sui native bridge | Chain-derived transfer identity and beneficiary; inbound claims carry their origin identity |
| Circle CCTP | Source domain and nonce identify the transfer; beneficiary decoded from Sui data |
| LayerZero V2 | Destination endpoint, GUID and destination OApp; LayerZero Scan's delivery transaction |
| Axelar ITS, Allbridge Core, Celer cBridge | Chain-derived transfer data and beneficiaries |
| Meson | Recognized, but its destination is not in Sui data |

`beneficiaries` names who is paid on the far side, decoded from the Sui
transaction for Wormhole Token Bridge (including Token Bridge Relayer),
Wormhole NTT, Mayan MCTP and Swift, Circle CCTP, Sui's native bridge,
LayerZero OFT, Axelar ITS, Allbridge Core and Celer cBridge. A contract
receiving a redemption or message is separate: `redeemed_via_contract`
or `destination_oapp`.

Transfers arriving on Sui include native-bridge claims and Wormhole Token
Bridge and NTT redemptions. `fulfilment_inbound` also covers any package whose
events quote the cross-chain message consumed, a CCTP source domain and
nonce or a VAA passed in, while the transaction credits an address. It lists
origin chain, CCTP transfer ID and VAA ID, amounts, and a beneficiary only
when the credited amount exactly matches an event amount. The package name
comes from the registry or a bridge label on the package or an object it defines.

`carriers` names a package outside a bridge's lineage whose PTB call emitted
that bridge's event, with its function and its own events, such as an adapter
order ID. `cross_chain_leads` lists uncovered packages' events that have a
chain field beside a foreign-address-sized byte string. These are heuristic
leads for possible exits through an unrecognized bridge, never exits by themselves.

Evidence tiers distinguish values read from Sui from delivery asserted by an
indexer. Confirm indexer delivery on the destination chain before relying on
it. `include_destination` defaults to true and queries Wormholescan and
LayerZero Scan; false keeps the read strictly on-chain.

## Graph allocation and coverage

`trace_flow_graph` starts from a Base58 `digest` or an `address`, never both.
From an address, it follows payouts after `from` forward or receipts before
`to` backward. A `coin_type` restricts the starting coin, such as
`0x2::sui::SUI`, but value is still followed through swaps.

Each transfer's traced value is allocated across recipients in proportion
to what they received. The walk keeps the actor through swaps and self-credits,
follows value released from objects, and stops at sinks, hubs, protocols,
bridge exits or a transaction signed by someone other than the sender.
Bridge terminals include the far-side beneficiary read from the transaction.
An address's swap counts once: later moves carry the proceeds forward, and
earlier inflows carry its input backward. Unmoved value ends as `unspent`
forward or `source` backward, or `budget` if the move limit stopped the search.

Nodes contain the address, coin, identity, traced share and amount, and ending
reason. Edges contain amounts, USD at transaction time and digests. `terminals`
groups the traced shares by reason, including `bridge_exit`, `sink`, `hub`,
`unspent`, `consumed`, `retained` and `budget`. `coverage` counts expanded and
pruned nodes, marks truncation, and sets `partial` when the starting address's
move search stopped at its limit.

`address_poisoning` always gives `addresses_compared` and the lookalike `pairs`
among reached addresses. Every format's summary names those pairs. No empty
list clears addresses outside the graph, and a lookalike branch is never
pruned for its share or USD value. Consumed and retained terminals can carry
heuristic `cross_chain_leads` when the transaction emitted a message-shaped
event from a package no bridge reader covers.

The summary fits about 20,000 characters, putting the largest traced shares
first and retaining bridge exits, sinks, hubs, protocols, consumed and retained
nodes, labelled addresses and lookalikes, with their incoming edges. Terminal
totals, coverage and shares cover the whole graph. `omitted` reports missing
rows; `detail: "full"` lists every node and edge.

Expansion costs about one search plus the spends found per node; 40 nodes
typically require 100–300 requests.

## Summarizing one address's window

`summarize_address_flows` gives each coin's inflow, outflow and net in raw
and human units, with `coin_verified` and USD valued at the window's time.
It lists every funder with amounts and digests, the top recipients by value
with identity and labels, and both the address's gas sponsors and the parties
whose gas it paid.

Bridge exits include far-side beneficiaries decoded from CCTP, Sui Bridge,
Wormhole Token Bridge and NTT payloads, and Mayan. Up to 20 other sends whose
value reached no address are read for message-shaped events from an
unrecognized bridge. Their `cross_chain_leads` are heuristic leads, never
proof of exits.

Gas is separate from coin totals. Value with no counterparty address is
`unattributed`, as in a swap, withdrawal or exploit. `address_poisoning`
always reports `addresses_compared` and lookalike `pairs` across sources,
recipients and received dust in this window. Empty pairs clear nothing outside it.

The scan runs newest first. Check `coverage.complete`; a budget stop gives
`coverage.continue_with`. `from` accepts an ISO time such as
`2025-09-07T00:00:00Z` or checkpoint; omitting it scans backward subject to
the budget. A `coin_type` filter affects totals and counterparties, while gas
and bridge exits stay complete.

The summary fits about 20,000 characters of counterparties, coins and
unattributed rows, ranked by value and preserving every labelled or non-wallet
address and lookalike. Totals and counts cover every row; `omitted` counts
display exclusions, and `detail: "full"` lists every row.

## Identifying a subject before tracing

`identify_address` distinguishes a wallet, package, validator and object
before further tool selection. Wallet context includes balance and SuiNS;
packages include modules, and validators include stake information.

For a package, `protocol` can fall back to a bridge label's entity on an
object of a type defined by that package, marked
`identified_via: "labeled-object"`. `bridge_carrier` lists bytecode calls into
a curated bridge's exit entry, identifying an adapter or aggregator capable
of sending that bridge's transfers.

A wallet's `first_seen` contains the oldest transaction GraphQL returns
where it was sender or an affected party: digest, timestamp, checkpoint,
sender and coins `received`. All of that transaction's balance-change pages
are read. `first_inflow` is true if it gained coins without sending the
transaction, including system-created genesis allocations with `sender: null`.
Genesis does not identify a funding wallet.

If no gain was found and the balance changes could not all be read,
`first_inflow` is null. `first_seen_unavailable` reports a failed first read.
Use `find_funding_sources` to find funding when the first transaction was not it.
