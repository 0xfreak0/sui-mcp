---
title: Lookalike addresses
description: How tracing and history tools report address-poisoning pairs, and how they decide which side is the impostor.
sidebar:
  order: 4
---

`get_transaction_history`, `trace_funds`, `trace_flow_graph` and
`summarize_address_flows` compare every address they touch and always report
`address_poisoning`: `addresses_compared` and the `pairs` close enough to be
mistaken for one another. An empty `pairs` covers only the addresses in that
result. The two tracing tools also print the pairs in their summary, so a
Mermaid or CSV export carries the warning:

```
⚠ Addresses in this trace close enough to be mistaken for one another:
  0xa1b2c3d4…e5f60718  vs  0xa1b9f0e2…4c3a0718
```

## The attack

An attacker generates an address sharing the leading and trailing characters
of one you already deal with, sends dust from it, and waits for someone to copy
the wrong row out of their own history. The check covers senders,
balance-change recipients and the branches a trace declined to follow. A
poisoning wallet sends rather than receives, so it never shows up as a
counterparty, and the lookalike is usually several hops from the address it
imitates. `trace_flow_graph` and `find_flow_path` never prune a branch to an
address that renders like one already reached, whatever `min_share` or
`min_usd` say: the small amount is the finding.

## When a pair is reported

A pair is reported when at least three characters match at each end, roughly
one collision in seventeen million pairs by chance. The two addresses do not
render identically at every width; they match at both ends, which is enough to
fool a glance or a short truncation.

## Which side is the impostor

The address with the larger footprint is named as the established side, but
only when the gap is wide enough to support it. Dust repeating inside a single
page is normal for this attack, so a small margin proves nothing. Failing
that, an address that received nothing is the likelier impostor.

In a transaction history, timing can also decide it, but only for the shape
poisoning leaves: the later address first appears paying the wallet dust and
receiving nothing, within ten minutes of the address it imitates, and that
address's first row is not the oldest one shown. Otherwise the pair is
reported with `direction_known: false`.
