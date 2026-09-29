---
title: "Example: Typus oracle authority check"
description: Finding which oracle version an exploit called, who held its upgrade authority, why any caller could set prices, and what the fix upgrade changed.
sidebar:
  label: Package authority
  order: 5
---

Question: on 15 October 2025 an attacker set its own prices in the Typus
oracle. Which package version did it call, who controlled that package, and
what let an outside address write a price?

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
      { "object_id": "0x6e7ca39c4ad0a1ad83937e98b220824566d858814aa8fd01294400b45c2bbc21", … },
      …
      { "value": "1", … },
      { "value": "1", … },
      …
    ], … },
  { "index": 3, "type": "MoveCall",
    "target": "0x9eda9afa0b42bf908766c42d02a549c271d7d0ae02c8c58c5075858f8f4d3b69::lp_pool::swap", … },
  …
]
```

The attacker's own transaction called `update_v2` twice, writing a price of
651548270 into one oracle and 1 into another, then swapped against the pool
that reads those oracles. It passed the protocol's `UpdateAuthority` object
by reference.

### 2. Find the version and who held the upgrade authority

[`get_upgrade_history`](/reference/tools/incident-investigation/#get_upgrade_history)
with `as_of` set to the exploit:

```json wrap
{ "package": "0x855eb2d260ee42b898266e6df90bfd3c4ed821ccb253a352c159c223244a4b8a", "as_of": "2025-10-15T13:05:14Z" }
```

```text wrap
"as_of": {
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

Version 9 was the newest at the exploit and is the version the transaction
called. A 3-of-8 multisig held the UpgradeCap, and the same multisig
published version 10 the next day. Control of the upgrade key was not the
issue.

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

Any address can call a public entry function. `update_v2` takes the
`UpdateAuthority` by reference, not as an owned capability, and the object is
shared, so any transaction can pass it. Passing it proves nothing about the
caller; whatever check exists has to be in the body.

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

The function checks whether the sender is in the authority list, then
discards the answer with `Pop` and writes the price regardless. This is the
missing assert Typus, SlowMist and the forum post describe.

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

The scan reaches the same instruction without being told where to look. It
grades the lead strong because the discarded result was computed from the
sender.

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

Version 10 replaced the `UpdateAuthority` list with an `UpdateCap` issued by
the manager, added a way to burn the old authority object, and removed
`entry` from `update_v2`. Reading `update_v2` in version 10 with step 4's call
shows a body of `LdU64(0)` then `Abort`: it no longer writes anything.

## What this shows and what it does not

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
