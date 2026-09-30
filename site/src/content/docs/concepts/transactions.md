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
share about 20,000 characters, prioritizing every capability and, for SUI
and verified coins, the sender's changes and each coin's largest credit and
debit. `omitted` reports the rest.
Full detail lists every row, but commands are paged at about 30,000 characters,
with non-framework Move calls first.

Every event is decoded unless `max_event_field_bytes` sets a byte budget;
skips are reported and zero disables decoding. Past about 20,000 characters,
the summary folds events differing only in amounts into rows with counts,
emission indices, shared fields and each varying field's total, min and max.
It caps rows while retaining every event emitted by a called non-framework
package. `omitted` reports the reduction; full detail lists events in pages
of about 40,000 characters.

`commands: [3, 7]` selects exact command indices in full detail instead of
the first command page. Events narrow to the calls that emitted them; objects
narrow to commands taking them as arguments or returning their type.
`events_omitted` and `object_changes_omitted` state what was excluded.
`event_offset` starts at a position in the event list after that narrowing;
follow `events_page.next_call` for the next offset.

`route_loops` marks router paths that swap a coin away and back before the
real hop, for example USDC to USDT to USDC. It lists the loop's action indices,
coins and round-trip cost from the pools' own swap events, or null with a reason.


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

The first command page fits about 30,000 characters, prioritizing commands
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

USD prices need no API key: DefiLlama supplies them, with Pyth for verified
coins when `PYTH_API_KEY` is set. Every unpriced coin is listed. `attacker`
selects the profit address; a losing address is reported as a loss with the
addresses that gained, as with a victim who signed a drain.

The summary keeps rows within their shares of about 40,000 characters,
preserving pools, holders and addresses named by anomalies or flash legs,
the sender and the profit address. Totals and anomalies cover every row;
`omitted` reports the rest and `detail: "full"` lists every row.
