---
title: "Example: claim::swapS drainer kit"
description: Reading a drainer package from the drainer's side, how its shared switch hid the drain from a dry run, and who collected the stolen stake.
sidebar:
  label: Wallet drainer
  order: 3
---

Question: how did package `0xa032d8b8` take a wallet's staked SUI on 28
November 2024 when a dry run at signing showed no loss, and who collected it?

## Sources

- Sui Developer Forum, [Lost my staked SUI](https://forums.sui.io/t/lost-my-staked-sui/46588)
- Sui Developer Forum, [Missing staked SUI coins](https://forums.sui.io/t/missing-staked-sui-coins/45839)
- Case file: [`claim-swaps-staked-drainer-2024-11.json`](https://github.com/0xfreak0/sui-mcp/blob/main/cases/incidents/claim-swaps-staked-drainer-2024-11.json)

| Subject | Value |
|---|---|
| Drainer package | `0xa032d8b82cb3168ee197aab042edc9421cec42f305dbb6a474a047ec083b5083` |
| Shared `ClaimParams` object | `0x7188a53ee9daee5604da2649e7b87b100c6693e4ce6b9d411f8af799b9960ecd` |
| Drain transaction | `F3TCZ6KiuZWosPhnNF4QrYsWuU4pbKncec6vkoVS9Vyd` |
| 75% collector | `0x55abfb40f533b549e43cdd2711746b208052512ee72874f7a5851ce186489e0f` |
| 25% collector | `0x532517d0f3d0d56566ab3580ca4d3b373a9303cb513c26dbdcf852582ba4e096` |

The steps below read the drainer's package, objects and wallets. They do not
need the signer's address, and the excerpts leave it out.

## Steps

### 1. Identify the package

[`identify_address`](/reference/tools/starting-points/#identify_address) on
the package id:

```json wrap
{ "address": "0xa032d8b82cb3168ee197aab042edc9421cec42f305dbb6a474a047ec083b5083" }
```

```text wrap
"type": "package",
"flagged_by": [ { "kind": "package", "tier": "third-party", … } ],
"publisher": {
  "publisher": "0xf09d967bd112eb1d71dc1da09a7d19897dba1903d771eee970e72c0213806a5c",
  "publish_tx": "3LWaip5cvzmAWJZn2Rb87sC2i7HfxdEwnk613GxxSM91",
  "published_at": "2024-11-28T18:27:47.705Z"
},
"modules": [ "claim" ]
```

The package was published 36 minutes before the drain, by `0xf09d967b`. A
third-party scam blocklist lists it.

### 2. Read what the code does with a stake

[`disassemble_module`](/reference/tools/packages/#disassemble_module) on the
`claim` module:

```json wrap
{ "package_id": "0xa032d8b82cb3168ee197aab042edc9421cec42f305dbb6a474a047ec083b5083", "module_name": "claim" }
```

```text wrap
struct ClaimParams has key {
	id: UID,
	owner: address,
	delegate: address,
	initialized: bool,
	details: Option<ClaimDetails>,
	wallet: address,
	dev_wallet: address,
	profit_split: u8
}
…
entry public swapS(Arg0: &mut SuiSystemState, Arg1: StakedSui, Arg2: &mut ClaimParams, Arg3: &mut TxContext) {
	…
	1: ImmBorrowField[1](ClaimParams.initialized: bool)
	2: ReadRef
	3: BrFalse(64)
	…
	36: Call sui_system::request_withdraw_stake_non_entry(&mut SuiSystemState, StakedSui, &mut TxContext): Balance<SUI>
	…
	59: Call transfer::public_transfer<Coin<SUI>>(Coin<SUI>, address)
	…
	62: Call transfer::public_transfer<Coin<SUI>>(Coin<SUI>, address)
	…
	74: Call transfer::public_transfer<StakedSui>(StakedSui, address)
	…
}
…
entry public set_claimable(Arg0: &mut ClaimParams, Arg1: bool, Arg2: &mut TxContext) {
	…
	2: Call tx_context::sender(&TxContext): address
	…
	15: MutBorrowField[1](ClaimParams.initialized: bool)
	…
}
```

`swapS` branches on `ClaimParams.initialized`. When it is false (offset 64 on)
the stake goes back to the sender. When it is true, the stake is withdrawn and
the SUI is split by `profit_split` between `wallet` and `dev_wallet`. Only the
object's `owner` can call `set_claimable` to flip it.

### 3. Put the object's changes on a timeline

[`trace_object_history`](/reference/tools/incident-investigation/#trace_object_history)
on the shared `ClaimParams`:

```json wrap
{ "object_id": "0x7188a53ee9daee5604da2649e7b87b100c6693e4ce6b9d411f8af799b9960ecd" }
```

```text wrap
"history": [
  { "version": "418135263", "tx": "F1hZSV2waUBCiRQQgeyqj2AR7Xgquk6bwT4T6mfGULgZ", "timestamp": "2024-11-28T19:02:57.330Z", … },
  { "version": "418135264", "tx": "HBuiLzCyicPavHeVRrYoUGpDhWWAHMkYzX8oz2AwweBc", "timestamp": "2024-11-28T19:03:25.066Z", … },
  { "version": "418135265", "tx": "4nxCU6RYo2rayrcQPe99chqF1iAFu7fiMurqrHDsmtUL", "timestamp": "2024-11-28T19:03:28.797Z", … },
  { "version": "433094869", "tx": "F3TCZ6KiuZWosPhnNF4QrYsWuU4pbKncec6vkoVS9Vyd", "timestamp": "2024-11-28T19:03:29.732Z", … }
]
```

The object was created 32 seconds before the drain and written twice in the
last five seconds before it.

### 4. Read the object as it was created

[`get_object`](/reference/tools/objects/#get_object) at the creation version:

```json wrap
{ "object_id": "0x7188a53ee9daee5604da2649e7b87b100c6693e4ce6b9d411f8af799b9960ecd", "version": "418135263" }
```

```text wrap
"content": {
  "details": { "coin_details": [ { "amount": "0", … }, { "amount": "0", … } ] },
  "dev_wallet": "0x532517d0f3d0d56566ab3580ca4d3b373a9303cb513c26dbdcf852582ba4e096",
  "initialized": false,
  "owner": "0xf09d967bd112eb1d71dc1da09a7d19897dba1903d771eee970e72c0213806a5c",
  "profit_split": 75,
  "wallet": "0x55abfb40f533b549e43cdd2711746b208052512ee72874f7a5851ce186489e0f",
  …
}
```

With `initialized: false` and zero amounts, a dry run against this version
returns every object to the signer. The owner is the package publisher.

### 5. Break down the drain

[`analyze_attack_tx`](/reference/tools/incident-investigation/#analyze_attack_tx)
on the drain:

```json wrap
{ "digest": "F3TCZ6KiuZWosPhnNF4QrYsWuU4pbKncec6vkoVS9Vyd" }
```

```text wrap
"recent_foreign_writes": [
  { "object": "0x7188a53ee9daee5604da2649e7b87b100c6693e4ce6b9d411f8af799b9960ecd",
    "writer": "0xf09d967bd112eb1d71dc1da09a7d19897dba1903d771eee970e72c0213806a5c",
    "digest": "4nxCU6RYo2rayrcQPe99chqF1iAFu7fiMurqrHDsmtUL", "ms_before": 935,
    "changed": [ { "path": "initialized", "kind": "gate", "before": "false", "after": "true" } ] },
  { …, "digest": "HBuiLzCyicPavHeVRrYoUGpDhWWAHMkYzX8oz2AwweBc", "ms_before": 4666,
    "changed": [ { "path": "details.coin_details[0].amount", "kind": "amount", "before": "0", "after": "5367827991" }, … ] }
],
"addresses": [
  …
  { "address": "0x55abfb40f533b549e43cdd2711746b208052512ee72874f7a5851ce186489e0f",
    "coins": [ { "symbol": "SUI", "amount": "520060685745", … }, … ] },
  { "address": "0x532517d0f3d0d56566ab3580ca4d3b373a9303cb513c26dbdcf852582ba4e096",
    "coins": [ { "symbol": "SUI", "amount": "173353561916", … }, … ] },
  …
],
"anomalies": [ { "severity": "high", "code": "switched-before-execution", … }, … ]
```

The publisher filled in the signer's coin amounts 4.666 s before the drain and
set `initialized` to true 0.935 s before it. The drain then paid 520.06 SUI to
the 75% collector and 173.35 SUI to the 25% collector, 693.41 SUI in all.
`switched-before-execution` is the flag for this pattern: a shared object
another address rewrote just before the transaction ran, changing where value
goes.

### 6. Link the two collectors

[`identify_address`](/reference/tools/starting-points/#identify_address) on
the 75% collector:

```json wrap
{ "address": "0x55abfb40f533b549e43cdd2711746b208052512ee72874f7a5851ce186489e0f" }
```

```text wrap
"first_seen": {
  "digest": "CqwzuQvR94ZUzvrxR8KSig3HTTkN6DaLtK5Zic5nNRkd",
  "timestamp": "2024-11-08T21:22:29.002Z",
  "sender": "0x532517d0f3d0d56566ab3580ca4d3b373a9303cb513c26dbdcf852582ba4e096",
  "received": [ { "coin_type": "0x…0002::sui::SUI", "amount": "1570000000000" } ],
  "first_inflow": true
}
```

The 75% collector's first inflow was 1,570 SUI from the 25% collector, twenty
days before the drain.

## What this shows and what it does not

- A dry run at signing reads shared objects as they are at that moment. A
  package whose behaviour depends on a shared object its author can rewrite
  can pass a dry run and still drain the wallet once the author flips it.
- The bytecode, the object versions and the transfers are chain facts. That
  both collectors belong to the drainer's operator is an inference from the
  split in the code and the funding link.
- A blocklist entry is third-party context. A package missing from every list
  is not cleared by that.
- `switched-before-execution` is a lead. A shared object legitimately updated
  by its protocol just before a user's transaction can raise it too; read what
  changed in `recent_foreign_writes`.

## Related

- [Packages and upgrade authority](/concepts/packages/#reading-one-functions-bytecode):
  reading one function's bytecode.
- [Reading a transaction](/concepts/transactions/): objects that are not coins.
- [`simulate_transaction`](/reference/tools/transaction-building/#simulate_transaction):
  dry-runs unsigned transaction bytes against current chain state, with the
  same limit as a wallet's dry run.
