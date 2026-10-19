---
title: "Wallet drainer: claim::swapS kit"
description: Drainer bytecode, shared-object versions and collector transfers in a staked SUI transaction.
sidebar:
  order: 3
---

Package `0xa032d8b8…` withdrew a signer's staked SUI on 28 November 2024.
These calls compare the shared state before execution with the resulting transfers.

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

The calls use the package, shared object and collector addresses; the
signer's address is omitted.

To follow the SUI recipients of the drain, call `trace_funds` with the drain
digest, `direction: "forward"` and `coin_type: "0x2::sui::SUI"`. The trace
follows the larger collector and lists the other under `unfollowed_spends`.
`trace_flow_graph` with the same digest and coin type shows both collectors.
The `swapS` function name does not make the CTX minted to the signer swap
proceeds when SUI was paid to other addresses.

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

The package publisher is `0xf09d967b…`; publication preceded this drain
by about 36 minutes. `flagged_by` reports a third-party blocklist entry.

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

`swapS` reads `ClaimParams.initialized`. When false, its other branch
transfers the stake back to the sender. When true, it withdraws the stake
and splits SUI between `wallet` and `dev_wallet` according to
`profit_split`. Only the object's `owner` can call `set_claimable`, which
writes `initialized`.

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

The object was created 32 seconds before the drain. The listed versions
include two writes in the final five seconds.

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

At creation, `initialized` was false, both recorded amounts were zero,
and the package publisher was the object's owner. A simulation using
that state takes the return-stake branch.

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

`recent_foreign_writes` records an amount update 4.666 seconds before
execution and a false-to-true `initialized` change 0.935 seconds before it.
The two collectors received 520.06 and 173.35 SUI respectively.
`switched-before-execution` flags the foreign write to the shared object
shortly before value moved to those addresses.

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

`first_seen` records 1,570 SUI sent by the 25% collector to the 75%
collector twenty days earlier.

`first_seen.received` reads all balance-change pages of the first
transaction. A genesis allocation has `checkpoint: "0"`, `sender: null`
and `first_inflow: true`; it does not identify a funding wallet. If
continuation fails before a gain can be established, `first_inflow` is null.

## Evidence and limits

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
