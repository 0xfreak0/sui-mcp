---
title: What an investigation looks like
description: A worked example that ranks a lending protocol's wallets for a day and tests whether a funding cluster is coordinated.
sidebar:
  order: 3
---

Ranking a lending protocol's wallets for a day, then testing whether a cluster
is coordinated:

```
aggregate_events(module: <package>, from: "2026-08-07T00:00:00Z", to: "now")
  → every event type it emits, with counts and the numeric fields available
    (user actions are usually far rarer than bookkeeping events)

aggregate_events(event_type: <DepositEvent>, value_field: "event.deposit_value", value_scale: 100)
  → wallets ranked by USD deposited, truncated: false

find_funding_sources(addresses: [...25], depth: "first_hop")
  → 23 of 25 share one funder, funded in three bursts of under a minute

get_address_fanout(<that funder>)
  → 1,623 recipients, classified "distributor", so shared funding alone
    proves nothing here; the second-level timing clusters carry the case
```

Several wallets tracing back to one funder looks decisive until you measure the
funder itself. A distributor with 1,623 recipients funds unrelated wallets all
day, so shared funding on its own says very little. Every funding result
includes the fan-out measurement for this reason.

Fan-out reports shape as well as size. Measured on the same day, a known
exchange and a sybil funder had almost identical counterparty counts, 399 and
431, but very different flow. The exchange ran balanced at 0.73 out/in,
deposits in and withdrawals out. The funder ran 9.78, paying many addresses and
being paid by few.

`get_address_fanout` also reports whether an address pays other people's gas;
see [Gas sponsors](/concepts/gas-sponsors/).

## Recommended starting points

For a first look at an address or a coin, the tool reference lists four
[recommended starting points](/reference/tools/starting-points/):
`identify_address`, `get_wallet_overview`, `get_transaction_history` and
`analyze_token`. All four are in the default `core` profile.

## Next steps

- [The forensics skill](/guides/forensics-skill/) sets the order to work in
  and the conclusions to refuse.
- [Multisig](/guides/multisig/) reads a treasury's committee and who signs.
- [Fund flows](/concepts/fund-flows/) covers `trace_flow_graph` and
  `find_flow_path`, which follow every branch of a set of funds.
- [What a result tells you about itself](/concepts/) explains the marks tools
  put on their answers.
