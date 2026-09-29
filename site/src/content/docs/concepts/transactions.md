---
title: Reading a transaction
description: Abort reasons, objects that change hands without a balance change, transactions with no commands, and address balances.
sidebar:
  order: 2
---

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
