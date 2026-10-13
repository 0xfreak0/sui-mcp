---
title: "Package authority: Typus oracle"
description: Typus oracle call arguments, upgrade authority, bytecode and the subsequent package diff.
sidebar:
  order: 5
---

The first exploit transaction on 15 October 2025 called a Typus oracle
package. The calls below identify the version, its UpgradeCap holder and
the function's sender check.

## Sources

- Typus, [TLP oracle exploit post-mortem](https://medium.com/@TypusFinance/typus-finance-tlp-oracle-exploit-post-mortem-report-response-plan-ce2d0800808b)
- SlowMist, [the Typus permission validation vulnerability](https://slowmist.medium.com/is-the-move-language-secure-the-typus-permission-validation-vulnerability-755a5175f7c3)
- Sui Developer Forum, [how a missing assert drained Typus Finance](https://forums.sui.io/t/how-a-missing-assert-drained-3-44m-from-typus-finance-and-why-the-code-looked-correct/49420)
- Case file: [`typus-2025-10.json`](https://github.com/0xfreak0/sui-mcp/blob/main/cases/incidents/typus-2025-10.json)

| Subject | Value |
|---|---|
| First exploit transaction | `6KJvWtmrZDi5MxUPkJfDNZTLf2DFGKhQA2WuVAdSRUgH` |
| Oracle package, original id | `0x855eb2d260ee42b898266e6df90bfd3c4ed821ccb253a352c159c223244a4b8a` |
| Oracle version the exploit called | `0x4658a0fbd9a234dfc87726addcbe1a602f27ce4513ecc1ec99e6d973c7bfb101` |
| Oracle version after the fix | `0x1ead8a0d21d4eb446a75e9125c2e53e9c6505c863c05424c6e898ee3415efbe4` |

## Steps

### 1. Read what the exploit passed to the oracle

[`decode_ptb`](/reference/tools/advanced/#decode_ptb) on the first exploit
transaction:

```json wrap
{ "digest": "6KJvWtmrZDi5MxUPkJfDNZTLf2DFGKhQA2WuVAdSRUgH" }
```

```text wrap
"commands": [
  …
  { "index": 1, "type": "MoveCall",
    "target": "0x4658a0fbd9a234dfc87726addcbe1a602f27ce4513ecc1ec99e6d973c7bfb101::oracle::update_v2",
    "arguments": [
      { "object_id": "0x0a318f26fcf35922a8671a2d843872a7a25ac10b678bdee52f10fbc77140c0d0", "object_type": "oracle::Oracle", … },
      { "object_id": "0xef710183951f400bc1480bab662d793e7ff324192a2518d8bd036358d9f0fb85", "object_type": "oracle::UpdateAuthority", … },
      { "value_type": "u64", "value": "651548270", … },
      { "value_type": "u64", "value": "651548270", … },
      …
    ], … },
  { "index": 2, "type": "MoveCall", "target": "0x4658a0fb…::oracle::update_v2",
    "arguments": [
      { "object_type": "oracle::Oracle", … },
      …
      { "value": "1", … },
      { "value": "1", … },
      …
    ], … },
  { "index": 3, "type": "MoveCall", "target": "…::lp_pool::swap", … },
  …
]
```

The excerpt shows the first two `update_v2` calls, with price inputs
651548270 and 1, followed by a pool `swap`. The transaction calls
`update_v2` twelve times in total. Both shown calls pass an
`UpdateAuthority` object by reference.

### 2. Find the version and who held the upgrade authority

[`get_upgrade_history`](/reference/tools/incident-investigation/#get_upgrade_history)
with `as_of` set to the exploit:

```json wrap
{ "package": "0x855eb2d260ee42b898266e6df90bfd3c4ed821ccb253a352c159c223244a4b8a", "as_of": "2025-10-15T13:05:14Z" }
```

```text wrap
"as_of": {
  …,
  "cap_state": "held",
  "holder": {
    "kind": "address",
    "address": "0xb9a09efd534d29cc9f990db26b2dab00289f32de0cdcefa68c6808de208bc9cb",
    "scheme": "multisig threshold 3 of 8 weight"
  },
  "policy": "compatible",
  "newest_version": {
    "version": 9,
    "package_id": "0x4658a0fbd9a234dfc87726addcbe1a602f27ce4513ecc1ec99e6d973c7bfb101",
    "published_at": "2025-08-12T02:37:43.250Z", …
  }, …
},
"versions": [
  …
  { "version": 10, "package_id": "0x1ead8a0d21d4eb446a75e9125c2e53e9c6505c863c05424c6e898ee3415efbe4", …,
    "timestamp": "2025-10-16T13:34:50.852Z",
    "sender": "0xb9a09efd534d29cc9f990db26b2dab00289f32de0cdcefa68c6808de208bc9cb", … },
  …
]
```

Version 9 was the newest package at the exploit checkpoint and the version
called. A 3-of-8 multisig held its UpgradeCap and published version 10 the
next day. The upgrade holder and the function's caller authority are separate
checks.

### 3. Check who can call the function

[`get_move_function`](/reference/tools/packages/#get_move_function):

```json wrap
{ "package_id": "0x4658a0fbd9a234dfc87726addcbe1a602f27ce4513ecc1ec99e6d973c7bfb101",
  "module_name": "oracle", "function_name": "update_v2" }
```

```text wrap
"visibility": "public",
"is_entry": true,
"parameters": [
  "&mut 0x855eb2d2…::oracle::Oracle",
  "&0x855eb2d2…::oracle::UpdateAuthority",
  "u64",
  "u64",
  "&0x…0002::clock::Clock",
  "&mut 0x…0002::tx_context::TxContext"
]
```

`update_v2` is a public entry function. It accepts a shared
`UpdateAuthority` by reference, so a caller need not own the object.
Authorization depends on the function body.

### 4. Read the function body

[`disassemble_module`](/reference/tools/packages/#disassemble_module) with
`function_name`:

```json wrap
{ "package_id": "0x4658a0fbd9a234dfc87726addcbe1a602f27ce4513ecc1ec99e6d973c7bfb101",
  "module_name": "oracle", "function_name": "update_v2" }
```

```text wrap
entry public update_v2(Arg0: &mut Oracle, Arg1: &UpdateAuthority, Arg2: u64, Arg3: u64, Arg4: &Clock, Arg5: &mut TxContext) {
	…
	1: ImmBorrowField[1](UpdateAuthority.authority: vector<address>)
	…
	5: Call tx_context::sender(&TxContext): address
	…
	9: Call vector::contains<address>(&vector<address>, &address): bool
	10: Pop
	…
	13: Call version_check(&Oracle)
	…
	20: Call update_(&mut Oracle, u64, u64, &Clock, &TxContext)
	21: Ret
}
```

`vector::contains` compares the sender with the authority list. `Pop`
discards its result before `update_` writes the price. Typus, SlowMist
and the forum post describe the missing assertion.

### 5. Let the package scan find it

[`analyze_package`](/reference/tools/packages/#analyze_package) on the same
version, capability audit off:

```json wrap
{ "package_id": "0x4658a0fbd9a234dfc87726addcbe1a602f27ce4513ecc1ec99e6d973c7bfb101", "audit_capabilities": false }
```

```text wrap
"findings": [
  …
  { "severity": "medium", "code": "discarded-check", "title": "Check result reaches no use", …
    "leads": [
      { "function": "oracle::update_v2", "grade": "strong", …
        "instructions": [ "oracle::update_v2: 9: Call vector::contains<address>(&vector<address>, &address): bool" ] }
    ], … },
  …
]
```

The scan reports `oracle::update_v2` as a strong `discarded-check` lead.
The disassembly in step 4 shows the discarded check and subsequent write.

### 6. See what the fix changed

[`diff_package_upgrade`](/reference/tools/packages/#diff_package_upgrade)
from version 9 to 10:

```json wrap
{ "package": "0x855eb2d260ee42b898266e6df90bfd3c4ed821ccb253a352c159c223244a4b8a", "from_version": 9, "to_version": 10 }
```

```text wrap
"diff": {
  "added_functions": [
    { "signature": "public burn_update_authority(Arg0: UpdateAuthority)", … },
    { "signature": "entry create_update_cap(Arg0: &ManagerCap, Arg1: address, Arg2: &mut TxContext)", … },
    …
    { "signature": "public update_with_update_cap(Arg0: &mut Oracle, Arg1: &UpdateCap, Arg2: u64, Arg3: u64, Arg4: &Clock, Arg5: &TxContext)", … }
  ],
  "removed_functions": [ { "function": "new_update_authority", … }, { "function": "add_update_authority", … }, … ],
  "visibility_changes": [ …, { "module": "oracle", "function": "update_v2", "from": "public entry", "to": "public", … } ],
  …
}
```

Version 10 added `create_update_cap`, which issues an `UpdateCap` from the
`ManagerCap`, `update_with_update_cap` and `burn_update_authority`, removed the
functions that create and extend an `UpdateAuthority`, and removed `entry` from
`update_v2`. Reading version 10's `update_v2` with `disassemble_module` shows
`LdU64(0)` followed by `Abort`, so it no longer writes a price.

## Evidence and limits

- The bytecode, the version dates and the multisig holder are chain facts.
  The finding in step 5 is a lead that step 4 confirms by reading the code.
- A package whose upgrade authority sits with a multisig can still be
  exploited through a function that needs no authority at all. Check both.
- Older versions of a package stay callable after an upgrade unless the code
  checks a version number. `analyze_package` reports older versions that skip
  a check the newest makes as `ungated-older-version`.
- A scan with no `discarded-check` lead has not cleared the package. The scan
  follows a fixed set of data-flow shapes; arithmetic, pricing and ordering
  errors are outside them.

## Related

- [Packages and upgrade authority](/concepts/packages/#upgrade-history): the
  upgrade history, `as_of`, and the UpgradeCap holder.
- [Packages and upgrade authority](/concepts/packages/#upgrade-diffs-and-bytecode-leads):
  upgrade diffs and bytecode leads.
- [KONG SUI rug pull](/examples/token-rug/): the capability audit on a coin
  package.
