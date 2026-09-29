# sui-mcp

[![CI](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml)

Read-only MCP server for **investigating activity on Sui**. Trace where funds went, attribute wallets to their funding sources, rank addresses by protocol flow, work out who can actually sign for a multisig treasury, and tell a coordinated cluster from a crowd, then reconstruct it all on a timeline.

76 tools. It also covers the ordinary things: wallet overviews, DeFi positions, NFTs, prices and Move package analysis.

## Install

Add this to your MCP client config (Claude Code, Claude Desktop, Cursor, or anything else that speaks MCP over stdio):

```json
{
  "mcpServers": {
    "sui": {
      "command": "npx",
      "args": ["-y", "sui-analytics-mcp"]
    }
  }
}
```

No account, API key, or config file is required. The server reads public Sui endpoints and defaults to mainnet. Requires Node.js >= 22.13.

Doing investigative work? Start with the forensics tools loaded:

```json
"env": { "SUI_TOOLS": "core,forensics" }
```

## What an investigation looks like

Ranking a lending protocol's wallets for a day, then testing whether a cluster is coordinated, in six calls:

```
aggregate_events(module: <package>, from: "2026-08-07T00:00:00Z", to: "now")
  → every event type it emits, with counts and the numeric fields available
    (user actions are usually far rarer than bookkeeping events)

aggregate_events(event_type: <DepositEvent>, value_field: "event.deposit_value", value_scale: 100)
  → wallets ranked by USD deposited, truncated: false

find_funding_sources(addresses: [...25], depth: "first_hop")
  → 23 of 25 share one funder, funded in three bursts of under a minute

get_address_fanout(<that funder>)
  → 1,623 recipients, classified "distributor", so shared funding alone
    proves nothing here; the second-level timing clusters carry the case
```

Several wallets tracing back to one funder looks decisive until you measure the funder itself. A distributor with 1,623 recipients funds unrelated wallets all day, so shared funding on its own says very little. Every funding result includes the fan-out measurement for this reason.

Fan-out reports shape as well as size. Measured on the same day, a known exchange and a sybil funder had almost identical counterparty counts, 399 and 431, but very different flow. The exchange ran balanced at 0.73 out/in, deposits in and withdrawals out. The funder ran 9.78, paying many addresses and being paid by few.

## Multisig

A Sui address is the hash of whatever authenticates it. For a multisig, the threshold, every member key and every weight are part of that hash, so the committee can be read off the address and checked by deriving it and confirming it reproduces the address.

**Identify a wallet and its committee.** `identify_address` returns the shape, every member address, and each member resolved to its own name, labels and SuiNS history.

```
identify_address(0x045dadba…)
  → authentication: multisig, 4-of-7, verified: true
    committee_members: 7, each with name/label/kind
```

**See which keys are actually used.** The committee is fixed by the address, but who signs varies per transaction. `analyze_multisig` reads that across the wallet's most recent sent transactions, newest first, up to `max_transactions`.

```
analyze_multisig(0x045dadba…, max_transactions: 200)
  → transactions_examined: 8
    signer_sets: [0,1,3,4] x4, [1,2,3,4] x2, [0,2,3,4] x2
    always_present: [3, 4]
    dormant_members: [5, 6]
    active_signers_meet_threshold: true
```

`dormant_members` are keys that hold weight and have never used it. `always_present` are keys the wallet currently cannot move without. Both are reported against `transactions_examined`, since the claim is only as good as the window.

**See who authorised one transaction.** `get_transaction` returns an `authorization` block naming the keys that signed and the members that did not, plus the gas sponsor when there is one.

```
get_transaction(oxrJ3Bppuk…)
  → authorization[0]: sender, multisig 4-of-7
      signed_by:     [0, 1, 3, 4]
      did_not_sign:  [2, 5, 6]
```

**Search backwards from keys to a treasury.** Given addresses a trace has already linked, `find_shared_multisig` derives every committee they could form and returns the ones that exist on chain. This finds multisigs that never appeared in the trace, since a wallet is only visible if it transacted with something you looked at.

```
find_shared_multisig([0xafe2fafa…, 0xc848c5cc…])
  → candidates_checked: 4, found: 1
    0xcf4e7b88… 1-of-2, evidence_tier: chain-derived
```

**See who else can spend it.** A wallet can authorize up to eight other
addresses to act for it through `0x2::address_alias`. `identify_address` returns
that set, so a fixed committee does not have to be read as the only way to move
the funds.

```
identify_address(0x434d9c12…)
  → aliases: [0x66b816ed…, 0x33a86fba…]
    delegated_to: [0x66b816ed…, 0x33a86fba…]
    owner_can_authorize: false
```

`aliases` is the set as the chain holds it and `delegated_to` is that set
without the wallet itself. Enabling the feature seeds the set with the wallet's
own address, so an empty `delegated_to` means nobody else was authorized.

The set replaces the signer rather than extending it, so `owner_can_authorize`
decides who controls the wallet. When it is false the wallet's own key can no
longer sign for it and only `delegated_to` can move the funds. Measured across
all 63 mainnet sets, 50 are in that state.

An alias is control read from chain state, so you may write that the address can
authorize for the wallet. It is not evidence of shared ownership, since a
custodian holds authority for a client. A key acting for many wallets is a
service, and two mainnet keys already act for 22 each. The
set is mutable, so it is true as of the read, and most wallets have never
enabled the feature. The reverse answer, which wallets name a given key
(`alias_delegate_for` on `identify_address`, `signed_as_alias` on
`get_transaction_history`), comes from a scan reused for up to five minutes,
and `alias_scan_as_of` says when that scan read the chain. When the scan could
not finish, `signed_as_alias_unavailable` says so, also beside rows it did find.

**Clustering.** `build_wallet_edges` emits a `co_signer` edge for any key that can spend a wallet on its own, and marks clusters built only from those `chain-derived` rather than `heuristic`. Keys sitting on more committees than the limit are treated as custody or wallet-provider keys and listed under `excluded_co_signers` instead of linking everyone who uses that provider.

**Limits, also stated in the tool output.** Member order is part of the address, so `find_shared_multisig` is factorial in committee size and refuses past five keys; it covers equal-weight committees only, so a nil result is not a negative finding. A wallet that has never sent a transaction cannot be classified at all, because it has produced no signature. It comes back as unknown rather than as an ordinary wallet.

zkLogin and passkey wallets go through the same path. zkLogin reports its OAuth issuer, which is all the chain discloses about the account.

## What a result tells you about itself

Several tools qualify their own answers rather than returning a number that
looks more certain than it is.

**Is this coin the one you meant?** A symbol is not an identifier on Sui.
142,152 of the 174,685 coins on mainnet share one with another, and imitators
are named to be mistaken. `analyze_token` reports `verified`, and every balance
change in a trace carries `coin_verified`:

```
-850 MAGMA (unverified, assumed scale)     coin_verified=false
+202.361728 USDC                           coin_verified=true
```

These are two separate marks. `unverified` refers to which coin it is.
`assumed scale` refers to whether the amount is right: decimals for an unknown
coin are a guess, and 47 of 289 imitators declare a different scale from the
coin they imitate. Every tool that formats or values an amount reads the
coin's own `CoinMetadata` first, so an amount at the coin's real decimals
carries only `unverified`, and `assumed scale` means the coin has no
`CoinMetadata` to read or the read failed.

`analyze_token` narrows the guess by reading `0x2::coin_registry`, Sui's
canonical on-chain coin metadata, and `decimals_source` names where the scale
came from:

```
analyze_token(0xdba34672…::usdc::USDC)
  → decimals: 6, decimals_source: coin_metadata
    verified: true
    coin_registry: { registered: true, regulated: regulated, regulated_cap_id: 0x699b3162… }
```

Being in that registry is not a vouch. Anyone who can publish a coin can
register it, so an impostor's entry looks the same as the real asset's, and
`verified` still reports only what the curated list says. The registry supplies
chain-derived decimals, and whether an issuer holds a cap that can freeze
holders.

`decimals_source` is one of `coin_metadata`, `coin_registry`, `curated`,
`symbol_scan` or `assumed`. The last two carry a note saying what the scale
rests on.

An ambiguous symbol returns candidates rather than a coin. `USDC` matches seven
legitimate verified coins on Sui (Circle's, Wormhole's, Celer's), so picking one
would misreport which asset moved.

A symbol no curated list covers is looked up in a symbol index of every coin
on mainnet, synced from each `CoinMetadata` and coin registry entry by
`npm run sync:coin-symbols`. 30 coins use `KONG`, so `analyze_token` returns
all 30 as candidates, verified first and then by supply, and `search_token`
lists them. The index has a date, and every answer drawn from it names that
date: a coin published later is found only by a bounded live scan of on-chain
metadata, which says how far it got.

**Why did it fail?** `get_transaction` returns the abort code with the package,
module and function that raised it, and a clever error's constant name where the
author defined one.

**Who deployed this, and can they still change it?** `identify_address`
reports `publisher`, the address that created the package, attributed to the
lineage root. `analyze_package` reports it as `root_publisher`, beside
`version_publisher`, the sender of the upgrade that created the version you
passed. The UpgradeCap carries `holder_status`, judged against the root:
`burned` means upgrade rights were renounced, which *reduces* risk, and is what
27 of every 30 departing caps did. A cap sent to an unspendable address (0x0,
0x2…) reads the same way even when the object itself still exists: nobody
holds a key for it, so the risk it once carried is gone.

The audit is not limited to caps minted at publish. It also walks the
package's own struct definitions for every `key`-ability type whose name
marks it as an authority (`Cap`, `Admin`, `Operator`, `Owner`, `Manager`,
`Authority`), catching a capability such as Volo's `OperatorCap`, minted long
after publish and handed to one key. A type held by a small number of
addresses is listed individually, each holder's `signing_scheme` reported
alongside it; one held one-per-user, like DeepBook v3's `balance_manager::
TradeCap` or 0x2's `kiosk::KioskOwnerCap`, is reported as a count in
`user_held_types` instead of one entry per holder. A struct whose instance
scan fails outright (a timeout, a 429 after retries), or whose defining
package version cannot be read, is named in `incomplete_scans` rather than
silently read as having no live instances.

`analyze_package` also reports `upgrade_cap`, the cap's owner-change count and
latest change. `get_upgrade_history` joins every version to its publisher, the
publisher's signing scheme and the cap holder at that moment, and `as_of`
answers who held upgrade authority at a given time:

```
get_upgrade_history { package: "0x0f286ad0…", as_of: "2025-09-07T16:03Z" }
→ flags: cap_round_trip (v10, 11 minutes away from the 3-of-4 multisig),
         single_key_upgrade (v10, v11)
  as_of: holder 0xf55cc609… (ed25519) since 2025-08-10, newest_version 10
```

**What does the exploited function do?** `disassemble_module` with
`function_name` returns one function's bytecode, the `use` lines of the modules
it calls and the constants it loads. A dependency's `use` line prints its
original ID; the note gives the version this package's linkage runs, which is
the ID to disassemble next. Large integers carry their hex or shift form and a
clever abort code its error name, message and source line:

```
disassemble_module { package_id: "0xc6faf370…", module_name: "clmm_math", function_name: "get_delta_a" }
→ uses: use 714a63a0…::math_u256; // linked version 3: 0xe2b515f0…
disassemble_module { package_id: "0xe2b515f0…", module_name: "math_u256", function_name: "checked_shlw" }
→ 1: LdU256(115792…127040) // 0xffffffffffffffff << 192
  2: Gt
```

`diff_package_upgrade` matches functions by name, lists in `changed_functions`
the ones whose instructions changed, and counts lines that only renumber
locals, fields or instruction offsets apart from the hunks. `analyze_package`
traces data flow through each function and the package's own callees and
returns graded leads, each with its instructions: `discarded-check` (a bool
from a comparison or a read-only call that reaches no branch, abort, return
or store), `sibling-guard-gap` (a public function that mutates an object type
without a check most of its module's public functions on that type make) and
`unchecked-state-write` (a caller's value written into a shared object with no
comparison linking it to stored state). Weak leads raise no finding and are
listed in `bytecode_scan.weak_leads`, every one with `detail: 'full'`. It
also compares the lineage's older versions with its newest: every version of
a package stays callable, so an older version whose public functions mutate a
shared type without the check the newest version makes (a version check added
later) is raised as `ungated-older-version`. None of these need the optional
decompiler.

**Has an issuer frozen this address?** `check_coin_restrictions` reads the
on-chain deny list in both directions. A frozen address usually holds none of
the coin that froze it, so it checks every configured coin type rather than the
ones it holds. A freeze by validators is node configuration, not chain state,
and does not appear here.

**What moved that was not a coin?** `trace_funds` reports `object_flow`, and
`get_transaction` reports `object_changes`, `object_transfers`, `created_for`
and `mutated_capabilities` for one transaction. A balance change nets each
owner's coins and address balance per coin type, so an NFT, a Kiosk or a
capability changes hands without producing one, and a capability that
authorises a call by mutating itself in place (a nonce, a rate limit) without
changing owner produces neither a balance change nor a custody change —
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
`Publisher` are marked as carrying control. A capability sent to an unspendable
address is reported under `renounced_capabilities` instead, since those rights
have been given up rather than transferred.

**Where did all of it go?** `trace_funds` follows one branch. `trace_flow_graph`
follows every branch and says what share of the traced value ended where. From
the Nemo exploit transaction:

```
trace_flow_graph(digest: "19Zkat1xArMTMvPCB4e4QtM5HstpYiKvgPjbvkLUAw9")
  → 144,835.8 SUI credited to the attacker, swapped to 492,236.5 USDC in 3
    transactions, then burned through Circle CCTP in 3 more
    terminals: bridge_exit 99.9% ($492.1K) → beneficiary eip155:1:0x135477aa…
               below_threshold 0.07%
```

A node's traced amount is spent first in, first out: an address that pays out
more than it received from these funds is treated as paying these funds first,
and its payment carries only the traced part (`traced_amount`) onward. That is
a convention, not something the chain records. Terminals are grouped by reason
(`bridge_exit`, `sink`, `hub`, `unspent`, `consumed`, `retained`,
`signer_not_sender`, `budget`), and `coverage.truncated` says whether a limit
cut the graph short. A sale whose proceeds are worth under a tenth of what went
in carries only what they are worth, whatever its calls are named; the rest is
`consumed` when the seller holds a receipt or position for it, new or
existing, or may hold an account in a table the transaction wrote, and
`retained` by the shared objects the transaction wrote only when the object
changes show it holds nothing.
A labelled attacker is followed rather than treated as a sink.

`find_flow_path(from, to)` asks whether any path connects two addresses. It
searches forward from `from` and backward from `to` and joins them where the
money arrived before it moved on. `to` may also be an account on another chain,
which a path reaches through a bridge exit that pays it:

```
find_flow_path(from: <Cetus attacker>, to: "eip155:1:0x89012a55…",
               window_start: "2025-05-22T10:30:00Z")
  → 5 one-hop paths: Mayan MCTP (55 txs, 54.4M USDC), CCTP (7 txs),
    Wormhole, Sui Bridge
```

`trace_flow_graph`, `find_flow_path`, `trace_funds` and `build_wallet_edges`
take `format: "mermaid"` (a fenced diagram that renders in a markdown viewer),
`"graph_json"` or `"csv"`. `export_case` with `format: "mermaid"` appends a
fund-flow diagram of the transfers in the case's cited transactions.

**What has happened since I last looked?** `watch_addresses` records a set of
addresses and where it last looked; `poll_watch` returns only what is new:

```
{ "watched": 20, "active": 0, "hits": [], "requests": 1 }
```

That empty answer is 13 tokens and one request, so it is cheap to call
repeatedly. Nothing triggers a poll on its own; the caller drives it. A hit
names the address, digest, checkpoint and why it fired. It does not include the
transaction, which you read separately with `get_transaction`:

| reason | |
|---|---|
| `value_in` / `value_out` | coin moved, with per-coin nets |
| `capability_moved` | mint, upgrade, freeze or publish rights changed hands |
| `object_moved` | an NFT, kiosk item or DeFi position changed hands |
| `sink_reached` | a counterparty carries a sink label (exchange, bridge, mixer, burn) or a `malicious` one |
| `lookalike_appeared` | a new counterparty renders like a watched address |
| `appeared` | something happened that moved no coin and no named object |

Watching starts from the current checkpoint, so adding an address does not
replay its history. `min_amount` filters coin movements only: a labelled sink
or a transfer that moves no coin is reported whatever its size. An address busy
enough to fill the per-poll cap is listed in `more_pending` rather than being
silently truncated. Requires `SUI_STORE_PATH`.

**Who really holds a kiosk-stored NFT?** A kiosk-held NFT is owned by the Kiosk
object, and a kiosk carries an `owner` field that `set_owner` writes. That field
does not follow the `KioskOwnerCap`, so it names whoever set it last. Measured
over 300 mainnet kiosks it disagreed with the real cap holder 40% of the time,
and one address was declared by 82 different kiosks, which is enough to invent a
top holder out of a platform address.

`get_nft_sales` closes that gap. A marketplace sale names the buyer and the
buyer's kiosk in one record, so any kiosk seen trading has a chain-derived
owner:

```
get_nft_sales({ hours: 24 })
{ "sales": 237, "volume_sui": "5982.3007", "kiosk_owners_learned": 249, "requests": 13 }
```

Those mappings are stored, and `get_top_holders` uses them. `holder_kind` names
how each holder was arrived at, weakest evidence first: `kiosk_declared` from
the kiosk's own field, `kiosk_resolved` from a sale record, `wallet` read from
the object itself, and `mixed` when one address holds NFTs by more than one
route. A sale-derived owner is chain-derived but a snapshot at that
checkpoint, and a kiosk can be sold afterwards, so it is not reported as
`wallet`. `from_kiosk_owner_field` and `from_sale_records` carry the split. The window is bounded because `events` has no
collection filter, so all-time volume would be unbounded paging. It reads
TradePort, BlueMove and OriginByte, and requires `SUI_STORE_PATH` to keep what
it learns.

For ONE kiosk you already have the id of, `get_object`, `identify_address`
and `trace_object_history` answer this directly with `kiosk_cap_holder`: read
from the cap's own current owner, found via the kiosk's creation transaction
(which `kiosk::new()` always creates alongside the cap) rather than a scan.
`get_object`'s version only applies to the LATEST snapshot: a past `version`
skips the lookup, since today's cap holder is not who controlled a prior
state. `trace_object_history` attaches it only to `current`, never to
`created`, a `history` row or an `owner_changes` endpoint even when they
share the same kiosk: the cap's holder today is not who controlled the
kiosk THEN. A cap wrapped inside another object (a personal kiosk's
`PersonalKioskCap`, including one created in the same transaction as the
kiosk) resolves to the owner of the outermost wrapper, with
`kiosk_cap_wrapped_in` listing the wrappers from the cap outwards. A wrapper
is named only while its current contents still hold the cap; when the cap
has moved to another container, the lookup follows it there. A chain that
cannot be followed, or a failed read (in `trace_object_history`, also the
walk from an item up to its kiosk), gives `kiosk_cap_holder_note` and the
rest of the answer.
`get_top_holders`'s sale-derived resolution above is for ranking many kiosks
at once, where reading each one's creation transaction is not practical.

`collection_type` narrows the result, but only for marketplaces that name the
collection in the event, which most do not: in one measured window 70 of 73
sales carried no collection type at all. Those are counted in
`unattributable_sales` rather than filtered out quietly, so a small number of
matches is never mistaken for a collection that did not trade.

**Did this transaction run no commands, or could we not decode them?**
`get_transaction` reports `command_count` beside a count of the objects the
transaction touched, so an empty `actions` list separates the two. A transaction
that runs no commands still writes an effect, and bots use that to manage a pool
of gas coins:

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

Both parties there are Kiosk objects rather than wallets. `changed` counts every
object effect, including the coin that paid, so it is a weaker signal than
`object_transfers`. `created_for` lists objects minted to an owner other than
the sender, which is a delivery even though nothing held them before.

**Did funds move without a coin object?** An address balance holds funds
credited to an address or an object id with no `Coin<T>` behind them.
`get_transaction` lists each deposit and withdrawal, the withdrawals the
transaction requested, and whether gas came from coins or the address balance:

```
get_transaction(CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay)
  → object_changes: { changed: 0, created: 0, deleted: 0 }
    address_balance_ops: [
      { owner: 0xb71e…1d47, op: deposit,  amount: 1951 },
      { owner: 0x7c8e…bdbf, op: withdraw, amount: 101951 } ]
    funds_withdrawals: [ { amount: 1951, coin_type: …::sui::SUI, source: sender } ]
    gas_source: address_balance
```

A coin folded into its owner's address balance is deleted while no value moves.
That deposit carries `converted_from_coins` and a note saying so.
`get_balance` and `get_wallet_overview` report `coin_balance` and
`address_balance` beside each total, and `identify_address` and `get_object`
list `address_balances` for an object id: funds the object holds itself, which
are not among its fields and which only its defining module can withdraw.

**What did this address hold at a past moment?** `get_balance` takes `at` (ISO
8601) or `at_checkpoint`. GraphQL reads a balance directly only inside its
consistent range, about the last hour (`method: consistent_read`). An older
point is reconstructed (`method: reconstructed`): the balance at a recent
anchor checkpoint, minus the owner's balance changes in that coin in every
transaction after the requested checkpoint up to the anchor. Balance changes
include address-balance deposits and withdrawals, so the result is exact when
`complete` is true.

```
get_balance(owner: 0x01229b3c…c724, at: 2025-09-07T16:00:00Z)
  → method: reconstructed, at_checkpoint: 187414630, complete: true,
    balance: 78.654856875 SUI, transactions_scanned: 30,
    anchor: { checkpoint: 326856716, balance: 93.696806819 SUI, … }
```

The scan reads at most `max_transactions` (default 1,000, max 10,000). When
that runs out, `complete` is false, `balance` is null, and `reached_checkpoint`
is the oldest checkpoint the scan got back to: every transaction after it was
read. A reconstructed balance has no coin/address split, so `coin_balance` and
`address_balance` are null and `anchor` carries the split at the anchor.

**Are these really the top holders?** Only when `complete_ranking` is true.
`get_top_holders` walks two things in object-id order, which is unrelated to
balance: `Coin<T>` objects, and address balances (funds credited to an owner's
address rather than held as a coin object). A scan that stops early returns
the largest holder it happened to see. On SUI the reported top holder goes from
66 SUI at `max_scan` 200 to 3,454 at 800, with no overlap in the top five. A
truncated scan therefore returns `sampled_holders`, without a rank or a
percentage of supply, along with a caveat naming which walk stopped. Raise
`max_scan` (applied to each walk) until `truncated` is false to get a real
ranking; that is only practical for coins with few enough objects to
enumerate. A scan also stops at 35s, marked `time_budget_reached`, and the caveat
reports how far the scan got and whether a retry or a smaller `max_scan` would
help. In a sample, each holder's
`balance` is read directly for that address, since the walk saw only some of
its coins, and `balance_in_sample` is
the walk's own sum. Each holder carries `coin_balance` and `address_balance`
beside the total, and `owner_kind`, because an address balance can belong to an object
such as a bridge's liquidity bank. `analyze_token` reports the same
distinction.

**Is this address the one it looks like?** `get_transaction_history`,
`trace_funds`, `trace_flow_graph` and `summarize_address_flows` compare every
address they touch and always report `address_poisoning`: `addresses_compared`
and the `pairs` close enough to be mistaken for one another. An empty `pairs`
covers only the addresses in that result. The two tracing tools also print the
pairs in their summary, so a Mermaid or CSV export carries the warning:

```
⚠ Addresses in this trace close enough to be mistaken for one another:
  0xa1b2c3d4…e5f60718  vs  0xa1b9f0e2…4c3a0718
```

An attacker generates an address sharing the leading and trailing characters of
one you already deal with, sends dust from it, and waits for someone to copy the
wrong row out of their own history. The check covers senders, balance-change
recipients and the branches a trace declined to follow. A poisoning wallet sends
rather than receives, so it never shows up as a counterparty, and the lookalike
is usually several hops from the address it imitates. `trace_flow_graph` and
`find_flow_path` never prune a branch to an address that renders like one
already reached, whatever `min_share` or `min_usd` say: the small amount is the
finding.

A pair is reported when at least three characters match at each end, roughly one
collision in seventeen million pairs by chance. The two addresses do not render
identically at every width; they match at both ends, which is enough to fool a
glance or a short truncation.

The address with the larger footprint is named as the established side, but only
when the gap is wide enough to support it. Dust repeating inside a single page
is normal for this attack, so a small margin proves nothing. Failing that, an
address that received nothing is the likelier impostor. In a transaction
history, timing can also decide it, but only for the shape poisoning leaves:
the later address first appears paying the wallet dust and receiving nothing,
within ten minutes of the address it imitates, and that address's first row is
not the oldest one shown. Otherwise the pair is reported with
`direction_known: false`.

**Does this address pay other people's gas?** `get_address_fanout` reports
`sponsor_shape`. This is invisible to value fan-out, since sponsoring moves
none of the sponsor's own money. A sponsor that also sent a coin to at least
half the addresses it sponsors (`sponsored_and_paid_count`) is an `operator`
running those wallets, the relationship `build_wallet_edges` links; a public
relayer pays gas for strangers it never funded. An operator that funds from
one address and sponsors from another also reads `relayer` here;
`build_wallet_edges` tests for that split by the first funders of the wallets
the sponsor serves. `relayer` and `operator` are
proven; `private_sponsor` off a truncated scan is flagged provisional, since
breadth only grows with the window.

**Is this the whole list?** Only when the response has no `truncated`.
`summarize_address_flows`, `find_funding_sources`, `get_transaction` and
`decode_ptb` list what fits about 20k characters (30k for a PTB's commands)
and compute every total, count and verdict over all rows first. Flagged rows
always stay: bridge exits, lookalikes, labelled and non-wallet addresses,
capabilities, the sender's own changes, subjects tied to one another.
`omitted` names each list that lost rows with the count, the USD value of the
priced ones and how many are unpriced, the largest row left out by USD (or the
first, where rows carry no value), and `next_call` is the call that
returns them, usually the same call with `detail: "full"`. With the local store
on, `omitted.result.uri` is the stored full result, `sui://results/{id}`,
which pages any list as an MCP resource. `list_nfts` leaves raw Move contents
to `detail: "full"` and counts them. `get_nft_sales` with `include_sales`
lists the newest sales that fit, while its totals cover every sale. A `get_transaction` event list past 20k
characters folds events that differ only in amounts into one row, and says so
under `omitted.folded`.

## The forensics skill

The server gives Claude chain access, but not method: which tool answers which
question, what a control group is for, and which conclusions to refuse. That
lives in a skill shipped alongside it.

```bash
mkdir -p ~/.claude/skills
cp -r "$(npm root -g)/sui-analytics-mcp/.claude/skills/sui-forensics" ~/.claude/skills/
```

Or copy `.claude/skills/sui-forensics/` out of this repo. It loads automatically
once present; there is nothing to configure.

It covers the evidence tiers and what each one lets you claim, the order to work
in, the base-rate check that keeps shared ancestry from reading as collusion,
and the conclusions to refuse. "No edge found, so they are unrelated" is the
most common of those.

Clients without skills get the same method as MCP prompts. Each one states the
task and the order of tool calls, followed by the skill sections that govern it:

| Prompt | Arguments | For |
|---|---|---|
| `investigate_address` | `address`, optional `network`, `case_name` | What an address is, who funded it, where its money went |
| `trace_incident` | `subject` (attack digest or attacker address), optional `network`, `case_name` | What an exploit took, the flaw in the code it ran, and where the money went |
| `attribute_cluster` | `addresses` (comma-separated), optional `network`, `case_name` | Whether several addresses share an operator, with a control group |

Four more prompts answer the questions people without investigation experience
ask. Each gives a plain answer of two to four sentences first, then a
`How sure: high|medium|low` line naming what was and was not checked, then the
digests and addresses behind it. They treat every flag as a lead, never as a
verdict, never name a private person, keep to default detail levels, and call
`enable_tools` only when a step needs a tool outside `core`:

| Prompt | Arguments | For |
|---|---|---|
| `was_i_scammed` | optional `address`, `digest`, `network` | What left the wallet, where it went, whether a blocklisted drainer package or a lookalike address was involved, and whom to report to |
| `is_this_token_safe` | `coin_type`, optional `network` | Who can mint, freeze or upgrade the coin, how concentrated its holders are, where it trades, and whether a scam list flags it |
| `is_this_protocol_safe` | `protocol` (package ID, MVR name or protocol name), optional `network` | Who can upgrade the code or use the admin caps, how they sign, and what changed recently |
| `who_is_this_wallet` | `address` (or SuiNS name), optional `network` | What kind of account it is, its labels and their evidence, its funding, activity and exchange deposit behaviour |

## Tool profiles

All 76 tools loaded at once cost about 29k tokens of context on every request (117k characters of tool list; `core` alone is about 7k tokens and `core,forensics` about 24k), and a large flat tool list makes models pick the wrong tool. So the server starts with a **core** set of 18 and keeps the rest one call away.

When you ask for something outside the current set, such as "trace where these funds went", the model calls `enable_tools` and the tracing tools appear immediately, with no restart. You never have to pick a profile. `enable_tools` names every tool that is still off, and the server's `instructions` name the profiles and the main investigation tools, so a client that shows them to the model knows what to ask for. Profile names are case-insensitive.

To start with more, set `SUI_TOOLS`:

```json
"env": { "SUI_TOOLS": "core,forensics" }
```

| Profile | Tools | Contents |
|---|---|---|
| `core` *(default)* | 18 | Wallets, balances, transactions (single and batched), tokens, NFTs, DeFi positions, staking, pools, names |
| `forensics` | 38 | Fund tracing and flow graphs, path finding between addresses, address flow summaries, exploit and incident-loss analysis, exposure screening, exchange deposit-address detection, upgrade history, funding-source attribution, cross-chain bridge resolution, wallet-edge clustering, package analysis, control-group sampling, timelines, object provenance, labels, events, oracle-vs-market deviation, live address watching, NFT marketplace sales |
| `developer` | 18 | Move packages, disassembly, decompilation, upgrade diffing, dependency graphs, PTB decoding, unsigned transaction building, Move Registry |
| `market` | 6 | DeepBook order book and fills, pool stats, token search, validators |
| `all` | 76 | Everything |

Runtime switching relies on `notifications/tools/list_changed`, sent once per `enable_tools` call. Claude Code and Claude Desktop honour it; some clients cache the tool list and will only see the change after a restart. `SUI_TOOLS` always works, so set it explicitly if your client doesn't refresh.

Upgrading from 1.1.x, where every tool loaded at startup? Set `SUI_TOOLS=all` to keep that behaviour.

## No wallet, no keys

The server has no credentials and no ability to move funds:

- It never accepts a private key, mnemonic, or seed phrase. No tool takes one as an argument and nothing in the code reads one from the environment.
- It never submits a transaction. `build_transfer` and `build_staking` return unsigned BCS bytes that you sign and broadcast somewhere else; `simulate_transaction` dry-runs bytes against a fullnode without executing them.
- Every remaining tool is a read.
- No provider accounts. RPC, indexing, and price data all come from public endpoints.

### What the process actually does

Supply-chain scanners report which capabilities a package uses but not why. The full list for this one:

| Capability | Where it's used |
|---|---|
| Network | Public Sui RPC and GraphQL, plus Pyth, Aftermath, DefiLlama and the Move Registry for prices and name resolution. Hosts are listed in [`src/config.ts`](src/config.ts) and [`src/utils/price-providers.ts`](src/utils/price-providers.ts). |
| Filesystem | Temp files for `decompile_module`, and reading `SUI_LABELS_FILE` if you set it. |
| Subprocess | One call, in [`src/tools/decompiler.ts`](src/tools/decompiler.ts), to the decompiler binary you build and configure yourself. It uses `execFile` with array arguments, so no shell is involved and nothing is interpolated into a command string. |
| Environment | The `SUI_`-prefixed variables in [`.env.example`](.env.example), plus two optional price-provider keys (`PYTH_API_KEY`, `CMC_API_KEY`). Nothing else is read. |

There is no `eval`, no dynamic `require`, no minified or obfuscated code, and no telemetry. Inputs that come from the chain are treated as untrusted: `decompile_module` validates module names before they reach a filesystem path, and bounds how many modules one call will process.

Most of the dependency tree is the MCP SDK. This server speaks stdio only and imports just `server/mcp.js` and `server/stdio.js`, so the SDK's HTTP-transport dependencies are installed but never loaded.

### Verifying a release

Releases are published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so every tarball carries a signed attestation tying it to the commit and workflow run that produced it:

```bash
npm audit signatures
```

## Capabilities

- **Per-call network** — every chain tool takes an optional `network` arg (`mainnet` / `testnet` / `devnet`); query multiple networks in one session (e.g. compare a testnet value to mainnet). `SUI_NETWORK` sets only the default. Tools that only use the local store (`list_findings`, `export_case`, `delete_finding`) do not take it.
- **MCP metadata** — every tool has a title and annotations: chain reads are `readOnlyHint: true`, and the tools that write the store (`save_finding`, `delete_finding`, `manage_labels`, `watch_addresses`, `poll_watch`) are not, with `destructiveHint` on the ones that delete. `trace_funds`, `build_wallet_edges` and `screen_address` also return their JSON as `structuredContent`. Tools whose complete result is the point (`get_transaction`, `get_transactions`, `find_funding_sources`, `analyze_attack_tx`, `summarize_incident_losses`, `screen_address`) declare `anthropic/maxResultSizeChars`, so Claude Code keeps their results inline up to 500k characters.
- **Protocol-aware** — decodes transactions from Cetus, Suilend, NAVI, Scallop, Bluefin, DeepBook, and more into human-readable actions
- **Incident investigation** — labeled fund tracing, batch funding attribution with fan-out controls, multi-address timelines, object provenance, exploit-transaction breakdown and incident loss totals in USD at block time, PTB anomaly triage, oracle-vs-market deviation
- **Multisig** — a Sui address is the hash of its authenticator, so the committee is read off the address itself. Names every member, says which keys are live and which have never signed, and shows who signed a given transaction. Also handles zkLogin and passkey wallets
- **Move package analysis** — disassembly, heuristic risk scan, capability audit, publisher attribution, upgrade-cap holder status, and upgrade diffing, none of which need an external binary
- **Asset verification** — a curated coin registry, so a trace says whether the asset it followed is the real one rather than an imitator wearing its symbol
- **Multi-source architecture** — gRPC for low-latency reads, GraphQL for filtered queries, archive node fallback for historical data
- **Price aggregation** — Aftermath, DefiLlama, Pyth and CoinMarketCap behind one interface, current or at a past block time, with no key required
- **Kiosk-aware** — resolves NFT ownership through Sui's kiosk system to actual wallet addresses
- **Move Registry (MVR)** — resolves names like `@deepbook/core` to package addresses, and back

## Configuration

All environment variables are optional. See [`.env.example`](.env.example) for the full list; the common ones are `SUI_NETWORK` (default network), `SUI_FULLNODE_URL` / `SUI_GRAPHQL_URL` (custom RPC endpoints), and `SUI_LABELS_FILE` (address attribution labels for fund tracing).

GraphQL and fullnode requests retry a rate limit (HTTP 429), a 5xx or a dropped connection up to four times with backoff, time out after 30 seconds, and run at most eight at a time per network. Requests to `*.sui.io` endpoints are also spaced to at most 180 per 10 seconds per endpoint; `SUI_RATE_LIMIT` changes that number for every endpoint, and `0` turns it off. If the public endpoint still rate-limits a heavy investigation, set `SUI_GRAPHQL_URL` to a private one.

Address arguments accept any case, a short form (`0x2`), the hex without `0x`, or a SuiNS name (`example.sui`). A name is resolved on the call's network and echoed back as `resolved_from`.

### Price sources

Current USD prices come from **Aftermath**, then **DefiLlama** for anything Aftermath does not list. The 24h change in `get_token_prices` and `analyze_token` is DefiLlama's, and null for a coin it does not list. Prices at a past moment (`get_token_prices` with `at`, per-hop USD in `trace_funds`, `analyze_attack_tx`, `summarize_incident_losses`) come from **DefiLlama**, or from Pyth for verified coins when `PYTH_API_KEY` is set. A Sui Bridge token (ETH, USDT, wBTC, wLBTC) that DefiLlama has no price for under its own Sui type is priced as the Ethereum asset it is minted against, and the price says so in `priced_as`. Neither Aftermath nor DefiLlama needs a key.

```
get_token_prices(["0x2::sui::SUI"], at: "2025-05-22T10:30:00Z")
  → price_usd 4.16, source "defillama", confidence 0.99,
    price_time 2025-05-22T10:30:01Z, price_offset_sec 1
```

Every price names its source, the provider's confidence, and the time of the sample it came from; one more than an hour from the moment asked for is marked `stale`. Every coin that could not be priced is listed under `unpriced` with the reason, and a failed request is reported differently from a coin the provider does not list.

DefiLlama and Aftermath key on the full coin type, so an impostor coin that copies a real coin's symbol is priced as itself or not at all. Pyth feeds are matched by symbol, so Pyth is only ever asked about coins on the verified list.

Two paid sources are opt-in and engage only when their key is set, so nobody is billed by accident and nothing degrades if you set neither:

| Variable | Enables |
|---|---|
| `PYTH_API_KEY` | Pyth as the preferred historical source for verified coins, with DefiLlama covering the rest, and the oracle-vs-market comparison in `compare_oracle_price`, which is Pyth-only. Without it, `compare_oracle_price` returns the DeepBook candles with `oracle_unavailable` and compares nothing. Pyth's Hermes endpoint requires authentication for price *values*; feed discovery is still open. |
| `CMC_API_KEY` | CoinMarketCap as an additional current-price source. Note it keys on ticker symbols, which are not unique on-chain, so it is only consulted for symbols already mapped to a coin type. |

A missing price and a price of zero mean different things, and no tool reports one as the other.

### Optional local store

Set `SUI_STORE_PATH` to keep address labels and fan-out measurements across sessions. It uses Node's built-in `node:sqlite`, so it adds no dependency and no native build. It is unset by default, and nothing is written to disk unless you set it. An investigation store is a record of which addresses you looked at, so that default is deliberate.

```json
"env": { "SUI_STORE_PATH": "/Users/you/.local/share/sui-mcp/store.db" }
```

Fund traces are not cached. A trace depends on your label set, so a stored result would disagree with a fresh run as soon as a label changed.

Each recorded case is also a resource, `sui://case/{name}`, holding the Markdown report `export_case` renders. `resources/list` lists every case in the store.

A capped tool response ("Is this the whole list?" above) names its full result as `sui://results/{id}` when the store is on. Reading that URI lists the result's lists and their lengths. Each list's `page` URI, `?path=inflow_sources&omitted=1`, pages only the rows the response left out; `offset`, `limit` and `match=0xab` page any list, 20k characters at most per page.

```json
{
  "mcpServers": {
    "sui": {
      "command": "npx",
      "args": ["-y", "sui-analytics-mcp"],
      "env": { "SUI_NETWORK": "testnet" }
    }
  }
}
```

## Move decompiler (optional)

72 of the 76 tools need nothing beyond the install above. Only `decompile_module` requires an external binary, and every code question can be answered without it:

- `disassemble_module` returns Move bytecode assembly via the GraphQL endpoint; `function_name` returns one function.
- `get_move_function` returns a function's signature and visibility.
- `diff_package_upgrade` diffs two versions of a package, function by function.
- `analyze_package` summarizes a package's API and runs a heuristic risk scan.

Use the decompiler when you want higher-level, source-like Move output instead of bytecode.

The binary is Revela's `move-decompiler`, built from Rust. It is not bundled in the npm package because a published tarball could only carry one platform's build, so you compile it once yourself and point the server at it with `SUI_DECOMPILER_PATH`. This works the same whether you installed via npx or from source. You need a Rust toolchain ([rustup.rs](https://rustup.rs/)); the build takes a few minutes.

```bash
git clone --depth 1 https://github.com/verichains/revela_sui.git
cd revela_sui/external-crates/move
cargo build --release --bin move-decompiler
# binary lands at target/release/move-decompiler
```

Then add its absolute path to your client config:

```json
{
  "mcpServers": {
    "sui": {
      "command": "npx",
      "args": ["-y", "sui-analytics-mcp"],
      "env": {
        "SUI_DECOMPILER_PATH": "/absolute/path/to/revela_sui/external-crates/move/target/release/move-decompiler"
      }
    }
  }
}
```

If you already cloned this repo, `npm run build:decompiler` does the same clone and build and copies the result to `bin/move-decompiler`.

Without `SUI_DECOMPILER_PATH` the server falls back to looking for `move-decompiler` on `PATH`. Prefer the absolute path: desktop clients often launch servers with a minimal environment that doesn't include your shell's `PATH`, so a binary you can run in a terminal may still be invisible to the server. If it's found in neither place, or `SUI_DECOMPILER_PATH` is set to an empty string, `decompile_module` returns an error naming the tools that read bytecode without it, its module listing reports `decompiler_available: false`, and every other tool is unaffected.

## Running from source

For development, or to run a version you've modified:

```bash
git clone https://github.com/0xfreak0/sui-mcp.git
cd sui-mcp
npm install
npm run build
```

Then point your client at the build output instead of npx:

```json
{
  "mcpServers": {
    "sui": {
      "command": "node",
      "args": ["/absolute/path/to/sui-mcp/dist/index.js"]
    }
  }
}
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and release workflow.

## Tools (76)

### Recommended Starting Points

| Tool | Description |
|---|---|
| `identify_address` | Identify what a Sui address is: wallet, package, validator, or object. For a package, `protocol` names its protocol from the curated registry or its upgrade lineage, else from its Move Registry name, else from a curated protocol whose key published this package version, that key having also published or upgraded the protocol's curated lineage (`identified_via: publisher`, no category), else from the entity of a bridge label on an object whose type the package defines (`identified_via: labeled-object`). `bridge_carrier` lists the package's bytecode calls into a curated bridge's exit entry, in the bridge's own package (an adapter or aggregator that can send that bridge's transfers). For an object, `address_balances` lists funds held in the object's own address balance. For a wallet, `names_held` lists every SuiNS registration it holds and whether it registered or used each one or was sent it by another address, and `first_seen` gives its oldest transaction (digest, timestamp, sender, coins received) with `first_inflow` saying whether another address funded it there (`first_seen_unavailable` when the read failed) |
| `get_wallet_overview` | Comprehensive wallet overview: every coin balance (each split into `coin_balance` and `address_balance`), SuiNS name, the count of staked SUI objects and of kiosks, and the five most recent transactions, newest first. With `include_prices`, holdings are ranked by value and DeFi positions (staked SUI with rewards, liquid staking, liquidity, lending, and balances held inside objects the wallet owns) are totalled beside the coins in `positions_value_usd`, with `include_nfts` NFTs as estimates in `nft_estimate_usd` kept out of the total, a coin a position already values is counted once, and readers that could not read are listed in `unread`. `coverage` sorts every object the wallet owns into what read it and lists the ones no reader recognises by type and count; `leads` names lending positions within 5% of their borrow limit and shared vaults whose fields name the wallet, with what they hold (not in the total). The default lists the holdings and unrecognised types that fit about 12k characters each; `detail: "full"` lists all |
| `get_transaction_history` | Decoded activity feed with protocol names and human-readable actions. Newest first by default (`order: "oldest"` starts at the first transaction); each page reports its order and the oldest and newest timestamps shown. `subject_flow` is the wallet's own signed balance change per coin with formatted amounts; `token_flow` is the sender's, given on rows another address sent. `counterparties` names up to 25 recipients per row and counts the rest. The page lists the rows that fit about 35k characters, keeping failed rows and rows a lookalike address took part in; `detail: "full"` lists all |
| `analyze_token` | Full token analysis: metadata, price, 24h change, supply, top holders. A symbol several coins use returns every candidate from the synced symbol index instead of picking one; a symbol more than 100 coins use returns only its count. A failed metadata read is reported as a failure with its error, not as a token that was not found |

### Chain & Network

| Tool | Description |
|---|---|
| `get_chain_info` | Current chain ID, epoch, checkpoint height, timestamp, gas price |
| `get_checkpoint` | Checkpoint details by sequence number, digest or `timestamp`. With a timestamp it returns the nearest checkpoint plus the last one before and the first one at or after that moment |

### Objects

| Tool | Description |
|---|---|
| `get_object` | Object by ID with type, owner, JSON content, and display metadata; `address_balances` lists funds held in the object's own address balance, which are not among its fields. For a kiosk, `kiosk_cap_holder` names who actually controls it — the kiosk's own `owner` field is self-declared and does not follow the KioskOwnerCap transfer |
| `list_owned_objects` | List objects owned by an address with optional type filter. `count` covers the whole page; the default lists the objects that fit about 30k characters and `detail: "full"` lists all |
| `list_dynamic_fields` | Dynamic fields of an object (tables, kiosk contents, etc.) |

### Coins & Tokens

| Tool | Description |
|---|---|
| `get_balance` | Balance of a coin type for an address or object (defaults to SUI), with `coin_balance` and `address_balance` beside the total; now, or at a past time or checkpoint (reconstructed from balance changes outside the last hour) |
| `get_coin_info` | Token metadata: name, symbol, decimals, description, supply |
| `search_token` | Search tokens by name or symbol. Verified coins come first and every result says whether a curated list vouches for its exact type; the rest come from a synced index of every mainnet coin, which names its date, or from a bounded live scan for a coin newer than the index. A symbol more than 100 coins use has no listed coins, and `unlisted_symbols` names each such symbol that is or contains the query with its count |
| `get_token_prices` | USD prices for tokens, current (Aftermath, then DefiLlama, then Pyth) or at a past moment when `at` is set (Pyth for verified coins with a key, DefiLlama otherwise). Each price carries its source, confidence and sample time; unpriced coins are listed with the reason |

### Transactions & Events

| Tool | Description |
|---|---|
| `get_transactions` | Reads up to 50 transactions in ONE call given their digests — sender, timing, balance changes, Move calls, and events with decoded fields. Ten digests go from ten round trips to one. Malformed digests are rejected before the request, because the server refuses a whole batch over one bad key. `protocols` names packages the same way `get_transaction` does. Each transaction's events, Move calls and balance changes share about 30k characters, the sender's own changes kept; `detail: "full"` lists all |
| `get_transaction` | Transaction by digest with protocol-decoded actions, address-balance deposits and withdrawals, and where gas came from. A called or event package with no curated or Move Registry name is named after the curated protocol whose key published it, and a `balance_changes` row whose address signed a curated protocol's packages carries `publisher_key_of`, so a fee paid to that team's key shows. `detail: "full"` adds the PTB's inputs, each command's arguments resolved (the object with its version and type, a pure value decoded with the called function's parameter type, the command a Result came from) and every changed object's id and type by kind, with commands paged at about 30k characters (Move calls into non-framework packages first) and `commands: [i, j]` to list exactly those, with the events, inputs and changed objects narrowed to them (each event names the command that emitted it). Dynamic fields of one type fold into one row with every id, and events page by position, about 40k characters a page, with `event_offset` and `events_page.next_call`. The default view caps `created_for`, `object_transfers`, `balance_changes` and `coins_delivered_to` at about 20k characters, keeping every capability, the sender's changes and each coin's largest credit and debit, and counts each list (`created_for_count`, `balance_change_count`). Events past about 20k characters fold: events that differ only in amounts become one row with their count, emission indices, shared fields and each varying field's total, min and max, and every event a non-framework package the transaction called emitted is kept |
| `query_transactions` | Filter transactions by sender, address, object, or function, bounded by checkpoints or ISO times. Newest first by default. A `function` filter matches one package version; `all_versions: true` reads the whole lineage as one list |
| `query_events` | Filter events by type, sender, module, and a checkpoint or ISO time range. Newest first by default. An event type written with an upgraded package ID is rewritten to the package that defined the struct |

### DeFi

| Tool | Description |
|---|---|
| `get_defi_positions` | Find and value a wallet's DeFi positions: staked SUI with accrued rewards, liquid-staking coins at their issuer's exchange rate, CLMM positions (Cetus, Bluefin, Momentum, FlowX, Magma, Turbos, also when wrapped inside another object) and AMM LP shares, balances held inside an object the wallet owns (its `Balance` and `Coin` fields, the tables and bags it holds, its dynamic fields), and lending and margin positions (Suilend, NAVI in every market and through `AccountCap`s, Scallop obligations and its sCoin, market-coin and spool receipts, AlphaLend, Bucket v1 and v2, Bluefin Pro accounts). Each carries `usd`, its `method`, `tier` and asset legs; `total_usd` and `by_protocol` sum every priced position, an unpriced one says why, `unread` lists what could not be read, `coverage` lists the owned objects no reader recognises by type and count, and `leads` names positions within 5% of their borrow limit and shared vaults whose fields name the wallet. A lending leg is priced at the protocol's own stored oracle price only when a provider's price is within 2% of it; otherwise the provider's price values it and both are in `price_check`, an oracle price no provider can confirm makes the position an estimate (tier heuristic), and a liquid-staking leg is valued as SUI at its issuer's rate. `health` holds the figures the protocol itself stores, with `borrow_limit_used` and `liquidation_threshold_used` derived from them (Bucket's from its minimum collateral ratio at the legs' prices), and when those figures and the legs' USD part by more than 2% `health_basis` says to use `health` for distance to liquidation and `usd` for worth |
| `find_pools` | Every liquidity pool for a token pair on Cetus, DeepBook (v3 and v2) and Turbos (every fee tier), with each pool's own token order; a search that failed is reported, never read as no pools |
| `get_pool_stats` | Pool reserves, fees, and prices for a given pool object ID (AMMs; see below for DeepBook) |

### DeepBook

DeepBook v3 is a central limit order book, so it has no reserves. Depth, spread and traded price come from the [DeepBook indexer](https://docs.sui.io/standards/deepbookv3-indexer) rather than from a pool object. Mainnet and testnet only.

| Tool | Description |
|---|---|
| `deepbook_orderbook` | Live bid/ask depth, spread, mid price and resting-liquidity imbalance. Omit `pool_name` to list pools. |
| `deepbook_trades` | Recent fills with maker/taker balance manager IDs — attribute trading to an account during an incident window |
| `compare_oracle_price` | (Security) Pyth oracle price vs the price DeepBook actually traded at, over a window — detects stale feeds, manipulation windows, and liquidations priced at levels the market never printed |

### NFTs

| Tool | Description |
|---|---|
| `list_nfts` | List NFTs owned by a wallet, including kiosk-stored NFTs and those in OriginByte kiosks, with display fields and an estimated value per NFT (`est_usd`, tier heuristic); each priced collection's unit value and basis appear once under `valuation`; `detail: "full"` adds each NFT's raw Move contents and each collection's floor, last sale and wash check |
| `list_nft_collections` | Collection summary with counts and an estimated value per collection and for the wallet (tier heuristic): per item, the lower of the collection's lowest active listing and its last sale in the past 30 days (a listing alone counts only if placed in that window), with zero-price sales, sales within one address or kiosk, and sales where one side first funded the other left out; unpriced otherwise. The total covers every collection; `detail: "full"` lists every row |
| `get_top_holders` | Holders of an NFT collection or token — a ranking only when the scan completes |

### Staking

| Tool | Description |
|---|---|
| `get_validators` | List validators (stake, commission, voting power), or full detail for one when `address` is set |
| `get_staking_summary` | Every StakedSui position a wallet owns and their total principal; the total is null when the positions could not all be read |

### Names

| Tool | Description |
|---|---|
| `resolve_name` | SuiNS name resolution (forward and reverse). An unregistered, expired or targetless name resolves to null with a `name_note` saying which; a failed lookup is an error, never a null |

### Move Registry (MVR)

The [Move Registry](https://www.moveregistry.com) maps human-readable package names like `@suins/core` or `@deepbook/core` to on-chain package addresses. Backed by `mainnet.mvr.mystenlabs.com/v1` (or `testnet.mvr...` when `SUI_NETWORK=testnet`).

| Tool | Description |
|---|---|
| `mvr_resolve` | Resolve one or many MVR names → package IDs. Accepts version-pinned names like `@suins/core/3`. |
| `mvr_reverse_resolve` | Reverse-lookup: package addresses → MVR names. Useful for enriching raw addresses anywhere. |
| `mvr_get_package_info` | Full record for a name: metadata, version, package_address, package_info ID, git source. |
| `mvr_search` | Browse / search the registry. Supports substring search, pagination, and an `is_linked` filter for published packages. |
| `mvr_resolve_struct` | Resolve `@org/app::module::Type` → canonical type tag at the type's defining-package address. |

**Typical flows:**

- *"What's the package for `@deepbook/core`?"* → `mvr_resolve(['@deepbook/core'])` → `0x4874e1...`. Hand the address to `get_package` for module/function details.
- *"What is package `0xf22f…`?"* → `mvr_reverse_resolve(['0xf22f…'])` → `@suins/core`.
- *"Find DeepBook-related packages"* → `mvr_search('deepbook', limit=20, is_linked=true)` → paginated list.
- *"Pin to a specific version"* → `mvr_resolve(['@suins/core/3'])` returns the v3 package address rather than the latest.

### Packages (Developer)

| Tool | Description |
|---|---|
| `get_package` | Move package modules. By default a per-module summary (function and struct counts, entry and public function names); `modules: ['pool']` returns those modules' structs (with ordered fields) and function signatures, `detail: 'full'` every module's. `dependencies` gives the version and ID of each dependency the package runs |
| `get_move_function` | Specific Move function signature and parameters |
| `get_package_dependency_graph` | A package's dependencies from its linkage table, each with the version linked, read recursively to depth 3 |
| `analyze_package` | Summarize a package's API + heuristic risk scan + capability audit (no binary; accepts 0x id or MVR name). The scan includes three bytecode data-flow checks with graded leads (`discarded-check`, `sibling-guard-gap`, `unchecked-state-write`), and `bytecode_scan` names them; a function with no lead is not cleared, and weak leads are listed in `bytecode_scan.weak_leads`. It also compares every version of the lineage with the newest and raises `ungated-older-version` for older versions whose public functions mutate a shared type without the check the newest version makes, since old versions stay callable. The overview is a per-module summary and caps of one type are listed once with every holder; `modules: ['pool']` adds those modules' struct shapes and signatures, `detail: 'full'` returns everything |
| `disassemble_module` | Disassemble Move bytecode via GraphQL (no binary; accepts 0x id or MVR name). `function_name` returns one function with the `use` lines and constants it refers to. Notes decode clever abort codes, write large integers in hex (`0xffff << 240`), and give each dependency's linked version on its `use` line |
| `decompile_module` | Decompile Move bytecode to source (optional; requires the decompiler binary, and its module listing says whether it is available). `function_name` returns one function; large literals carry their hex or shift form |
| `diff_package_upgrade` | (Security) Diff two package versions to spot what an upgrade changed — malicious-upgrade / backdoor detection. Functions are matched by name, so each hunk holds its own function's lines; `changed_functions`, added, removed and visibility changes are named in the summary; lines that only renumber locals, fields or offsets are counted apart; relinked dependencies; when a module's sample is cut, every changed function gets a hunk first and the ones left out are named with the call that shows them |

### Transaction Building

| Tool | Description |
|---|---|
| `build_transfer` | Build an unsigned transfer of SUI or any coin, drawing on coin objects and the address balance; returns BCS for `simulate_transaction` |
| `build_staking` | Build an unsigned stake/unstake transaction (`action: stake\|unstake`) |
| `simulate_transaction` | Dry-run a transaction to preview effects and gas cost |

### Advanced

| Tool | Description |
|---|---|
| `decode_ptb` | The pre-sign check: decode a Programmable Transaction Block from BCS bytes before signing it, or pass `digest` to decode an executed transaction's PTB. With bytes, what it sends to another address is set against the sender's balances now and each recipient's first transaction on chain (`presign_context`). Each argument resolved the way `get_transaction` with `detail: "full"` shows it (a u64, u128 or u256 with its top bit set also shows its two's-complement reading), `FundsWithdrawal` amounts, the gas source, and anomaly flags for a payout to a non-sender address (with `digest`, also coins and objects the effects show the sender lost to another address), a call into a wallet-blocklisted package, a call into a package that neither the curated registry nor a curated protocol's publishing key vouches for (medium only when value moves through it one way (with `digest`: another address gained what the sender lost, or the sender got nothing back) or another lead fires; a Move Registry name is display only), or into a superseded version of a lineage. `checks_run` names every check; one that matched nothing clears nothing, and before signing `simulate_transaction` shows the effects. Commands are paged at about 30k characters, the commands a flag names kept first, then Move calls into non-framework packages; `commands_omitted` gives the exact ranges left out, `command_offset` lists commands in index order from that index and `commands: [i, j]` lists exactly those |
| `check_activity` | One-shot check for new activity on an address (since a checkpoint, time or cursor) or an object (since a version) |

### Incident Investigation

| Tool | Description |
|---|---|
| `trace_funds` | Swap-aware, USD-valued multi-hop fund tracing (forward or backward) that follows the tracked coin, follows value out of objects, follows the largest of the spends that cover what arrived (the rest in `unfollowed_spends`), passes over deposits the holder keeps a share coin for (`kept_as_claim`), and stops at labeled sinks, bridge exits and hubs (forward, only an address 100+ senders pay into), always with a `stop_reason`. Each hop lists its valued objects with USD at its checkpoint (`object_values`), and forward follows them (basis `object`) to their recipient's next transaction that touches one when they outweigh the coin flow, as in a drain of stakes or LP positions. `format: mermaid\|graph_json\|csv` renders the followed path with the unfollowed branches dashed |
| `trace_flow_graph` | Follows every branch of the funds from a transaction, or from an address after a time, forward or backward, and allocates the traced value across recipients in proportion to what each received (first in, first out when funds are mixed). Returns nodes, edges with amounts, USD and digests, `terminals` grouped by reason with the share of the value that ended there (bridge exits with the far-side beneficiary, sinks, hubs, unspent, deposits), and `coverage`. The default lists the nodes and edges that fit about 20k characters, every exit, stop and labelled address included, and states the rest in `omitted`; `detail: "full"` lists all. `format: mermaid\|graph_json\|csv` |
| `find_flow_path` | Whether value moved from one address to another within `max_hops` (at most 6): searches forward from one end and backward from the other, heaviest branch first so the node limit goes to where the value is, and returns each path with its digests and amounts. The target may be an EVM or Solana account a bridge exit paid. A missing path is reported with what was explored and the nodes the node limit left unexpanded (`explored.node_limited`) |
| `analyze_attack_tx` | Break down one exploit transaction: each address's net per coin and in USD at block time, flash-loan and flash-swap legs paired borrow to repay, every swap's coins and amounts and, where the DEX event carries it, the pool price before and after (identical swaps on one pool fold into one row with their count, event indices and summed amounts; `swap_count` counts them all, and rows past about 8k characters are left to `omitted`, keeping every pool a flash leg or anomaly names), what each pool, vault or market lost by its own events (an event belongs to the changed shared object whose id it carries, whatever the field is named), each changed shared object read at its input and output versions (`state_deltas`, at most 24, the largest first, the rest listed), a reconciliation of the value that reached addresses against what decoded events and read balances paid out, oracle calls inside the PTB, anomaly flags (a stored number that moved 100x, a balance drained, a holder losing most of its priced value to addresses, or a value copied from an object other than the one referenced; a value the caller passed that is stored in a shared object, or reaches its accounting multiplied by another number an event states, and then used in the same PTB; a liquidity event credited more than its amounts buy on its tick range, or a share mint far above the deposit's share of the holdings; value no decoded event or read balance paid out; and `decode_ptb`'s PTB checks with the transaction's sender, blocklist and effects, printed in the text too), `checks_run` naming every check (one that matched nothing clears nothing), the commands the medium and high flags name with the `decode_ptb` call that lists them (`flagged_commands`), and the attacker's profit, or, for an address that lost value (a victim who signed), its loss and the addresses that gained. `attacker` defaults to the sender, unless the sender's own coins show it only paid gas: then the largest priced gainer over $1 in the same transaction is used instead (`attacker_defaulted_from_sender`), skipped in favour of the sender when another non-sender's gain is unpriced. The same default applies when the sender took nothing priced (a coin a scam list flags is a decoy) and gave valued objects away, as a victim-signed drain does: every address's net counts the objects it received, gave up or kept changed (staked SUI, LP positions, lending caps, vault receipts), valued at the transaction's checkpoint and listed with their method in `object_values`; NFT estimates are kept apart. Reads PTBs of any size in full over gRPC. Addresses, pool flows, state reads and unpriced coins keep what fits their share of about 40k characters, and every pool, holder and address an anomaly or flash leg names; `detail: "full"` lists every row |
| `summarize_incident_losses` | Total an attacker's take across many transactions (a digest list, or a sender and window), grouped by the pool each one drained, in USD at the time of the attack. `attacker` defaults to `sender`/each transaction's sender, unless every successful transaction's sender only paid gas: then the largest priced gainer across the same transactions is used instead (`attacker_defaulted_from_sender`), skipped in favour of the sender(s) when another non-sender's gain is unpriced. Coins with no price are listed with amounts, and the total is marked a lower bound when any are. A coin the attacker sent on to other addresses, in a transaction where it moved only between addresses, is listed in `transfers_out` and kept out of the take. Valued objects the attacker received, consumed or kept changed count in the totals (`objects`, each at its transaction's checkpoint), and objects it handed on are kept out as coins sent on are. A transaction whose events decode into no pool amounts is grouped under the shared objects whose `Balance<T>` holdings fell (`pool_basis: "state"`). Each list keeps what fits about 40k characters, largest first; `detail: "full"` lists every row |
| `summarize_address_flows` | One address over a window: per coin in/out/net with USD at the time, every address that paid it, the top recipients with identity and labels, who paid its gas and whose gas it paid, and every bridge exit it sent grouped by bridge and destination, with the far-side beneficiary read from chain data. Up to 20 other sends in which its value reached no address are read for the shape of a cross-chain message from a bridge with no marker here (`cross_chain_leads`, tier heuristic). Gas is reported apart from the totals, value with no counterparty address is `unattributed`, and `coverage` says whether the scan reached the start of the window. Valued objects (staked SUI, LP positions, lending caps, vault receipts) that entered or left the address, or that it kept while a transaction changed their value, count in `totals_usd` and with their counterparty, each at its transaction's checkpoint (`objects`), read for the newest 300 successful transactions of the scan, whoever signed them. The default view lists the counterparties, coins and unattributed rows that fit about 20k characters, always keeping labelled and non-wallet addresses and lookalikes; totals and `inflow_source_count` / `recipient_count` cover every row, and `detail: "full"` lists all |
| `resolve_bridge_transfer` | Follow funds across a bridge, in either direction. An event from a package no reader here covers that carries a chain field beside a foreign-address-sized byte string is listed in `cross_chain_leads`, tier heuristic: a possible exit through an unrecognised bridge, never an exit on its own. `beneficiaries` names who the transfer pays on the far side, decoded from the Sui transaction for Wormhole Token Bridge, the Token Bridge Relayer, NTT, Mayan MCTP and Swift, CCTP, the native bridge, LayerZero OFT, Axelar ITS, Allbridge Core and Celer cBridge. The contract a transfer is delivered to is reported apart from the recipient (`redeemed_via_contract`, `destination_oapp`). Resolves **Wormhole** (VAA identity `(emitter chain, emitter address, sequence)`, redemption from Wormholescan), **LayerZero V2** (GUID, destination endpoint and OApp from the packet, delivery from LayerZero Scan), and **Sui's native bridge**, **Circle CCTP**, **Axelar ITS**, **Allbridge Core** and **Celer cBridge**, whose events carry the destination chain and recipient, so their far side needs no indexer. Detects **Meson**, whose destination is not in Sui data, and any package the registry types as a bridge. Transfers arriving on Sui (native-bridge claims, Wormhole Token Bridge and NTT redemptions) resolve to their origin chain and transfer id rather than being mistaken for exits. So does a solver-style fulfilment by any package whose events quote the message it consumed, a CCTP source domain and nonce or a VAA passed in, while the transaction credits an address: `fulfilment_inbound` gives the origin chain, the CCTP transfer id and VAA id, the amounts, and the beneficiary credited exactly an amount and coin the events state (`chain-derived`; the lone other credit is `heuristic`). A package outside a bridge's lineage whose PTB call emitted that bridge's event is named under `carriers`, with the function called and the events it emitted, such as an adapter's order id. Every result is tiered: `chain-derived` trusts nobody, `indexer-attested` is a lead to confirm |
| `find_funding_source` | Walk an address back to its funding source(s) for attribution; stops at labeled exchanges/bridges, at an established funder that paid the address after its own earliest 12 transactions, and at any funder that paid more than 50 distinct addresses at least 0.01 SUI or $0.10 each (addresses paid only dust are counted apart in `below_floor_recipients`), the same limit `build_wallet_edges` uses, and fails closed (stops rather than guessing) when that funder's popularity cannot be read, because the budget ran out or the read failed. Lists the dust it skipped and who sponsored the address's gas (`sponsored_by`), whether or not this hop also found a qualifying inflow. A coin no price source quotes counts only as at least 1% of its supply, 0.1% from its publisher, or 0.01% sent as a grant to at most five addresses with no burst or list of equal amounts around it (`unpriced_funding` with its `basis`), such as a rug deployer's grant to an insider. A hop judged while no coin price could be read is listed in `prices_unavailable_at`, and one where such a coin's supply, publisher or send shape could not be read in `origin_unread_at` |
| `find_funding_sources` | Same, for up to 100 addresses in one call — shares work across converging chains, reports shared funders with flow shape (a chain counts only up to the first funder that is itself a subject; a funder past the 50-address limit is classed `distributor` even when its fan-out window counts fewer counterparties), addresses paid by one transaction (weighed against that transaction's full recipient count), subjects that funded each other, every payment one subject signed to another (`subject_paid_subject`), and sub-minute funding bursts. Each result carries its origin, first funder and first hop and counts its skipped dust; results and `subject_paid_subject` are capped at about 20k characters, keeping every subject tied to a shared funder, a subject link, co-funding, a burst or a payment. `detail: "full"` returns every hop, every dust row and every row |
| `sample_control_addresses` | Draw a random, reproducible control group from the same protocol and window, so a cohort's rate can be compared against chance |
| `resolve_protocol_packages` | Find which of a protocol's package versions are actually emitting now — the bundled registry is a decode map full of historical IDs, and querying one returns nothing |
| `get_address_fanout` | How many distinct addresses a funder pays. Tells an exchange hot wallet apart from a real common origin |
| `classify_deposit_address` | Whether an address is an exchange deposit address (verdict likely/no/unknown, tier heuristic): full-balance sweeps to one hot wallet (a self-paid sweep may keep up to 1 SUI for gas), relayer-sponsored gas, a labelled or hub-shaped destination. Every check runs, and `checks_not_run` says why any is null. Returns the hot wallet, exchange label with its source_url, sweep sponsor, sweep digests and a deposits sample |
| `screen_address` | Direct and indirect exposure (default 2 hops) to labelled malicious, exchange, bridge and mixer accounts and to OFAC-listed accounts on the far side of bridge exits (every chain-derived `resolve_bridge_transfer` beneficiary), with path digests, amounts, each label's source_url, and the coverage of the label and sanctions lists. Each bridge exit counts once, under the protocol that carried it, with the bridges it settled over in `route` (a Mayan order over Wormhole and CCTP) and any other bridge the same transaction used in `also_exited` |
| `build_wallet_edges` | Finds addresses that may share an operator with the ones you give it, and shows the evidence. Multisig co-signature (read from the address hash, not inferred), shared first funder, direct funding, shared gas sponsor, or a third party paying both. Exchanges and relayers are measured and discarded first (a funder's recipients count only when paid at least 0.01 SUI or $0.10), one the budget could not reach or whose read failed is excluded rather than assumed narrow (a failed read also sets `truncated`), and a sponsor that also first-funded the address it sponsors is kept as an operator link regardless of how widely it also sponsors strangers. So is a sponsor whose other sponsored wallets were mostly first funded by the seeds' own funder, when that funder is narrow and unlabelled (`role_split`: at least 3 of up to 6 read, and half), one operator funding from one address and paying gas from another. `format: mermaid\|graph_json\|csv` draws the clusters |
| `analyze_multisig` | For a multisig wallet, which committee keys are actually live and which have never signed, across its history. The committee is fixed for the life of the address; only who signs varies. A key written by hand, which nobody can sign with, is marked `unsignable` and the threshold restated in `effective_committee` |
| `find_shared_multisig` | Given addresses you suspect are related, derive every committee they could form and find the multisig they jointly control — a hit is proof, since the address IS the hash of its committee |
| `check_coin_restrictions` | Read a regulated coin's on-chain deny list — which addresses its issuer froze, or which of every deny-listed coin type an address is frozen for. Chain-derived: it is the issuer's own decision, reversible by whoever holds the DenyCap |
| `save_finding` | Record a conclusion against a named case, so an investigation outlives its session |
| `list_findings` | List findings in a case, or every case with its count |
| `export_case` | Render a case as a Markdown report, grouped by evidence tier, highest-confidence findings first within each. `format: mermaid` appends a fund-flow diagram of the transfers in the findings' transactions, with value drained from or paid into protocols' shared objects drawn against the protocol; `graph_json` and `csv` export the diagram or the findings |
| `delete_finding` | Retract a finding that turned out to be wrong |
| `aggregate_events` | Rank wallets or event types by activity/value over a time window — "top wallets on this protocol today" in one call. `group_pnl` ranks the senders of the matched transactions by their own balance changes per coin and in USD, and marks PTBs that also called other protocols. Each sender's coins keep what fits about 1.5k characters, largest USD first, and `detail: "full"` lists them all; with a `module` filter, `pnl.scope_note` says that calls through the lineage's other versions are not in the P&L |
| `build_timeline` | Merge multiple addresses' activity into one checkpoint-ordered, protocol-decoded timeline. ISO `from`/`to` are resolved to the checkpoints stamped inside the window; `coverage` reports per address whether `per_address` cut the walk short and where to continue. `subject_flow` gives each involved address's own signed balance change, keyed by address; `token_flow` is the sender's, given when the sender is not tracked. Entries fit about 35k characters in order, keeping failed entries and entries two tracked addresses took part in; `detail: "full"` lists all |
| `trace_object_history` | Object provenance: version history + ownership transitions (who created/held an object when), including a deleted or wrapped object (`end` names the transaction and kind) and a capability mutated on every privileged call (a checkpoint search reaches a distant transition without paging through every version). `order: "newest"` pages back from the current version; `next_cursor`/`next_call` continue either direction. A kiosk-held item's owner reports `kind: "object"` with `kiosk_cap_holder` naming who controls the kiosk |
| `get_upgrade_history` | Upgrade governance across a package lineage: per version the publish tx, sender, signing scheme (single key or multisig with threshold and signers) and UpgradeCap holder. Flags cap round trips around an upgrade, single-key upgrades of a multisig-held cap, policy changes and a destroyed or wrapped cap. `as_of` answers who held upgrade authority at a moment and which version was newest, with the dependency versions that version ran. `find_redeploys: true` also looks for other lineages carrying the same module code (a redeploy, not an upgrade) among those whose UpgradeCap the publisher or the current cap holder holds, and returns `module_origins`, the earliest lineage with each module's code, and `function_origins`, functions whose code (compared function by function) predates their module's origin |
| `manage_labels` | Address-label registry (exchanges, bridges, mixers, malicious wallets) used by the tracing tools. The shipped set holds first-party disclosed labels and, below them, exchange deposit addresses inferred from their sweeps into a disclosed exchange wallet (`source: inferred`, evidence `sweep-pattern`, sweep digests in `inferred_from`; `npm run sync:labels` regenerates them). `list` counts every label by category and source and lists the labels added here first, then what fits about 30k characters; `detail: "full"` lists all |
| `diff_package_upgrade` | Diff two package versions to detect malicious upgrades / backdoors |

## License

[MIT](LICENSE)
