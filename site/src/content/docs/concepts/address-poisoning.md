---
title: Lookalike addresses
description: How tracing and history tools report address-poisoning pairs, and how they decide which side is the impostor.
sidebar:
  order: 4
---

`get_transaction_history`, `trace_funds`, `trace_flow_graph` and
`summarize_address_flows` compare the addresses they read and report
`address_poisoning` with `addresses_compared` and any lookalike `pairs`.
An empty list covers only the addresses in that result. This is the relevant
part of a completed check with no matching pair:

```json
{"address_poisoning":{"addresses_compared":2,"pairs":[]}}
```

`trace_funds` and `trace_flow_graph` also name lookalikes in their prose
summary, so Mermaid and CSV exports carry the warning.

## The attack

An attacker generates an address sharing the leading and trailing characters
of a known recipient, sends dust from it, and waits for someone to copy the
wrong row from their own history. The check covers senders,
balance-change recipients and branches a trace declined to follow. A
poisoning wallet can send dust while receiving nothing, so a forward trace
of the victim's funds may never reach it as a recipient. It appears as a
sender in the victim's history, where `get_transaction_history` compares it.
`trace_flow_graph` and `find_flow_path` keep a branch to an address that
renders like one already reached, regardless of `min_share` or `min_usd`.

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
poisoning leaves. The address that appears later is named the impostor, with
`direction_basis: "lifecycle"`, when all of these hold:

- Its first transaction in the history credits the wallet, and the address
  receives nothing in it.
- That transaction is at most ten minutes after the other address's first
  transaction in the history.
- The other address's first transaction is not of that kind.
- The other address's first transaction is not the oldest one shown, so the
  history reaches back before it.

Otherwise the pair is reported with `direction_known: false`.
