---
title: Truncated lists
description: When a list in a tool response is complete, what omitted and next_call report, and how to page the rest.
sidebar:
  order: 9
---

A list is complete only when the response has no `truncated`.

`summarize_address_flows`, `find_funding_sources`, `get_transaction` and
`decode_ptb` list what fits about 20k characters (30k for a PTB's commands)
and compute every total, count and verdict over all rows first. Flagged rows
always stay: bridge exits, lookalikes, labelled and non-wallet addresses,
capabilities, the sender's own changes, subjects tied to one another.

`omitted` names each list that lost rows with the count, the USD value of the
priced ones and how many are unpriced, the largest row left out by USD (or the
first, where rows carry no value), and `next_call` is the call that returns
them, usually the same call with `detail: "full"`.

With the local store on, `omitted.result.uri` is the stored full result,
`sui://results/{id}`, which pages any list as an MCP resource; see
[Optional local store](/guides/configuration/#optional-local-store).

`list_nfts` leaves raw Move contents to `detail: "full"` and counts them.
`get_nft_sales` with `include_sales` lists the newest sales that fit, while its
totals cover every sale. A `get_transaction` event list past 20k characters
folds events that differ only in amounts into one row, and says so under
`omitted.folded`.
