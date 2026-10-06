---
title: Reading a transaction
description: Abort reasons, objects that change hands without a balance change, transactions with no commands, and address balances.
sidebar:
  order: 2
---

## Choosing a transaction read

`get_transaction` reads an executed transaction by Base58 digest: sender,
status, gas, balance changes, decoded actions such as a swap or deposit, and
events with decoded fields. `decode_ptb` reads resolved commands without an
effects/event report, and accepts pre-sign bytes too. `analyze_attack_tx`
adds exploit profit, shared-object state deltas, reconciliation and anomaly
leads. Use `get_transactions` for a batch rather than one detailed transaction.

Protocol identification uses events as well as Move calls.
`protocols_from_events_only` marks an event-identified protocol behind an
obfuscated wrapper. A package lacking a curated or Move Registry name is
named for the curated protocol whose key published it; `protocols_unchecked`
lists packages whose publisher was unread. A balance-change address that
signed a curated protocol's packages carries `publisher_key_of`, for example
to identify a fee paid to the team's key.

Event fields in the top half of the u256 range also get their two's-complement
reading in `signed_readings`, for signed fees or PnL stored unsigned.
With `detail: "full"`, high-bit u64, u128 and u256 pure values get `signed_value`.
The full view includes inputs with object ID, read version and type, and
pure values decoded by the called function's declared type. Commands resolve
arguments to inputs, producing Result commands or the gas coin.
`object_changes.by_kind` lists every changed object's ID, type and version
under created, mutated, unwrapped, wrapped or deleted.

The default summary gives object-change counts without inputs or commands.
`created_for`, `object_transfers`, `balance_changes` and `coins_delivered_to`
share a display budget, prioritizing every capability and, for SUI
and verified coins, the sender's changes and each coin's largest credit and
debit. `omitted` reports the rest.
Full detail lists every row, but commands are paged,
with non-framework Move calls first.

Every event is decoded unless `max_event_field_bytes` sets a byte budget;
skips are reported and zero disables decoding. When events exceed the display budget,
the summary folds events differing only in amounts into rows with counts,
emission indices, shared fields and each varying field's total, min and max.
It caps rows while retaining every event emitted by a called non-framework
package. `omitted` reports the reduction; full detail lists events in pages.

`commands: [3, 7]` selects exact command indices in full detail instead of
the first command page. Events narrow to the calls that emitted them; objects
narrow to commands taking them as arguments or returning their type.
`events_omitted` and `object_changes_omitted` state what was excluded.
`event_offset` starts at a position in the event list after that narrowing;
follow `events_page.next_call` for the next offset.

`route_loops` marks router paths that swap a coin away and back before the
real hop, for example USDC to USDT to USDC. It lists the loop's action indices,
coins and round-trip cost from the pools' own swap events, or null with a reason.

Two-pool `router::swap_ab_bc`, `swap_ab_cb`, `swap_ba_bc` and `swap_ba_cb`
actions name the first and third type arguments as input and output. The
middle type is the route's intermediate coin; the function suffix describes
the pools' coin ordering.


## Why a transaction failed

`get_transaction` returns the abort code with the package, module and function
that raised it. A
[clever error](https://move-book.com/reference/abort-and-assert/clever-errors/)
is Move's name for an abort constant marked `#[error]`, which carries a
readable message. When the abort is one, `get_transaction` also returns the
constant's name, its message and the source line under `clever_error`.

## Objects that are not coins

`trace_funds` reports `object_flow`, and `get_transaction` reports
`object_changes`, `object_transfers`, `created_for` and
`mutated_capabilities` for one transaction. A balance change nets each owner's
coins and address balance per coin type, so an NFT, a Kiosk or a capability
changes hands without producing one. A capability that authorises a call by
mutating itself in place (a nonce, a rate limit) without changing owner
produces neither a balance change nor a custody change, and
`mutated_capabilities` is the only place that capability is named:

```
--- Hop 1 (2025-01-10 10:25:31 UTC) ---
Sender: 0x8c4f…5ee8
Action: Transfer to recipient
Objects:
  package::UpgradeCap ⚠  0x8c4f…5ee8 -> 0xeda2…6c2b
    Whoever holds this can publish new code for the package.
```

Kiosk moves are included. A kiosk-held NFT is owned by the Kiosk object, so an
ordinary NFT trade reads `object -> object`, and that counts as a custody
change. DeFi position objects are named by their protocol, for example
`position::Position (Cetus)`.

Transfers of `UpgradeCap`, `TreasuryCap`, `DenyCap`, `DenyCapV2` and
`Publisher` are marked as carrying control. A capability sent to an
unspendable address is reported under `renounced_capabilities` instead, since
those rights have been given up rather than transferred.

## Round-trip checks

`analyze_attack_tx` compares a share redemption or position closure with what
the sender paid to enter it within the previous day. Entry balance changes
are read across every page before identifying share credits or calculating
`round_trips.paid_usd` and `factor`.

If the entry's balance changes are missing or a continuation cannot be read,
that entry is not scored. The share coin type or position object id appears
in `round_trips_unread`. Other fully read entries can still produce
`round_trips`; an unread entry does not establish that no suspicious round
trip occurred.

## Transactions with no commands

`get_transaction` reports `command_count` beside a count of the objects the
transaction touched, so an empty `actions` list separates a transaction that
ran no commands from one whose commands could not be decoded. A transaction
that runs no commands still writes an effect, and bots use that to manage a
pool of gas coins:

```
get_transaction(F7xprc5y7LmkzMQqRjaEWexzupdtFTSPUXoF49GNepjY)
  → command_count: 0
    actions: []
    object_changes: { changed: 1, created: 0, deleted: 0 }
    object_changes_note: objects were written but none changed hands
```

`object_transfers` names anything that genuinely changed hands, with each
party's owner kind and the note explaining what a capability grants:

```
get_transaction(796Fr642E4W3XfvNcUWknTsDywd4RouMaCbqL5Ziptk)
  → object_transfers[0]:
      type:  popkins_nft::Popkins
      from:  { kind: object, address: 0x1d6d9ccb… }
      to:    { kind: object, address: 0xe0ee7531… }
```

Both parties there are Kiosk objects rather than wallets. `changed` counts
every object effect, including the coin that paid, so it is a weaker signal
than `object_transfers`. `created_for` lists objects minted to an owner other
than the sender, which is a delivery even though nothing held them before.
Coins are excluded from `created_for`. When no other object moved,
`coins_delivered_to` lists non-sender addresses that gained coins.

## Address balances

An address balance holds funds credited to an address or an object id with no
`Coin<T>` behind them. `get_transaction` lists each deposit and withdrawal,
the withdrawals the transaction requested, and whether gas came from coins or
the address balance:

```
get_transaction(CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay)
  → object_changes: { changed: 0, created: 0, deleted: 0 }
    address_balance_ops: [
      { owner: 0xb71e…1d47, op: deposit,  amount: 1951 },
      { owner: 0x7c8e…bdbf, op: withdraw, amount: 101951 } ]
    funds_withdrawals: [ { amount: 1951, coin_type: …::sui::SUI, source: sender } ]
    gas_source: address_balance
```

A coin folded into its owner's address balance is deleted while no value
moves. That deposit carries `converted_from_coins` and a note saying so.
`get_balance` and `get_wallet_overview` report `coin_balance` and
`address_balance` beside each total, and `identify_address` and `get_object`
list `address_balances` for an object id: funds the object holds itself, which
are not among its fields and which only its defining module can withdraw.

## Decoding a PTB before signing

`decode_ptb` accepts exactly one of `transaction_bcs` (base64 BCS bytes) and
`digest` (an executed transaction's Base58 digest). It never executes the
transaction. Use the bytes mode before approving a wallet prompt, then
`simulate_transaction` to see where every coin and object would end up.
`checks_run` names the checks performed; no match clears nothing.

The command list resolves each argument and annotates protocols. Pure inputs
are decoded using the receiving Move function's declared type, in `value_type`
and `value`; address-typed values appear under `address`. A u64, u128 or u256
with its high bit set also carries `signed_value`, its two's-complement
reading. Without a readable type, the input stays `bytes`. A 32-byte value
also gets `possible_address` in inputs or `address` without `value_type` in
commands. That guess is not proof: a u256, an `ID` and a 31-byte string can
also occupy 32 bytes.

Result and NestedResult arguments identify the producing command in `from`;
that command's `returns` gives the declared type. With a digest, object
inputs include the version read and the object's type. FundsWithdrawal inputs
name the amount, coin type and address-balance source (Sender or Sponsor).
`gas_source` distinguishes coin-funded gas from the gas owner's address balance.
`get_transaction` with `detail: "full"` returns these inputs and commands
alongside effects and events.

The heuristic checks cover publishes/upgrades, wallet-blocklisted packages,
unvouched packages, unlisted lineages, superseded versions, non-sender payouts,
flash-loan patterns and multi-package composition. A package is vouched for
by the curated registry or a curated protocol's publishing key; an MVR name
is display only. The unvouched-package check reaches medium only with one-way
value flow or another lead. For a digest, the flow must show another address
gaining what the sender lost, or the sender receiving nothing back.

Payout checks read TransferObjects and framework calls:
`transfer::public_transfer`, `pay::split_and_transfer`,
`pay::join_vec_and_transfer`, `sui::transfer`, `coin::send_funds`,
`balance::send_funds`, `coin::mint_and_transfer`, `token::transfer`, and
`party::single_owner` building a party for `transfer::public_party_transfer`
(all under `0x2`). Digest mode also reads the effects for coins and objects
the sender lost to another address.

With bytes, `presign_context` compares outgoing SplitCoins amounts, whole
coins and the gas coin against the sender's balances now. It gives each
coin's `share_of_balance` and each recipient's first chain transaction as
`first_seen`, null when no transaction has ever affected that recipient.

The first command page has a display budget, prioritizing commands
named by anomalies, highest severity first and fewest named commands among
ties, then non-framework Move calls. Every anomaly lists its command indices.
`command_offset` instead reads in index order from that offset; `commands`
selects exact indices, such as `[3, 7]`. Each returned command carries its
`index`. `commands_omitted` lists missing index ranges and the continuation
`next_call`. Checks cover all commands, even when the displayed list is a page.

## Investigating one exploit transaction

`analyze_attack_tx` reads the whole transaction through gRPC with archive
fallback, including PTBs with hundreds of commands and events. It reports
gains and losses per address and coin in USD at block time, pairs flash-loan
and flash-swap borrows with repayments, and lists each swap's coins and amounts.
Before/after pool prices are included where the DEX event carries them.
Pool, vault and market flows come from their own events, attributed to the
changed shared object whose ID the event names.

Oracle calls and updates are read from the PTB. Shared objects are read at
their input and output versions under `state_deltas`. Reconciliation compares
value leaving objects or mints for addresses against decoded events and the
objects read. Address-to-address transfers cancel; objects left out by read
caps are counted.

The heuristic anomaly checks include:

- A caller's argument written into shared state, or multiplied by an
  event-stated number into its accounting, then used in the same PTB.
- A stored number moving 100x, a drained balance, or a holder losing most of
  its priced value to addresses.
- Liquidity credited above what the event amounts buy over its tick range,
  or shares minted far above the deposit's share of the holdings.
- A public key held in a shared object replaced by another key.
- An event or coin-keyed table price at least 5x from the provider price for
  one coin while the same field agrees with the provider for other coins.
- Shares or a position redeemed within a day for at least 1.1x the sender's
  purchase cost.
- A shared object rewritten by another address in the minute before the
  transaction, flipping a flag or setting a recipient or amount it moved.

The tool also runs `decode_ptb`'s checks, including effects-based payouts,
superseded package versions and packages vouched for by neither the curated
registry nor a curated protocol's publishing key. `flagged_commands` gives
a `decode_ptb` call selecting the medium and high flags' commands.
Flash legs, oracle touches and anomalies are leads; `checks_run` names every
check, and no match clears nothing.

USD prices need no API key: DefiLlama supplies them, CoinGecko and
GeckoTerminal price recent dates it cannot, and Pyth is used for verified
coins when `PYTH_API_KEY` is set. Every unpriced coin is listed. `attacker`
selects the profit address; a losing address is reported as a loss with the
addresses that gained, as with a victim who signed a drain.

The summary keeps rows within a display budget,
preserving pools, holders and addresses named by anomalies or flash legs,
the sender and the profit address. Totals and anomalies cover every row;
`omitted` reports the rest and `detail: "full"` lists every row.

## Object provenance

`trace_object_history` lists versions with their producing transactions and
times, and the ownership transitions found: transfers, sharing, freezing and
party transfers. It can establish who created a pool, vault or capability and
who held it at a given time. Deleted and wrapped objects have `current: null`;
`end` identifies the ending transaction and kind.

A party object has owner kind `consensus` and its single owner's address.
A kiosk-held object's current row has owner kind `object`, with the kiosk ID
or its dynamic-field wrapper. `kiosk_cap_holder` names who controls the kiosk
today. These custody details are never attached to historical rows as though
they identified the controller then.

For a capability mutated on every privileged call, a checkpoint search reaches
old transitions without paging every intervening version. It can only find
checkpoints whose owner differs from the previous probe, so a round trip out
and back within one probed span can be invisible. `owner_change_count` beyond
the shown page is always a lower bound. `owner_change_note` and
`more_versions_note` explain that limit. If read or time budgets stop the
search, `owner_change_unpinned` lists checkpoint ranges with the owners at
each end; each range contains a change that was not pinned.

Oldest-first is the default, starting from the first retained version.
`order: "newest"` starts at the current version and pages backward, useful
for a busy shared object before an incident. Each page echoes its order;
pass `next_cursor` as `cursor` with the same order, or use `next_call`.
Ownership changes compare each row to its preceding version in time, even
on a newest-first page.

`limit` defaults to 25. Newest-first and cursor pages show at most 49 versions,
because one of the service's 50 rows supplies the predecessor needed to
attribute the change into the oldest listed row.

## Wallet activity pages

`get_transaction_history` is the wallet-activity read, with protocol names
such as Cetus and Suilend, decoded actions such as “Swap USDC to SUI”, and coin
flows. `query_transactions` is for filtering transactions by other criteria.
Each history row uses the transaction's complete balance changes and commands.
The page reports `order`, `oldest_shown` and `newest_shown`; continue with
`next_cursor` as `cursor`, preserving the order. Newest-first is the default;
oldest-first starts at the address's first transaction.

`subject_flow` is the queried wallet's signed balance change for each coin,
with formatted amounts and `coin_verified`. `token_flow` describes the sender,
so a received transfer shows the sender's outflow there. If the wallet sent
the transaction, only `subject_flow` is listed because both describe the same
side. `counterparties` lists up to 25 value recipients per row, with
`counterparty_count` when the complete set is larger.

`address_poisoning` always reports `addresses_compared` and lookalike `pairs`
over the displayed page. Empty pairs on a recent page clear nothing older.
The summary keeps rows within a display budget in page order, retaining every
failed row and every row involving a lookalike. `omitted` reports excluded
rows; `detail: "full"` returns the whole page, not the wallet's whole history.

`signed_as_alias` separately lists transactions signed as an
`0x2::address_alias` delegate for another wallet. Their sender is the other
wallet, so the ordinary activity page cannot show them. The scan of wallets
naming this delegate is reused for up to five minutes; `alias_scan_as_of`
records when it read the chain. `signed_as_alias_unavailable` marks an
unfinished scan even when some matches were returned.

## Querying events across transactions

`query_events` filters by event type, transaction sender, emitting module, or
a time/checkpoint range. It returns event types and decoded fields, so there
is no need to hand-write GraphQL for event values. In raw GraphQL, `type` and
`json` are under `contents`, not on the Event itself. A protocol's own events
are the right source for its flows: a whole-PTB balance change can include
other protocols' activity. For events from one known transaction, use
`get_transaction`.

Newest-first is the default. Each page reports its order, oldest and newest
timestamps, and resolved window. Preserve order and filters when passing
`next_cursor` as `cursor`. The tool fills short service pages up to `limit`;
if its read budget stops first, `scan` names the continuation. Checkpoint
bounds are exclusive; ISO 8601 bounds include events at the stated time.
For example, `after_checkpoint: "2026-08-07T00:00:00Z"` includes that instant.

An event type carries the package ID that defined its struct.
`event_type: "0x2::coin::CoinBalanceChange"` is a full type filter. If an
upgraded package ID is supplied, the tool resolves it to the defining version
and reports `event_type_resolution`.

An emitting-module filter, such as `0x2::coin` or package-only `0x2`, follows
the network's `relocate_event_module` cutover:

| Network | Cutover |
|---|---|
| Mainnet | Checkpoint 69,982,635, 2024-10-17 |
| Testnet | Checkpoint 118,397,835, 2024-10-09 |
| Devnet | Genesis |

Before cutover, events use the original package ID regardless of which
version was called. Afterward, they use the called version's ID. A window
crossing cutover queries both scopes and merges them; `module_scope` reports
the scope. After cutover any one ID, including the original, matches only
that version, and `module_scope.other_version_ids` lists the rest. Framework
packages such as `0x2` and `0x3` upgrade in place, so one ID covers all versions.

## Ranking event activity

`aggregate_events` answers questions such as "who were the top wallets on
this protocol today" from one call, without paging `query_events`. Its
`event_type` and `module` filters follow the rules above. Start without
`value_field`:

```json
{ "module": "0x…::pool", "from": "2026-08-07T00:00:00Z", "to": "now" }
```

The answer lists the most frequent event types, each with a sample event and
its numeric fields. Many protocols put their own USD valuation in an event, so
one of those fields can often be summed directly. Re-run with `event_type` set
to the action's event and `value_field` set to the field, and use
`value_scale: 100` when a protocol reports USD cents.

`sort_order: "asc"` ranks the smallest groups first. A swarm of wallets that
each make one tiny action never reaches a top-N view, so coordinated dust
activity shows at that end. Budget stops and continuations are described
under [Partial event rankings](/concepts/truncation/#partial-event-rankings).

## Raw transaction filters

`query_transactions` accepts a sender and range, plus only one of
`affected_address`, `affected_object` and `function`; GraphQL cannot combine
those three filters. The affected-address filter includes sender, sponsor
and recipient. A Move filter can name a function such as
`0x2::coin::transfer`, a module such as `0x2::pay`, or a package.
Use `get_transaction_history` for decoded wallet activity instead.

`affected_object` uses the service's affected-object index. Transactions that
only read an object can be absent, so this filter cannot enumerate every user
of an oracle or other immutable input. Search the relevant function and time
window, then inspect `decode_ptb` inputs to establish which object each call used.

The default order is newest-first. Pages report `order`, `oldest_shown`,
`newest_shown` and the resolved `window`; pass `next_cursor` as `cursor`
with the same order and filters. Checkpoint bounds are exclusive; ISO bounds
include the stated instant, for example `2026-08-07T00:00:00Z`.

Short service pages are filled to `limit` within a read budget. If that budget
runs out, `scan` explains the stop and supplies the continuation call.
Continue while `has_next_page` is true, even if `transactions` is empty.

A function filter matches only the named package version, so each upgraded
version sees a different share of calls. `function_scope` reports the lineage;
`all_versions: true` merges calls through every version.
Rows wait until each version stream's next rows or exhaustion establish their
global order.

Matching a call does not attribute the whole transaction to that protocol.
A PTB may also make a large Cetus swap or use another protocol; summing its
balance changes as the filtered protocol's volume over-attributes the flow.
Use its own events through `query_events`. `include_functions` lists every
Move call for inspection. With `function`, `matched_calls` counts matching
calls at the filter's function, module or package granularity and version
scope; `total_calls` counts all calls.

## Combining an incident timeline

`build_timeline` merges up to 10 wallets or objects into one protocol-decoded
timeline, deduplicated and ordered by checkpoint. `from` and `to` accept ISO
times or checkpoint numbers. Times resolve to checkpoints inside the window
and constrain the query, rather than filtering a previously fetched page.
With `from`, each address is read forward from the start. Without it, the most
recent `per_address` transactions are read, before `to` if supplied.

`coverage` reports each address's read count, whether `per_address` truncated
the walk, the checkpoint reached, and continuing `from`/`to` bounds.
`subject_flow` is keyed by tracked address and contains each participant's
own signed change per coin. `token_flow` is the sender's, present only when
that sender is not already tracked in `subject_flow`.

The default summary keeps rows within a display budget in order, always retaining
failures and entries involving two tracked addresses. `omitted` describes
display exclusions; `detail: "full"` returns entries up to `limit`, which
defaults to 60. The read budget defaults to 30 transactions per address.
Even a short window can exceed the summary budget; a missing closing action
does not establish that it never happened. Follow `omitted.next_call` before
treating the displayed timeline as the complete sequence.

`activity_hours` is off by default. It reports distributions by UTC hour and
offers a timezone reading only when sample size, time span and read depth
support it. A daily rhythm needs at least 50 transactions spanning a week;
raise `per_address` accordingly, and heed the warning on smaller samples.
A flat pattern consistent with automation is common on Sui and is itself
useful evidence, without a timezone claim.

## Reading a batch of digests

Use `get_transactions` for several known digests. It accepts up to 50 and
collapses duplicates. Each transaction reports sender, status, timing, coin
balance changes, ordered Move calls, decoded events, protocol names, non-coin
`object_transfers`, and `created_for` objects delivered to someone other than
the sender. Object owners carry a `kind` (`address`, `object`, or `consensus`)
alongside their address; a kiosk-owned NFT is not attributed to a wallet.
Opened or frozen capabilities can instead have a `shared` or `immutable`
destination. `created_for` includes only creations for a party, not shared or
immutable objects. GraphQL misses are retried through the archive.

```json
{"digests":["<digest-1>","<digest-2>"]}
```

For a transaction with no coin balance change, the relevant part of the
response can still be:

```json
{"balance_changes":[],"object_transfer_count":1,"object_transfers":[{"object_id":"0x<object-id>","type":"collectible::Item","kind":"transferred","from":{"kind":"address","address":"0x<sender>"},"to":{"kind":"address","address":"0x<recipient>"},"category":"asset"}]}
```

The default view budgets the displayed events, calls, balances and object
custody across the batch. `event_count`, `move_call_count`,
`object_transfer_count` and `created_for_count` count rows before display
trimming; `omitted.next_call` retrieves rows left out of the summary.
`detail: "full"` removes display limits but not read bounds. Events stop at
50 per transaction (`events_truncated`); object changes stop after five
pages of 50 per transaction, and a failed page or missing cursor also sets
`object_changes_truncated`. Use `get_transaction` on the flagged digest for
the complete event or object list. A non-coin custody list is conclusive only
when its object-change read is complete.

## Totalling incident losses

`summarize_incident_losses` accepts exploit digests or a sender with an optional
window, not both. It groups the attacker's net per coin and each pool's or
vault's reserve change, with USD for both. Reserve changes come from decoded
events. If no event in the transaction yields amounts, it reads the drained
objects' `Balance<T>` holdings at input and output versions instead.
Transaction reads use gRPC with archive fallback and need no API key.

Coins sent onward in a coin that moved only between addresses in that
transaction are `transfers_out`, excluded from take. Unpriced coin legs and
unread or unpriced objects make `totals.partial` true. Missing debits can raise
a net, so a partial USD total is not a lower bound.

Sender mode includes swaps, deposits, withdrawals and bridge burns in the
window. These can net against exploit credits. It does not classify which
transactions were exploits, so use an explicit exploit digest set to measure
the take before subsequent trading and bridging.

Groups use the exact set of pool or vault objects attributed to a transaction
and the evidence basis (events or state). A transaction touching several
pools has one attacker net that cannot safely be split among them. Deposits
and withdrawals involving different sets remain separate groups even if they
share a port. For that port's net, attribute its digest set or aggregate its
own events; the largest group's `attacker_usd` need not be its total loss.

The default attacker is `sender`, or each transaction's sender. If every
successful transaction's sender only paid gas, the largest priced gainer above
the gas-only threshold across those transactions becomes the default instead,
reported in `attacker_defaulted_from_sender`. An unpriced gain by any other
non-sender blocks this default. Set `attacker` to choose explicitly.

Each coin is priced at its median movement time within each UTC hour before
amounts are summed; each moved object uses its own transaction's time.
`usd_basis` states the method, sources and coverage. Missing quotes, unknown
decimals and pricing-budget stops leave amounts unpriced without falling back
to another day's price. `price_at` sets one Unix-seconds or ISO 8601 moment for
both coins and objects. See [USD over a time window](/concepts/fund-flows/#usd-over-a-time-window).

The summary keeps the largest rows within a display budget. Totals cover
all rows, even when `max_groups` limits the listed groups. `omitted` gives
each trimmed list's count, USD, largest row and the call to retrieve it.
`detail: "full"` lists every row.

## Caller-set values

`analyze_attack_tx`'s `caller-value-used` rule connects a caller input to a
shared-object field or an attributed event, followed by a call using that
object. It does not reconstruct intermediate VM state. A set-use-restore
sequence can be detected when events track the changed field, but a value
restored before the final object write can escape the rule when the event
fields cannot be matched to that state. Inspect `decode_ptb` and the called
bytecode before treating the absence of this flag as evidence of a safe
oracle update. `price-off-market` is a separate check of a quoted price.
