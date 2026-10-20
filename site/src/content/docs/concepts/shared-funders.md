---
title: Shared funders
description: Why wallets sharing a funder prove little until the funder is measured, and how get_address_fanout reports its breadth and flow shape.
sidebar:
  order: 5
---

Wallets sharing a first funder have a common funding source. Measure that
funder before treating the relationship as evidence of shared control:
exchange wallets and payout services also fund unrelated wallets.
`find_funding_source` and `find_funding_sources` stop at a funder that pays
many distinct addresses, and `find_funding_sources` reports each shared funder
with its fan-out and flow shape.

## Breadth

`get_address_fanout` counts the distinct addresses an address pays
(`recipient_count`) and is paid by (`sender_count`) over its recent activity,
and classifies the total, `counterparty_count`:

| `classification` | Reading |
|---|---|
| `hub` | An exchange hot wallet, bridge or faucet-scale distributor. Two addresses sharing it as a funder are not linked by it. |
| `distributor` | Pays widely. Shared funding through it is weak on its own; compare the rate against a control group from `sample_control_addresses`. |
| `narrow` | Several targets funded from here is meaningful and worth following. |

Both directions count. An exchange cold wallet receives from thousands of
addresses and sends to few, and a count of recipients alone would read it as
narrow.

A scan that stopped at `max_transactions` before the end of the address's
history reports `truncated: true`. Its count is a lower bound, so a `narrow`
or `distributor` reading from it carries `classification_provisional: true`.
A `hub` reading is never provisional: what was seen already proves it.

Every sampled transaction's balance changes are read to the end, including
payments with more recipients than fit on one page. If a continuation cannot
be read, `get_address_fanout` returns an incomplete-measurement error rather
than counts, a classification, flow shape or sponsor shape. No partial
measurement is cached. Retry the call once the read succeeds; increasing
`max_transactions` does not resolve missing rows within a transaction.

When fan-out is optional context beside a completed funding walk, a failed
measurement does not discard the walk. `find_funding_source` reports
`origin_fanout_unread`; `find_funding_sources` reports `fanout_unread` on the
affected shared funder. Both include the reason and omit the unread measurement.

## Shape

Breadth alone does not separate an exchange from a sybil funder, since the two
can have near-identical counterparty counts. `out_in_ratio` is recipients over
senders, and `flow_shape` reads it:

| `flow_shape` | Meaning |
|---|---|
| `disperser` | Pays many addresses and is paid by few, like a funder or a payout wallet. |
| `collector` | Is paid by many addresses and pays few, like a sweep or deposit target. |
| `balanced` | Deposits in and withdrawals out, the way an exchange runs. |
| `unknown` | No senders were seen, so there is no ratio. |

A `disperser` paid by few can still be one operator's payout wallet, so a
`distributor` with that shape needs the control group before any conclusion.

`get_address_fanout` also reports whether an address pays other people's gas;
see [Gas sponsors](/concepts/gas-sponsors/).

## Related

- [WAL claim farm example](/examples/sybil-farm/): a shared funder tested
  against a control group.
- [Forensics skill](/guides/forensics-skill/): the base-rate check that keeps
  shared ancestry from reading as collusion.

## Building shared-control edges

`build_wallet_edges` looks for possible shared control among seed wallets
and candidates it discovers. It uses these chain observations:

- Multisig co-signature: a committee key can spend the wallet whose address
  the committee hashes to. This is the non-behavioral signal.
- A shared first funder.
- One address first-funding another.
- Value moving both ways between two non-service addresses.
- Six or more wallets sweeping one coin to a collector within 30 minutes.
  Include the collector as a seed; each edge cites a sweep transaction.
  The collector must receive at least 90% of what the payer lost in that coin,
  and a priced coin must clear the dust floor. A payer whose payment took
  at least 90% of its balance just before it receives a weight-0.8 edge;
  a payer in six payments within 5% of the same amount receives a
  weight-0.6 edge. These are leads below the 1.0 merge floor and require
  another signal: an exchange's customers, presale buyers and unrelated
  depositors can also pay one collector. Popular collectors, labelled
  services and addresses repeatedly paying the same recipient are excluded.
  A failed service scan cannot establish a narrow collector; an incomplete
  payer history cannot establish its balance. Check
  `excluded_intermediaries` and `truncated` before interpreting a missing
  edge.
- A shared gas sponsor.
- Co-appearance in one transaction.

Every intermediary is measured before use. An exchange or sponsorship relayer
is discarded rather than linking unrelated users. The `role_split` exception
applies when most other wallets served by a sponsor were first funded by the
seeds' own narrow, unlabelled funder: one operator may fund and sponsor from
different addresses.

`edges` are facts with transaction digests to check; `co_signer` instead cites
the committee's address hash. `clusters` are inferences with their own
`evidence_tier`, never proof of ownership.

`observed_but_below_threshold` lists each pair once with its signal types
and total weight; the underlying digests remain in `edges`. It can show a
consolidation lead that has no corroborating signal. A query-budget stop
leaves candidates unmeasured, and balance-change continuations consume that
same `query_budget`; an unread page cannot be treated as a small payout.

`first_funders` maps each seed whose qualifying first inflow was read to its
funder, and with `expand` each sibling whose first funder was confirmed as the
shared one. A funder filtered out as a popular intermediary remains in this map:
the first transfer and the clustering decision answer different questions.
Check `truncated` before interpreting an absent key. An unmeasured seed has
no reliable negative finding.

For example, with `0xw1` and `0xw2` standing for the full seed addresses:

```json
{"tool":"build_wallet_edges","args":{"addresses":["0xw1","0xw2"],"expand":false}}
```

The relevant response fields are:

```json
{"first_funders":{"0xw1":"0xw2"},"truncated":false}
```

Supply suspected wallets as seeds, up to 25; the tool tests signals among
them. `expand` defaults to true, admitting additional candidates only after
checking their own first funder. The expansion budget defaults to 25
candidates, and candidates the budget left unchecked are reported as
unverified, neither confirmed nor ruled out.

`popularity_limit` defaults to 50 distinct counterparties. Funders' recipients
count only if paid at least 0.01 SUI or $0.10. Raise this limit only with cause:
otherwise a service can link thousands of unrelated wallets. Reciprocal
counterparties are also checked for popularity before that signal is trusted,
up to `reciprocal_budget` (15 by default).

`min_signal_types: 2` is the stricter batch-pipeline rule, improving precision
but missing ordinary personal alt-wallets that share one mechanism; the
default is 1. `max_cluster_size` rejects merges above 100 by default.
`query_budget` caps GraphQL requests at 150 by default; inspect `truncated`.

Mermaid output has one box per cluster and signal-labelled edges, with
unclustered pairs dashed. `graph_json` returns nodes and edges; CSV gives one
row per edge. JSON is the default.

## Following a funding chain

`find_funding_source` starts at a wallet's first funding transaction and its
sender, then follows the funder's own funding, up to five hops by default
(maximum 12). It can establish a first funding source such as a Binance
withdrawal; that is narrower than attributing every later payment.

The walk stops at a labelled exchange, bridge or known wallet (managed through
`manage_labels`), a repeated wallet, a dead end, or a funder that paid more
than 50 distinct recipients at least 0.01 SUI or $0.10 each. Dust-only recipients
do not count. This is the same service threshold used by `build_wallet_edges`;
ancestry beyond a service does not attribute its users.

It also stops when a funder's payment occurred after that funder's own earliest
12 transactions. An established wallet can pay from a long-held balance,
as when a victim transfers to a thief; that wallet's original funding does
not explain this payment.

Every hop reports funder popularity. `dust_skipped` lists ignored inflows;
`sponsored_by` lists gas payers for the hop's own transactions even if no
funding was found. Address-balance gas can support a wallet with no SUI inflow,
and a poisoning lookalike's operator may appear only in sponsorship.
`measure_fanout` defaults to true and uses `get_address_fanout`'s default window,
so the counts and truncation status agree.

## Comparing many funding chains

`find_funding_sources` shares reads when chains converge, so it is cheaper
than a separate single-address call for each subject. It walks 1–100
`addresses`; `related_addresses` accepts up to 500 other subjects without
walking them. For a larger set, split the walked addresses across calls and
pass the other addresses as `related_addresses` each time. Full depth is the
default, up to `max_hops` (five by default); `depth: "first_hop"` stops after
one hop.

```json
{"addresses":["0xw1"],"related_addresses":["0xw2"],"depth":"first_hop"}
```

When `0xw2` first funded `0xw1`, the result includes
`"subject_funded_subject":[{"funder":"0xw2","funded":"0xw1","funding_tx":"…"}]`.
The related address has no funding-chain result of its own.

Like the single walk, it stops at funders that paid more than 50 distinct
addresses. Each common funder has fan-out and flow shape to distinguish a
narrow origin from an exchange many unrelated users withdrew from. A chain
counts toward shared funders up to the first funder that is a walked subject.
When a walked chain reaches a related address, the funders past it are
counted for that related address, so a split set reports the shared funders
one call over every address would. Two addresses walked in different calls
are not compared for shared funders; compare their `first_funder` fields.

Co-funding is measured against each transaction's total recipient count.
Two subjects among two recipients suggests a bespoke payment; two among
twenty can occur in an unrelated service batch. The tool reports direct
funding and later signed payments under `subject_paid_subject`. Every ordered
pair of up to 20 walked addresses is checked directly. Links with related
addresses, and batches of more than 20 walked addresses, are read from each
walked address's sent and affected transactions: the newest 150 per
direction, plus the earliest 50 when the newest did not reach the start.
This covers payments in either direction between a walked and a related
address, and between walked addresses. Payments only between related
addresses belong in a call that walks one of them.
`subject_payment_scope.incomplete` names each history not read end to end:
`page_limit` (the transactions between the earliest and newest pages were not
read), `missing_cursor`, or the read error. `incomplete_transactions` names
balance changes that could not all be read. An empty payment list with an
incomplete scope cannot establish absence.
Fundings within a minute form timing clusters, a lead for scripted setup
rather than proof. Run the same read on a `sample_control_addresses` control
group before interpreting rates.

`sample_control_addresses` draws that group from the addresses that used the
same protocol in the same window. Its `module` and `event_type` filters follow
the event rules in
[Querying events across transactions](/concepts/transactions/#querying-events-across-transactions),
including the network's `relocate_event_module` cutover.

The summary retains each result's origin, first funder and first hop and
counts `dust_skipped`. Results and later subject payments share a display
budget, prioritizing every result tied to a shared funder, subject link,
co-funding, burst or payment. `detail: "full"` returns every hop under
`results[].chain`, every dust row and every list row.
