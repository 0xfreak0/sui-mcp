---
title: Shared funders
description: Why wallets sharing a funder prove little until the funder is measured, and how get_address_fanout reports its breadth and flow shape.
sidebar:
  order: 5
---

Several wallets tracing back to one funder looks like one operator. It is
evidence only when the funder is narrow. An exchange hot wallet or a payout
service funds unrelated wallets all day, so ancestry through it links nothing.
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

`build_wallet_edges` asks whether a fresh address reached by a trace is a new
party or another wallet of the same operator. It builds signals live, without
an analytics warehouse, from six sources:

- Multisig co-signature: a committee key can spend the wallet whose address
  the committee hashes to. This is the non-behavioral signal.
- A shared first funder.
- One address first-funding another.
- Value moving both ways between two non-service addresses.
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

Supply all suspected wallets as seeds, up to 25; links among them are exactly
verified. `expand` defaults to true, admitting unknown siblings only after
checking their own first funder. The expansion budget defaults to 25 candidates,
and unverified candidates are reported rather than hidden.

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
