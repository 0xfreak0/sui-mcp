---
title: Packages and upgrade authority
description: Who deployed a package, who can still change it, which capabilities and mint authority exist, and what its bytecode does.
sidebar:
  order: 8
---

## Publisher and UpgradeCap holder

`identify_address` reports `publisher`, the address that created the package,
attributed to the lineage root. `analyze_package` reports it as
`root_publisher`, beside `version_publisher`, the sender of the upgrade that
created the version you passed.

The UpgradeCap carries `holder_status`, judged against the root: `burned`
means upgrade rights were renounced, which reduces risk, and is what 27 of
every 30 departing caps did. A cap sent to an unspendable address (0x0,
0x2…) reads the same way even when the object itself still exists: nobody
holds a key for it, so the risk it once carried is gone.

## Capability audit

The audit is not limited to caps minted at publish. It also walks the
package's own struct definitions for every `key`-ability type whose name marks
it as an authority (`Cap`, `Admin`, `Operator`, `Owner`, `Manager`,
`Authority`), catching a capability such as Volo's `OperatorCap`, minted long
after publish and handed to one key.

A type held by a small number of addresses is listed individually, each
holder's `signing_scheme` reported alongside it. One held one-per-user, like
DeepBook v3's `balance_manager::TradeCap` or 0x2's `kiosk::KioskOwnerCap`, is
reported as a count in `user_held_types` instead of one entry per holder.

A struct whose instance scan fails outright (a timeout, a 429 after retries),
or whose defining package version cannot be read, is named in
`incomplete_scans` rather than silently read as having no live instances.

A cap another object holds, such as a TreasuryCap a launchpad keeps as a
dynamic object field of its bonding curve, reads owner `object`, with the
holding object in `owner_address` and its type in `owner_type`, and is rated
like a wrapped cap: that object's module decides who can use it.

## Mint authority

Mint authority is looked up for the coins the package defines, including one
whose TreasuryCap the publish transaction never showed at top level:
Wormhole's wrapped coins, and meme coins such as SRT and CLOWNPEPE, keep the
cap (or the Supply it became) inside another object from `init` on.

Coins come from the publish transaction and from the registry entry each
non-generic `key` struct and each one-time-witness struct would have: a coin
created later through `coin_registry::new_currency`, or one whose `init`
wrapped both its TreasuryCap and its CoinMetadata. A one-time witness the
registry does not know is asked of the node. A generic `key` struct in a
module whose functions take the CoinRegistry is named in `incomplete_scans`,
since its coins cannot be looked up.

For each coin the audit reads the TreasuryCap id the registry records, then
searches for a live `TreasuryCap<T>` by type, and marks a cap found this way
with `found_by`. A coin whose cap neither finds is named in
`coins_without_located_mint_authority` with what was checked, and its `risk`
says what that means. At medium, who can mint it is unknown. At info, nothing
can mint it: the registry records its supply as fixed or burn-only (recording
that consumes the cap), or the coin is SUI, whose Supply was destroyed at
genesis.

## Upgrade history

`analyze_package` also reports `upgrade_cap`, the cap's owner-change count and
latest change. A package whose publish transaction passed its new UpgradeCap
to `0x2::package::make_immutable` never had a cap object: both tools say it is
immutable and name that transaction.

`get_upgrade_history` joins every version to its publisher, the publisher's
signing scheme and the cap holder at that moment, and `as_of` answers who held
upgrade authority at a given time:

```
get_upgrade_history { package: "0x0f286ad0…", as_of: "2025-09-07T16:03Z" }
→ flags: cap_round_trip (v10, 11 minutes away from the 3-of-4 multisig),
         single_key_upgrade (v10, v11)
  as_of: holder 0xf55cc609… (ed25519) since 2025-08-10, newest_version 10
```

## Reading one function's bytecode

`disassemble_module` with `function_name` returns one function's bytecode, the
`use` lines of the modules it calls and the constants it loads. A dependency's
`use` line prints its original ID; the note gives the version this package's
linkage runs, which is the ID to disassemble next. Large integers carry their
hex or shift form and a clever abort code its error name, message and source
line:

```
disassemble_module { package_id: "0xc6faf370…", module_name: "clmm_math", function_name: "get_delta_a" }
→ uses: use 714a63a0…::math_u256; // linked version 3: 0xe2b515f0…
disassemble_module { package_id: "0xe2b515f0…", module_name: "math_u256", function_name: "checked_shlw" }
→ 1: LdU256(115792…127040) // 0xffffffffffffffff << 192
  2: Gt
```

## Upgrade diffs and bytecode leads

`diff_package_upgrade` matches functions by name, lists in `changed_functions`
the ones whose instructions changed, and counts lines that only renumber
locals, fields or instruction offsets apart from the hunks.

`analyze_package` traces data flow through each function and the package's
own callees and returns graded leads, each with its instructions:

- `discarded-check`: a bool from a comparison or a read-only call that reaches
  no branch, abort, return or store.
- `sibling-guard-gap`: a public function that mutates an object type without a
  check most of its module's public functions on that type make.
- `unchecked-state-write`: a caller's value written into a shared object with
  no comparison linking it to stored state.

Weak leads raise no finding and are listed in `bytecode_scan.weak_leads`,
every one with `detail: 'full'`.

It also compares the lineage's older versions with its newest: every version
of a package stays callable, so an older version whose public functions mutate
a shared type without the check the newest version makes (a version check
added later) is raised as `ungated-older-version`.

None of these need the optional [decompiler](/guides/decompiler/).
