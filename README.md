# sui-mcp

[![CI](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml)

Read-only MCP server for **investigating activity on Sui**. Trace where funds went, attribute wallets to their funding sources, rank addresses by protocol flow, work out who can actually sign for a multisig treasury, and tell a coordinated cluster from a crowd, then reconstruct it all on a timeline.

68 tools. It also covers the ordinary things: wallet overviews, DeFi positions, NFTs, prices and Move package analysis.

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

**See which keys are actually used.** The committee is fixed by the address, but who signs varies per transaction. `analyze_multisig` reads that across the wallet's history.

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
    aliases_note: each of these can move the wallet's funds
```

An alias is control read from chain state, so you may write that the address can
authorize for the wallet. It is not evidence of shared ownership, since a
custodian holds authority for a client. The set is mutable, so it is true as of
the read. Most wallets have never enabled the feature, so the field is usually
absent.

**Clustering.** `build_wallet_edges` emits a `co_signer` edge for any key that can spend a wallet on its own, and marks clusters built only from those `chain-derived` rather than `heuristic`. Keys sitting on more committees than the limit are treated as custody or wallet-provider keys and listed under `excluded_co_signers` instead of linking everyone who uses that provider.

**Limits, also stated in the tool output.** Member order is part of the address, so `find_shared_multisig` is factorial in committee size and refuses past five keys; it covers equal-weight committees only, so a nil result is not a negative finding. A wallet that has never sent a transaction cannot be classified at all, because it has produced no signature. It comes back as unknown rather than as an ordinary wallet.

zkLogin and passkey wallets go through the same path. zkLogin reports its OAuth issuer, which is all the chain discloses about the account.

## What a result tells you about itself

Several tools qualify their own answers rather than returning a number that
looks more certain than it is.

**Is this coin the one you meant?** A symbol is not an identifier on Sui. 8,008
mainnet coins share one with another, and imitators are named to be mistaken.
`analyze_token` reports `verified`, and every balance change in a trace carries
`coin_verified`:

```
-850 MAGMA (unverified, assumed scale)     coin_verified=false
+202.361728 USDC                           coin_verified=true
```

These are two separate marks. `unverified` refers to which coin it is.
`assumed scale` refers to whether the amount is right: decimals for an unknown
coin are a guess, and 47 of 289 imitators declare a different scale from the
coin they imitate.

An ambiguous symbol returns candidates rather than a coin. `USDC` matches seven
legitimate verified coins on Sui (Circle's, Wormhole's, Celer's), so picking one
would misreport which asset moved.

**Why did it fail?** `get_transaction` returns the abort code with the package,
module and function that raised it, and a clever error's constant name where the
author defined one.

**Who deployed this, and can they still change it?** `analyze_package` and
`identify_address` report `publisher`, the address that created the package,
attributed to the lineage root. The UpgradeCap carries `holder_status`:
`burned` means upgrade rights were renounced, which *reduces* risk, and is what
27 of every 30 departing caps did.

**Has an issuer frozen this address?** `check_coin_restrictions` reads the
on-chain deny list in both directions. A frozen address usually holds none of
the coin that froze it, so it checks every configured coin type rather than the
ones it holds.

**What moved that was not a coin?** `trace_funds` reports `object_flow`.
Sui is object-based, so a balance change only covers `Coin<T>`. An NFT, a
Kiosk or a capability changes hands without producing one:

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
| `sink_reached` | a counterparty carries a sink label |
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

`collection_type` narrows the result, but only for marketplaces that name the
collection in the event, which most do not: in one measured window 70 of 73
sales carried no collection type at all. Those are counted in
`unattributable_sales` rather than filtered out quietly, so a small number of
matches is never mistaken for a collection that did not trade.

**Are these really the top holders?** Only when `complete_ranking` is true.
`get_top_holders` walks coin objects in object-id order, which is unrelated to
balance. A scan that stops early returns the largest holder it happened to see.
On SUI the reported top holder goes from 66 SUI at `max_scan` 200 to 3,454 at
800, with no overlap in the top five. A truncated scan therefore returns
`sampled_holders`, without a rank or a percentage of supply, along with a
caveat. Raise `max_scan` until `truncated` is false to get a real ranking; that
is only practical for coins with few enough objects to enumerate.
`analyze_token` reports the same distinction.

**Is this address the one it looks like?** `get_transaction_history` and
`trace_funds` compare every address they touch and report `address_poisoning`
when two of them are close enough to be mistaken for one another:

```
⚠ Addresses in this trace close enough to be mistaken for one another:
  0xd649a4d5…57127127  vs  0xd642ef27…c75d7127
```

An attacker generates an address sharing the leading and trailing characters of
one you already deal with, sends dust from it, and waits for someone to copy the
wrong row out of their own history. The check covers senders, balance-change
recipients and the branches a trace declined to follow. A poisoning wallet sends
rather than receives, so it never shows up as a counterparty, and the lookalike
is usually several hops from the address it imitates.

A pair is reported when at least three characters match at each end, roughly one
collision in seventeen million pairs by chance. The two addresses do not render
identically at every width; they match at both ends, which is enough to fool a
glance or a short truncation.

The address with the larger footprint is named as the established side, but only
when the gap is wide enough to support it. Dust repeating inside a single page
is normal for this attack, so a small margin proves nothing. Below that, the
pair is reported with `direction_known: false`.

**Does this address pay other people's gas?** `get_address_fanout` reports
`sponsor_shape`. This is invisible to value fan-out, since sponsoring moves
none of the sponsor's own money. `relayer` is proven; `private_sponsor` off a
truncated scan is flagged provisional, since breadth only grows with the
window.

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

## Tool profiles

All 68 tools loaded at once cost about 14k tokens of context on every request, and a large flat tool list makes models pick the wrong tool. So the server starts with a **core** set of 17 and keeps the rest one call away.

When you ask for something outside the current set, such as "trace where these funds went", the model calls `enable_tools` and the tracing tools appear immediately, with no restart. You never have to pick a profile.

To start with more, set `SUI_TOOLS`:

```json
"env": { "SUI_TOOLS": "core,forensics" }
```

| Profile | Tools | Contents |
|---|---|---|
| `core` *(default)* | 18 | Wallets, balances, transactions (single and batched), tokens, NFTs, DeFi positions, staking, pools, names |
| `forensics` | 30 | Fund tracing, funding-source attribution, cross-chain bridge resolution, wallet-edge clustering, package analysis, control-group sampling, timelines, object provenance, labels, events, oracle-vs-market deviation, live address watching, NFT marketplace sales |
| `developer` | 18 | Move packages, disassembly, decompilation, upgrade diffing, dependency graphs, PTB decoding, unsigned transaction building, Move Registry |
| `market` | 6 | DeepBook order book and fills, pool stats, token search, validators |
| `all` | 59 | Everything |

Runtime switching relies on `notifications/tools/list_changed`. Claude Code and Claude Desktop honour it; some clients cache the tool list and will only see the change after a restart. `SUI_TOOLS` always works, so set it explicitly if your client doesn't refresh.

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
| Network | Public Sui RPC and GraphQL, plus Pyth, Aftermath and the Move Registry for prices and name resolution. Hosts are listed in [`src/config.ts`](src/config.ts). |
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

- **Per-call network** — every tool takes an optional `network` arg (`mainnet` / `testnet` / `devnet`); query multiple networks in one session (e.g. compare a testnet value to mainnet). `SUI_NETWORK` sets only the default.
- **Protocol-aware** — decodes transactions from Cetus, Suilend, NAVI, Scallop, Bluefin, DeepBook, and more into human-readable actions
- **Incident investigation** — labeled fund tracing, batch funding attribution with fan-out controls, multi-address timelines, object provenance, PTB anomaly triage, oracle-vs-market deviation
- **Multisig** — a Sui address is the hash of its authenticator, so the committee is read off the address itself. Names every member, says which keys are live and which have never signed, and shows who signed a given transaction. Also handles zkLogin and passkey wallets
- **Move package analysis** — disassembly, heuristic risk scan, capability audit, publisher attribution, upgrade-cap holder status, and upgrade diffing, none of which need an external binary
- **Asset verification** — a curated coin registry, so a trace says whether the asset it followed is the real one rather than an imitator wearing its symbol
- **Multi-source architecture** — gRPC for low-latency reads, GraphQL for filtered queries, archive node fallback for historical data
- **Price aggregation** — Aftermath Finance, Pyth oracles, and CoinGecko in a single unified interface
- **Kiosk-aware** — resolves NFT ownership through Sui's kiosk system to actual wallet addresses
- **Move Registry (MVR)** — resolves names like `@deepbook/core` to package addresses, and back

## Configuration

All environment variables are optional. See [`.env.example`](.env.example) for the full list; the common ones are `SUI_NETWORK` (default network), `SUI_FULLNODE_URL` / `SUI_GRAPHQL_URL` (custom RPC endpoints), and `SUI_LABELS_FILE` (address attribution labels for fund tracing).

### Price sources

Current USD prices come from **Aftermath**, which is free and needs no key. That is the default path, and it covers everything except historical pricing.

Two paid sources are opt-in and engage only when their key is set, so nobody is billed by accident and nothing degrades if you set neither:

| Variable | Enables |
|---|---|
| `PYTH_API_KEY` | Historical prices (`get_token_prices` with `at`), oracle-vs-market comparison. Pyth's Hermes endpoint began requiring authentication for price *values*; feed discovery is still open. |
| `CMC_API_KEY` | CoinMarketCap as an additional current-price source. Note it keys on ticker symbols, which are not unique on-chain, so it is only consulted for symbols already mapped to a coin type. |

Without a key, tools that need a paid source say so explicitly rather than returning a null price. A missing price and a price of zero mean different things.

### Optional local store

Set `SUI_STORE_PATH` to keep address labels and fan-out measurements across sessions. It uses Node's built-in `node:sqlite`, so it adds no dependency and no native build. It is unset by default, and nothing is written to disk unless you set it. An investigation store is a record of which addresses you looked at, so that default is deliberate.

```json
"env": { "SUI_STORE_PATH": "/Users/you/.local/share/sui-mcp/store.db" }
```

Fund traces are not cached. A trace depends on your label set, so a stored result would disagree with a fresh run as soon as a label changed.

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

64 of the 68 tools need nothing beyond the install above. Only `decompile_module` requires an external binary, and there are lighter options to try first:

- `disassemble_module` returns Move bytecode assembly via the GraphQL endpoint.
- `analyze_package` summarizes a package's API and runs a heuristic risk scan.
- `diff_package_upgrade` diffs two versions of a package.

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

Without `SUI_DECOMPILER_PATH` the server falls back to looking for `move-decompiler` on `PATH`. Prefer the absolute path: desktop clients often launch servers with a minimal environment that doesn't include your shell's `PATH`, so a binary you can run in a terminal may still be invisible to the server. If it's found in neither place, `decompile_module` returns an error explaining how to fix it, and the other 56 tools are unaffected.

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

## Tools (68)

### Recommended Starting Points

| Tool | Description |
|---|---|
| `identify_address` | Identify what a Sui address is: wallet, package, validator, or object |
| `get_wallet_overview` | Comprehensive wallet overview: balances, SuiNS name, staking, kiosks, recent txs |
| `get_transaction_history` | Decoded activity feed with protocol names and human-readable actions |
| `analyze_token` | Full token analysis: metadata, price, 24h change, supply, top holders |

### Chain & Network

| Tool | Description |
|---|---|
| `get_chain_info` | Current chain ID, epoch, checkpoint height, timestamp, gas price |
| `get_checkpoint` | Checkpoint details by sequence number or digest |

### Objects

| Tool | Description |
|---|---|
| `get_object` | Object by ID with type, owner, JSON content, and display metadata |
| `list_owned_objects` | List objects owned by an address with optional type filter |
| `list_dynamic_fields` | Dynamic fields of an object (tables, kiosk contents, etc.) |

### Coins & Tokens

| Tool | Description |
|---|---|
| `get_balance` | Balance of a coin type for an address (defaults to SUI) |
| `get_coin_info` | Token metadata: name, symbol, decimals, description, supply |
| `search_token` | Search tokens by name/symbol, with Aftermath Finance fallback |
| `get_token_prices` | USD prices for tokens — current (Aftermath + Pyth), or historical via Pyth when `at` is set |

### Transactions & Events

| Tool | Description |
|---|---|
| `get_transactions` | Reads up to 50 transactions in ONE call given their digests — sender, timing, balance changes, Move calls, and events with decoded fields. Ten digests go from ten round trips to one. Malformed digests are rejected before the request, because the server refuses a whole batch over one bad key |
| `get_transaction` | Transaction by digest with protocol-decoded actions |
| `query_transactions` | Filter transactions by sender, address, object, or function |
| `query_events` | Filter events by type, sender, module, or checkpoint range |

### DeFi

| Tool | Description |
|---|---|
| `get_defi_positions` | DeFi positions across Suilend, Cetus, NAVI, Scallop, Bluefin, Bucket |
| `find_pools` | Discover liquidity pools by token pair (Cetus, DeepBook, Turbos) |
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
| `list_nfts` | List NFTs owned by a wallet, including kiosk-stored NFTs |
| `list_nft_collections` | Lightweight collection summary with counts |
| `get_top_holders` | Holders of an NFT collection or token — a ranking only when the scan completes |

### Staking

| Tool | Description |
|---|---|
| `get_validators` | List validators (stake, commission, voting power), or full detail for one when `address` is set |
| `get_staking_summary` | Wallet's staking positions and pools |

### Names

| Tool | Description |
|---|---|
| `resolve_name` | SuiNS name resolution (forward and reverse) |

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
| `get_package` | Move package modules, structs (with ordered fields), and functions |
| `get_move_function` | Specific Move function signature and parameters |
| `get_package_dependency_graph` | Package dependency analysis with recursive traversal |
| `analyze_package` | Summarize a package's API + heuristic risk scan (no binary; accepts 0x id or MVR name) |
| `disassemble_module` | Disassemble Move bytecode via GraphQL (no binary; accepts 0x id or MVR name) |
| `decompile_module` | Decompile Move bytecode to source (requires decompiler binary) |
| `diff_package_upgrade` | (Security) Diff two package versions to spot what an upgrade changed — malicious-upgrade / backdoor detection |

### Transaction Building

| Tool | Description |
|---|---|
| `build_transfer` | Build an unsigned transfer of SUI or any coin (auto coin selection); returns BCS for `simulate_transaction` |
| `build_staking` | Build an unsigned stake/unstake transaction (`action: stake\|unstake`) |
| `simulate_transaction` | Dry-run a transaction to preview effects and gas cost |

### Advanced

| Tool | Description |
|---|---|
| `decode_ptb` | Decode a Programmable Transaction Block from BCS bytes |
| `check_activity` | Monitor address or object for new activity since a checkpoint |

### Incident Investigation

| Tool | Description |
|---|---|
| `trace_funds` | Swap-aware, USD-valued multi-hop fund tracing that stops at labeled sinks (forward or backward) |
| `resolve_bridge_transfer` | Follow funds across a bridge, in either direction. Resolves **Wormhole** (VAA identity `(emitter chain, emitter address, sequence)`), **Sui's native bridge** and **Circle CCTP** — the latter two carry the destination chain and recipient in their own events, so their far side needs no indexer at all. Detects **Mayan MCTP** and any package the registry types as a bridge. Inbound claims resolve to their origin chain and transfer id rather than being mistaken for exits. Every result is tiered: `chain-derived` trusts nobody, `indexer-attested` is a lead to confirm |
| `find_funding_source` | Walk an address back to its funding source(s) for attribution; stops at labeled exchanges/bridges |
| `find_funding_sources` | Same, for up to 100 addresses in one call — shares work across converging chains, reports shared funders with flow shape, addresses paid by one transaction (weighed against that transaction's full recipient count), subjects that funded each other, and sub-minute funding bursts |
| `sample_control_addresses` | Draw a random, reproducible control group from the same protocol and window, so a cohort's rate can be compared against chance |
| `resolve_protocol_packages` | Find which of a protocol's package versions are actually emitting now — the bundled registry is a decode map full of historical IDs, and querying one returns nothing |
| `get_address_fanout` | How many distinct addresses a funder pays. Tells an exchange hot wallet apart from a real common origin |
| `build_wallet_edges` | Finds addresses that may share an operator with the ones you give it, and shows the evidence. Multisig co-signature (read from the address hash, not inferred), shared first funder, direct funding, shared gas sponsor, or a third party paying both. Exchanges and relayers are measured and discarded first |
| `analyze_multisig` | For a multisig wallet, which committee keys are actually live and which have never signed, across its history. The committee is fixed for the life of the address; only who signs varies |
| `find_shared_multisig` | Given addresses you suspect are related, derive every committee they could form and find the multisig they jointly control — a hit is proof, since the address IS the hash of its committee |
| `check_coin_restrictions` | Read a regulated coin's on-chain deny list — which addresses its issuer froze, or whether a given address is frozen for the coins it holds. Chain-derived: it is the issuer's own decision, reversible by whoever holds the DenyCap |
| `save_finding` | Record a conclusion against a named case, so an investigation outlives its session |
| `list_findings` | List findings in a case, or every case with its count |
| `export_case` | Render a case as a Markdown report, highest-confidence findings first |
| `delete_finding` | Retract a finding that turned out to be wrong |
| `aggregate_events` | Rank wallets or event types by activity/value over a time window — "top wallets on this protocol today" in one call |
| `build_timeline` | Merge multiple addresses' activity into one checkpoint-ordered, protocol-decoded timeline |
| `trace_object_history` | Object provenance: version history + ownership transitions (who created/held an object when) |
| `manage_labels` | Address-label registry (exchanges, bridges, mixers, malicious wallets) used by the tracing tools |
| `diff_package_upgrade` | Diff two package versions to detect malicious upgrades / backdoors |

## License

[MIT](LICENSE)
