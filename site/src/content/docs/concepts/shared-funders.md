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
