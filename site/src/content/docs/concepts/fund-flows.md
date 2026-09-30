---
title: Fund flows
description: How trace_flow_graph allocates traced value across branches, how terminals are grouped, and how find_flow_path joins two addresses.
sidebar:
  order: 3
---

## USD over a time window

For an overview of quote times and reporting estimates, see
[How USD values are calculated](/concepts/pricing/).

`summarize_address_flows` values each coin movement using the median leg time
for its coin and UTC hour, then sums those values. It does not multiply a
multi-month coin total by one price. Counterparties, unattributed flows and bridge exits share the samples.
Objects retain their own valuation methods and transaction times.

`usd_basis.method` is `hourly_utc` by default. When the requested coin-hours
exceed the sample budget, `daily_median_time` uses each coin/day's median
transaction time instead. Sample times are not rounded to the hour. For an
even number of legs, the later middle leg is used.
The block reports sources and requested, priced and missing coin samples.
Quotes within one hour of the sample time are fresh. Quotes over one and up
to two hours away are accepted as stale; `stale_quotes` lists each coin's
largest signed offset in seconds. Older quotes stay unpriced. These are
estimates, not execution prices. `priced_raw`, `stale_priced_raw` and
`unpriced_raw` separate fresh, stale and excluded amounts without overlap.
Missing timestamps or quotes never fall back to today's price.
Fully priced flow and participant rows use gross `raw.in` and `raw.out`
instead of repeating priced and zero unpriced buckets. For these rows,
`stale_priced_raw`, when present, is a subset of `raw`; the rest is fresh.
Bridge summaries cap transaction detail, not group totals or destinations.
`omitted` names the removed rows and gives the full-result continuation.
Coin decimals come from the registry, cached on-chain metadata or the quote's
provider. A quote without a known decimal scale stays unpriced.

DefiLlama is the default, with keyless CoinGecko and GeckoTerminal fallbacks
for recent dates; Pyth is used only with `PYTH_API_KEY`. Historical
DefiLlama reads batch samples, and successful samples are cached per network.
The newest samples are priced first within a bounded read budget. If
`budget_skipped_coin_samples` is nonzero, narrow the window and combine
disjoint windows. A partial USD net is not a lower bound: missing debits can make it
too high.

`summarize_incident_losses` uses the same quotes for gains, pool deltas,
recipient selection and transfers sent on. Coin legs are priced before being
netted: equal token amounts at different dates can have a nonzero USD net.
Objects received and later consumed retain each leg's historical value.
`price_at` explicitly switches coins and objects to a fixed-time valuation;
`usd_basis.method` identifies that choice. Missing coin legs or objects make
`totals.partial` true, not a claim that the total is a lower bound.

With `group_pnl: true`, `aggregate_events` uses the same median-time samples
to price each sender's balance changes before netting them. Gas stays included.
Check `pnl.usd_basis` before comparing senders with different missing-price coverage.

## Historical object flows

`summarize_address_flows` lists valued objects a transaction deleted or wrapped,
including transactions from before about March 2024, when effects did not record
their owners. These rows carry `source_unrecorded`. It reads the holder at the
version the transaction read and values the object for the address that held it.
Object-held, shared and immutable owners are excluded from direct-address
valuation. An unread or unrecognised holder is listed under `objects_unread`.

A stake withdrawal has a `StakedSui` row with direction `out` and a separate SUI
inflow in the same digest. Both legs remain separate in the output.

`analyze_attack_tx` and `summarize_incident_losses` use the same valuation path.
`trace_funds` can value these objects through its archive path, but its GraphQL
path can omit historical deleted objects whose type is absent. A tracked
object's deletion or wrap ends its trail. `get_transaction` does not report a
wrap with no recorded holder as a custody change.

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

The graph's starting branches and percentages cover coin balance changes.
Transferring a `StakedSui`, NFT or position without a coin credit does not seed
an object branch, even if another coin moved in the same transaction. A
reported 100% unspent share therefore says nothing about those transferred
objects. Use `get_transaction` for object transfers, `trace_funds` for an
object branch and `trace_object_history` for custody; start a coin graph at
the transaction that releases the object's coins.

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

Each side expands one address node at a time, heaviest branch first, so
`max_nodes` goes to the branches carrying the most value. `min_share` skips
smaller branches, except a branch to an address that renders like one
already reached. When nothing is found, `explored.node_limited` names, per
side, the nodes the node limit left unexpanded and the share of that side's
value they carry.

If an unread branch prevents the search from establishing a path, the result
is `search incomplete`, not a complete negative. `explored.terminals` retains
the `read_failed` entries and their reasons. Raising the limits does not
repair a failed read.

## Diagrams and exports

`trace_flow_graph`, `find_flow_path`, `trace_funds` and `build_wallet_edges`
take `format: "mermaid"` (a fenced diagram that renders in a markdown viewer),
`"graph_json"` or `"csv"`. `export_case` with `format: "mermaid"` appends a
fund-flow diagram to the case report, read from the chain: the transfers
between the case's addresses in the findings' transactions, plus value those
addresses took out of or paid into protocols' shared objects, drawn as one
node per protocol set. Each finding's cross-chain accounts are linked by
dashed edges. Its `graph_json` is the same diagram as nodes and edges, and its
CSV has one row per finding.

Graph JSON retains terminal reasons and coverage (`explored` for
`find_flow_path`). `trace_flow_graph`'s graph JSON also carries
`address_poisoning`, the lookalike check over every reached address. Mermaid
and CSV responses state unread reasons in the accompanying summary, without
adding them to the diagram or CSV data.

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

Orbiter Finance is not in the curated bridge decoders. Its
`OrbiterRouter::MessageTakenEvent.msg` can hold the intended recipient and
chain in an ASCII query-string memo. That encoding has no separate
chain/address fields for `cross_chain_leads` to match, so an empty bridge
result does not rule out an Orbiter route. Read the memo with `get_transaction`
and verify the maker's payment on the destination chain. A memo records the
requested route, not proof of delivery.

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

The summary has a display budget, putting the largest traced shares
first and retaining bridge exits, sinks, hubs, protocols, consumed and retained
nodes, labelled addresses and lookalikes, with their incoming edges. Terminal
totals, coverage and shares cover the whole graph. `omitted` reports missing
rows; `detail: "full"` lists every node and edge.

## Summarizing one address's window

`summarize_address_flows` gives each coin's inflow, outflow and net in raw
and human units, with `coin_verified` and USD valued per transaction day.
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

The summary applies a display budget to counterparties, coins and
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

## Screening exposure

`screen_address` reads direct and indirect exposure to labelled malicious,
sanctioned, exchange, bridge and mixer accounts. It defaults to two hops in
both directions. Each exposure gives its path, per-leg digests and amounts,
and the label's entity, evidence kind and `source_url`.

Bridge beneficiaries decoded by `resolve_bridge_transfer` are screened
against labels and OFAC's SDN digital currency list: CCTP, Sui Bridge,
Wormhole, Mayan, LayerZero OFT, Axelar, Allbridge and Celer. Each exit counts
once under the carrying protocol; `route` gives settlement bridges and
`also_exited` identifies other bridges used in the same transaction.

Coverage reports available label sources, the absence of Sui addresses from
OFAC's list, and how much history was read for each address. The default
subject window is 300 recent transactions in each direction; a 100-transaction
window can miss an active address's largest exit. Expanded counterparties
get 50 transactions. `max_expand` defaults to eight counterparties per hop,
highest value first.

`windows[].incomplete_transactions` names transactions whose balance pages
could not all be read. Their paths are withheld, and affected bridge
`sent` amounts are null rather than partial totals.

A CAIP-10 account on another chain, such as `eip155:1:0x…`, receives only a
direct label and sanctions lookup; the server does not trace that chain.

## Classifying an exchange deposit address

`classify_deposit_address` tests whether an address is a per-customer deposit
address that an exchange sweeps into its hot wallet, the identifier used to
request the customer's identity. Its `likely`, `no` or `unknown` verdict is
heuristic. With complete balances, it checks three things independently:

1. Every outflow sweeps the full balance to one destination.
2. A relayer-shaped sponsor pays the sweeps' gas.
3. The destination is a labelled exchange, with its `source_url`, or is hub-shaped.

A sweep paying its own gas may leave up to 1 SUI as reserve. A balance equal
to deposits arriving just before a sweep can be left for the next one,
recorded in `left_for_next_sweep`, if the next outflow of that coin empties
it into the same destination or is not yet in the window. Any other residual
balance fails the sweep check.

With complete balances, each check runs regardless of the others' results.
`checks_not_run` explains null checks. Unread balances instead produce
`unknown`, null checks, null `sweep_count` and `deposit_count`, and
`incomplete_transactions`, not a negative deposit-address finding.

Results identify the hot wallet, exchange label and provenance, sweep sponsor,
sweep digests and deposits. The default verdict covers the newest 50
transactions, not the address's lifetime. An `unknown` result with no outflows
does not rule out older exchange sweeps.

Pass `from` and `to` for the period in question. ISO timestamps include both
edges; checkpoint numbers are exclusive, as in `summarize_address_flows`.
Bounds go into the transaction filter before the read:

```
classify_deposit_address(address: <candidate>,
  from: "2026-09-29T00:00:00Z", to: "2026-09-30T00:00:00Z",
  max_transactions: 500)
```

`window` reports the requested bounds, resolved checkpoints, oldest and newest
transactions read, transaction and read budgets, and completeness.
`window.continue_with` reads further back, repeating the boundary checkpoint.
Each call judges its own window; separate verdicts are not a combined
classification. Raise `max_transactions` or narrow the period when capped.
The maximum scan is 5,000 transactions or 100 transaction-page reads.
`detail: "full"` returns all scanned evidence rows; summary omissions name
the call that returns them.

A historical upper bound also needs the balances then. The tool pins a recent
balance anchor and subtracts every later balance change, across all coins,
before judging the requested sweeps. `balance_reconstruction` states its
anchor, coverage and separate `max_balance_transactions` budget (default
1,000, maximum 10,000), with at most 200 transaction-page reads. An unread or
incomplete reconstruction leaves the
full-balance check null, never a partial sum. A very recent requested bound
can be newer than the balance anchor; `window.anchor_limited` then states that
the newer part was not read. Retry later to include it.
Sponsor and destination fan-out checks use their recent activity, not a
historical reconstruction of their behaviour.

`summarize_address_flows`, `identify_address` and `manage_labels` lookup share
a `deposit_address` field without running the classifier. It reports an
effective inferred deposit label with its sweep evidence and one applicable
`session_verdict`. A flow summary selects that verdict by its resolved
checkpoint bounds, so `from: "now"` is not confused with unbounded history.
The same bounds apply to the subject, inflow sources, recipients and gas
sponsors. Their classification follow-up calls retain the incident period.
`other_session_observations` counts the other windows without repeating them
on each row. `session_observations_call` returns all observations and their
full checks through `manage_labels(action: "lookup", detail: "full")`.
Without either applicable source it says `not classified` and returns the
`classify_deposit_address` call. The session cache is network- and
address-qualified, keeps the latest observation per resolved window and lasts
only for the server process.

An inferred `cex` label stops a trace. A session verdict alone does not create
a label or stop it. [Label precedence](/guides/configuration/#address-labels)
still applies: an investigator's `other` label overrides an inferred deposit
label and lets the trace continue. Cached observations remain evidence, not
an override of that decision.

## Following one fund-flow path

`trace_funds` starts with a Base58 digest and a required direction. Forward
follows the recipient's next transaction moving the tracked coin; backward
follows the payer's most recent earlier inflow. It follows value through DEX
swaps, exploits and withdrawals crediting only the actor, and objects that
received funds. Use `trace_flow_graph` for all branches.

The walk stops at sinks labelled through `manage_labels`: exchanges, bridges,
mixers and burn addresses. A malicious-labelled wallet is followed instead.
Bridge exits and high-fanout hubs also stop it. Forward hub stops require at
least 100 distinct senders paying in; an address with fewer can pass on the
funds and remains followed. Every ending has a `stop_reason`.

Each hop includes decoded actions and USD at block time, with the price source
under `usd`. Reads are sequential per hop, defaulting to three and capped at ten.
A `coin_type`, such as `0x2::sui::SUI`, selects the starting coin and filters
displayed balance changes; padded and short types match. The trace still
follows value across swaps. Without the filter, all balance changes are shown
and the first hop chooses the largest flow.

JSON is the default. Mermaid returns a fenced path diagram with unfollowed
branches dashed, bridge exits and the stop reason. `graph_json` gives nodes
and edges; CSV has one row per followed or unfollowed transfer. Every format
except `graph_json` starts with the prose summary.
