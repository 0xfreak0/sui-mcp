---
title: Packages and upgrade authority
description: Who deployed a package, who can still change it, which capabilities and mint authority exist, and what its bytecode does.
sidebar:
  order: 9
---

## Choosing a package read

`analyze_package` accepts a package ID or an MVR name such as `@org/app`.
It summarizes modules, public and entry functions, and struct shapes, then
scans for freeze/denylist and mint authority, admin capabilities, fund
handling, randomness and hot-potato types. It is a heuristic surface scan,
not a security audit; no finding proves a flaw and no empty scan proves safety.

By default, `overview.modules` lists function and struct counts and entry
and public function names. `modules: ["pool"]` returns just those modules'
full signatures and struct field names and types. `detail: "full"` returns
every module in full, every capability separately and every bytecode lead.
The summary groups capabilities of one type while listing every holder.
`audit_capabilities: false` skips the capability audit; `include_disassembly:
true` adds each module's GraphQL bytecode assembly.

Use `get_package` for module names and linkage, `get_move_function` for one
signature, `disassemble_module` for instructions and `diff_package_upgrade`
for code changes. Direct GraphQL reads need care: `structs` is a connection
paged at 20 by default, while `fields` is a plain list with no `nodes`.


## Publisher and UpgradeCap holder

`identify_address` reports `publisher`, the address that created the package,
attributed to the lineage root. `analyze_package` reports it as
`root_publisher`, beside `version_publisher`, the sender of the upgrade that
created the version you passed.

The UpgradeCap carries `holder_status`, judged against the root: `burned`
means upgrade rights were renounced, which reduces risk, and is what most
departing caps did. A cap sent to an unspendable address (0x0,
0x2…) reads the same way even when the object itself still exists: nobody
holds a key for it, so the risk it once carried is gone.

## Packages published by a wallet

`identify_address` and `get_wallet_overview` show package versions created by
the wallet's first 20 sent transactions under `package_activity`. The optional
scan has a short time limit; if `package_activity` is unavailable, use its
`package_activity_next_call` to run `get_wallet_packages` without that limit.
Follow `scan.next_call` with its opaque cursor to inspect older sent transactions.
`scan.complete` is false while pages remain or a transaction on any page
could not be checked. `incomplete_transactions` names unread digests on this
page, and `prior_incomplete_transactions` counts unread digests on earlier
pages. Sending a publish transaction does not prove who holds its UpgradeCap
now, and an alias may have authorized the sender.

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
hex or shift form. A
[clever error](https://move-book.com/reference/abort-and-assert/clever-errors/)
is Move's name for an abort constant marked `#[error]`, which carries a
readable message; an abort that raises one is annotated with the constant's
name, its message and the source line:

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

`analyze_package` traces bytecode data flow through each function and the
package's own callees, without name lists. Each lead names the function and
supporting instructions and is graded strong, medium or weak:

- `discarded-check`: a bool from a comparison or a read-only call that reaches
  no branch, abort, return or store.
- `sibling-guard-gap`: a public function that mutates an object of a package
  type without a check most of its module's public functions on that type
  make, such as an ID binding, version check or pause check.
- `unchecked-state-write`: a public function writes a plain-value argument
  into a shared object's field without a comparison against stored state,
  sender check or owned-object gate.

Strong and medium leads raise findings listing the first leads. Weak leads
raise no finding and appear in `bytecode_scan.weak_leads`, the first few by
default. `detail: "full"` lists every lead, weak ones included;
`bytecode_scan.read` gives the calls to inspect them.

It compares older versions' checks with the newest version, reading every
version when there are at most 30. For longer lineages it reads the oldest 29
versions and the newest. Every version stays callable against the same shared
objects, whichever package ID you pass. An older
version whose public functions mutate a shared type without a check most
of the newest version's public functions on that type make is raised as
`ungated-older-version`, for example a version check added later.

None of these need the optional [decompiler](/guides/decompiler/).

## Governance and redeployed code

`get_upgrade_history` accepts any version's ID or an MVR name. Each lineage
version has its package ID, publish or upgrade transaction, time, sender,
signing scheme and UpgradeCap holder then. Signing schemes include single
key, zkLogin, passkey and multisig, with threshold and actual signing members.

A round trip is flagged when the cap leaves its usual holder, an upgrade
ships, and the cap returns within `round_trip_hours` (24 by default).
Other flags cover a single-key upgrade while the cap is usually multisig-held,
policy changes, and a cap destroyed to make the package immutable, wrapped,
frozen, shared or sent to an unspendable address. `as_of` accepts an ISO time,
`now` or a checkpoint and reports the holder and newest version then.

Each version lists non-framework dependency relinks. The latest version and
the version newest at `as_of` also list their dependencies' linked versions.
Use `linked_id` with `disassemble_module`; bytecode names dependencies by
original ID. Old versions remain callable, but this governance read does not
compare their guards. `analyze_package` supplies `ungated-older-version` leads.

`find_redeploys: true` searches for code carried by other lineages rather
than upgrades in the same lineage. It starts from up to 250 UpgradeCaps each
still held by the root publisher and current cap holder. Candidates sharing
at least half the module names have every version compared, ignoring package
addresses. Nearest-published candidates are read first, within 120 package reads.

`module_origins` gives each module's earliest matching version, including
this lineage. `function_origins` compares functions with table indices resolved
and reports code predating its module's origin, or functions whose whole module
appears in no compared lineage. Groups identify the module and origin version;
`related_lineages` lists the related packages.

Only this redeploy output is capped. The default summary applies a display
budget to function-origin groups, prioritizing the code that most predates
its module's origin. `omitted` counts excluded groups and functions;
`detail: "full"` lists all groups.

## Reading upgrade hunks

`diff_package_upgrade` resolves the requested two versions, each with its own
package address, and disassembles both. It accepts any version's ID or an
MVR name. By default it compares the latest to its predecessor; with
`to_version`, an omitted `from_version` means the immediately preceding version.

The summary names added and removed modules and functions, functions made
more or less reachable (for example private to public), and `changed_functions`
whose instructions changed. Changed modules have unified hunks; dependency
relinks include a call to diff the dependency itself. Behavior can change
through a dependency alone, with no local module changing.

Functions, structs and constant-pool entries are matched by name. Each `@@`
hunk stays within the named declaration even if compilation changed their
order. Renumbered instruction offsets, local slots, field/struct/constant
indices, branches and consistently renumbered locals are excluded from hunks
and counted in `renumbered_lines`. A function with no other change appears in
`renumbering_only_functions`. Clever abort codes, truncated constants, large
integers and `Shl`/`Shr` instructions carry explanatory `//` notes.

`max_sample_lines` budgets 60 lines per changed module by default. Changed
function bodies rank by the fraction rewritten; each receives its largest
hunk before any receives a second. Added and removed functions, types, `use`
lines and constants follow, and changed lines take priority over context.
`sample_truncated` marks a short sample; `unsampled_functions` and
`partly_sampled_functions` name its gaps. Follow `sample_next_call` to read them.

## Bytecode assembly annotations

`disassemble_module` reads assembly through GraphQL without an external
binary. The output is lower-level than decompiled source, with basic blocks
and stack operations. It accepts a package ID or MVR name such as `@org/app`.
Without `module_name` it lists modules; `all_modules: true` reads the package.
For a smaller read, supply `function_name` and `module_name`: the result
contains that function plus referenced `use` lines and constants.

Comments explain operands that the raw assembly leaves opaque:

- A clever abort code's error name, message and source line.
- A large integer's hexadecimal or shift form, such as `0xffff << 240`.
- The full value of a truncated constant.
- On `Shl` and `Shr`, the fact that shifted-out bits are dropped without an abort.
- On dependency `use` lines, the version and ID selected by this package's
  linkage table, rather than only the original ID printed in raw assembly.
