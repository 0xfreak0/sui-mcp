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

```
get_balance(owner: 0x01229b3c…c724, at: 2025-09-07T16:00:00Z)
  → method: reconstructed, at_checkpoint: 187414630, complete: true,
    balance: 78.654856875 SUI, transactions_scanned: 30,
    anchor: { checkpoint: 326856716, balance: 93.696806819 SUI, … }
```

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

`get_staking_summary` takes `as_of`, an ISO 8601 date or checkpoint:

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

The tool chooses a direction from the address's first and latest transaction
checkpoints, then tries the other if the first cannot finish. Each direction
has its own `max_transactions` budget, which also bounds object-change pages.
Every nested page must finish. Missing history, discontinuous ownership,
ambiguous wrapped/unwrapped states or a budget stop give `complete: false`
and a null total, never an intermediate set labelled as historical holdings.
Objects created already wrapped are skipped only when a gRPC effects read
proves they never existed at top level; other missing states remain incomplete.
When effects v1 omit an input holder, the tool reads that exact object version.
`attempts` records the stopping point and budget. `continue_with` supplies a
higher-budget call for transaction/page limits. A time-budget stop stays
incomplete without suggesting that a larger transaction budget can help.
`detail: full` returns all positions from a completed read. Display caps leave
totals intact and give a saved-result page or full call for omitted rows.

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

For NFT collections, `holder_kind` says how each holder was found; see
[Kiosk-held NFTs](/concepts/nft-ownership/).

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

The default summary keeps the most valuable positions fitting about 30k
characters and every unpriced position. `omitted` reports the rest.
`detail: "full"` returns every position.
