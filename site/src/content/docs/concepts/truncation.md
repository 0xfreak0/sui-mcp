---
title: Truncated lists
description: When a list in a tool response is complete, what omitted and next_call report, and how to page the rest.
sidebar:
  order: 10
---

Display truncation is reported by `truncated` and `omitted`. Connection
pagination uses `has_next_page` and cursors; a response without `truncated`
can still have more pages.

For `query_events`, continue while `has_next_page` is true, even when `events`
is empty. `scan` reports a read-budget stop, and `scan.next_call.repeat_with`
continues the same query with its filters, order and network unchanged.

`summarize_address_flows`, `find_funding_sources`, `get_transaction` and
`decode_ptb` list the rows that fit a fixed size budget and compute every
total, count and verdict over all rows first. Flagged rows
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
totals cover every sale. A `get_transaction` event list too long for the
budget folds events that differ only in amounts into one row, and says so
under `omitted.folded`.

`get_validators` defaults to `detail: "summary"`: name, address, stake,
commission, voting power and at-risk status, sorted over the whole set before
the list is capped. At-risk validators stay even beyond the summary budget
or an explicit `limit`. `active_validator_count` and `total_stake` describe
the whole set; `validator_count` counts only the rows shown.
`omitted.fields` names the dropped fields and `omitted.lists.validators`
counts any dropped rows. Follow `omitted.next_call` for full rows on the same
network, in the same order, without a limit. `detail: "full"` has no size cap;
an explicit `limit` still applies. An `address` lookup always returns the
single validator's details.

## Scan-limited transaction pages

`query_transactions` fills a page to `limit` across several reads when the
service returns short pages. Continue while `has_next_page` is true, even when
`transactions` is empty. `scan` reports a read-budget stop, and
`scan.next_call.repeat_with` continues the same query with its filters, order
and network unchanged.

With `all_versions: true`, rows wait until the next rows or exhaustion of
every version stream establish their global order. The tool stops reading once
that ordered page is full; it refills only streams whose unknown frontier
prevents filling the page. The cursor retains progress through empty reads as
well as transactions already returned.

## Partial event rankings

`aggregate_events` scans oldest first, stopping at either `max_events` or
`max_reads`. Empty reads count against `max_reads` across every module segment.
At a budget stop, `truncated` is true and `scan.stop_reason` is `event_budget`
or `read_budget`. Continue with `scan.next_call.repeat_with` on
`aggregate_events`, keeping the same filters and network. The opaque cursor
records the module segment and scan boundary, including empty reads; it does
not identify a covered checkpoint range.

Each call ranks a disjoint event slice. A resumed ranking remains `truncated`
even when `has_next_page` becomes false, because it excludes earlier slices.
Per-key event counts and `value_sum` add only when every group was retained in
every slice (`scan.groups_complete`); values retain each slice's rounding.
Top-N rankings, `distinct_keys`, `distribution` and `group_pnl` are not additive.
One transaction's events can span slices, so adding slice P&L can count that
transaction more than once.

An all-missing `value_field` in a partial or resumed slice is counted under
each group's `missing_value_count`; the scan can still continue. The tool
rejects a field absent from every event only after reading the complete window
in one call.

For example, a stopped call can return:

```json
{
  "truncated": true,
  "has_next_page": true,
  "scan": {
    "reads": 3,
    "stop_reason": "read_budget",
    "next_call": {
      "tool": "aggregate_events",
      "repeat_with": { "cursor": "opaque-next-cursor" }
    }
  }
}
```
