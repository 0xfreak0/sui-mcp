---
title: Historical balances and top holders
description: How get_balance reconstructs a balance at a past moment, and when get_top_holders returns a real ranking.
sidebar:
  order: 7
---

## Liquid balances

`get_balance` reads one coin type, SUI by default, for an address or object.
The total `balance` includes `coin_balance` held as `Coin<T>` objects and
`address_balance` held without coin objects. A wallet with no coin objects
can still hold funds. For an object, only its defining module can withdraw
its address balance.

Staked SUI and DeFi position value are excluded. Use `get_staking_summary`
and `get_defi_positions` before concluding that an address holds little;
`get_wallet_overview` reads all its coins together.


## Balance at a past moment

`get_balance` takes `at` (ISO 8601) or `at_checkpoint`. GraphQL reads a
balance directly only inside its consistent range, about the last hour
(`method: consistent_read`). An older point is reconstructed
(`method: reconstructed`): the balance at a recent anchor checkpoint, minus
the owner's balance changes in that coin in every transaction after the
requested checkpoint up to the anchor. Balance changes include address-balance
deposits and withdrawals, so the result is exact when `complete` is true.

```json
{"owner":"0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724","at":"2025-09-07T16:00:00Z"}
```

```text
"method": "reconstructed", "at_checkpoint": 187414630, …, "complete": true,
"balance": "78654856875", "balance_formatted": "78.654856875 SUI",
"transactions_scanned": …, "anchor": { "checkpoint": …, … }
```

The anchor and `transactions_scanned` depend on when the call runs; the
balance at the requested checkpoint does not.

The scan reads at most `max_transactions` transactions; its default and range
are in the [tool reference](/reference/tools/coins-and-tokens/#get_balance).
When that runs out, `complete` is false, `balance` is null, and
`reached_checkpoint` is the oldest checkpoint the scan got back to: every
transaction after it was read. A reconstructed balance has no coin/address
split, so `coin_balance` and `address_balance` are null and `anchor` carries
the split at the anchor.

`at_checkpoint` asks for the balance at the end of that checkpoint.
An ISO `at` selects the last checkpoint stamped at or before that time;
the two arguments are mutually exclusive. Reconstruction uses one request
per page of 50 transactions. `max_transactions` does not apply to a current
balance or a direct read within the consistent range.

## Staking at a past moment

`get_staking_summary` takes `as_of`, an ISO 8601 date or checkpoint string:

```json
{"address":"0x…","as_of":"2025-06-01T00:00:00Z"}
```

The result describes **StakedSui objects directly held by the address** at the
end of that checkpoint. A date selects the last checkpoint at or before it,
not the nearest checkpoint. `total_staked_mist` is their principal, excluding
rewards. Transferred stakes count for their holder, and split/joined positions
use their historical object versions. Wrapped or object-owned stakes,
FungibleStakedSui and liquid-staking tokens are outside this total. An empty
set says nothing about those excluded holdings.
Single-address consensus ownership counts as direct ownership.

`method: checkpoint_objects` reads the owned set at that checkpoint when the
provider retains it. Outside that range, `reconstructed_object_changes`
replays every transaction affecting the address, including incoming objects:

- `direction: reverse` starts with an owned set at `anchor_checkpoint` and
  reverses changes after the requested checkpoint through that anchor.
- `direction: forward` starts empty and applies changes from genesis through
  the requested checkpoint. Genesis is included when it affects the address.

The first call chooses a direction from the address's first and latest
transaction checkpoints, then tries the other if the first cannot finish.
Each direction has its own `max_transactions` budget, which also bounds
object-change pages, and a 45-second replay budget. Every nested page must
finish. Missing history, discontinuous ownership, ambiguous wrapped/unwrapped
states or a budget stop give `complete: false` and null totals, never an
intermediate set labelled as historical holdings.
Objects created already wrapped are skipped only when a gRPC effects read
proves they never existed at top level; other missing states remain incomplete.
When effects v1 omit an input holder, the tool reads that exact object version.

A time, transaction or object-change-page stop returns `continue_with`, a
complete `get_staking_summary` call with an opaque `continuation` argument.
Call it unchanged to resume the selected direction with the same target and
anchor, not to start again. The saved state carries the held object IDs,
versions, principal, pool IDs and activation epochs, plus the transaction
cursor, offset within its page and any unfinished object-change cursor.
Already-applied changes are not applied twice. `max_transactions` can change
between calls; increasing it is not required to pass a time stop.

`replay_calls` counts the initial call and its resumes. `attempts` describes
this call; `replay_transactions_scanned` and `replay_object_change_pages` count
work across the selected replay. Totals and the historical position list remain
unavailable until it finishes.

`continuation_storage` explains where the state lives:

- `argument`: authenticated, encrypted state travels in the argument when
  the encoded token fits within 1 KiB with `SUI_STORE_PATH` configured, or
  8 KiB without a configured store. This avoids requiring a database for
  small held sets while keeping arguments smaller when storage is available.
  It needs the same server session.
- `local_store`: state above the applicable inline limit is encrypted in the
  result store at `SUI_STORE_PATH`, and the argument is a short capability
  for that saved state. It survives a server restart with the same store.
  With no writable store, `continuation_unavailable` explains how to enable
  one before starting the replay again; a configured but unwritable store
  does not raise the inline limit to 8 KiB.

Both forms expire after 24 hours. Keep `address`, `as_of` and `network`
unchanged. Altered tokens, another network, expired tokens, missing stored
state and replay ranges the provider no longer retains are rejected rather
than restarting against different data. A resumed reverse replay uses its
saved owned set even after the anchor leaves the recent ownership range;
an unfinished anchor enumeration still needs that range.

`detail: full` returns all positions from a completed read. Display caps leave
totals intact and give a saved-result page or full call for omitted rows.
Saved-result arguments redact the incoming continuation, and the full-call
link omits it. Read the saved-result pages to avoid replaying; the full-call
fallback starts a fresh replay without exposing the previous capability.

`estimated_reward_mist` is separate. Each position's principal converts to
pool tokens at its activation-epoch exchange rate, then back to SUI at the
requested checkpoint's epoch, with integer rounding. Inactive pools stop at
their deactivation epoch. Missing rates leave rewards null without discarding
known principal. The estimate excludes a withdrawal-time cap from the pool's
remaining reward balance; it never substitutes today's rate.

### Why events alone do not establish holdings

`0x3::validator::StakingRequestEvent` records the requester in `staker_address`;
`UnstakingRequestEvent` records the withdrawer. Subtracting their principal
amounts by that field measures requests and withdrawals attributed to an
address. It does not track transfer recipients, splits, joins, genesis stakes
or conversion to fungible stake. A later holder can withdraw another
address's original stake, so this event net can even be negative.

GraphQL's `availableRange` reports separate retention for owned-object sets,
point object history and transaction/event lists. The tool returns these
ranges rather than assuming that historical object reads imply historical
owner enumeration. gRPC and its archive read known object IDs and versions;
they do not enumerate an address's holdings at an old checkpoint. GraphQL
resolves the historical versions needed by this reconstruction. Event-list
retention and the absence of a `staker_address` field filter also prevent an
unqualified event-only fallback.

See [GraphQL scope and retention](https://docs.sui.io/develop/accessing-data/graphql/query-with-graphql)
and the [validator event definitions](https://docs.sui.io/references/framework/sui_sui_system/validator).

## Top holders

`get_top_holders` returns a ranking only when `complete_ranking` is true. It
walks two things in object-id order, which is unrelated to balance:
`Coin<T>` objects, and address balances (funds credited to an owner's address
rather than held as a coin object). A scan that stops early returns the
largest holder it happened to see. Raising `max_scan` can change who ranks
first, because more coin objects and address balances are read; on SUI, the
top five of two scans of different sizes can have no holder in common.

A truncated scan therefore returns `sampled_holders`, without a rank or a
percentage of supply, along with a caveat naming which walk stopped. Raise
`max_scan` (applied to each walk) until `truncated` is false to get a real
ranking; that is only practical for coins with few enough objects to
enumerate. A scan also stops when it runs out of time, marked
`time_budget_reached`, and the caveat reports how far the scan got and whether
a retry or a smaller `max_scan` would help.

In a sample, each holder's `balance` is read directly for that address, since
the walk saw only some of its coins, and `balance_in_sample` is the walk's own
sum. Each holder carries `coin_balance` and `address_balance` beside the
total, and `owner_kind`, because an address balance can belong to an object
such as a bridge's liquidity bank. `analyze_token` reports the same
distinction.

Without `mode`, a type the chain knows as a coin is scanned as a token: one
with a `Coin<T>` object, an address balance, coin metadata or a coin registry
entry. Anything else is scanned as an NFT collection.

For NFT collections, `holder_kind` says how each holder was found; see
[Kiosk-held NFTs](/concepts/nft-ownership/).

## Objects by Move type

`list_objects_by_type` scans current top-level objects of a Move struct or
module across all owners. An object wrapped inside another object's fields is
not indexed by type and is not listed. To count bids with a funded `offer` and
sum their value:

```json
{"type":"0xabc::bidding::Bid","sum_fields":["offer"],"where":{"field":"offer","gt":"0"}}
```

A completed scan with two funded bids, both `Bid<SUI>`, includes:

```json
{"scanned":3,"matched":2,"complete":true,"sums":{"offer":{"total":"1000000000","min":"300000000","max":"700000000","count":2,"unreadable":0,"coin_type":"0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI","formatted_total":"1","decimals":9,"decimals_source":"registry"}},"owner_kinds":{"shared":2,"address":0,"object":0,"consensus":0,"immutable":0,"unknown":0}}
```

`scanned` counts every object read and `matched` counts bids passing `where`.
Sums cover all matching rows, including rows the display cap leaves under
`omitted`. Amounts are raw integers; `formatted_total` applies the coin's
decimals and `decimals_source` says where they came from. For a nested field
use a path such as `state.offer`; `balance.value` and `balance` read the same
`Balance<T>`.

A total is given only when every amount is in one unit. A field the struct
layout shows to be a `Balance<T>` or `Supply<T>` is counted in coin `T`, so
objects of different types holding the same coin add up. Any other field is
counted per concrete object type. When the scanned objects hold the field in
more than one unit, `total`, `min` and `max` are null and `sum_units` lists
each unit:

```json
{"sums":{"offer":{"total":null,"min":null,"max":null,"count":3,"unreadable":0,"unit_count":2}},
 "sum_units":[
  {"field":"offer","coin_type":"0xc0…::coins::A","count":2,"raw_total":"150","min":"50","max":"100","formatted_total":"1.5","decimals":2,"decimals_source":"coin_metadata"},
  {"field":"offer","coin_type":"0xc0…::coins::B","count":1,"raw_total":"7000000","min":"7000000","max":"7000000","formatted_total":"7","decimals":6,"decimals_source":"coin_metadata"}]}
```

A value that cannot be read as an integer leaves `total` null, with
`observed_total` (a lower bound) and `unreadable` saying what was read. An
object whose struct has no field at the path is counted under `absent`; when
no matched object has it, `field_note` lists the first object's fields.
`where_unreadable` and `where_absent` count objects the `where` test could
not be applied to.

The type is rewritten to the package version that defined each struct, type
arguments included, since that is the id an object's type carries. A module,
struct or type argument the package does not define is refused with the
closest names:

```json
{"error":"Package 0x…0002 defines no struct in a module named SUI, so no object can have this type. Modules that define structs, closest first: sui, bag, bcs, coin, …"}
```

The scan walks by type and object ID, not by value. `complete: false` means
the sums and counts cover only the scanned portion. `next_call` resumes at the
next cursor with separate totals; they are not cumulative. Use
`detail: "full"` to retrieve omitted rows. A full view too large for one
response continues with `row_offset`, which scans current state again from
the same cursor, so rows can move between pages if objects changed. A module
filter can span types introduced by different package versions;
`other_defining_packages` lists the versions this scan did not cover.

## DeFi positions

`get_defi_positions` values staked SUI with accrued rewards, liquid-staking
coins at their issuer's exchange rate, CLMM and AMM liquidity, lending, and
balances inside owned objects such as vaults, coin tables and wrapped
positions.

Each position has asset legs, its valuation `method`, evidence `tier` and
`usd`. If any leg has no price, `usd` is null and `unpriced_reason` explains
why. `total_usd` and `by_protocol` sum every priced position, not the missing
ones. `coverage` compares supported positions with the wallet's owned objects
and lists unrecognised types and counts; `unread` records failed reads.

Lending `health` includes the protocol's `borrow_limit_used` and
`liquidation_threshold_used`. When those figures differ from the legs' USD by
more than 2%, `health_basis` explains the difference. `leads` flags positions
near their borrow limit and shared vaults the wallet operates, including what
they hold.

The default summary keeps the most valuable positions within a display budget
and every unpriced position. `omitted` reports the rest.
`detail: "full"` returns every position.

`get_wallet_overview` with `include_prices: true` values the same positions
beside the wallet's coins and totals each group apart. Adding
`include_nfts: true` walks every object and kiosk item the wallet holds and
reads each collection's market, so a wallet holding many objects costs many
requests. The NFT estimates stay out of the total.
