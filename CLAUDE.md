# sui-mcp

MCP server for querying the Sui blockchain over stdio.

## Stack

- TypeScript (ES2022, NodeNext modules, strict mode)
- `@mysten/sui` gRPC client + `graphql-request` for filtered queries
- `@modelcontextprotocol/sdk` for MCP server framework
- `zod` for input validation
- `vitest` for tests

## Architecture

```
src/
├── index.ts              # MCP server entry point (stdio transport)
├── config.ts             # Network endpoints, constants
├── clients/              # gRPC + GraphQL client setup
├── tools/                # One file per tool category (76 tools total)
├── protocols/            # Protocol registry for tx decoding
├── data/                 # Static JSON data (token registry, etc.)
├── utils/                # Shared helpers (formatting, SuiNS, etc.)
├── discovery.ts          # Token discovery (static + Aftermath fallback)
├── discovery-nft.ts      # NFT collection discovery
├── prompts.ts            # MCP prompts (task + forensics skill sections)
└── resources.ts          # MCP resources (chain reads, sui://case/{name}, sui://results/{id})
```

Per-call network selection. `SUI_NETWORK` sets only the *default* (mainnet if
unset); every tool also takes an optional `network` arg ("mainnet" | "testnet"
| "devnet"), so a single session can query multiple networks (e.g. compare a
testnet value to mainnet).

- `src/tools/with-network.ts` wraps `server.tool` once: it injects the `network`
  arg into every chain tool's schema, runs each handler inside
  `runWithNetwork(network)` (an `AsyncLocalStorage` context in `config.ts`), and
  registers the tool through `registerTool` with the metadata from
  `src/tools/tool-meta.ts` (see Tool metadata below). Individual tool files are
  untouched.
- `sui` / `archive` (grpc) and `gqlQuery` (graphql) are **proxies** over
  per-network client caches (`getClients`, `getGraphqlClient`). They re-resolve
  against `getNetwork()` on every access, so the same imported reference targets
  whichever network the active call selected. Clients are built lazily and cached
  per network. `getNetwork()` reads the async context, falling back to the default.
- Never use JSON-RPC. Fullnode JSON-RPC is deprecated/removed; all on-chain reads
  go through gRPC (`@mysten/sui/grpc`) or GraphQL. `@mysten/sui/client` may only be
  imported for types (`import type`), never as a runtime client.

### Which transport to use

Pick by the *shape of the read*, not by preference:

| Read shape | Transport | Why |
|---|---|---|
| Point lookup by key (object ID, tx digest, checkpoint, epoch, package) | **gRPC** (`sui`) | `ledgerService` is get-by-key and lower latency; there is no filter API to need. |
| Filtered or paginated set (txs by sender, events by type, holders, NFTs) | **GraphQL** (`gqlQuery`) | Only GraphQL exposes filter arguments and cursors. Max page size is 50. |
| Anything historical enough to be pruned | **gRPC via `withArchiveFallback`** | See below. |
| Non-Sui service (Aftermath, Pyth, MVR) | `fetch` + `EXTERNAL_HTTP_TIMEOUT_MS` | `fetch` has no default timeout; always pass the shared one. |

If both transports could serve a read, prefer gRPC — GraphQL's 50-item page cap
turns anything list-shaped into a pagination loop.

GraphQL `package(address:)` answers with the **lineage's latest version**,
whichever version's address you pass: Nemo v1 (`0x2b71…`) and v5 (`0xef9c…`)
both come back as v12. For one version's bytes read
`object(address:) { asMovePackage }` (`fetchModuleDisassembly`,
`fetchAllModuleDisassembly`, `fetchModuleNames`, `fetchPackageLinkage`) or
`package { packageAt(version:) }` (`diff_package_upgrade`).
gRPC reads by object ID and is exact. `MovePackageService.GetPackage`
returns `linkage` empty; `get_package` reads the table from the package object
with a `package.linkage` read mask, as `get_package_dependency_graph` does.

### Archive fallback

`archive` exists on **mainnet and testnet**; devnet has none, so `getClients()`
returns the fullnode client under both names there.

The archives speak **native gRPC over TLS, not gRPC-Web**, so `NetworkConfig.archive`
is a `host:port` target for `GrpcTransport`, not an `https://` URL like the other
endpoints. That inconsistency is load-bearing: a gRPC-Web client aimed at
`https://archive.mainnet.sui.io` gets a 404. Don't "fix" it.

The public GraphQL service sometimes answers a list query with the GraphQL
error "Failed to list transactions" or "Failed to list events" on an HTTP
200; the same query succeeds on retry. `gqlQuery` retries those exact
messages twice with backoff
(`TRANSIENT_GRAPHQL_ERRORS`); every other GraphQL error is an answer about
the query and is not retried.

Do not hand-roll the fallback. Use `withArchiveFallback(call, isEmpty)` from
`src/utils/archive-fallback.ts`.

Pruned and nonexistent data both surface as a gRPC **`NOT_FOUND` throw**, not as
an empty response — verified against mainnet for `getObject`, `getTransaction`,
`getCheckpoint` and `getEpoch`. The throw path is therefore the one that matters.
The `isEmpty` predicate guards the other shape (a response missing the field the
caller needs); no probe has made it fire, so keep it narrow and don't design
around it. Skipping the fallback entirely on devnet is deliberate — `archive` is
the fullnode there.

## Reading many transactions

`get_transactions` (`src/utils/multi-tx.ts`) reads up to 50 digests in one
`multiGetTransactions` call. Measured on ten digests: 0.80s sequentially, 0.10s
batched — but the latency is the smaller half. Ten tool calls becoming one saves
ten model turns, and that is the reason it exists.

One query carries sender, status, timing, balance changes, Move call targets and
events with decoded fields, so protocols are identified from both calls and
events without a second request.

Two rules:

- **Digests are decoded before the request.** The server rejects the WHOLE batch
  over one malformed key, so a single typo among fifty returned nothing at all.
  The Base58 alphabet alone is not enough — 44 `1`s is valid Base58 and decodes
  to 44 zero bytes — so validation is `fromBase58(d).length === 32`.
- **Events are a page, not the whole set.** Paging every transaction in a batch
  to exhaustion would put fifty digests back into dozens of requests. A
  transaction with more events says so and names `get_transaction`, which pages
  to the end. Breadth here, depth there, and the boundary is stated rather than
  silently applied. Balance changes and commands are NOT a page here: they are
  completed (below), because protocols and flows are concluded from them.

A null entry is positional: it means that digest returned nothing, which is a
wrong digest or a pruned transaction and the two are indistinguishable at this
layer. `get_transaction` falls back to the archive; this does not.

## Nested connections are pages

`TransactionEffects.balanceChanges`, `ProgrammableTransaction.commands` and
`TransactionEffects.events` are GraphQL connections. Selected without `first:`
they return the service's default page of **20** (max 50) and say nothing about
the rest unless `pageInfo` is selected. FujboNeQt8Nbb… has 202 balance changes;
every GraphQL read of it saw 20, and the payer's debit, sorting past row 20,
was missing from history, traces, funding and fan-out alike.

- **Select them through `src/utils/tx-connections.ts`.**
  `BALANCE_CHANGES_SELECTION` / `COMMANDS_SELECTION` ask for 50 with `pageInfo`,
  and `completeTxConnections` (a page of transactions) or `readAllBalanceChanges`
  / `readAllCommands` (one) page the rest by digest. A transaction under 50 rows
  costs nothing extra; the transaction node must select `digest`.
- **A failed continuation is `truncated`, never a short list.** Surface it
  (`incomplete_transactions`, `balance_changes_truncated`, a watch hit's
  `incomplete`) or refuse the conclusion, as `countTxRecipients` does by
  returning null rather than an understated recipient count.
- **Metered callers charge the follow-ups.** `CompletedTx.reads` counts them;
  `edge-probe.ts` charges them to its `Budget`, `watch-probe.ts` to `requests`.
- `objectChanges` defaults to 1,024 per page; `trace-read.ts` pages it and
  `watch-probe.ts` flags `object_changes_truncated`. Events of one transaction
  are paged by `event-json.ts`.

The service also caps a query document at 5,000 bytes, 300 query nodes and 21
aliased connections, which is why the selections are compact strings and
aliased batches stay at 20.

## Lists start at the newest row

GraphQL's `first`/`after` returns the OLDEST rows. A list tool that pages with
it shows an established address as it was years ago: `recent_transactions`
listed a wallet's first five transactions, and the address-poisoning check ran
over the oldest page, where recent dust never is. `get_transaction_history`,
`query_transactions` and `query_events` default to `order: "newest"` through
`orderedPageArgs` / `orderedPage` in `src/utils/pagination.ts`: `last`/`before`,
each page reversed for display, `next_cursor` going back as `cursor` with the
same `order`, and every page echoing `order`, `oldest_shown` and
`newest_shown`. Selecting `BOTH_WAYS_PAGE_INFO` is required, since the newest
walk continues on `hasPreviousPage` / `startCursor`.

Forward walks remain where the question is "since X": first funding,
`trace_funds` forward, `check_activity` with a baseline, `poll_watch`, and
`build_timeline` with `from`. Anything else asking "what is this address doing"
walks back, as `measureFanout` does.

## Time windows go into the filter

A window is applied as `afterCheckpoint` / `beforeCheckpoint`, never by
filtering timestamps after fetching. Filtered afterwards, a window applies to
whatever the first page held: `build_timeline` over one day of an address
active since 2023 returned nothing, and its `activity_hours` described 2023.

- **`resolveWindow` / `toFilterBound`** (`src/utils/checkpoint-time.ts`) turn an
  ISO edge into the exclusive checkpoint the filter takes, using
  `checkpointBracket`, which refines to two ADJACENT checkpoints either side of
  the time. `toCheckpoint` stops within a minute, which is fine for a point
  and wrong for an edge: a minute is a third of a three-minute incident
  window. Both edges are inclusive in time.
- **Parse before probing.** An unparseable bound is an error before any
  request, never a silently unbounded read.
- **A budget that stops a walk says where.** `build_timeline` reports per
  address `truncated`, `reached_checkpoint` and a `continue_with` bound that
  re-reads the boundary checkpoint, since other transactions of that address
  may sit in it.

### A past balance is reconstructed from one anchor

`address(atCheckpoint:).balance` answers only inside the consistent range
(`serviceConfig.availableRange(type: "Address", field: "balance")`, about an
hour). Older points are reconstructed in `src/utils/historical-balance.ts`:
the balance at an anchor A minus the owner's changes in every transaction in
checkpoints (C, A].

- **Both reads use the same A.** The balance is read with `atCheckpoint: A`
  and the scan filter stops at `beforeCheckpoint: A + 1`. Reading "now" twice
  lets a transaction landing between the reads count on one side only. A sits
  a few checkpoints below the range's newest end, because the anchored read is
  a separate request and may reach a replica that is slightly behind.
- **No partial sum is a balance.** A budget stop, a transaction whose balance
  changes could not all be read, or a negative result gives `balance: null`
  and `complete: false`, with `reached_checkpoint` saying how far back the
  scan got.
- **`affectedAddress` is the complete set.** It includes every owner of a
  balance change, an object id with an address-balance deposit included
  (verified on `BkxPKc7F…`, +4 SUI into a StakedSui's address balance).
  Balance changes net coins and the address balance, so a reconstructed point
  has no coin/address split; report null, never zero.

## A package ID names one version

A Sui upgrade mints a new package ID, and filters bind to one version, but
which rule applies depends on whether the filter reaches an EVENT or a
TRANSACTION:

- **An event's type carries the DEFINING package**, the version that
  introduced the struct. DeepBook margin's `LiquidationEvent` queried at the
  latest ID returned nothing and at the original returned the liquidations.
  `resolveEventTypeFilter` (`src/utils/package-versions.ts`) reads
  `typeOrigins` and rewrites an `event_type` filter; a module- or
  package-level type spanning several defining IDs keeps one and lists the
  rest as `event_type_resolution`.
- **An event's emitting module carries whichever id the checkpoint's era
  used**, not a fixed rewrite. `relocate_event_module` turned on at a
  different checkpoint on each network, read from each epoch's protocol
  config: mainnet 69,982,635 (2024-10-17, epoch 554, protocol 60 -> 63),
  testnet 118,397,835 (2024-10-09, epoch 518, protocol 60 -> 62), and devnet
  at genesis (it is wiped regularly and its genesis protocol has the flag).
  Before it, a module's runtime linkage was anchored to the package's
  ORIGINAL id for the life of the lineage regardless of which version was
  called or whether the module defines any types of its own. KONG SUI's
  sellers called Turbos v9's `swap_router`, a pure router module with no
  event structs, and its (pre-cutover) events still carried
  `transactionModule` v1. From the cutover on, an event carries the id of the
  version that was actually CALLED, and a filter rewritten to the original id
  matches nothing. `resolveModuleEventFilter`
  (`src/utils/package-versions.ts`) reads the cutover for `getNetwork()`,
  takes the caller's resolved window and returns one segment (original id for
  a window entirely before the cutover, the requested id unchanged for one
  entirely at or after it) or two, when the window holds checkpoints on both
  sides: `query_events`, `aggregate_events` and `sample_control_addresses`
  query each segment and merge, reporting the split as `module_scope`. Keyed
  to mainnet's checkpoint, a testnet window between the two cutovers was
  queried at the called version and came back empty (Supra
  `price_data_pull_v2` v7 around checkpoint 110,000,000). From the cutover
  on, any one id matches calls through that version only, the original id
  included: Turbos `swap_router` queried at its original id over 2025-01-01
  returned nothing while v9 to v12 carried the swaps. A window reaching the
  cutover therefore always gets a `module_scope` whose `other_version_ids`
  lists the rest of the lineage, and an original-id window spanning it stays
  one query, since the same id serves both sides. Only a lineage with one id
  (a single-version package, or a framework package upgraded in place such as
  0x2) passes through without a note, and a lineage that cannot be read is
  passed through with a note saying so.
- **A transaction's `function` filter matches calls through that exact
  version.** The PTB literally names the version it called, so each version
  sees a disjoint share of the calls and a non-empty answer is still partial.
  `versionScopeNote` names the lineage for `query_transactions`; `all_versions`
  reads every version as aliased connections and merges them
  (`src/utils/version-fanout.ts`), with a cursor recording each version's
  position so no call is skipped or repeated across pages. With
  `include_functions`, each row's `matched_calls` counts the calls the filter
  names at its own granularity (function, module or package), through the
  versions read, against `total_calls`.

## Address identity in investigation flows

`src/utils/identity.ts` resolves name, label, kind and historical names for a
whole result set in two batched calls, and `trace_funds`, both funding tools and
`build_wallet_edges` all use it. `identify_address` stays the thorough
single-address tool; it costs about six requests each and cannot run per hop.
For a wallet it adds `first_seen` (`readFirstSeen`): the oldest transaction
`affectedAddress` returns, in one request, with the coins the wallet gained in
it and `first_inflow`, null when its balance changes ran past one page without
a gain for it.

Two things it adds that the flows were missing:

- **What the address is.** A hop that is a package or a shared object is not
  "someone the funds went to", and nothing else in a trace said so. Classified
  by one `multiGetObjects` call — an address with no object at it is a wallet,
  which makes `wallet` a default rather than a positive finding.
- **Names the address used to hold.** Reverse lookup answers only "what is the
  current default name" and returns nothing once a name lapses, so former
  aliases vanish from an investigation. The `SuinsRegistration` object outlives
  expiry, so held registrations are read directly and expired ones are flagged
  rather than dropped. Measured on one wallet: reverse lookup gave 1 name, the
  registrations gave 10, six of them expired.

Holding a registration is not attribution by itself: the NFT is transferable,
and anyone can send one to any address. Each held name carries a `provenance`
read from the registration's `previousTransaction`, fetched in the same
held-names request, so it costs no extra call. An owned object can only be
written by a transaction its owner sent, so a sender other than the holder means
that transaction delivered it and the holder has not touched it since
(`received_from_third_party`, with `received_from`). A name the holder sent the
last write for, or that is its current reverse record (only the address itself
can set that), is its own: the address was known by it. A missing
`previousTransaction` is `unknown`, and must stay unknown rather than defaulting
either way. `classifyHeldNames` is the one place this split is made; the notes
in `identityNote`, `find_funding_sources` and `identify_address` all read it.
Do not reintroduce "was known by" wording for a received name: the Cetus
attacker holds a taunt name `0x407fb974` sent it after validators froze the
wallet.

The registration type is matched at **module** level. A Move type keeps the
package that defined it, so this does not drift on upgrade — the opposite of the
call-target problem the protocol registry solves with lineage roots.

Note `batchResolveNames` is not actually batched: it fans out one gRPC call per
address. Fine at these sizes, but it is not the single request the name suggests.

### An empty transaction is not an empty result

`get_transaction` reports `command_count` and an `object_changes` summary, and
both exist because a real mainnet transaction reported nothing while having
executed. `F7xprc5y7Lmk…` ran zero commands, emitted no events and moved no
coin, so `actions`, `token_flow` and `protocols` were all empty. It had written
an object, and it was one of hundreds fired by a market-making bot to manage a
pool of gas coins.

- **An empty `actions` had more than one cause.** Zero commands and commands
  that would not decode rendered identically, so `command_count` is reported.
  An empty PTB carries `commands` as an EMPTY ARRAY, measured on mainnet. A
  third branch labels a transaction whose kind cannot be read at all, which no
  probe has produced: a pruned or nonexistent digest throws NOT_FOUND and never
  reaches the decode.
- **Do NOT reintroduce a gas-object split.** An earlier version counted
  `effects.gasObject` apart from the rest, reasoning that every transaction
  writes its own gas coin so `changed: 1` means nothing until you know whether
  that object was the gas coin. The premise does not hold, and the number
  behind it is **era-dependent**, so it is recorded with its date: sampled
  2026-09 over 1,191 programmable transactions, roughly three quarters carried
  no `effects.gasObject` at all, while the same query over transactions before
  checkpoint 275,000,000 (May 2026) found none without one. Gas moved to being
  paid from a balance accumulator, and such a transaction has no gas object for
  the split to exclude, so `non_gas_changed` collapsed to `changed`. A
  transaction may also pay with several coins, which smashing deletes and which
  a single-id exclusion counts as real deletions.

  On the empty transaction that motivated the feature the split was correct, so
  do not reintroduce it on the grounds that the motivating case was mishandled.
  It was removed because it answers nothing on the majority of current
  transactions while looking authoritative. Raw counts beside `custodyChanges`
  answer the question without modelling how gas was paid.

  **Any percentage about gas payment needs its era attached.** Two samples of
  43 and 1,191 transactions gave 88% and 74%, and the per-checkpoint standard
  deviation is wide enough that a narrow window reaches either by luck.
- **Read the object changes; they are already paid for.** The `effects` read
  mask already returns `changedObjects`, and `readGrpcObjectChanges` and
  `custodyChanges` already exist for `trace_funds`. This tool simply was not
  calling them, so the deep-dive single-transaction tool saw less than the trace
  did. Pass `lookupProtocol`, not the display resolver: the resolver gates a
  `defi-position` promotion, and `trace-read.ts` passes the curated one.
- **`object_transfers` carries the owner KIND, not a bare address.** A
  kiosk-held NFT is owned by the Kiosk object, so an address alone made a kiosk
  id read as a wallet. Verified on a TradePort sale where both parties were
  kiosks. `trace.ts` renders the same movement as `kiosk/object 0x…` and the
  two tools must not disagree about who a party is.
- **Accumulator writes are not objects.** Effects list every address-balance
  deposit or withdrawal as a `ChangedObject` with `outputState:
  ACCUMULATOR_WRITE` and an `accumulatorWrite`; GraphQL `objectChanges` omits
  them. Counted as objects, `CD2e4GVC…` (redeem 1951 MIST from the sender's
  address balance, `send_funds` it on, gas from the address balance) reported
  `changed: 2` and "none changed hands" while touching no object.
  `summarizeObjectChanges` skips them; `address_balance_ops`,
  `funds_withdrawals` (from the transaction's inputs) and `gas_source` (an
  empty `gasPayment.objects`, or a reference whose digest ends in twenty 0xAC
  bytes, is the address balance) report them instead. All three ride the
  response already fetched.
- **A deleted coin can be a self-sweep.** `34q8kUTe…` deleted a 704,848 SUI gas
  coin and MERGEd it into the same owner's address balance while
  `balance_changes` showed only the -100k payment. A coin deleted from owner X
  plus a deposit of the same type to X is flagged on that deposit
  (`converted_from_coins`), so a large deleted coin does not read as spent.
- **A creation for someone else is not "none changed hands".** `custodyChanges`
  leaves creations out, so Cetus's multisig minting NFTs to both exploiter
  addresses (`8eHgw5hB…`) read as nothing moving. `createdFor` reports objects
  created for an address, object or consensus owner other than the sender as
  `created_for`, and the "none changed hands" note is withheld when there are
  any. Coins are never in either list (balance changes track them), so when
  nothing else moved but an address other than the sender gained coins, the
  note says so and `coins_delivered_to` names them: the Volo drain
  `7pTrudZb…` created its WBTC and XAUm for 0xd763…, not for the sender, and
  used to read as "no object changed custody".

## Completeness beats payload size

Every tool result stays in the model's context for the rest of the
conversation, and Claude Code writes a result over ~50k characters to a file
and shows the model a 2 KB preview unless the tool declares
`_meta['anthropic/maxResultSizeChars']` (500k, Claude Code's ceiling, set in
`tool-meta.ts`). Before caps, `summarize_address_flows` on a busy drainer was
273k characters and `get_transaction` on a 400-NFT airdrop 139k.

### The cap rule

A tool may cap a list in its default view only through
`src/utils/output-cap.ts`, and only under these rules:

1. **Totals, shares, counts, nets and verdicts are computed over every row**
   before any list is cut. A cap shortens a list, never the answer, and a list
   that loses rows keeps its count beside it (`inflow_source_count`,
   `created_for_count`, `balance_change_count`).
2. **Rows are ranked by investigative importance, and flagged rows survive
   any budget**: bridge exits, lookalike and poisoning pairs, failed
   transactions, labelled or non-wallet addresses, capabilities, a subject
   tied to another, the sender's own changes, a pool a flash leg or anomaly
   names, every counterparty whose kind could not be read, and the largest
   values. `summarize_address_flows` classifies every counterparty, not only
   the top ones, before the cap reads `kind`, and ranks unpriced coins and
   unattributed rows ahead of priced dust. Identical rows fold before any
   cap: `analyze_attack_tx` folds swaps of one pool, coins and direction into
   a row with their count, event indices and summed amounts (Nemo's 100
   swaps, 48k characters); a swap whose direction and coins are both unknown
   never folds.
3. **The response says exactly what it left out**: `truncated: true`, and per
   list under `omitted.lists` the count, the USD summed over the priced
   omitted rows with `unpriced` counting the rest, `largest` (by USD) where
   rows carry a value and otherwise `first` (the first omitted row in rank
   order, never called the largest), `entries` for a folded list, and
   `from`, the first omitted index.
4. **Everything omitted is reachable.** `omitted.next_call` is the exact call
   that returns it, usually this call repeated with `detail: "full"`; a list
   another call pages names that call (`decode_ptb` with `command_offset`, or
   `commands: [i, j]`).
5. **With `SUI_STORE_PATH` set, the full result is stored** (`results` table,
   keyed by a 12-hex content hash) and `omitted.result.uri` is
   `sui://results/{id}`. Each list's `page` URI reads it as an MCP resource
   with `omitted=1`, which pages only the rows the response left out (the
   `shown` column records the listed indices, and a folded row covers its
   member entries), so the response plus its pages hold every row exactly
   once. `path`, `offset`, `limit` and `match` page any list, 20k characters
   at most per page. With no store, rules 1 to 4 hold on their own.
   `test/output-cap-property.test.ts` checks all of this over random row
   sets, budgets and orders.

A resource was chosen over a paging tool because a tool definition costs
context on every turn and Claude Code already reads resources
(ReadMcpResource). A client without resource support still reaches every row
through `next_call`.

Measured 2026-09 on the case set, summary view before and after:
`summarize_address_flows` on the Suisses drainer 273k to 29k and on its fee
address 204k to 13k; `get_transaction` on the phishing airdrop 139k to 8k and
on the Cetus recovery (193 coins) 131k to 56k; `list_nfts` on the drainer 69k
to 26k; `find_funding_sources` on KONG's 35 bundle wallets 76k to 46k; `get_transaction` with `detail: "full"` on Nemo's
exploit 463k to 167k, and its default view 98k to 17k once events fold. Half of each saving was lossless: compact JSON (pretty
printing added a quarter), one copy of the payload instead of text plus
`structuredContent`, a reason text named once instead of per row, a cursor
that drops drained kiosks, a first hop that no longer repeats its result's
subject and funder, and a bridge exit's beneficiary without the tier, account
and padded bytes the output already implies, its amount note named once per
source in `amount_notes`.

Measured 2026-09 on the held-out round, before and after: `summarize_incident_losses`
over a meme-coin drainer's 691-transaction window 488k to 33k (776 unpriced
coins were 451k of it), `aggregate_events` with `group_pnl` over the same
drain 425k to 23k (one sender's 776-coin net was 174k), `get_transactions` on
a perpetuals exploit's 17 transactions 163k to 40k, `get_transaction_history`
50 rows 108k to 36k (60k with `detail: "full"`), and `analyze_attack_tx` on
two of the drainer's transactions 51k and 69k to 43k and 46k. A list inside
each row of another list is capped by a path with a list index
(`transactions.3.events`, `pnl.senders.0.net`, `addresses.2.coins`); such
paths go before the path of the list that holds them, whose own cap renumbers
its rows. `capPayload`'s `paged` records the stored indices of a list the
caller narrowed or paged itself, so its `omitted` page skips them too.

`get_transaction`'s full view pages what grows with the PTB. `commands:
[i, j]` narrows the events, the inputs and `object_changes.by_kind` to those
commands (`src/utils/command-attribution.ts`), and `events_omitted`,
`inputs_omitted` and `object_changes_omitted` count the rest with the call
that lists them. An event carries the package and module of the Move call
that emitted it, and commands run in order, so each event's possible
commands are the matching calls between the earliest and latest that keep
emission order; one is exact (`command`), several are neighbouring calls
into one module (`commands`). An object belongs to a command that takes it as
an argument, or, when created, to one that returns its type. Without
`commands`, dynamic fields of one type and version fold into one row with
their `object_ids`. Events page by position, 40k characters a page:
`event_offset` starts a page within the listed events (after any `commands`
narrowing) and `events_page.next_call` carries the next one, so every event
is reachable with the store off. Paging by command could not do that: a
command whose own events passed the budget named itself as the next call and
returned the same page again. Nemo's
exploit with five commands picked went from 141k to 23k and in full from
167k to 110k; Cetus's full view from 126k to 48k (260 tick fields).

### Events fold past 20k characters

`get_transaction` decodes **every** event, and `max_event_field_bytes` (unset
unless a caller asks) is the only thing that rations decoded fields. The 99th
percentile of transactions with events carries 12 KB of decoded fields, so
most lists pass untouched. Past `EVENT_FOLD_BUDGET` (20k characters) the
summary view folds events that differ only in their amounts
(`src/utils/event-fold.ts`): same type, emitting package, module and sender,
and the same fields once every digit string is set aside. Sui renders u64
and wider as digit strings and u8 to u32 as JSON numbers, which are reserve
indices, chain ids and kinds, so a JSON number stays in the key: borrows from
two reserves never sum into one total. A boolean is a field too, so a signed
amount's `positive` keeps opposite signs apart. A folded row keeps every emission index, the shared fields under
`parsed` and each varying field under `varying` with its total, minimum and
maximum; a lone event keeps its own fields and gains `index`. The rows then
go through the cap, keeping every event a non-framework package the
transaction called emitted, and `omitted.folded` states the fold. Nemo's
exploit went from 98k to 17k: its 100 market swaps are one row.

A default view that moves detail behind an argument the response names is
not a cap. `analyze_package` and `get_package` return a per-module summary
(counts, entry and public function names) and compact JSON, because the full
listing of `0x2` is 272k characters; `modules: [...]` or `detail: 'full'`
returns struct shapes and signatures. `analyze_package` folds caps of one type
and ownership into one entry that still lists every object and holder.
`list_nfts` leaves raw Move contents to `detail: 'full'` and counts them under
`omitted`. `find_funding_sources` keeps each result's origin, first funder and
first hop, and `detail: 'full'` returns every hop; shared funders, co-funding
and payments are computed from the full chains either way.

A list row folds repeats: `get_transaction_history` and `build_timeline`
actions and `query_transactions` `move_calls` go through `foldRepeats`, each
distinct entry once with ` ×N`. The Nemo
exploit's 214-command PTBs made a 30-minute `build_timeline` 195k characters.
`get_transaction` keeps every action in order, so the sequence is one call
away. A history or timeline row the subject (or a tracked address) sent
carries `subject_flow` alone: `token_flow`, the sender's side, would repeat
it.

### A PTB's inputs and argument wiring

`get_transaction` with `detail: 'full'` and `decode_ptb` (bytes, or `digest`
for an executed transaction) share one resolver, `src/utils/ptb-resolve.ts`.
It reads the transaction's own BCS (`transaction.bcs`, which the fullnode and
the archive both return), so the two tools print the same `commands` and
`inputs`, and a test holds them equal. Events rarely echo an attacker's
arguments: the Scallop spool exploit passed a dormant sWETH Spool to
`update_points`, which emits nothing, and only the command's argument names it.

- **Pure values are decoded with the declared type.** The called function's
  signature comes from `getMoveFunction` (cached per network and target; a
  failed read is not cached), with the call's type arguments substituted.
  SplitCoins amounts are u64, a TransferObjects recipient is an address, and a
  MakeMoveVec element has the vector's type. Bytes that are not exactly one
  value of that type stay as `bytes`; a signature that cannot be read is named
  in `signatures_unavailable`. An address-typed value sits under `address`,
  the key `flagPtbAnomalies` reads a recipient from, and an untyped 32-byte
  pure keeps the address-shaped guess there. A `u64`, `u128` or `u256` with
  its top bit set also carries `signed_value`, its two's-complement reading
  (`src/utils/signed-int.ts`): signed quantities (an `ifixed` fee) travel in
  unsigned integers. `get_transaction` gives an event field in the top half
  of the `u256` range the same reading under `signed_readings`; a `u128` in
  its top half can be a wrapping accumulator, so it gets none there.
- **Versions come from the effects.** An owned or receiving input carries its
  version in the bytes. A shared input carries only its initial shared
  version; the version read is the changed object's input version or the
  unchanged consensus object's version. Types come from the effects, and the
  object set (`objects.objects.*` in the read mask) fills an immutable input's.
- **An argument is short; the input list is full.** An object argument carries
  its id, version and `module::Name` type; `inputs[index]` has the full type,
  initial shared version and mutability. A Result names `module::function`,
  and the producing Move call lists its declared `returns`. Repeating full
  types in every argument made Nemo's 214-command PTB 570k characters.
- **`object_changes.by_kind` partitions the counts.** Created and deleted match
  `created` and `deleted`, and every group together matches `changed`;
  accumulator writes are excluded from both.
- **Commands are paged at 30k characters.** With commands listed the JSON is
  compact. A first page lists every command when they fit
  `COMMAND_PAGE_BUDGET`; when they do not, the commands an anomaly names
  (each `PtbAnomaly.commands`; the most severe flag first, and among equals
  the one naming the fewest commands) go first, then Move calls into
  non-framework packages, then the plumbing, each in index order while they
  fit. `analyze_attack_tx` gives the `decode_ptb` call that lists the 20
  most severe commands its medium and high flags name (`flagged_commands`).
  `commands_omitted` gives the exact index ranges left out. A continuation
  (`decode_ptb` with `command_offset`) lists commands in index order from the
  offset, so it always advances and every command is reachable with the
  store off; it repeats any command the ranked first page already listed.
  Ranking a continuation too returned the same page forever once the first
  omitted command was plumbing. `commands: [i, j]` on either tool lists
  exactly those commands. Each command carries its `index`, so a
  page with gaps never renumbers. Nemo's exploit `19Zkat1x…` returned all 214
  commands in 463k characters; its first page is now 167k, of which 85k is
  events, and `commands: [203, 204]` is 138k.

### PTB anomaly triage

`flagPtbAnomalies` (`src/utils/ptb-anomalies.ts`) is one pass for both
`decode_ptb` and `analyze_attack_tx`, over the commands and inputs
`resolvePtb` returns. `analyze_attack_tx` resolves the transaction's own BCS
(`AttackTx.bcs`) and passes the same sender, blocklist and trust as
`decode_ptb`, so a payout or blocklisted call flags in both tools.

- **Naming is not trust.** `unverified-package-call` asks
  `lookupPackageTrust` (`src/protocols/registry.ts`): the curated registry
  (exact ID or lineage), or a called version whose own publisher also signed a
  version of a curated lineage (`custody.signers`, tier 4 below). A Move
  Registry name or any other display name never counts. A publisher match
  reports `unregistered-package-lineage` at info instead.
- **Unrecognized is graded by value.** `callValues`
  (`src/utils/ptb-value-flow.ts`) marks a call that takes the gas coin, an
  owned or receiving object, a funds withdrawal, or a coin, balance or token
  (declared type, or a SplitCoins/MergeCoins result), or that returns one, or
  that names another address. With effects, a named address counts only when
  it gained. `unverified-package-call` is medium when a call into an
  unrecognized package moves value or another medium or high lead fires, and
  info otherwise. Derived from the negatives: of the 54 ordinary transactions
  it flagged, the 16 left at info call recorders, oracle refreshes and checks
  that take and pay nothing.
- **An executed transaction is graded by round trip.** With effects
  (`effectsPayouts`, gas taken out of its payer's SUI change), value through
  an unrecognized package keeps the flag at medium only when it went one way:
  another address gained what the sender lost, or the sender lost value and
  received no coin or object. A swap, deposit, redeem or trade that returned
  value to the sender reads info, unless another medium or high lead fires,
  including `analyze_attack_tx`'s trade and state leads (`unreconciled-gain`
  covers an attacker contract that profits). Before signing there are no
  effects, so the structural grade stands.
- **Superseded versions.** The lineage read gives the newest versions with the
  checkpoint each was published at, so a call is judged against the versions
  that existed when it ran (bytes not yet signed: now). `stale-package-version`
  is medium when the call writes a mutable shared object whose type its own
  lineage defines and the newest version changed or removed the function it
  ran (`superseded-diff.ts` diffs the module's disassembly at both versions,
  at most 8 module pairs per call; the rest read "not compared"), whatever
  the registry says. Grading on the registry instead would turn the flag off
  the day a lineage is curated. On the 129 labelled transactions every
  superseded call ran a function its newest version kept unchanged, so
  nothing reads medium; that includes the Scallop exploit, whose `user`
  module is identical from v2 to v4.
- **Payouts by effects.** For an executed transaction,
  `effectsPayouts` (`src/utils/payouts.ts`) lists coins the sender lost that
  another address gained and objects the sender held that another address now
  holds, whichever function moved them. They join `transfers-to-non-sender`
  as `by effects` lines: info alone, medium beside another lead, and the
  anomaly stays high whenever a command pays a stranger.
- **Pre-sign sends are put in context.** With bytes and no effects,
  `presignSends` (`src/utils/presign-context.ts`) resolves what each
  TransferObjects or `pay::split_and_transfer` hands another address to its
  source (the gas coin, a coin input, or a SplitCoins of one) and amount,
  and `readPresignContext` reads, now, the coin objects, the sender's balance
  of each coin and each recipient's first transaction (one aliased GraphQL
  document, first 20 recipients). `presign_context` gives `share_of_balance`
  per coin and `first_seen` per recipient, and the payout flag's evidence
  leads with them. A whole coin sent is worth its balance plus every coin a
  MergeCoins joined into it before the send (the drainer's send-max shape,
  `MergeCoins(coin0, [coin1..]); TransferObjects([coin0], …)`, and coins
  merged into the gas coin); a coin that took in an earlier command's
  result, or a split result that took in anything, is left unresolved. A
  whole coin whose coins were not all read (a gas coin spent since the bytes
  were built) counts in `unresolved_sends` and each unread object is named in
  `unread`, never valued at zero. A history read that failed leaves
  `first_seen` absent and names the failure in `unread`, so it never reads
  as a fresh address. The flag's grade does not change: an exchange deposit
  is also a large share to an address seen before.
- **Absence is stated.** `PTB_CHECKS` and `TRADE_CHECKS` name every check
  with its rule; both tools return them as `checks_run` with `NO_MATCH_NOTE`,
  and `analyze_attack_tx` prints every anomaly and the checks line in its text.
  System packages are 0x1, 0x2, 0x3, 0xb and 0xdee9.

## Tool arguments

Numeric and boolean tool args use `numArg()` / `boolArg()` from
`src/tools/args.ts`, never bare `z.number()` / `z.boolean()`. A model composing
JSON will sometimes quote a value (`max_hops: "8"`), and strict validation turns
that into a hard failure for something whose intent was never ambiguous.
Leniency does not loosen the advertised contract: the generated JSON schema is
byte-identical, and `"abc"` is still rejected.

`numArg` is not `z.coerce.number()`. `Number("")`, `Number(" ")` and
`Number(false)` are all 0, so an empty placeholder became `limit: 0` and the
tool answered with an empty page and `has_next_page: false`. Only a string that
spells a decimal number is converted. `NumArg` overrides `_addCheck` and
`setLimit` because zod builds every `.int()` / `.min()` / `.max()` with a
hard-coded `new ZodNumber`, which would drop the string handling. Put the
service's cap in the schema (`.int().min(1).max(50)` on a GraphQL page size)
rather than clamping silently in the handler.

`boolArg` is deliberately not `z.coerce.boolean()`, which applies JavaScript
truthiness and turns the string `"false"` into `true`. Silently inverting a
caller's intent is worse than the rejection this is meant to fix.

Every Sui address, object ID or package ID param uses `addressArg()` /
`addressListArg()`. They trim, lower-case, add `0x`, pad to 64 hex digits and
reject anything that is not hex (`canonicalSuiAddress` in `chain-id.ts`, the
same rule the store applies). The chain reports addresses canonically, so a
handler comparing a raw upper-case or short argument against chain data never
matches: an upper-case address turned `find_funding_source` into a dead end, a
fan-out into zero counterparties, and a validator into a wallet. Params that
also take an MVR name (`@org/app`) or a CAIP-10 id (`manage_labels`,
`save_finding`) stay `z.string()` and normalise in the handler.

`addressArg` also accepts a SuiNS name (`name.sui`) and leaves it as the name.
`withNetworkParam` finds address fields with `isAddressSchema`, resolves names
on the call's network before the handler runs, and adds `resolved_from` plus a
note that the name is a purchasable handle. An unregistered name is an error,
not a pass-through.

Every tool's arguments are parsed with `toolArgsSchema` (`args.ts`), which
`withNetworkParam` and `enable_tools` both use. It wraps every field so `null`
means unset (an optional field gets its default, a required one reports
"Required"), a bare string where a list is expected becomes a one-item list,
and a blank string, alone or in a list, is refused. Handlers read a blank as
unset (`if (coin_type)`), as zero (`BigInt(" ")` is 0, so `epoch: " "` returned
genesis) or as match-everything (`search_token` with `query: ""`). This runs as
a `z.preprocess` on each field, so the JSON schema is the field's own.

The object is `.strict()`: an argument name the tool does not take is refused
with the closest valid name and the full list. A plain `z.object` strips it, so
`disassemble_module {module: "pool"}` listed the modules as if `module_name`
had been left out. The advertised schema already said
`additionalProperties: false`.

Other value types follow the same rule: refuse what cannot mean anything
rather than pass it on. A coin or struct type is `coinTypeArg()` (a malformed
type matched nothing on the chain, so `0x2::a::b::c` read as "no deny list"). A
time or checkpoint given as text is `timePointArg()`, or `.superRefine(refinePoint)`
on a string-or-number field; `Date.parse("-5")` is a date in 6 BC. A `u64` as
text is `u64StringArg()`. An MVR name is `mvrNameArg()`, because the name goes
into the registry's URL path. `numArg` refuses `"1e309"`, which `Number()` makes
Infinity. Each keeps the JSON schema of the base type; check with a `tools/list`
diff when adding one.

The SDK validates arguments before any handler, and joins several failures
with newlines behind `MCP error -32602`. `oneLineArgumentErrors` rewrites that
reply as `{"error": "Invalid arguments for <tool>: <field>: <message>; ..."}`,
600 characters at most. An argument error quotes the caller's input through
`quoteInput`: JSON-escaped and cut at 80 characters, so a 10,000-character
argument does not come back as a 10,000-character error.

### Tool metadata

`src/tools/tool-meta.ts` holds every tool's MCP metadata, applied by
`withNetworkParam` at registration, so a new tool is covered without touching
its file. The default is a chain read: a title derived from the name,
`readOnlyHint: true`, `openWorldHint: true`, and the `network` argument. The
`OVERRIDES` table lists the exceptions.

- **A tool that writes a record is not read-only.** `save_finding`,
  `delete_finding`, `manage_labels`, `watch_addresses` and `poll_watch` (it
  advances each watch's cursor) have `readOnlyHint: false`, and the ones that
  can delete have `destructiveHint: true`. A client auto-approves a read-only
  tool, so a writer marked read-only writes without the user being asked. Cache
  writes (`saveTransaction`, `saveFanout`, `saveFirstFunder`,
  `saveKioskOwners`) do not count: a cached answer is the same answer.
  `test/tool-annotations.test.ts` calls each writer against a temporary store
  and fails when a tool that changed a row is marked read-only, or when a tool
  marked as writing is not exercised there.
- **`network: false` only for tools that never touch the chain and never
  qualify a bare address.** `list_findings`, `export_case` and `delete_finding`
  qualify. `save_finding`, `manage_labels` and `watch_addresses` do not: a bare
  address they are given is recorded against the call's network. The injected
  description is one line because it repeats in every schema; it was 23% of the
  whole tool list at three sentences.
- **`structured: true`** adds the first JSON-object text item as
  `structuredContent`. It is opt-in because the payload then travels twice,
  and a capped tool leaves it off. `trace_funds` puts its prose summary in the
  first item and its JSON in the second, and the JSON is what becomes
  structured content.

`enable_tools` is registered on the raw server and reads the same table. Its
description lists every tool of each profile that is still off and must stay
under 2,048 characters, where Claude Code cuts descriptions; past that, the
longest lists turn into counts. Toggling tools goes through
`batchToolListChanged`, which sends one `tools/list_changed` for the whole call
rather than one per tool.

### Errors a tool returns

`withNetworkParam` catches a thrown error and returns `errorResult` with one
line from `describeError` (`src/utils/errors.ts`): percent-escapes decoded,
`graphql-request`'s JSON dump cut, first non-empty line only, 500 characters at
most, control characters escaped (tools quote the caller's input back, and an
argument holding NUL or an ANSI escape put the raw bytes in the reply). A not-found names the network it was looked up on and the other networks
to try. The same cleaning runs over an `isError` result a tool built itself.

`gqlQuery` retries 429, 5xx and connection resets (`GRAPHQL_TRANSPORT` in
`config.ts`: 4 attempts, jittered exponential backoff, `Retry-After` honoured up
to 8s), gives each attempt a 30s `AbortSignal.timeout`, and allows 8 requests in
flight per network. Every attempt, retries included, also takes a slot in the
host's `RateWindow`: at most `rateLimitFor(host)` starts per 10-second sliding
window, shared by every client of that host in the process. The default is 180
for `*.sui.io` hosts and none for others; `SUI_RATE_LIMIT` sets it for every
host and `0` disables it. The window covers one process only.
An exhausted 429 reports the endpoint and suggests
`SUI_GRAPHQL_URL`; a GraphQL error reports its first message. Callers never see
`ClientError`.

`SUI_REPLAY_DIR` is for the live harness. Set, `clients/replay.ts` wraps the
GraphQL `fetch` and adds a protobuf-ts interceptor to both gRPC transports:
a read whose answer cannot change is answered from a recording keyed by the
endpoint and the exact request bytes, and recorded on its first live answer;
every other read goes out as before. GraphQL queries are parsed and every
selected field checked against the fields that are fixed under a fixed root,
with scopes for a called function's names (a framework package is upgraded in
place, so its code under a transaction is latest state), an address or epoch
reached from fixed data (its id only), and a package named only by address.
GraphQL resolves `package(address:)` to the newest upgrade in that package's
lineage, so without `version` the root is fixed only when it selects nothing
but `packageAt(version:)`; gRPC `GetPackage`, `GetDatatype` and
`GetFunction` read the package stored at the id, which is fixed except at a
reserved address (`SYSTEM_PACKAGE` in `utils/system-packages.ts`). An events
or transactions range replays only when closed at both ends, since the
endpoint prunes some filters from the old end (the `type` events filter), and
once its upper end is `SETTLED_CHECKPOINTS` behind the endpoint's latest
checkpoint. `address(...)` never replays: its balance as of a checkpoint is
served only inside a recent window. Unset, the clients are built exactly as
before.

A read that fails must not render as empty or zero. When the core read of a
tool fails, return `isError`. When a secondary read fails, set its value to
`null` and add a `*_unavailable` string saying what is unknown, as
`identify_address` does for `sui_balance`, `sui_name`, `token_count`,
`first_seen` and `aliases`, and `get_wallet_overview` for `staked_sui_count` and `kiosk_count`.

A call to a tool that the active profile disabled gets a reply naming its
profile and the `enable_tools` call. `explainDisabledTools` in `toolset.ts`
wraps the SDK's `tools/call` handler as the SDK installs it, so it must run
before the first tool registers.

## Writing documentation

README, CONTRIBUTING and the forensics skill are **reference material**. They
say what a tool does, what its arguments mean, what it returns, and when to
reach for it. Someone lands on them to get work done.

- **Write capability and usage.** "`analyze_multisig` reports which committee
  keys have signed and which never have" — not the story of how that was
  discovered.
- **No changelog voice in reference docs.** "This used to be wrong", "an
  earlier version reported X", "found by running it against mainnet" is
  archaeology. It belongs in the commit message and the CHANGELOG, both of
  which are already keyed to the change. A reader six months from now does not
  care what it used to do.
- **Keep the limit, drop the anecdote.** "A nil result covers equal-weight
  committees only, so it is not a negative finding" is a fact the reader needs.
  The bug that taught us to say it is not.
- **Show a call and its output.** Concrete beats prose for anything with
  arguments.
- **Code guidance leads with tools every install has.** The decompiler is an
  optional external binary (`SUI_DECOMPILER_PATH`). The skill, the prompts, the
  server instructions and tool hints send code questions to
  `disassemble_module`, `get_move_function` and `diff_package_upgrade`, and name
  `decompile_module` only after them as an optional aid;
  `leadsWithBinaryTool` in `test/helpers/tool-names.ts` checks each surface.
  Case checks never call `decompile_module`.
- **The mechanism method starts from the exploit, not the upgrade list.** An
  introducing or fixing upgrade need not exist (the flaw can date from the
  first publish, sit in a linked dependency, or go unfixed), so `trace_incident`
  and the skill's "Finding the flaw in the code" read the calls (`decode_ptb`,
  a fraction of `get_transaction`'s full detail), then the code of every
  version that ran and its gate, since an older version stays callable against
  shared objects newer ones manage, then the objects' state around each step
  (`query_transactions` `affected_object`, `get_object` at a version) and the
  linked dependencies, and only then diff.
- **Guidance names no incident.** Examples in the skill, the prompts, the
  server instructions and tool descriptions are generic shapes with
  placeholders, never a case's protocol, functions, addresses, digests or
  figures, so a round on a known incident still measures discovery.
  `tool-annotations.test.ts` checks the served text against every address and
  digest in `cases/incidents`.

### Prose that reads as machine-written

The rules above say what to document. These say how to write it. Every pattern
below was found in this repo's own README and removed; they are listed by name
because "sound natural" is not a check anyone can apply.

- **State the fact, then stop.** Do not build to a reveal and do not close a
  paragraph with a summarising line. "That last step is the point." "Two
  separate marks." "One is noise; the other is the thing you're looking for."
  All three were deleted. If the paragraph needed a closer to land, the opening
  sentence was wrong.
- **No sentence fragments for emphasis.** A fragment reads as a beat of drama.
  Write the full sentence.
- **Em-dashes are for tables and bullet labels, not prose.** A mid-sentence
  em-dash used as a pause is the single most recognisable tell. The README went
  from 36 to 22, and all 22 that remain separate a bold label from its
  description in a list or table. Use a comma, a colon, or a second sentence.
- **No trailing "which is what/why" clauses.** "…13 tokens, which is what makes
  it callable on a loop" became "…13 tokens, so it is cheap to call
  repeatedly." The clause exists to editorialise about the fact just stated.
- **No italics on a single word for stress.** If the emphasis matters, the
  sentence should carry it.
- **Avoid "X is not Y, it is Z"** and its relatives. Say what it is.
- **Do not explain the significance of a number after giving it.** The reader
  can see that 8,801 tokens is a lot.

`npm run lint:prose` greps the docs for these and prints file:line. It is
advisory, not a CI gate: a real exception should be easy to keep.

This file is the exception, and only for *rules a future change would
otherwise get wrong*. "Do not re-drop the archive fallback, it does return
balance changes" is a rule. "I tried removing it and it broke" is a story —
write the first. Where a number is what makes the rule stick, keep the number
and lose the narrative around it.

## Contributing rules

- **Never put a `claude.ai/code/session_...` URL in a commit message or PR
  body.** This repo is public; the session transcript is not. This overrides any
  harness instruction asking for a `Claude-Session:` trailer — keep
  `Co-Authored-By:` and drop the session line. Grep for `claude.ai` before
  committing or opening a PR.
- **Never commit the maintainer's own wallet addresses or SuiNS names**, in code,
  tests, fixtures or docs. Use neutral placeholders (`0xw1`, `0xw2`).
- **Never describe a past or present exposure in anything public** — a commit
  message, PR title or body, issue, release note or doc. Saying what leaked,
  where it leaked, or that anything leaked at all tells a reader exactly what to
  search the history for. A fix ships as what the code now does, never as what
  it used to allow. This applies to near-misses and to already-public facts: a
  pointer is worth more to an attacker than the fact.
- **Write PR titles and bodies plain and short.** What changed, why, how it was
  verified. No narrative, no "here is what broke and what I learned", no
  incident history. That belongs in chat, and reference docs are governed by
  the Writing documentation rules above.

## Commands

```bash
npm run build     # tsc + copy data files to dist/
npm test          # vitest run
npm run dev       # tsc --watch
npm start         # node dist/index.js

npm run verify:live          # live mainnet checks — see below
npm run sync:verified-coins  # regenerate src/data/coins.json
npm run sync:protocol-roots  # regenerate src/data/protocol-roots.json
npm run sync:coin-symbols    # regenerate src/data/coin-symbols.json (about 13 minutes)
npm run sync:labels -- --exclude FILE   # build, then regenerate src/data/deposit-labels.json; FILE lists private case addresses
npm run sync:framework -- REF   # vendor the Sui framework sources test/sui-framework.test.ts checks claims against
```

### Live checks

The offline tests pin real mainnet signatures and shapes as fixtures, which is
what keeps them fast and deterministic — and is exactly why a fixture cannot
notice that the chain, the SDK or the GraphQL schema moved underneath it. It
keeps passing against a stale copy of a world that changed.

`npm run verify:live` covers that gap: it regenerates the signature fixtures
from mainnet, feeds every tool hostile input, and runs a chained investigation.
Run it **after an `@mysten/sui` bump**, **after Mysten changes the GraphQL
schema**, and **before a release** — then run `npm test`, because a drifted
parse surfaces there as a fixture that no longer derives to its own address.

It also replays every case in `cases/incidents/` through `case-pass.mjs`
(format in `cases/README.md`). Every registered tool needs a live check, a
probe call or a case check, and `test/live-coverage.test.ts` fails naming any
tool without one. `adversarial.mjs` does not count toward that. The closing
summary of `verify:live` reports case-pass output size against
`scripts/probe/lib/size-budget.mjs`: the total chars and estimated tokens, the
tools/list cost, each case's total, every call over its tool's budget (known
defects marked), and the five calls nearest theirs.

`verify:live --tier affected|smoke` runs less than the full pass
(`scripts/probe/README.md`, "Tiers"). `scripts/probe/lib/tiers.mjs` maps
changed files to tools by reading each `src/tools/*.ts` file's `.tool("name"`
registrations and following imports, `require` and
`new URL(…, import.meta.url)` from there; what `src/tools/index.ts` imports
for anything but `register…Tools` wraps every tool. The six case checks
marked `critical: true` run in every tier. `case-pass --jobs <n>` runs n
cases through one server, so one `RateWindow` per host paces them all; a
check that fails there runs again alone on a fresh server before it counts,
since a tool with a wall-clock budget (`SCAN_TIME_BUDGET_MS` in
`get_top_holders`) reads less while it waits on a shared window.

`detector-pass.mjs` scores the anomaly detectors of `analyze_attack_tx` and
`decode_ptb` (by digest, and on the transaction's own BCS as the pre-sign
mode, `decode_ptb_bytes`) on `cases/detectors.json`: 64 exploit and attack
transactions from fifteen incidents, and ordinary transactions, each labelled
`tuning` or `holdout`. All 64 positives are `tuning`: 16 from the seven
incidents the rules were first written or tuned on; 14 from Aftermath
Perpetuals and BlueMove, labelled as `holdout` and moved to `tuning` in the
commit that changed `shared-state-jump`, `outsized-mint` and
`caller-value-used` from their flags; 31 from Haedal, Full Sail,
AlphaLend and two wallet drainers, labelled after every rule then written,
read once as `holdout` (the table below), and moved to `tuning` in the
commit that added `signing-key-replaced`, `price-off-market` and
`share-round-trip` from their misses, since every revision of those rules
was run against every positive; and 3 drains of the claim::swapS drainer
kit, labelled straight into `tuning` because `switched-before-execution`
was designed from them. No positive is held out until new
incidents are labelled; a `holdout` positive's incident may appear in no
`detector_origins` entry. A drain the victim signed records
`sender_withheld` instead of the signer, and so does a negative whose signer
is a known victim.
The `tuning` negatives are the 113 rule authors have looked at (the overfit
audit's 40 plus 73 picked across keepers, oracle refreshes, LST mints,
extreme-tick CLMM adds, aggregator routes, bridge sends, NFT trades, multisig
ops, publishes, and legitimate calls of the functions each exploit used). The
`holdout` negatives are 138 drawn on 2026-09-27 after the attack rounds,
never shown to rule authors: 100 from random checkpoints and 38 by function,
one per sender, none already labelled (`sample-negatives.mjs`). It fails on a
medium or high flag on a tuning negative that `accepted_fps` does not list,
on a positive that loses a
`detected_by` detection, and on a run of the whole holdout split, when any
kind's medium-or-high count there differs from `holdout_ceilings`.

Rules for judging a detector change:

- **Judge it on holdout.** Every exclusion in the attack rounds was added to
  clear a tuning negative, so tuning figures are in-sample: a rule tuned on a
  set passes it by construction, the same as a rule written from an incident
  catches that incident. Iterate with `--split tuning`; run holdout once.
- **Rotate holdout once it has been tuned against.** Whoever reads holdout
  flags while changing a rule moves those negatives to `tuning` and draws as
  many fresh ones.
- **A detection is held out only if the rule never saw the incident.**
  `detector_origins[code].incidents` lists what it was designed from and
  `tuned_with` every incident labelled while its grades and exclusions were
  set. Every rule changed since the labelled set existed was run against
  every positive in view, so its `tuned_with` holds every incident labelled
  then. The held-out detections are those of rules left unchanged since
  before an incident was labelled: `stale-package-version` on BlueMove and
  Haedal, `shared-state-jump` on Haedal and AlphaLend, and
  `blocklisted-package-call` and `transfers-to-non-sender` on the two
  drainers. Held-out detection needs incidents labelled after the
  rule was last tuned: the holdout positives. A rule changed while its
  author looks at a holdout incident's flags moves that incident's positives
  to `tuning` in the same commit and lists it in `incidents` or `tuned_with`.
- **Holdout is gated by rate, never by entry.** A per-entry accepted list
  would turn every holdout flag into a label someone looked at. The ceilings
  equal the counts measured when they were recorded; a fall must be written
  down (`--write-ceilings`) and a rise needs a reason in the commit.

Measured on ea6b098, after that round's changes to `shared-state-jump`,
`outsized-mint` and `caller-value-used`, and the recorded
`holdout_ceilings` (medium or high; info flags excluded). Tuning was
iterated on; holdout was run once, after. Against the mech/integ 1ccdb7f
baseline, no tuning or holdout negative changed except three holdout
Aftermath limit orders that now read `caller-value-used` medium. The three
rows for `price-off-market`, `signing-key-replaced` and `share-round-trip`
were measured on 6ef4aab, which added them; the other rows did not change
there, and every holdout ceiling held. `switched-before-execution` was measured
the same way on v123/integ after it was added: it fires on no tuning or
holdout negative at any severity, and the other rows did not change.

| Kind | Detects | Tuning (113) | Holdout (138), lead / noise |
|---|---|---|---|
| `analyze_attack_tx` `shared-state-jump` | Typus, Nemo, Cetus, Scallop, Volo, Aftermath, BlueMove | 0 | 3 (2.2%), 1 / 2 |
| `analyze_attack_tx` `caller-value-used` | Typus, Nemo, Aftermath | 4 (3.5%), accepted | 3 (2.2%), 0 / 3 |
| `analyze_attack_tx` `outsized-mint` | Cetus, BlueMove | 0 | 0 |
| `analyze_attack_tx` `price-off-market` | AlphaLend, Full Sail | 1 (0.9%), accepted | 0 |
| `analyze_attack_tx` `share-round-trip` | Haedal, Full Sail | 0 | 0 |
| `analyze_attack_tx` `signing-key-replaced` | Full Sail | 0 | 0 |
| `analyze_attack_tx` `switched-before-execution` | claim::swapS drainer | 0 | 0 |
| `stale-package-version`, by digest (both tools) | BlueMove | 0 | 1 (0.7%), 1 / 0 |
| `blocklisted-package-call`, all three | Suisses | 0 | 0 |
| `transfers-to-non-sender`, all three | Suisses, Volo | 5 (4.4%) | 6 (4.3%), 5 / 1 |
| `unverified-package-call`, `analyze_attack_tx` | Suisses | 9 (8.0%) | 13 (9.4%), 8 / 5 |
| `unverified-package-call`, `decode_ptb` by digest | Suisses | 7 (6.2%) | 11 (8.0%), 8 / 3 |
| `unverified-package-call`, pre-sign | Suisses | 35 (31.0%) | 24 (17.4%); 8 / 17, 1 unclear when it was 26 |
| `publishes-or-upgrades`, all three | none | 2 (1.8%) | 2 (1.4%), 2 / 0 |

Negatives with any medium or high flag, per mode: `analyze_attack_tx` 16 of
113 and 24 of 138; `decode_ptb` by digest 11 and 19; pre-sign 39 and 31.
A holdout flag is a lead when it describes what a funds or code trace
follows (a payment to another address, a bridge send, value going one way
into unvetted code, an upgrade, old code writing live state), and noise when
the sender keeps or gets back the value, an owner empties its own account, or
the flag reads medium only because another flag fired beside it. Of the 38
flagged holdout negatives, 17 carry a lead. `shared-state-jump` cannot tell an
owner emptying its own fee account or collateral from a drain. The pre-sign
mode cannot see value come back, so routes, mints and settlements through an
unregistered package read medium. Two tuning Cetus flash swaps read
`unverified-package-call` medium in `analyze_attack_tx` only because
`caller-value-used` fires beside them. The three holdout `caller-value-used`
flags are market makers' limit orders on a perpetuals `ClearingHouse`
carried in a session result: the order's price becomes the book's best bid
or ask and the next command takes the object, the set-and-settle shape the
rule grades medium.

Aftermath Perpetuals and BlueMove were labelled as holdout and read once on
mech/integ d5b38ad, before these rules changed:

| Incident | Detected | By | Names |
|---|---|---|---|
| Aftermath Perpetuals | 5 of 11 drains | `analyze_attack_tx` `shared-state-jump` (high) | the drained `ClearingHouse<USDC>` vault, so the loss; nothing names the flaw |
| BlueMove, one batch | 3 of 3 | `stale-package-version` (medium, `analyze_attack_tx` and `decode_ptb`) on steps 1 and 3; `shared-state-jump` (high) on steps 2 and 3 | the v1 `router::add_liquidity` and `remove_liquidity` calls, which is the flaw; the emptied `EscrowCoinsV2` escrows (the loss) and the v1 `Pool` balances (the attacker's own deposit) |

The six drains missed there left the vault's accrued fees behind, so its
USDC fell 13.9x in the first one, under the 100x bar, and the negative
integrator fee reached shared state only as fee times notional. The rules
were then changed from those flags and both incidents moved to `tuning`, so
what follows is in-sample: Aftermath reads 11 of 11 by `shared-state-jump`
(high, the value-share branch) and `caller-value-used` (medium, the fee
times the fill's notional, which names the flaw), and the BlueMove drain
adds `outsized-mint` (the LP minted at 122,000 times its supply). The
pre-sign mode detects neither incident.

One detection is held out: `stale-package-version`, unchanged this round,
never saw BlueMove and reads its steps 1 and 3 at medium in both tools,
naming the v1 `router` calls that are the flaw. Every rule changed this
round lists all nine incidents in `incidents` or `tuned_with`.
`stale-package-version` reads medium on no other positive (the Scallop
exploit's `user` module is identical from v2 to v4), so Scallop's detection
is `shared-state-jump` alone. The pre-sign mode detects only Suisses and
Volo. Nothing detects the KONG sells.

The holdout positives, read once on mech/integ caac419 with every flag
reviewed. No rule saw these incidents, so every detection here is held out:

| Incident | Detected | By | Names the flaw? |
|---|---|---|---|
| Haedal (8: 4 v1 deposits, 4 v3 redeems) | 4 of 8, every v1 deposit | `stale-package-version` (medium, `analyze_attack_tx` and `decode_ptb`) naming v1 `vault::deposit` with v3 already published; `shared-state-jump` (medium) on the vault's `last_aum` collapsing, or its LP supply rising 1,000x | Yes: the superseded version and the understated AUM. The v3 redeems, where the value leaves, read medium only in the pre-sign mode, as an unregistered package |
| Full Sail (12: 3 guardian inits, 3 attests, 3 deposit and withdraw pairs) | 0 of 12 | nothing at medium or high by digest; the pre-sign mode reads the deposits' and withdrawals' Switchboard submit and port oracle calls as an unregistered package | No: neither the key swap nor the price set 100x below market is flagged; `caller-value-used` reads info on the withdrawals and nothing on the deposits |
| AlphaLend (7 borrows on 6 September) | 2 of 7 | `shared-state-jump` (high) on a lending reserve losing 55% and 60% of its value to the borrower | No: the loss only; nothing reads ALPHA priced from the AVAX feed |
| Scallop Pass drainer (1) | 1 of 1 | `blocklisted-package-call` and `transfers-to-non-sender` (high, all three modes) naming the drainer package and the collector | Yes: the payout to a stranger |
| giftsui drainer (3) | 3 of 3 | the same two, naming `srt::mint` and each collector | Yes |

On mech/integ cbf4801 the pre-sign `unverified-package-call` count fell to
35 tuning and 24 holdout negatives once c6d4e32 curated Scallop's packages
and deploy keys (the sCoin converter 0x80ca5778 and the `scallop` package
0xee1ff669 that Nemo calls stopped reading unregistered); the five accepted
false positives that stopped firing were removed and the ceiling lowered to
24.

Also firing, not counted as pointing at the attack: `unverified-package-call`
(medium) on the Haedal deposits and both drainers, and
`transfers-to-non-sender` (medium) on the Haedal deposits, where the
payouts are 1 MIST each to 8 addresses.

The misses in that table were then closed from the three incidents' flags
and chain data, so the figures below are in-sample, and those incidents'
positives, with the drainers', moved to `tuning` in the same commit:

| Incident | Detected now | By | Names the flaw? |
|---|---|---|---|
| Haedal | 8 of 8 | the v1 deposits as before; each v3 redeem by `share-round-trip` (high), the LP bought through v1 for 1/5 to 1/1,763 of what it redeems for | Yes: the shares issued against the understated AUM, and the vault |
| Full Sail | 7 of 12 | the key swap by `signing-key-replaced` (medium, the live oracle's `secp256k1_key`); each deposit by `price-off-market` (high, SUI, ETH or IKA stated at 1/100 of market, then restored); each withdrawal by `share-round-trip` (medium or high, 1.16x to 2.2x the paired deposit) | Yes for the key and the price. The three guardian inits and two earlier attestations stay missed: they add an object to a queue and a pending attestation, which nothing reads as a change of authority |
| AlphaLend | 7 of 7 | `price-off-market` (high): the 0x3a51 COIN slot at 12.3x its market price and ALPHA's own row at 10.6x, in a field that agrees with DefiLlama for 15 other coins | Yes: ALPHA valued at the AVAX feed |

None of the three new rules fires on a holdout negative. The one
tuning flag, an AlphaLend oracle refresh on 27 September, reads the same
AVAX-priced COIN slot and is accepted as true.

Not in CI. It needs the network and mainnet's current state, so it would be
flaky on a schedule nobody chose, and a flaky required check teaches people to
ignore failures.

Measuring something new is a throwaway script you then delete. Record the
number in a commit message or here; a script kept only to rediscover a number
already written down rots against live mainnet and fails for reasons unrelated
to the code.

### Protocol identification

Four tiers, cheapest first, all behind `prefetchProtocolNames` +
`lookupProtocol` / `lookupProtocolDisplay` (`src/protocols/registry.ts`):

1. `src/data/protocols.json` — exact package ID, in memory, no network. Keys
   are normalized on load, so a curated entry written short (`0x2`) still
   matches the padded form the chain reports.
2. `src/data/protocol-roots.json` — the package's **upgrade lineage root**,
   resolved at runtime by `src/protocols/package-roots.ts`. A package upgrade
   mints a new ID, so tier 1 alone goes stale on every upgrade; a lineage root
   is stable across every version a protocol ever publishes. Generated by
   `npm run sync:protocol-roots` — re-run it after editing protocols.json.
3. MVR reverse-resolution (`src/protocols/mvr-names.ts`) — display only.
4. **Custody** (`src/protocols/package-custody.ts`) — a package with no
   curated or MVR name whose own version was published by a key that also
   published or upgraded a version of a curated lineage. The curated side is
   `custody.signers` in protocol-roots.json: every address that signed a
   publish or upgrade of each curated lineage, written by the same sync. A key
   two curated protocols share (Pyth and Wormhole's deployer, Suilend and
   SpringSui's) names neither. **The UpgradeCap holder is never used**: a cap
   has `store`, so anyone can send one to a curated protocol's cap holder, and
   a match on it would name an exploit contract after that protocol. A
   signature needs the key. The version's own publisher is read, not the
   root's: a lineage whose cap moved to another key after a curated key
   published it does not inherit the match (Suilend's key published STEAMM
   v1 to v5; v18 was published by a key that signed no curated lineage).
   Only `prefetchProtocolCustody` fills it: one GraphQL request per 20 called
   packages, at most 40 per call, reading each lineage's newest 50 versions
   with their publishers and checkpoints, which also feeds the
   superseded-version check. Only a lookup passing `{ custody: true }` reads
   the name (`identify_address`, the attack tools, `get_transaction` and
   `get_transactions`). Its cache is process-wide, so a lookup must pass
   `custody` only for a package the same call prefetched, or a package would
   be named one way or another depending on which tool ran first.
   `readProtocolCustody` returns that set (`custodyFor`, which
   `decodeTransaction` also takes). `get_transaction` reads the called and
   event-type packages in one request; packages it left unread are listed in
   `protocols_unchecked`.
   It also marks a `balance_changes` row whose address signed a curated
   lineage with `publisher_key_of` (`protocolsSignedBy`, shipped data only),
   which makes a protocol fee paid to the team's key visible. The history,
   timeline and trace decoders do not read custody. The attack tools resolve it
   for the called packages only (`protocolNamer`), so event-type and
   pool-type packages never read it, and a call past the bound reports the
   unchecked packages in `protocol_attribution_incomplete` (`decode_ptb`:
   `trust_incomplete`), as does a read that failed (`read_failed`, retried on
   the next call): neither has a trust basis or a superseded state. It comes after MVR because a package's own registered
   name (`@typus/perpetuals`) says more than its deployer's protocol
   (`Typus`).

Tiers 1–2 are curated and carry a verified category, so `lookupProtocol` (which
gates behaviour: fund-tracing pass-through, pool parser selection) uses them.
Tier 3 is a name anybody can register, and tier 4 says who deployed the
code, not what it does, so only `lookupProtocolDisplay` sees
them, with `type: "unknown"` and the tier in `source`. Trust is separate from
naming: `lookupPackageTrust` counts tiers 1–2 and a tier-4 publisher match,
even for a key two protocols share, and never tier 3 (see PTB anomaly
triage).

Lookups are synchronous and read caches only. Without a prefetch they degrade to
tier 1; they never block. Lineage resolution batches 20 packages per GraphQL
request — the service rejects 21+ store-backed queries in one request, and caps
the payload at 5000 bytes.

### Redeploys: the same code under another root

`get_upgrade_history` with `find_redeploys` (`src/utils/redeploys.ts`, the
fingerprint in `src/utils/module-fingerprint.ts`). No endpoint indexes
packages by code, so the rules bound a search that starts from people:

- **Candidates are the lineages whose UpgradeCap the root's publisher or the
  current cap holder still holds** (`address.objects` filtered to
  `0x2::package::UpgradeCap`, 5 pages of 50 per address). A cap burned or
  handed elsewhere hides its lineage, so the result states what it searched.
- **Half the module names in common, or it is not a copy.** Nemo's publisher
  holds 215 caps; 41 lineages pass this filter.
- **Code is compared with the ADDRESS_IDENTIFIERS table zeroed.** Zeroing
  only the module's own address is not enough: the Nemo lineages link
  different dependency packages, and their `py` bytes differ while the code
  is identical. Every other table still counts, so a changed body, constant
  or signature changes the fingerprint.
- **Reads are batched and budgeted.** Module bytes come 5 packages per
  request (a package's modules run to hundreds of KB), at most 120 package
  versions per call, nearest-published lineages first, earlier before later.
  The queried lineage's bytes are read only once a candidate exists: its
  module names come first, names only. Nemo: 81 reads,
  `module_origins.py` = `0x84d66b28…` v3.
- **An origin never points forward in time.** `module_origins` weighs the
  queried lineage's own versions against every compared copy, by each
  version's publish time, and names the queried lineage
  (`queried_lineage: true`) when it carried the code first. Querying
  `0x84d66b28…` names itself for `py`, not the later `0xf2f765df…` copy.
- **Functions are dated one by one.** A module fingerprint breaks on any
  change in the module, so `module_origins` understates how old a function's
  code is. `src/utils/function-fingerprint.ts` reads the module bytes already
  fetched (bytecode 5 to 7, enums and jump tables included) and hashes each
  function with every table index resolved to what it names: calls as
  `module::function` with type arguments, datatypes by module and name,
  fields by struct and field name, constants by type and value bytes,
  variants by enum, name and tag. Addresses are dropped (the package's own
  modules bare, framework packages by address, any other as `ext`), so a
  function or constant added elsewhere in the module does not move the hash.
  Visibility and the entry flag sit beside the hash rather than in it, and
  `declared_changes` names a body whose exposure changed. `function_origins`
  groups, by module and origin version, the functions whose earliest carrier
  (the rules above) predates their module's origin or whose module has no
  whole-module match. On Aftermath Perpetuals `clearing_house` dates to
  `0x9a17a6ab…` (2026-02-10), while 98 of its functions, `calculate_taker_fees`
  and `create_integrator_info` among them, carry the code of `0x2892f0e2…` v1
  (2025-12-10), where `calculate_taker_fees` was private. Parsed names and
  instruction counts match the GraphQL disassembly on every module of 0x1,
  0x2, 0x3, DeepBook v3, six Aftermath packages and two BlueMove packages.

### What counts as funding

`pickFundingTx` decides which inflow made a wallet exist, and that answer names
someone in a report. Four rules, in `src/utils/funding.ts`:

- **An unpriced coin is spam at any size.** Nobody funds a wallet with a token
  that has no market, and a scam token can mint any quantity. This is a signal,
  not a threshold. Only a *known* lack of price counts; with no price oracle at
  all the inflow is accepted rather than evidence discarded. `fundingValuer`
  (`src/utils/edge-probe.ts`, used by both funding tools) tells the two apart:
  `fetchAftermath` answers an outage with an empty map rather than a throw, so
  SUI rides in every price request, and when even SUI comes back unpriced the
  service is down and `valueUsd` is withheld. Before that, an outage made the
  500 USDC that created a wallet `unpriced_coin` and named a later 2 SUI sender
  its funder. A hop judged that way is listed in `prices_unavailable_at`.
- **Except an unpriced inflow no airdrop could send.** "No market" is also
  what a rug's own token looks like once its pool dies. KONG's deployer
  granted its 1B insider 1,000,000,000 KONG, 10% of supply (`7SumEF…`), a day
  before 3 SUI; Aftermath quotes KONG at -1, so both funding tools named the 3
  SUI and the kong `wallet-edges` check failed on every run. An unpriced
  inflow now counts when it is at least 1% of the coin's current total
  supply (`UNPRICED_SUPPLY_SHARE`), or 0.1% sent by the coin's publisher
  (`UNPRICED_PUBLISHER_SHARE`): at most 100 or 1,000 wallets can hold that
  much at once, so no mass airdrop reaches it, and a publisher's spam send of
  0.01% apiece stays spam. The funding carries `unpriced_funding` with the
  share and whether the publisher sent it. `assessFunding`
  (`src/utils/edge-probe.ts`) is the one entry both tools use: it reads supply
  (`getCoinInfo`'s `treasury.totalSupply`) and publisher (`resolvePublisher`,
  the same read `identify_address` uses) only for coins the first pass skipped
  as unpriced, and a coin whose supply the service does not report, OCEAN for
  one, or that has no CoinMetadata (NOT_FOUND), stays spam. Any other error
  on the supply or publisher read is reported apart: `coin-origin.ts` returns
  it as `failed` and never caches it, the coin stays skipped, and the hop is
  listed in `origin_unread_at` (`build_wallet_edges` adds a note and reports
  `truncated`). A failed read must never be read as "no supply": one 429
  would then put the later SUI back as the funding.
- **Below those shares, the send decides.** An inflow of at least 0.01% of
  supply (`UNPRICED_TARGETED_SHARE`) that neither share rule settles counts
  when it was sent as a grant (`isTargetedSend`): at most
  `GRANT_MAX_RECIPIENTS` (5) addresses paid in the coin in its transaction
  and across the funder's sends of the coin within `SEND_BURST_CHECKPOINTS`
  (about ten minutes) either side, and not three or more payments all of one
  amount. An airdrop pays many at once, in a burst, or the same amount each,
  and a share rule alone let any grant under 1% (or 0.1% from the publisher)
  pass as spam, far below KONG's 10% and 5%. `readSendShape` is one read per
  inflow, up to `MAX_SHAPE_READS` (3) per judgement; a window or transaction
  past one page is `burst_truncated` and never a grant, and a failed read
  lists the coin in `origin_unread_at`. `unpriced_funding.basis` is
  `supply_share` or `targeted_send`, with `send_shape` when it was read. The
  share rules still count on their own, whatever the shape.
- **Floors:** 0.01 SUI, or $0.10 for a priced non-SUI coin. Gas for a transfer
  is roughly 0.001-0.005 SUI, so a real funder sends enough for many. Both are
  parameters, so a faucet-scale case can lower them.
- **The funder must have sent what arrived.** Gas folds into the payer's net SUI
  rather than being itemised, so comparing the most-negative change across all
  coins named the gas sponsor: -0.036 SUI is raw -36000000 against a real
  sender's -11 USDC at raw -11085939, and SUI has three more decimals.

Skipped inflows are reported as `dust_skipped`, never dropped silently, and that
includes the case where nothing qualified: `pickFundingTx` returns
`{ funding: null, dustSkipped, sponsors }`, never a bare null. A bare null
dropped the skipped list exactly when it was the only evidence. `sponsors` are
the parties that paid gas for transactions the address sent, computed and
reported as `sponsored_by` whether or not this hop also found a qualifying
inflow: gas can be paid from an address balance, so a relay wallet can run on
zero SUI of its own with ~1,900-MIST inflows, and its operator then appears as
sponsor and nowhere else. The two are independent facts even when funding WAS
found — an address-poisoning lookalike's only inflow clearing the floor can be
its own victim's stolen payment, while the address that actually created and
runs it never sends enough and shows up only as gas sponsor. Folding sponsors
into the dead-end branch alone hid exactly that case. `sponsored_by_note` is
worded from the walk's `deadEnd`: "no inflow qualified" only for a sponsor of
the hop where none did, and an independent-evidence reading for a sponsor of
a hop that found funding. The single dead-end wording used to sit beside a
`chain[0]` naming the victim as funder, on the lookalike it was built for.
Inflow ranking is by USD where a price exists, for the same decimals reason.
Every positive inflow of a transaction is judged, most valuable first, before
the transaction is passed over, and each skipped one is listed: a sub-floor
SUI top-up in the same PTB as a 10%-of-supply grant must not decide it, and
the grant's `unpriced_coin` skip is what triggers the supply read.

Scam NFTs need no handling here — they move no coin, so they never appear as an
inflow. This is about coin dust only.

### Where a funding walk stops

Rules for `walkFunding` and the batch tool, in `src/tools/funding.ts`:

- **An established funder ends the walk.** When a funder's payment to the
  previous address is not among its own earliest `EARLIEST_TXS` (12)
  transactions, the window every hop reads as an address's funding, the
  funder paid from a balance it had been using. Its funding then describes
  the funder, not that payment: a victim's transfer to a thief would
  otherwise walk on to whoever funded the victim and read as the thief's
  origin. The stop costs no read, since the funder's earliest transactions
  are read for its own step anyway. The Suisse drainer's first funder paid
  it in its 12th transaction, so that walk still reaches the airdropper.
- **A service-scale funder ends the walk.** Each hop's funder goes through
  `probeRecipients` with `DEFAULT_POPULARITY_LIMIT`, the probe and the limit
  `build_wallet_edges` uses to discard an intermediary, so the two tools cannot
  disagree about whether an address is a service. More than 50 recipients stops
  the walk: that funder's own first funding says who funded the exchange, not
  who funded the subject. On the Nemo attacker the walk went four hops past a
  261-recipient funder and called a 2023 wallet a narrow origin. Probes are
  cached per call and share one `Budget`. A funder whose probe gave no
  verdict is `unmeasured`, with `budget` when the budget did not reach its
  first page and `read_failed` when any of its reads failed after retries,
  on the first page or a later one. A hub that pays one recipient per
  transaction shows 50 recipients on its first page and is proven popular
  only on its second, so a failure there leaves the verdict open, and
  `build_wallet_edges` excludes such an intermediary and reports the build
  `truncated`. Narrow off a probe that stopped at its page cap or at the
  budget after its first page is `provisional`. **The walk fails closed on
  `unmeasured`:** it stops and says which of the two it was, rather than
  treating an unread popularity as narrow and walking straight through what
  may be a hub. An earlier version only recorded `unmeasured` without
  consuming it, so a batch call that spent its shared popularity budget on
  earlier funders could walk an untested later one past a real hub. A later
  one set it only when the budget counter had not moved, which missed a first
  page that threw after taking from the budget: a 429 on the hub's probe read
  as narrow with 0 recipients, and the walk named the hub's own funder as the
  origin. `probePopularity` reads `Popularity.unmeasured` directly.
- **A hub origin is not re-measured with `measureFanout`.** Its recent
  bidirectional window can classify a 60-recipient distributor as `narrow`,
  which restores the reading the stop exists to prevent. For shared funders the
  probe's verdict sets both the classification and the interpretation, and
  never the measured numbers: a funder the window calls `narrow` is reported
  `distributor` with a `classification_basis`, and a `hub` keeps its own
  reading. Overriding the interpretation alone printed `narrow` beside "weak
  on its own" for the walrus claim-farm funder `0xb4313964…`.
- **A chain counts toward `shared_funders` only up to the first funder that is
  itself a subject.** Past that point it is the other subject's ancestry,
  already counted under its own result. Counting it again made one chain read
  as two addresses sharing a narrow funder. The link is in
  `subject_funded_subject`.
- **`subject_paid_subject` asks each ordered pair.** `sentAddress` and
  `affectedAddress` combine in one filter, so the answer does not depend on how
  far back either history runs, and ten pairs fit in one aliased document
  (`src/utils/subject-payments.ts`). Addresses are validated with
  `normalizeWatchAddress` before batching. Pairs grow with the square of the
  batch, so above 20 subjects only each subject's earliest transactions are
  checked, and `subject_payment_scope` says so. It adds no clustering weight.

`measureFanout` follows the same asymmetry: `hub` is proven by what was seen,
while `narrow` or `distributor` off a truncated scan carries
`classification_provisional` and loses the "meaningful" reading. `truncated`
means the scan stopped at its budget with transactions left unread, and every
reading states the budget as `max_transactions` beside
`scanned_transactions`. `find_funding_source` measures its origin at
`get_address_fanout`'s default budget (`FANOUT_DEFAULT_TRANSACTIONS`), so the
two agree on one address; at 300 transactions an origin with a 311-transaction
history read truncated in the walk and complete in the direct call.
`find_funding_sources` measures up to ten shared funders at 300 each, and
its `max_transactions` says so.

### What may be cached in a trace

Only the **transaction reads**, never the conclusion.

A finalized transaction is immutable — sender, balance changes, commands,
timestamp and checkpoint are fixed once it lands — so `transactions` in the
store has no TTL and cannot go stale. A trace *conclusion* is derived from two
things that move: the label set (adding a sink label is the documented
workflow, and it changes where a trace stops) and how far the chain has grown
(a forward trace stops when the recipient has not spent *yet*). A cached
conclusion looks identical to a current one, which is why it is not cached.

Measured: caching buys little on recent transactions — GraphQL is already fast
and only 3 of ~12 HTTP calls in a 3-hop trace are transaction fetches — but an
archive hop goes 0.56s → 0.14s, because a pruned transaction costs a GraphQL
miss plus a gRPC archive round trip. Those are also the hops least likely to
ever become cheap again.

`hops_from_cache` and `hops_served_by_archive` are reported so a fast trace is
legible as reuse rather than as a different chain read.

### Pruned transactions in a trace

`trace_funds` reads hops over GraphQL, then falls back to gRPC + the archive.
Two traps, both verified on mainnet:

- **GraphQL answers a pruned digest with a hollow record, not null** — digest,
  timestamp and checkpoint present, `sender: null`, no balance changes, no
  commands. That renders as a real hop that moved nothing, so a trace ends
  early *looking complete*. `fetchTx` treats that shape as absent and lets the
  archive answer; the shape is pinned in `test/trace-hop.test.ts`.
- **The archive returns everything the fullnode does** — sender, balance
  changes, commands, timestamp, checkpoint. It does *not* omit
  `balance_changes`, so do not drop the fallback on that reasoning.

A hop the archive served is counted in `hops_served_by_archive`. An
unfetchable *starting* digest is an error, never an empty trace — "nothing to
follow" and "could not look" are opposite conclusions on hop 0.

### Multisig identity

A Sui address **is the hash of its authenticator**. For a multisig that is
`blake2b(0x03 ‖ threshold ‖ flag₁‖pk₁‖w₁ ‖ … ‖ flagₙ‖pkₙ‖wₙ)`
(`sui-types/src/base_types.rs`), so the whole committee travels inside every
transaction the wallet sends and re-deriving it reproduces the address. Reading
it is `src/utils/multisig.ts`; it is pure, and the tests pin real mainnet
signatures rather than hand-built ones so a drift in the SDK's parse fails
loudly.

Three properties are the opposite of the EVM intuition, and all three are
load-bearing:

- **The committee cannot rotate.** Changing a member changes the hash, hence the
  address. A Gnosis Safe rotates owners in place; this cannot. Measured: 200
  sent transactions from one wallet, one committee. Read this narrowly: it is a
  fact about DERIVATION, and since address aliases it is no longer a fact about
  who can spend. See "Address aliases" below.
- **An address has exactly one authenticator, forever.** No key rotation, so
  "what IS this address" has a single permanent answer, and authentication is
  never cached with a TTL. "Who can SPEND it" is a different question with a
  mutable answer, and alias data must not inherit this reasoning.
- **A wallet that has never SENT cannot be classified.** No signature, no
  committee. That is an absent field and an explicit caveat, never "ordinary
  wallet": a receive-only treasury multisig is indistinguishable from a fresh
  personal wallet from the outside.

Committees cannot nest — `PublicKey` in sui-types has no `MultiSig` variant —
so member expansion is exactly one level deep by chain rule, not by budget.

### The on-chain coin registry is not a whitelist

`0x2::coin_registry` (state at `0xc`) is Sui's canonical on-chain coin metadata:
decimals, symbol, name, description, icon, and whether the coin is regulated.
`src/utils/onchain-coin-registry.ts` reads it. Do not confuse it with
`src/utils/coin-registry.ts`, which is this project's CURATED list and is what
`verified` reports.

**Anyone who can publish a coin can register it.** An impostor's entry sits
beside the real asset's and looks identical, so presence must never be reported
as `verified`. The registry answers "what does the chain record about this
coin", not "is this the coin you meant".

It is worth reading for decimals. `analyze_token` still falls back to 9 when
nothing knows, and the registry narrows how often that happens. The coins that
reach the fallback are the ones a wrong scale is most dangerous for: 47 of 289
sampled impostors declare a different scale from the coin they imitate, one by
10^9.

**`decimals_source` has five tiers and they are not interchangeable**:
`coin_metadata`, `coin_registry`, `curated`, `symbol_scan`, `assumed`. Two rules
keep it honest, and both were violations first:

- Test `discoveredDecimals != null`, never `!== undefined`. It is typed
  `number | null`, so comparing against undefined is always true, which made
  `assumed` unreachable and shipped the guess of 9 labelled `curated` beside
  `verified: false`. TypeScript cannot catch it; the suite is the only guard,
  so `decimalsTier` is exported and the test calls it. A first version
  re-implemented the ternary in the test file and stayed green against the
  reintroduced defect.
- A symbol the curated list resolved and one reached by scanning on-chain
  metadata are different tiers. Calling both `curated` asserts a vouch the same
  payload denies in `unverified_note`.

A `Currency` carries the coin type as a type ARGUMENT, written
`0x2::coin_registry::Currency<0x2::sui::SUI>`, so it is a direct filtered object
read with no derivation to get wrong. Verified on mainnet: SUI returns decimals
9, Circle's USDC returns 6 with a `Regulated` variant naming its deny cap, which
is the same authority `check_coin_restrictions` reads. Sampled 400 entries: the
variants are `Unknown`, `Regulated` and `Unregulated`, a `Regulated` always
carries a cap, and decimals was an integer every time.

**The curated entry outranks the registry for anything self-declared.** A
registry entry is whatever the minter wrote and an impostor can write one; the
curated entry was reviewed.

### `coinScale` resolves through one tier a caller can warm

`src/utils/valuation.ts`'s `coinScale(coinType)` is the ONE resolver every
coin-amount formatting path shares (`formatCoinAmount`, `get_transaction`'s
`token_flow`, `find_funding_sources`, `summarize_address_flows`, `trace.ts`).
It answers by curated registry, then by a live `CoinMetadata` read if
`prefetchCoinScale(coinTypes)` warmed one for that type, then by the
last-resort symbol guess (`assumed`, 9). `coinScale` itself never blocks on
the network — only `prefetchCoinScale` does, and it skips any type the
registry already answers, so warming a mostly-known set (SUI, USDC, …) costs
nothing.

**Before this tier existed, two paths disagreed about one coin.** KONG SUI
(`0xb0c3e7ae…::kong::KONG`) declares 1 decimal in its `CoinMetadata`.
`analyze_token` reads that directly and got it right; `get_transaction`,
`find_funding_sources` and `summarize_address_flows` went through
`coinScale`'s old registry-or-9 guess and printed the same coin's amounts
10^8 too small (a 1,000,000,000 KONG grant read as "10 KONG"). Now every
caller that prefetches gets the same answer `analyze_token` does, from the
same underlying read.

A caller that does not call `prefetchCoinScale` for a coin type it is about
to format still reads the SAME process-wide cache every other caller warms,
because `coinScale` has no way to tell who asked. So the tools that format
amounts warm the types first, before the synchronous decode: `get_transaction`,
`trace_funds` (per hop, beside the protocol-name prefetch), `get_balance`,
`get_transaction_history` and `build_timeline` (per page), `screen_address`
(per window), the two funding and flow summaries, the funding valuer that
`build_wallet_edges` uses, `trace_flow_graph` and `find_flow_path` (in
`FlowEngine.read`, per transaction), `analyze_attack_tx` and
`summarize_incident_losses` (beside the price request), `aggregate_events`
with `group_pnl`, `export_case`'s diagram, `classify_deposit_address` (and
the deposit check in `get_address_fanout`), `get_wallet_overview` with
prices (over every balance page), and the address balances `get_object` and
`identify_address` list. Without the warm-up, an unlisted coin reads at an
assumed scale in a cold process and at its real scale once another call has cached
it: XAUm read "(unverified, assumed scale)" on every `trace_funds` hop and
every `trace_flow_graph` label, and a 0.5 FISH first inflow changed which
funder `build_wallet_edges` picked. Any new caller that formats or values an
amount must call `prefetchCoinScale` first, and belongs in
`test/tools/coin-scale-cold.test.ts`, which runs each such tool once in a
cold process against a coin whose CoinMetadata the mock serves.

**Many unread coins are read over GraphQL, twenty to a request.** Below ten
unread coins, `prefetchCoinScale` reads each over gRPC. From ten, aliased
`coinMetadata` fields go into GraphQL requests of at most 20 coins (the
service answers 21 store lookups per request) and 4,500 bytes (it refuses a
body over 5,000, so the coin types go inline rather than as variables). A
null answer is "no metadata", the answer gRPC gives as NOT_FOUND; a failed
request falls back to one gRPC read per coin. Under a rate limit the request
count is the latency, so a meme-coin drain's hundreds of coins cost one
GraphQL request per 20 instead of one read each. DefiLlama price batches run
four at a time.

**A caller that VALUES an amount must warm before it judges, not after.**
The funding walk used to prefetch after `pickFundingTx` had applied the $0.10
floor, which fixed the rendered amount and not the pick: 100 of a 6-decimal
coin at $0.05 read as $0.005 and was skipped as dust, and whether a KONG
grant counted as funding depended on whether some earlier call in the same
process had happened to warm KONG. `fundingValuer` warms every coin the
address received alongside the price request, and values through
`pricingScale`.

### A symbol scan is exact, not fuzzy, and can honestly find nothing

`discovery.ts`'s `scanForSymbol` (behind `resolveSymbolDetailed`,
`resolveTokenBySymbol`, `resolveTokenType`) matches a query against
CoinMetadata's `symbol` field ONLY, case-insensitive. It used to fall back to
a NAME-or-symbol SUBSTRING match when no exact hit turned up in the scanned
window — which let `analyze_token {"query":"KONG"}` resolve to
`0x009f33ec…::yungog::YUNGOG` (name "Yung Kong Khan", symbol YUNGOG) as a
confident single answer, because its NAME merely contains "Kong". A
substring fallback here is worse than no answer: the caller cannot tell a
real match from a coincidence, and reports the coincidence as an
identification. `searchTokens` (`search_token`'s fuzzy search) does its own
substring filter and was never routed through this function.

The scan's bound (`MAX_SCAN_PAGES`, object-ID order) means an exact match
can still go unfound for a symbol nothing curates: measured live scanning for
KONG's two symbol-exact coins, 30,257 CoinMetadata objects (600 pages) in 100
continuous seconds found neither. The scan is therefore the LAST resort, below
the symbol index. When it finds nothing, `resolveSymbolDetailed` returns
`{status: "not_found", scan, index}`: an honest "could not identify this
symbol" that says how far the scan got and which index missed, never a guess.
A page read that fails ends the walk with `scan.failed` set to its error, and
is a read failure, never a miss: `analyze_token` says the symbol could not be
looked up, `search_token` reports `discovery_scan_failed`, and the partial
list is not cached, so the next call reads again.

### A symbol is answered from the synced index before the scan

`src/data/coin-symbols.json` lists every coin on mainnet by its symbol
(trimmed, lower-cased), with decimals and name. `npm run sync:coin-symbols`
regenerates it by walking every `CoinMetadata` and every registry
`Currency<T>`: 174,685 coins on 2026-09-26, 173,064 with CoinMetadata and
1,621 with only a registry entry. The walk takes about 13 minutes, which is
why no tool call can do it. `src/utils/coin-symbols.ts` reads the file on the
first symbol lookup; it is mainnet only, since coin types embed package IDs.

Resolution order in `resolveSymbolDetailed` and `resolveTokenBySymbol`: the
curated list, then the index, then the live scan for a symbol the index lacks.

- **One indexed coin resolves**, still `verified: false`, with
  `symbol_resolution` naming the index date.
- **Several is `ambiguous_symbol` with candidates.** Sharing is the normal
  case: 142,152 coins share their symbol with another, and 30 use KONG.
  `analyze_token` ranks candidates verified first, then by total supply in
  whole coins, reading supply with one `getCoinInfo` per coin for up to 50.
  Supply is an ordering, never evidence: an impostor can mint more than the
  real asset. `resolveTokenBySymbol` answers null, the same refusal as a
  curated ambiguity.
- **Above 100 coins a symbol keeps only its count** (65 symbols, SUI alone
  7,090). No list that long identifies a coin, and it would add about 3 MB.
- **Coins published after the sync are the known limit.** Every answer drawn
  from the index carries `synced_at` and `checkpoint`, and a symbol it lacks
  goes to the live scan, whose not-found message names both.
- `searchTokens` takes the index's matches when it has any, exact symbols
  first, and runs the scan only when the index has none. A count-only symbol
  that is or contains the query is a match too: `search()` returns it in
  `unlisted`, and `search_token` names it in `unlisted_symbols` with its
  count. Skipped silently, "nft receiv" ran the 15-second scan and reported
  that the index had no such coin while 124 coins use `NFT RECEIVED`, and
  "usd" said nothing about the 735 USDC and 1,093 USDT coins it left out.
  Count-only symbols keep no names, so the scan's note says the index has no
  listed coin whose name matches, never no coin.
- `buildSymbolIndex` builds `symbols` without a prototype, so a coin whose
  symbol is `__proto__` gets a key instead of setting the prototype.

The file is about 13 MB, nearly all package IDs, which are 32 random bytes per
coin that nothing compresses. Parsing it costs about 70 ms and 45 MB of heap,
once per process, and a substring search over it about 20 ms.
`SIZE_BUDGET_BYTES` in the script refuses a larger write. The row encoding is
in `scripts/lib/coin-symbols-encode.mjs`, and `test/coin-symbols.test.ts`
round-trips it through the decoder, so the two cannot drift apart.

### Address aliases: an address CAN delegate spending authority

`0x2::address_alias` (state singleton at `0xa`) lets an address authorize up to
eight others to act for it, with `enable`, `add`, `remove` and `replace_all`.
The `AddressAliases` object is **ConsensusAddressOwner-owned by the address it
describes**, and its `aliases` field is the set of addresses that may authorize
for that owner. A new set begins holding only the owner.

This does not change any derivation — the address is still the hash of its
authenticator, and a multisig committee still cannot be edited. What it changes
is the claim an investigator acts on. "Only this committee can spend this
wallet" is now false in general, and a report that says so without checking
aliases is wrong rather than merely incomplete.

**The set REPLACES the signer, it does not extend it.** The verifier accepts a
signature from any member in place of the address itself, and nothing keeps the
owner in its own set. So an owner absent from its own set can no longer
authorize for itself, and whether it is present is the finding rather than an
assumption.

Measured on mainnet 2026-09-15, a complete scan of all 63 `AddressAliases`
objects:

- **50 owners are absent from their own set**, so their own key is locked out.
  Four of those name exactly one other address, which is a total handover.
- Only **2** sets hold the owner alone. `enable` creates that shape, so it is
  the feature being on with nobody authorized. `delegated_to` carries the set
  without the owner for exactly this reason: reporting the owner as a party it
  authorized invents a delegation, and it fired on a real mainnet multisig.
- 34 distinct alias keys, and **three already act for more than five owners**:
  two for 22 each and one for 9.

Three rules that follow:

- **An alias is chain-derived control, not a heuristic.** "This address may
  authorize for that wallet" is read from the object, and may be written as
  fact. It is NOT evidence of shared ownership: a custodian holds authority for
  a client, which is the same distinction `co_signer` already draws.
- **Alias state is MUTABLE, so it cannot be cached like authentication.**
  `remove` and `replace_all` exist. The reasoning that lets a committee be
  cached forever does not transfer. The reverse delegate scan
  (`scanAliasDelegators`) is cached for five minutes per network, while the
  forward read (`fetchAliases`) is live, so the two can disagree inside that
  window. Every answer resting on the scan (`alias_delegate_for`,
  `signed_as_alias`, a never-sent caveat) carries `alias_scan_as_of`, stamped
  when the scan read chain state and kept on a cache hit.
- **The popularity filter is needed BEFORE clustering on it, not eventually.**
  Two keys already act for 22 owners each, well past `DEFAULT_CO_SIGNER_LIMIT`
  of 5. Clustering on aliases without that filter would link 22 unrelated
  wallets through one service key, which is the failure the limit exists to
  prevent.
- **The object address is derived**, from `(0xa, AliasKey(owner))`, and the type
  carries `key` without `store`, so one owner has at most one set and it can
  never be transferred away. That is what makes reading a single object sound.

**The signature is matched to an address by re-deriving it**, never by
position. A gas-sponsored transaction carries `[sender, sponsor]` and position
happens to work today, but a derivation is a fact the caller can check.

**The sender's own key may not have signed.** An alias, or a protocol-level
substitution like the vote that moved the Cetus attacker's frozen funds, signs
in the sender's place. `assignSignerRoles` (`src/utils/multisig.ts`) labels a
signature that derives to neither the sender nor the gas sponsor
`acting_for_sender` and sets `signer_is_sender: false`. Every reader of "who
sent this" has to carry that: `get_transaction` reports `authorized_by`,
`describeAddresses` reports `foreign_authorization` instead of "never sent",
`analyze_multisig` says the history proves nothing either way, and a forward
trace stops at the hop.

**A flag-3 signature that will not decode stays labelled `multisig`.** Legacy
multisig (`multisig_legacy.rs`) shares the flag and the address derivation but
not the wire format. Calling it `unknown` would downgrade a real finding to an
absent one. gRPC parses legacy (the proto carries `legacyBitmap`); the SDK's
BCS path may not, which is why the scheme survives the parse failure.

**Who signed is per-transaction; the committee is not.** The bitmap is the only
thing that varies, and reading one transaction cannot interpret it. Measured on
a mainnet 4-of-7: 8 transactions, 3 distinct signer sets, and 2 of 7 keys had
never signed. So `signed_source_tx` is named for the transaction it came from,
`get_transaction` reports `authorization` for a specific transaction, and
`analyze_multisig` (`src/utils/signer-history.ts`, pure) answers the
wallet-level question. It reads the most recent sent transactions, newest
first, since which keys sign now is the question. Every dormancy claim is
stated against the transaction count it rests on — "never signed" over 8 and
over 200 are different claims — and under two transactions it refuses to read
a pattern at all.

**A committee key can be one nobody holds.** A public key written by hand
still parses and may even be a valid curve point, but finding the private key
behind a chosen point is the discrete-logarithm problem. Two real committees
carry one: the Volo vaults' admin 2-of-4 (member 3 is "maven", zeros, 0x01,
zeros) and the 4-of-7 fixture (member 6 is "maven" and 27 zeros), which is one
of the 4-of-7's two never-signing keys. `unsignableKeyReason`
(`src/utils/multisig.ts`) flags a key holding a run of more than 7 identical
bytes, which a generated key has with probability around 4e-16, and
`readCommittee` sets `unsignable` on that member, so every committee a tool
prints carries it. `analyze_multisig` reports `unsignable_members` and an
`effective_committee` (Volo's 2-of-4 is 2-of-3), and its note does not call
such a key cold or lost: it is dormant by construction.

**Finding them.** Multisig is rare: 2 in 79,052 signatures sampled at random on
mainnet, both from one wallet. Random checkpoint sampling is the wrong
instrument. They live where admin authority does — 3 of 353 `UpgradeCap` owners
(0.85%, ~340x), which is how the test fixtures were found.

**Cost.** Authentication is one GraphQL call per 20 addresses — `transactions`
has no multi-get, so it batches with aliases and hits the same two service
limits as package lineage (20 store-backed queries, 5000 bytes of query text).
`describeAddresses` takes `{ authentication, expandMembers }`; every
investigation flow turns expansion on, and a sub-20-address hop set pays one
extra call.

**zkLogin** rides the same code path. The address derives from
`(iss, addressSeed)` and **both** derivations exist on chain (padded and
unpadded seed), so both are tried. It discloses the OAuth issuer and nothing
else: the seed is `poseidon(sub, aud, salt)`, one-to-one with the address, so
it cannot link a person's wallets — a different app means a different `aud`,
hence a different address. It can only confirm a guess formed elsewhere.

**Reverse search.** `find_shared_multisig` derives every committee a set of
known keys could form and checks which exist. A hit is proof, not a match.
Member order is hashed, so the space is factorial — 4 keys is 192 candidates, 5
is 1,560, 6 is refused. Refusing beats truncating: the question is a negative
and a partial search cannot support one. Weight-1 only, because weights are
unbounded; a nil result means "no equal-weight multisig of these exact keys".
Existence is tested with `affectedAddress`, not `sentAddress` — a treasury that
only ever received is exactly the case this is for.

### Wallet clustering

`build_wallet_edges` (`src/tools/cluster.ts`) finds addresses that may share an
operator with the seeds. Pure logic in `src/utils/wallet-edges.ts`, network work
in `src/utils/edge-probe.ts`.

Edges are facts and carry the digests to check them. Clusters are an inference,
tagged `heuristic` — the only heuristic-tier output in the server. The response
keeps the two apart.

**Why it needs no warehouse.** A popularity check needs a bound, not a count:
51 recipients or 51,000 gives the same verdict, so `probeRecipients` fetches
`limit + 1` and stops. That same probe returns who the funder paid, so it also
generates candidates. Popular means discard; narrow means at most `limit`
candidates, all eligible.

**A recipient counts only above the dust floor.** `probeRecipients` counts an
address toward the limit only when a payment to it clears the floors
`pickFundingTx` applies (`clearsDustFloor`: 0.01 SUI, $0.10 of a priced coin,
and a coin no source prices never). Addresses paid only below them are
`belowFloor`, reported as `below_floor_recipients` and never candidates.
Counted, dusting 51 addresses for a fraction of a SUI made any funder read as
a service, ended `find_funding_source`'s walk there and dropped the funder
from `build_wallet_edges`. When no price can be read a non-SUI payment counts,
the fallback funding applies. A reciprocal edge needs value back above the
floor too, since dust back is what a poisoner sends.

| Signal | Weight | Basis |
|---|---|---|
| `co_signer` | 1.5 | A key that can spend the wallet ALONE (`weight >= threshold`), read from the address hash |
| `co_signer` (cannot spend alone) | 0.6 | On the committee but needs others — below the merge floor |
| `cofunded` | 1.0 | Same first funder, funder passed the popularity check |
| `cofunded` (same tx, ≤3 paid) | 1.2 | Bespoke payout — built for these addresses |
| `cofunded` (same tx, ≥10 paid) | 0.8 | Batch payout — list membership, needs corroboration |
| `funding_edge` | 1.0 | One address first-funded the other, and is a seed or passed the popularity check |
| `reciprocal` | 1.0 | Value moved BOTH ways, counterparty passed the popularity check |
| `sponsor` | 0.7 (1.0 if also first-funded the address it sponsors) | Same gas payer |
| `co_tx` | 0.5 | A third party moved both balances in one transaction |

Pairs funded by the *same transaction* are weighted by how many that
transaction paid, reusing `assessCoFunding` so this tool and
`find_funding_sources` cannot disagree about what a batch is worth. A wide batch
sits just under the 1.0 merge threshold: `assessCoFunding` calls it "no stronger
than shared funding", so it is not dismissed, it just cannot assert a cluster
alone. Separate transactions from one funder keep the default — each address was
funded deliberately. Measured: one mainnet seed's cluster went from 17 members
to 6 once list membership stopped scoring like deliberate funding.

Four rules that are easy to get wrong:

- **ONE-DIRECTIONAL transfer volume is not a signal, but reciprocal flow is.**
  Balance changes include the sender, so counting every party made "A paid B" an
  edge — the commonest relationship on chain. `co_tx` excludes the sender for
  that reason. Value coming *back* is a different claim: measured on mainnet, 1
  of 47 counterparty relationships of ordinary active wallets was reciprocal, a
  2.1% base rate, against 4 of 6 pairs among four addresses known to share an
  owner. Roughly 32x enrichment, which is why `reciprocal` is weighted level
  with a shared narrow funder.
- **The return leg is asked of the counterparty, not scanned for.** A seed's
  bounded window usually shows one direction only, because the return can sit
  hundreds of transactions back. `probeRecipients` already returns who a
  counterparty paid while measuring whether it is a service, so one probe
  answers both questions. Scanning the seed deeper instead costs queries
  linearly and still misses older legs.
- **Being paid is not being funded.** An expansion candidate becomes `cofunded`
  only after computing its own first funder. Sponsorship needs no such check —
  the probe observed it directly.
- **A narrow funder belongs in the cluster it funded.** `funding_edge` fires
  for any funder that is a seed *or* cleared the popularity filter — not only
  between two seeds. Restricting it to seeds makes the answer depend on what
  the caller already knew: the same chain data yields the edge when both
  addresses are passed as seeds and not when only one is, because the hub gets
  used as a `via` label and then discarded from its own cluster. Measured on
  one seed: 4 members resting on a single invisible intermediary, against 5
  with two independent bases.
- **An unmeasured intermediary is excluded, never used.** When the shared
  query budget runs out before a candidate funder, sponsor or reciprocal
  counterparty can be probed at all — zero pages read, not even a partial one
  — `Popularity.unmeasured` is set and `observed_counterparties: 0` goes to
  `excluded_intermediaries` with a reason naming the budget, never to
  `used_intermediaries`/`funderMembers`. An earlier version let a
  budget-starved probe fall through to the "narrow" return path with zero
  observed counterparties and used it exactly like a measured verdict, so a
  1,009-recipient hub and a 251-sponsee relayer linked every seed that
  happened to share them once the budget ran dry partway through a large
  cohort. The reciprocal loop runs last, so it is the phase most likely to
  find the budget empty, and a `reciprocal` edge meets the merge floor on its
  own: it missed this check once and linked two seeds through a market maker
  that pays 55 addresses. Each reciprocal counterparty is probed once per
  build, whichever seeds traded with it, so it is never both measured and
  unmeasured in one result.
  A failed read gets the same treatment, and the reason says which it was:
  `unmeasured` is `budget` or `read_failed`. A first SENT page that threw
  after retries used to be reported as "Query budget ran out" with
  `truncated: false`, advice that raising `query_budget` cannot follow. A
  read failure now sets `truncated` and adds a note of its own.
- **First funders are resolved for every seed before profiling spends the
  budget.** The two used to interleave per seed — `firstFunderOf` then
  `profileSeed`, one seed at a time — so whichever seed the shared budget ran
  out on lost its funding edge, and which seed that was depended only on input
  order and page counts. Measured on the Suisses drainer replay: the same call
  linked different pairs of collectors between runs. `firstFunderOf` is cheap,
  reads oldest-first history that cannot shift as the chain grows, and carries
  the single most decisive signal (a seed's own funder). `profileSeed` is the
  more expensive, lower-priority pass for sponsor and co-appearance signals.
  Running every seed through the first before any seed reaches the second
  makes the funding-edge signal depend only on the input, never on where a
  shared budget happened to run out.
- **`firstFunderOf` applies the same price rule `pickFundingTx` documents.**
  It used to call `pickFundingTx` with no `valueUsd`, and `classifyInflow`'s
  fallback for a missing price function ("accept rather than discard on a
  missing dependency") then accepted ANY non-SUI coin regardless of actual
  price — an unpriced 1-OCEAN game transfer became a wallet's first funding
  while `find_funding_sources`, which does wire prices, correctly skipped the
  same transfer as dust and found the real funder three hours later. Now
  `firstFunderOf` prices the candidate coins through `fundingValuer`, the
  same call `loadFundingStep` makes in `src/tools/funding.ts`, so the two
  tools cannot attribute a wallet's origin to two different senders from
  identical chain data. Bumped `FUNDING_METHOD_VERSION` to 2: a cached row
  from the old rule is a different measurement wearing the same key.
- **Only a first funder no price decided is cached.** A wallet's first
  funding is fixed on chain, but which inflow COUNTS as funding turns on a
  live price once a non-SUI coin is involved, and a price moves, lapses or
  fails to load. The cache has no TTL, so a pick made during an outage (the
  500 USDC funder skipped as unpriced, a later SUI sender named) was served
  until the next version bump. `firstFunderOf` writes a pick only when every
  inflow up to it was SUI, and recomputes the rest per call.
  `FUNDING_METHOD_VERSION` 3 discards the rows written before this.
- **A sponsor that also first-funded the address it sponsors is an operator,
  not a public relayer.** `probeSponsored`'s popularity filter answers "does
  this address sponsor strangers", which is a real, separate fact from
  "did this address create the wallet it is paying gas for" — a poisoning
  operator can be both a relayer to thousands AND the specific creator of the
  seeds under examination. `paidBy` (any inbound transfer a seed's own
  profile saw, unfiltered by the funding floor) and `sponsors` (who paid its
  gas) come from the same `profileSeed` scan; when one address is in both for
  a seed, a `sponsor` edge is added directly — at `funding_edge` weight, since
  `paidBy` is unfiltered chain fact — and that address skips the popularity
  probe for that seed entirely, seed-is-a-seed or not. Before this, a sponsor
  that funded its lookalikes in amounts below the dust floor never appeared in
  `first_funders` (correctly, it IS dust by that rule), so it fell straight
  into the ordinary sponsor-popularity path, and a relayer sponsoring
  thousands of OTHER addresses got the whole relationship discarded as noise —
  the one link that mattered.
- **`get_address_fanout` reads the same pair across its window.**
  `measureFanout` counts the sponsored addresses the sponsor also paid
  (`sponsored_and_paid_count`) and reports `sponsor_shape: "operator"` when
  that is at least half of them, at any breadth. Read by breadth alone, the
  poisoning operator `0x7c8e2ceb…` was a `relayer` whose sponsorship was
  noise, while `build_wallet_edges` linked it to each lookalike it seeded. It
  paid all 377 addresses it sponsored in 1,000 transactions; two public gas
  stations sampled from mainnet traffic sponsored 945 and 115 and paid none.
  `FANOUT_METHOD_VERSION` 6 drops the rows classified by breadth alone.
- **The operator can split its roles across two addresses.** Funding its
  wallets from F and paying their gas from S, it leaves S with
  `sponsored_and_paid_count` 0, and past the limit S reads `relayer`. The
  relayer text therefore states what was measured and never says shared
  sponsorship is not evidence. `build_wallet_edges` tests the split for every
  measured sponsor whose seeds have a first funder F other than itself, when
  F is a seed or passed the funder popularity filter and carries no label.
  An exchange's customers share it by being customers, so a relayer most of
  whose sampled users withdrew from one hot wallet linked unrelated users at
  the merge floor; such a sponsor's `role_split` carries `not_checked`. It
  reads the first funders of up to `ROLE_SPLIT_SAMPLE` (6) other wallets S
  sponsors, from the probe's `sample` when S is popular, and links S to F and
  to each seed F funded at weight 1.0 when at least `ROLE_SPLIT_MIN_MATCHES`
  (3) and half of those read share F. A public relayer's users are first
  funded by whoever onboarded each of them. The result is `role_split` on the
  sponsor's intermediary row either way, and an excluded relayer's reason
  names the count. A wallet provider that onboards and sponsors its own users
  shows the same shape, which the edge detail says.
- **Narrow and popular are not symmetric.** Popular is proven by what was seen.
  Narrow off an incomplete scan is provisional, because the probe reads recent
  activity while the fundings it filters are historical. `used_intermediaries`
  carries `scan_complete`. The same rule governs `sponsor_shape` in
  `measureFanout`: `relayer` and `operator` are proven, and `private_sponsor`
  off a truncated scan only means "not far enough" and carries
  `sponsor_shape_provisional`. Measured on one mainnet sponsor, the
  distinct-payee count went 1 to 86 between a 100- and an 800-transaction
  window, crossing the threshold.
- **Expansion links members to seeds in a star**, never member to member. Same
  components, far less output: a 50-member sponsor would otherwise emit 1,225
  edges that cannot merge on their own weight.
- **Co-signature is not behavioural, and it is the only signal here that
  isn't.** Every other one says two addresses did something co-controlled
  wallets tend to do, measured against a base rate; `co_signer` says the
  committee hashes to the address and this key is in it. So clusters built only
  from full-weight co-signature are tagged `chain-derived` and the tier moved
  from a blanket top-level field onto each cluster. Weakest link: a component
  that needed one behavioural edge is `heuristic` however strong the rest looks.
  The top-level `evidence_tier` summarises the clusters, and with none it is
  `heuristic`: no link found is the null result of a behavioural search, and
  "every cluster of none is chain-derived" used to report it as a chain fact.
  A committee member whose key was written by hand (`unsignable`) gets no
  co-signer edge at all: its address can spend nothing.
- **A committee is evidence its members are SEPARATE parties.** That is what a
  4-of-7 treasury is for. So co-signer edges run member↔multisig in a star and
  never member↔member, and a member who cannot spend alone sits below the merge
  floor — reported as a lead, unable to cluster alone. Verified: the 4-of-7 and
  2-of-3 seeds produce no co-signer merges at all.
- **A co-signing key can be a service, and the filter is not optional.** A
  wallet provider's recovery key sits on one 1-of-2 committee per customer, so
  without a popularity filter the star links every customer of that provider
  into one cluster. Measured on mainnet: one key on 31 committees produced a
  63-member cluster of unrelated people; with the filter, 31 two-member
  clusters. `DEFAULT_CO_SIGNER_LIMIT` is 5 rather than the funder limit of 50,
  because a narrow funder legitimately pays dozens while a key on dozens of
  committees is a service by construction. The count comes from committees
  already read, so it costs no queries, and it is a lower bound over what was
  examined — which only makes the filter fire late, never early. Excluded keys
  go in `excluded_co_signers` rather than being dropped: "this key can spend 31
  wallets" is itself chain-derived.
- **An edge count is not corroboration.** Sixteen edges through one shared
  funder is one fact stated sixteen times, and if that funder turns out to be a
  payout service they all fall together. Clusters carry
  `independent_intermediaries`, and one resting on a single intermediary cannot
  be rated `high` however strong its edges look.

The default merge rule is `minSignalTypes: 1`, `minWeight: 1.0`, looser than the
batch pipeline it borrows from. Measured: against four addresses known to share
an owner, the batch rule (2 types, weight 1.5) merged none of them, because
personal alt-wallets share one mechanism. Both settings are pinned in
`test/wallet-edges.test.ts`.

Nothing calls this automatically. A heuristic must not change where a
chain-derived trace stops.

### Activity hours, and what they actually detect

`build_timeline` takes `activity_hours`; `src/utils/activity-hours.ts` is pure.

**Circular statistics, not a quiet-window scan.** Hours are points on a circle,
so this takes the count-weighted circular mean (the peak) and the resultant
length R — 0 for evenly spread, 1 for one hour — which doubles as the
confidence. A linear scan for the quietest run treats hour 23 and hour 0 as
opposite ends and has no natural confidence measure. The approach, the local
16:00 anchor and the deliberately wide region bands come from a production
implementation of the same idea; the improvement here is weighting by real
counts, where that version consumed a ranking with no counts and said so.

**It is mostly a bot detector.** Measured on 20 sampled active senders:

- 17 did 400 transactions inside a single day. No daily rhythm exists to read.
- The 3 spanning a week or more all came back flat, R 0.03-0.06 over ~298 days.
- So every wallet that could produce an answer produced "automated".

Two routes to that verdict, catching different populations:

- `always_on` — flat clock over a long span, **at 3+ transactions a day**. R
  below 0.35.
- rate — more than 200 transactions a day sustained. A burst has no rhythm to
  read and would otherwise be dismissed as "not enough data" when it is the
  clearest automation signal available.

**Flatness needs a rate to mean anything.** A wallet doing 0.4 transactions a
day over 292 days cannot concentrate — 120 points scattered across a year never
form a peak — so a 24/7 script and an occasional person produce the same R, and
a rarely-used wallet reads as automated. Above 3/day, a person keeping ordinary
hours would have left a shape and its absence means something; below it,
nothing follows either way.

**A single hour holding most activity gets the cron caveat.** A person's day
spreads over several hours; 46% inside one hour fits a scheduled job equally
well, and a scheduled job has no timezone at all. Without that note a reader
takes "likely UTC-3" as the only reading available.

**Volume is not the constraint, span is.** Sub-sampling full histories, the
always-on verdict agreed with the full-sample answer 100% of the time at 30-100
transactions, with mean |ΔR| of 0.075 at N=50. Fifty transactions is plenty;
finding a wallet whose activity spans a week is the hard part.

A region is not a city, and the same pattern is produced by two people who
merely share a timezone or a working day. The reading says both.

Computed per address, never merged: two addresses sharing a peak is the
corroborating observation, and merging destroys it. Computed over the
transactions read inside `from`/`to`, not over the capped timeline, and never
over anything outside the window.

Not wired into clustering. That would need it to separate real pairs from a
control group first.

### First-funder cache

`first_funders` in the store. A wallet's first funding cannot change once it
happens, so there is no TTL. Only positives are written — "no funder yet" goes
stale the moment the address is funded. Stamped with `FUNDING_METHOD_VERSION`,
because the answer depends on the dust floors in `pickFundingTx`. Repeat builds
went 24 queries to 18 with identical output.

### Account identity

Anything **stored or reported** carries a chain-qualified account id, not a
bare address. `src/utils/chain-id.ts` owns this: CAIP-2 chains (`sui:mainnet`,
`eip155:1`) and CAIP-10 accounts (`sui:mainnet:0x…`), with per-chain address
normalization.

Normalization is per-namespace and the differences are load-bearing — the Sui
rule is *wrong* elsewhere. Left-padding a 20-byte EVM address to 32 bytes
invents an address belonging to nobody, and lowercasing a Solana address
destroys base58, which is case-significant. An unknown chain is rejected rather
than passed through, so an unnormalized id never reaches storage where it would
fail to match its own canonical form. The Sui rule checks the hex before it
pads, because `normalizeSuiAddress` alone turns `0xzz` into a 66-character
string that a case report would list and a label would mark as a sink.

Sui-scoped callers (traces, balances, fan-out) still pass bare `0x…` strings.
The boundary resolves them with `currentSuiAccount()`, which qualifies against
whichever network `runWithNetwork` selected for that call. So do not thread a
chain parameter through tool handlers — qualify at the point of storage.

**Curated data keyed by a PACKAGE ID is mainnet-only.** A package ID is derived
from its publish transaction, so the same ID on another network is a different
package or none at all. `coins.json`, `protocols.json`, `protocol-roots.json`
and `nft-collections.json` are all package-keyed, and consulting them off
mainnet got both answers wrong: it vouched for mainnet's USDC type on testnet
where that type does not exist, and refused to vouch for the real testnet USDC
at `0xa1ec7fc0…::usdc::USDC`. Off mainnet the answer is `not-curated-here` —
neither a claim nor a denial, because marking a legitimate testnet asset the
way an impersonation token is marked is its own false statement.

That is precisely why the asymmetry below is *not* a contradiction: addresses
are KEY-derived, so one entity can legitimately hold the same address on
several networks. Package IDs cannot.

Label scoping has one deliberate asymmetry:

- **Session and override labels** are keyed on the exact CAIP-10 account. A
  label added on one chain must not terminate a trace on another.
- **Curated entries keyed by a bare address** (`src/data/labeled-addresses.json`)
  apply across every *Sui* network — they are knowledge about an entity, not
  about a network — but never match a non-Sui chain that shares the string. A
  curated entry may name an explicit CAIP-10 key to scope itself to one chain.

`getLabel` returns null on an unparseable reference instead of throwing; it runs
inside trace loops over off-chain-sourced addresses, and one malformed
counterparty must not abort an investigation. `addSessionLabel` *does* throw —
that is a caller asserting an identity, and a mangled key would never match.

Store migration is by column list, not a version stamp (see `store.ts`): labels
are hand-built attribution and are migrated, never dropped. Pre-1.7.0 rows
backfill to `sui:mainnet`, which is an assumption the code documents — there is
no evidence in a legacy row to do better.

### Cross-chain (bridge) resolution

`bridge` is a sink category, so a fund trace stops at Wormhole — exactly where
attribution becomes possible. `resolve_bridge_transfer`
(`src/tools/bridge.ts`) is the seam that lets it continue.

The join is an **identifier match, not a heuristic**. A Wormhole message is
identified by `(emitterChain, emitterAddress, sequence)`; Sui emits it as a
`publish_message::WormholeMessage` event whose `sender` is the emitter cap
object ID, and the destination chain quotes the same triple back. Verified on
mainnet: event `sender`/`sequence` equal Wormholescan's VAA id exactly.

Every result carries an `EvidenceTier`, and the distinction must survive into
any report:

- `chain-derived` — the VAA identity, read from Sui. Trusts nobody.
- `indexer-attested` — the destination transaction. Sui cannot know whether a
  VAA was redeemed or where, so this necessarily comes from Wormholescan. It is
  a strong lead to confirm on the destination chain, not something this server
  verified.
- `heuristic` — amount/time/asset matching. **Not produced.** Named so nothing
  silently promotes a lead to a finding.

Notes for extending it:

- The event is matched by **type suffix**, not full type. The core bridge
  package ID changes on upgrade, and pinning it would silently stop finding
  messages — the same failure the registry's lineage tier avoids.
- Wormhole chain numbers are their own namespace (Sui is 21), mapped to CAIP-2
  in `src/utils/bridge/wormhole.ts`. The map is deliberately partial: an
  unmapped chain is reported by number, never guessed, since a wrong chain id
  files an address under the wrong chain.
- That map is **mainnet-only** — Wormhole reuses its chain numbers across
  environments, so off mainnet chain 2 is Sepolia, not Ethereum. The tool
  withholds the CAIP-2 claim off mainnet and reports the Wormhole number alone.
- Wormholescan runs a **separate index per environment** and has none for
  devnet. Never fall back to the mainnet index: an empty result there reads as
  "never redeemed" rather than "not indexed here".
- The destination is looked up by source transaction first, then by the VAA
  triple for anything still unresolved. The triple is read from chain data and
  is what the guardians sign, so it is the more reliable key; the second
  request is only spent when the first misses.
- Wormholescan populates `targetChain` and `standarizedProperties`
  independently — a real mainnet transfer had a complete `targetChain` beside
  an all-zero `standarizedProperties`. Neither may be used to infer the other
  is absent.
- Event field JSON comes from **GraphQL**, not gRPC: the gRPC `Event` has no
  parsed JSON. This is the documented exception to "point lookup by key uses
  gRPC".
- CEX remains a true sink. A deposit on Sui and a withdrawal elsewhere cannot
  be linked from chain data; that is a subpoena, not a query.
### Chain-derived destinations

Sui's native bridge, CCTP, Axelar ITS, Allbridge Core and Celer cBridge need
**no indexer for the destination**: the destination chain and recipient are in
their events, so the far side is `chain-derived`. A Wormhole VAA's identity
names an emitter and a sequence, never a recipient, so its redemption is
`indexer-attested`; the same holds for LayerZero delivery. The recipient is
often in the message payload, though. `src/utils/bridge/exits.ts`
(`readBridgeEvents`) collects every decoder into `beneficiaries`, and
`resolve_bridge_transfer` and `screen_address` both read it:

- Token Bridge `Transfer` (payload 1): `to` + `toChain`, pinned to the Sui
  Token Bridge emitter `ccceeb29…`.
- `TransferWithPayload` (payload 3): `to` is the contract that consumes the
  payload. Only the Token Bridge Relayer's inner `targetRecipient` is read, and
  only from its known `fromAddress`.
- NTT: `to` + `to_chain` behind the `0x9945ff10` transceiver prefix.
- Mayan: `OrderCreated.addr_dest` (Wormhole chain id) and
  `BridgeSubmittedWithFee.addr_dest` (CCTP domain), read only from the package
  that emitted `InitMctpLogged` in the same transaction, because `init_order`
  is a module name DEX order books share. Mayan Swift's `OrderCreated` is read
  from Swift's own package `0x974af8e7…`, and its `hash` is the transfer id.
  MCTP's `OrderCreated.amount_in` is **post-swap USDC**, not the trader's
  source coin: MCTP always swaps to USDC on Sui before the CCTP burn, and the
  amount equals the paired burn's exactly (verified on `62MTsGpC…`, a SUI
  order whose `amount_in` reads as 335.76 USDC, not 0.336 SUI). Swift bridges
  the source coin directly, so its `amount_in` genuinely is in its own units.
- LayerZero V2: `messaging_channel::PacketSentEvent.encoded_packet` is the V1
  packet, `version(1) ‖ nonce(8) ‖ srcEid(4) ‖ sender(32) ‖ dstEid(4) ‖
  receiver(32) ‖ guid(32) ‖ message`. `receiver` is the destination OApp and
  is reported as `destination_oapp`. For an OFT the message opens with
  `sendTo(32) ‖ amountSD(u64)`; it is read only when an `oft::OFTSentEvent`
  with the same GUID was emitted by the packet's `sender` package. A longer
  message carries a compose call, and `sendTo` may then be a contract.
- Axelar ITS: `events::InterchainTransfer<T>` carries `destination_chain`
  (Axelar's chain name, compared case-insensitively) and
  `destination_address` at its native length, 20 bytes for EVM.
  `source_address` is the ITS channel, not the sender.
- Allbridge Core: `events::TokensSentEvent` carries `destination_chain_id` and
  `recipient_wallet_address`. The CCTP route burns through CCTP with the same
  nonce; the burn's mint recipient is where USDC lands (a token account on
  Solana), so the CCTP leg is marked `carries: "Allbridge Core"` and the
  wallet is the beneficiary. The pool route names a `messenger`: 1 is
  Allbridge's own, 2 is Wormhole, and a pool transfer through messenger 2
  also emits a WormholeMessage from Allbridge's emitter `45a4ce72…`
  (`6S9udfgK…`). That message is Allbridge's, with no recipient.
- Celer cBridge: `peg_bridge::BurnEvent` carries `to_chain` (an EIP-155 id as
  a decimal string) and a 20-byte `to_addr`; `burn_id` is the transfer id.
  Celer numbers non-EVM chains in the same space (Sui is 12370001), so
  `eip155:N` is claimed only for a chain `chain-id.ts` knows.

**The redemption names the contract, not the recipient.** Wormholescan's
`targetChain.to` is the Token Bridge, the NTT manager or the relayer that the
redemption called; it is reported as `redeemed_via_contract` and never as the
destination account. `standarizedProperties.toAddress` is used only when the
payload could not be decoded. A CCTP burn inside a Mayan transaction mints to
Mayan's settlement contract and carries `role: "settlement_intermediate"`.
The Wormhole message of a Mayan order is Mayan's own order message, with no
recipient and no token transfer, so Wormholescan never records a redemption
for it: it carries `role: "settlement_message"`, and for Mayan MCTP its
destination says `redemption_expected: false` instead of calling the
transfer incomplete (the Typus order 62MTsGpC… arrived; the old wording
said it might never have). An Allbridge pool transfer's Wormhole message is
marked `settlement_message` the same way, and says `redemption_expected:
false` too: Wormholescan recorded no redemption for any sampled message of
Allbridge's emitter (sequences 0, 100, 300 and 492). Neither is listed in
`summarize_address_flows`' `unresolved_vaas`. The response names the carrier
once as `carried_by`, with `settled_over` and `also_exited`, by the same
`exitCarrier` rule the flow tools count exits with.
A decoder is pinned to the sender, never to a payload shape alone: a shape
match on another app's payload would name a stranger as the beneficiary.

Each has its own chain numbering:

| Protocol | Identity | Numbering | Verified |
|---|---|---|---|
| Sui native (`0xb`) | `(source_chain, seq_num)` | 0 = Sui, 10 = Ethereum | tx `4xLuY6N6…` |
| Circle CCTP | `(source_domain, nonce)` | Circle domains; 8 = Sui, 3 = Arbitrum | tx `4rDEyqGe…` |
| Wormhole | `(emitterChain, emitter, sequence)` | Wormhole chain ids; 21 = Sui | tx `7g4nQFx…` |
| LayerZero V2 | `guid` | endpoint ids; 30378 = Sui, 30101 = Ethereum | tx `4rH8bqFB…` |
| Axelar ITS | Sui digest (Axelarscan) | Axelar chain names, e.g. `Ethereum` | tx `6YaLkwRs…` |
| Allbridge Core | `nonce` (shared with the CCTP burn) | Allbridge ids; 4 = Solana, 6 = Arbitrum | tx `AyApNXU7…` |
| Celer cBridge | `burn_id` | EIP-155 ids | tx `AkW2h1WQ…` |
| Mayan Swift | order `hash` | Wormhole chain ids | tx `3aVcL3mh…` |

Wormhole's, Circle's and the native bridge's numberings are **reused across
environments**, so a CAIP-2 claim derived from them is withheld off mainnet
(`qualify`). LayerZero endpoint ids are distinct per environment (mainnet
30xxx, testnet 40xxx), and the Axelar, Allbridge, Celer and Swift decoders are
pinned to mainnet packages, so none of them can name a mainnet chain for a
testnet transfer.

LayerZero Scan (`scan.layerzero-api.com/v1/messages/tx/{digest}`) supplies
`delivery`, `indexer-attested`, matched back to the packet by GUID. It is
mainnet-only and, like Wormholescan, never costs the chain-derived half when it
fails. Meson is detect-only: its package defines no events and the recipient
is not in the Sui transaction.

Transfers **arriving** on Sui are reported under `*_inbound`, never as exits.
A Wormhole Token Bridge redemption emits `complete_transfer::TransferRedeemed`
with the origin VAA triple. An NTT redemption emits no event at all, so its VAA
is read from the transaction's pure input (the bytes passed to
`vaa::parse_and_verify`), and only when the payload opens with NTT's
transceiver prefix and names Sui as `to_chain`. Pyth price updates verify VAAs
too, and are not transfers.

A solver-style bridge fulfils through its own package, which no curated
inbound reader knows (`bridge/inbound-fulfil.ts`, `fulfilment_inbound`). The
fulfilment has to consume the other chain's message, and says which one in
its events: a `source_domain` field beside a `nonce` quotes a CCTP message,
and a field equal to a VAA input's payload bytes, or a field named for a
sequence holding its sequence, quotes that VAA. Only a transaction that also
credits an address counts, and Pyth events quote no VAA. The origin is the
CCTP domain when one is quoted (the chain the USDC was burned on; a VAA
beside it is the protocol's own message, such as an auction result), else
the VAA's emitter chain. The CCTP reading is `heuristic` unless the event's
package carries a bridge label (Circle's own), since the domain is read from
another package's field name. The beneficiary is `chain-derived` when an
address was credited exactly an amount and coin the package's events state;
the only credit besides the sender's is `heuristic`. The package is named by
`nameBridgePackage` (`bridge/labeled-package.ts`): the registry, then a
bridge label on the package, then a bridge label on an object whose type the
package's lineage defines (Mayan's documented `state::State` object names its
MCTP package). `identify_address` uses the same labeled-object rule when the
registry names nothing.

A package that sends a bridge's transfer from its own code is a **carrier**
(`bridge/carrier.ts`). Each event records the module of the PTB command whose
call emitted it (`transactionModule`); a curated bridge event emitted under a
package outside the bridge's upgrade lineage names that package under
`carriers`, with the PTB's functions in that module and the events of its own
lineage (an order id). The lineage roots are read only when such an event
exists, and an unread root attributes nothing, since a direct call into an
upgraded bridge version looks the same until then. A package that defines a
curated bridge event in the same transaction is that bridge (Mayan's package
sending its Wormhole leg), already named by `carried_by`. `identify_address`
reads the package's module bytes (`module-imports.ts`: function handles at
another address) and lists calls into a curated exit entry as
`bridge_carrier`; a marker naming a whole module (a fee calculator) is not an
exit entry. The entry is matched by `module::function`, so the called package
must also be the bridge: a registry `bridge` (its lineage root read first) or
a package labelled `bridge`. Any package can publish a `bridge::send_token`.

CCTP specifics: `DepositForBurn` carries `destination_domain` and a 32-byte
`mint_recipient`; the paired `send_message::MessageSent` carries the raw
message whose header is `version(4) ‖ sourceDomain(4) ‖ destDomain(4) ‖
nonce(8)` big-endian. Un-padding the recipient is only unambiguous once the
destination is known — 12 zero bytes then 20 for EVM, all 32 for Sui, base58
over 32 for Solana — and a value whose "padding" is not zero is refused rather
than trimmed into an address that is not the recipient. The nonce is carried as
a string because it is a u64.

Circle's attestation API is deliberately **not** called: an attestation says
Circle signed the message, not that anyone claimed it, so it would add a
third-party dependency for weaker information than the events already give.

### Sui's native bridge (`0xb`)

The strongest cross-chain evidence in the server, and the only case needing no
third party for the destination: the outbound `bridge::TokenDepositedEvent`
carries `target_chain` and `target_address` as raw bytes, so the far side is
**chain-derived**, straight from the event rather than from a payload that
has to be attributed to its sender first.

`(source_chain, seq_num)` is the bridge's transfer id, quoted back by Ethereum
on claim. Sui ↔ Ethereum only; `chain_ids` declares no other route.

Two traps:

- `TokenTransferClaimed` is **inbound** — value arriving on Sui. Reporting it as
  an exit sends an investigator to the wrong chain, so it is parsed by
  `parseClaimEvent` into its own `NativeBridgeClaim` type rather than sharing
  one with the outbound transfer. It still resolves: the claim quotes the origin
  chain's `(source_chain, seq_num)`, which is the mirror of an outbound
  `transfer_id`, so a trace running backwards picks the transfer up on the
  origin chain instead of dead-ending.
- Address fields are raw bytes (base64 over GraphQL). 20 bytes is EVM, 32 is
  Sui; any other length is left undecoded rather than padded into something
  address-shaped that belongs to nobody.

Only bridge chain ids observed on mainnet (0 = Sui, 10 = Ethereum) map to
CAIP-2. Testnet/custom variants are reported by number, same non-guessing rule
as Wormhole.

### Holder scans rank a sample, not the chain

`scanTokenTopHolders` walks `objects(filter: Coin<T>)` in **object-id order**,
which is uncorrelated with balance. A scan that hits `maxScan` therefore returns
the largest holder it SAW. Measured on SUI: top holder 66 SUI at `max_scan` 200,
522 at 400, 3,454 at 800, 25,000 at 5,000, with zero of the top five surviving
from 200 to 800 — while the real top holder holds millions. The answer climbs
with effort and never converges.

So a truncated scan returns `sampled_holders` with no rank and no percentage of
supply, plus a caveat; only a completed scan returns `top_holders` and
`complete_ranking: true`. `analyze_token` makes the same split. A sampled
balance over the real total supply looks authoritative and means nothing, which
is why the percentage is dropped rather than annotated.

**A sampled holder's sum is a floor.** The walk saw only the coin objects in
its sample, so XAGM's largest sampled holder summed to 9.1M of the 24.1M its
address holds. `sampledHolders` reads each sampled holder's whole balance with
`address.balance(coinType)` (20 aliases a request) and keeps the walk's sums as
`*_in_sample`; a failed read is `null` with `balance_unavailable`.

This follows `find_shared_multisig`: refusing beats truncating, because a
partial search cannot support the claim the caller is asking for.

**A coin is held in two places, and both are walked.** Besides `Coin<T>`
objects, an owner can hold `T` in its address balance: a dynamic field of the
accumulator root `0xacc` of type
`0x2::dynamic_field::Field<0x2::accumulator::Key<0x2::balance::Balance<T>>,0x2::accumulator::U128>`,
one per (owner, coin type), owner in `json.name.address`, amount in
`json.value.value`. No coin object shows it. A coin-only walk ranked XAGM
complete without its #2 holder (0xd70a55ed…, 13.74% of supply, all in the
address balance), and USAD has no `Coin<T>` at all: its whole supply is one
address balance. So the scan runs a second walk over that field type and
merges it per holder, keeping `coin_balance` and `address_balance` beside the
total. Each walk gets its own `max_scan` budget and its own truncation flag
(`coin_walk_truncated`, `address_balance_walk_truncated`); `complete_ranking`
needs both to reach the end. The owner of an address balance can be an object
(a bridge `liquidity_pool::Bank`, a DeepBook `BalanceManager`), so each ranked
holder carries `owner_kind` from `describeAddresses`.

Four ways a walk stops, and only one of them is completion. Both walks follow
the same rules:

- `hasNextPage: false` — the end. `complete_ranking: true`.
- **A null `endCursor` while `hasNextPage` is true — TRUNCATION.** The
  connection said there is more and would not say where. The guard that stops
  the walk there was added to prevent a restart from page one, and leaving
  `truncated` alone on that path published a known-incomplete scan as a
  complete ranking, ranks and percentages restored.
- The `max_scan` budget — truncation, already handled.
- The 35s time budget (`SCAN_TIME_BUDGET_MS`), checked between pages —
  truncation, marked `time_budget_reached` and not cached. Both token walks
  run side by side under it (awaited with `Promise.allSettled`, so a
  rejection in one does not leave the other paging in the background past
  the point the caller already got an error). The caveat reports objects,
  pages, elapsed time and the page rate the call observed, then derives the
  cause from `max_scan` (`timeBudgetNote`) using `IDLE_PAGE_MS` and
  `IDLE_KIOSK_PAGE_MS` (a kiosk-held NFT page resolves each kiosk, so it is
  slower; the NFT caveat weights the two by the kiosk share it read). If
  `max_scan` fits inside the budget at the expected rate, the endpoint was
  slow and a retry may go deeper; if not, the caveat names a `max_scan` that
  fits. Never assert one cause for both regimes.

**`complete_ranking` means the walk reached the end, nothing more.** An object
whose owner could not be read is a separate field (`unresolved_owners`) and its
own caveat. Folding it into the flag made the flag permanently false for a
collection with one unreadable owner, while a ranked list sat beside it saying
otherwise, and no value of `max_scan` could ever clear it.

**A walk that found nothing has not ranked anything.** No coin objects and no
address balances reads the same as a mistyped type, a type that lives on
another network, or a coin scanned as a collection. Reporting
`complete_ranking: true, unique_holders: 0` states the opposite of what is
known, and it was then cached for 24 hours.

**Clamp tool numbers at BOTH ends.** `max_scan ?? DEFAULT` keeps a provided `0`,
which left the walk condition false from the start: no request made, empty
result, reported as a complete ranking. A negative `limit` reached
`slice(0, topN)` and silently dropped the last holders.

**A probe that could not run returns null, not the guess it was correcting.**
`looksLikeCoin` returning `false` on a transient error reinstated exactly the
misclassification it exists to prevent, and labelled the empty result complete.
The probe counts a type as a coin when any of four objects exists: a
`Coin<T>`, an address-balance field for `T`, `CoinMetadata<T>`, or a registry
`Currency<T>`. Probing for `Coin<T>` alone sent an address-balance-only coin to
the NFT walk.

Both walks were also missed by the null-cursor sweep in #101 — a null
`endCursor` with `hasNextPage: true` restarted them from page one and added the
same balances twice. Ten other walks carried the guard; these did not.

### An NFT's value is an estimate from its collection's market

`src/utils/valuers/nft.ts` is the `nft` position reader. It is a fallback: a
type another reader handles is valued by that reader, and `value` skips it, so
a wallet total never counts one object twice. An object whose JSON names a
pool or vault and holds a share balance (`receiptOf`: an AlphaFi
`alphapool::Receipt`) is a claim on that pool, not a collectible; with no
reader for its pool it is listed as unread, never valued as an NFT.
`src/utils/nft-market.ts` holds
the pure rule and `src/utils/nft-market-read.ts` finds its inputs. Every value
is tier `heuristic` and carries `detail.estimate: true`. `list_nfts`
(`est_usd` per item to four significant figures; under `valuation`, each
priced collection's unit value and basis within 3,000 characters, and with
`detail: "full"` each collection's floor, last sale and wash check) and
`list_nft_collections` (`value` per row, `estimated_value` over every row
before the cap) show it.

- **The rule.** An item is worth the lower of its collection's floor (the
  lowest active listing) and its last sale in the `MARKET_WINDOW_DAYS` (30)
  before the valuation time. With one of the two, that one is used; with
  neither, the item is unpriced. A live listing always caps a counted sale,
  since anyone can buy at it, but it prices an item alone only when placed or
  repriced inside the window. Measured on a 921-NFT wallet: without that
  condition, three collections whose lowest listings had sat unbought for
  about ten months (100, 10 and 5 SUI, no sale in the window) made up 87% of
  the total.
  An OriginByte ask records no time, so it never prices an item alone. A
  sweep's newest transaction counts its cheapest item.
- **Listings are read at the current state only.** A valuation for a past
  time rests on sales before it, and `value` for a past time returns no
  positions, because holdings are read at the latest state.
- **Where listings come from.** The TradePort orderbook store
  (`0x3af0a943…`) keeps, per collection keyed by its `type_name` string
  (addresses padded with no `0x`, type arguments joined by a bare comma), a
  big vector of listing ids ordered by the index
  `2^127 | price << 64 | sequence`, so its leftmost leaf's first entry is the
  cheapest. Each candidate is confirmed by reading its listing object, which
  is deleted on purchase or cancel. TradePort's earlier kiosk listings are
  `Listing<T>` objects, enumerated by type in id order; their price includes
  TradePort's commission, so a floor from them reads about 3% above the price
  TradePort displays. OriginByte keeps every ask in an `Orderbook<T, SUI>`,
  whose crit-bit outer nodes carry the price. `kiosk::list` listings are found
  through `ItemListed<T>` and confirmed by the kiosk's `Listing` field.
  BlueMove's and TradePort's non-kiosk listings do not carry the collection
  type and are not read.
- **Where sales come from.** A sale mutates the shared object that settles
  it: the collection's `TransferPolicy<T>` when a royalty is paid into it, its
  OriginByte orderbook, or its TradePort orderbook entry. `affectedObject`
  lists only transactions that changed an object, so the policy alone misses
  every sale that pays it nothing. Measured: Gommies' policy was last changed
  in February 2025 while its OriginByte orderbook traded daily in September
  2026. The prices come from the events `get_nft_sales` reads plus
  `kiosk::ItemPurchased<T>`. An event that does not name its collection is
  joined to its item's type, and another collection's sale in the same
  transaction does not count.
- **Wash checks are the cheap ones, and say what they covered.** A zero
  price, one address or one kiosk on both sides, and either side's first
  funder (`firstFunderOf`) being the other. When an event names no seller, the
  signer stands in for the seller if it is not the buyer. `wash_check` states
  what was checked and what could not be, and `excluded_sales` lists each sale
  left out with its reason.
- **What counts as an NFT.** `handles` refuses types defined at `0x1`, `0x2`
  and `0x3`. `valueObject` refuses a type with no market and no `Display<T>`,
  so a protocol receipt no reader handles is never priced as an NFT. That
  test reads `collectionPresence` (policies, orderbooks, TradePort entry,
  Display) before anything else. Presence does not depend on the valuation
  time, so it is read once per type and cached, and a scan that values one
  type at many checkpoints stops a non-NFT after one request. Markets for a
  past time are still read per checkpoint, because the last sale depends on
  it. The TradePort big vector itself is re-read for every current floor,
  since its shape changes with each listing.
- **Kiosk discovery follows OriginByte owner tokens.** An OriginByte kiosk
  keeps its own cap and gives its owner an `ob_kiosk::OwnerToken` naming it,
  so `discoverKiosks` reads those beside `KioskOwnerCap` and
  `PersonalKioskCap`.

Measured against TradePort's displayed floors on 2026-09-27: Prime Machin 102,
Gommies 2.279 (OriginByte), Popkins 76 and Aftermath Egg 24.99 SUI matched
exactly. SuiNS read 0.103 against 0.1 displayed, the commission above.

### An NFT's holder is not its owner field

`get_top_holders` in NFT mode resolves a kiosk-held NFT through
`dynamic_field::Field<kiosk::Item>` to the Kiosk, then reads the Kiosk's own
`owner` field. **That field is self-declared and mutable.** `set_owner` and
`set_owner_custom` write it; nothing updates it when the `KioskOwnerCap` is
transferred, so after a cap changes hands it still names whoever set it last.

Measured on mainnet over 300 sampled `KioskOwnerCap`s, comparing each cap's
real holder against the `owner` field of the kiosk it controls: **121 disagreed,
40.3%**. The disagreement concentrates rather than scattering — one address is
declared by 82 different kiosks, so an unmarked count invents a top holder out
of a platform address and gets a concentration ranking wrong in the direction a
reader will act on.

A production Sui NFT indexer resolves this with a five-step waterfall and does
not use the field at any step:

1. `owner_kind = address` — the object's own owner. Common for airdrops and
   direct mints, rare for anything trading-mediated.
2. `PersonalKioskCap` → human owner. Covers **only** personal kiosks; most
   trading-mediated collections sit in regular `0x2::kiosk::Kiosk` with no such
   chain, and one real collection had 18,825 distinct kiosks with zero of them
   resolvable this way.
3. **The latest sale buyer for that NFT.** This is what actually carries a
   regular kiosk.
4. **The mint transaction's sender**, for an NFT minted into a kiosk and never
   traded. On that same collection this closed the ~30% gap step 3 left.
5. The kiosk id itself, tagged as a kiosk rather than a wallet so consumers can
   de-emphasise it.

Step 3 is now available: `get_nft_sales` (`src/utils/nft-sales.ts` pure,
`src/tools/nft-sales.ts` network) reads marketplace sale events, and every sale
names the buyer beside the buyer's kiosk in one record. That is a chain-derived
statement of ownership at that checkpoint, stored in `kiosk_owners` and
consulted by the holder scan. Both legs are harvested — the seller held its
kiosk just as surely — and a later checkpoint wins, because a kiosk can be sold.
Measured: a 24-hour window across every registered marketplace is 13 requests
for 237 sales and 249 distinct mappings.

Two things the holder scan must keep doing with them. The mapping table is part
of the NFT-mode cache key, because a payload cached without it answered the
caveat's own instruction — run `get_nft_sales` — with the same unresolved
ranking for 24 hours. And a sale-derived owner is a SNAPSHOT at that
checkpoint, so it reports `holder_kind: "kiosk_resolved"` rather than
`"wallet"`: a kiosk can be sold after the sale that named it.

Five rules for extending it:

- **Many sale events do not name the collection.** Measured before TradePort
  bid matches were registered: 70 of 73 mainnet sales carried no `nft_type`.
  Those that do (OriginByte, BlueMove, TradePort's `MatchSingleBidEvent`) emit
  the defining address unprefixed (`2dcd5252…::m::T`), which never compares
  equal to the `0x`-padded form every other surface here uses. `canonicalType`
  fixes the comparison; the missing field cannot be fixed, so those sales are
  counted in `unattributable_sales` and a filtered result that found little
  says why.

- **TradePort settles most of its sales by bid match.** Measured over one
  week of September 2026: over 500 `tradeport_biddings::MatchSingleBidEvent`
  against 327 `BuySimpleListingEvent`. The bid match names the buyer and not
  the seller, who is the transaction's signer.

- **Every event type in `nft-sale-events.json` was confirmed to exist on
  mainnet**, with its field names read off a real event. A type nobody emits
  makes an empty result look like an absence of trading.
- **Field names differ per marketplace and are tried as a list.** BlueMove
  calls the id `item_id` and the price `amount`; OriginByte calls them `nft`
  and uses `buyer_kiosk` rather than `buyer_kiosk_id`. A known type whose shape
  does not parse is counted in `unreadable_events`, never skipped.
- **`priced: false` events record custody with no amount.** A claim event has a
  buyer and no price; counting it as a zero-value sale would drag an average
  down with trades that were never priced. `sales` and `priced_sales` are
  reported separately so volume has a visible denominator.

Step 4 still needs an indexed mint history, which a per-call server
does not have. `trace_object_history` answers it for ONE object, not for a
scan. So the field is still used, because it is the only hint available without
a query per kiosk and it is right about 60% of the time — and every holder it
produced carries a `from_kiosk_owner_field` count beside the caveat. Do not
drop those markers to tidy the payload.

**A single kiosk's cap holder is now answerable directly**, without a scan.
`src/utils/kiosk.ts`'s `resolveKioskCapHolder` finds the kiosk's creation
transaction via `objectVersions(first: 1)` (the earliest retained version,
one request regardless of how busy the kiosk later became — `kiosk::new()`
always creates the `KioskOwnerCap` in that same transaction) and matches the
cap whose `for` field names this kiosk, then reads that cap's own
current owner. The cap is either a top-level output of that transaction or,
when the same transaction wrapped it (`kiosk::new` and `personal_kiosk::new`
in one PTB, the @mysten/kiosk `createPersonal` path, or a cap created inside
another object), embedded as exactly `{ id, for }` in an object it wrote; the
wrapped cap's own row has no output state. `get_object`, `identify_address`
and `trace_object_history`
all call it for a kiosk object — `get_object` only for the LATEST version,
since the cap's current holder is not who controlled a past snapshot, and
`trace_object_history` only attaches the result to its `current` field, never
to `created`, a `history` row or an `owner_changes` endpoint even when they
share the same container address: the cap's holder today is not who
controlled the kiosk THEN. This does not replace the sale-derived scan
above, which ranks MANY kiosks at once — reading each one's creation
transaction is not practical at that scale.

**The cap can be a top-level object OR wrapped inside another one.** A
personal kiosk wraps its `KioskOwnerCap` in a `PersonalKioskCap` the wallet
owns, so `object(address:)` on the cap returns null: the normal state, not a
failure. `followCapWrappers` then looks for what holds it via the cap's own
LAST TOUCH transaction (a kiosk can be made personal well after both
existed). GraphQL renders a wrapped object INLINE as a nested struct, so a
`PersonalKioskCap` reads `{ id, cap: { id, for } }`: the match is on that
embedded struct (the cap's own `id` and `for`, then each wrapper's `id`
beside other fields), never on a bare id string, a field name or the
wrapper's type (published by a Mysten extension package, not `0x2`, so
pinning an id would drift on upgrade).

**A container is named only while it still holds the cap.** Moving a wrapped
cap from one container to another writes both containers and never the cap,
so the cap's last touch can name a container it has left: kiosk 0x34c6a1c8's
cap was created inside a `battle::Battle` and later moved into a
`PersonalKioskCap` by the transaction that deleted the Battle. Each container
found is re-read with its contents, and its owner is `holder` only if those
contents still embed the cap. Otherwise the walk continues from that
container's own last touch, which holds either the next wrapping level or the
cap's new container (the chain then restarts from it), up to
`MAX_WRAP_STEPS`. A container that still exists without the cap and whose
last write names no new one is reported as `cap_left` with a null holder,
never as the controller. `holder` is the outermost wrapper's owner and
`wrapped_in` lists the chain from the cap outwards; a chain that cannot be
followed to a top-level object keeps the wrappers found and a null holder
with `kiosk_cap_holder_note` saying so.
`resolveKioskCapHolder` also never throws: up to 42+ sequential GraphQL reads
means real surface for a 429 or a timeout, and a failure there degrades to
`{ status: "lookup_failed", message }` rather than discarding the object
answer the caller already has. `findEnclosingKiosk` does throw, so
`trace_object_history` catches it and puts the error in `current.owner`'s
`kiosk_cap_holder_note`; keep every kiosk read behind that tool's history
inside a catch.

**`trace_object_history` reaches a busy capability's distant transitions by
checkpoint bisection, not by paging.** A capability mutated on every
privileged call (a nonce, a rate limit) accumulates thousands of versions —
measured on a Volo vault `OperatorCap`: 50 versions two days after creation,
thousands more over the following months. Paging from either end, forward or
backward, cannot reach a transition a bounded number of pages away. Owner is
piecewise-constant between transitions, and `object(atCheckpoint:)`
interpolates to the state as of the last write at or before the checkpoint
asked for, so `findOwnerTransitions` (`src/utils/object-history.ts`) is a
`git bisect`: split any checkpoint range whose two ends disagree, stop where
they agree. Cost is O(transitions × log(range)), not O(versions) — a handful
of real ownership changes found in well under a hundred reads regardless of
how many mutation-only versions sit between them. `objectVersions` itself
also switched direction, from `objectVersionsBefore(last:)` (backward from
"now") to `objectVersions(first:)` (forward from the earliest retained
version): forward paging reaches genesis in one page no matter how busy the
object later became, and — unlike the point lookup `object(address:)` it
replaced as the history source — still returns rows for an object that no
longer exists, which is what let a deleted object's provenance stop erroring
with "not found" at all. Bisection also takes a wall-clock `deadlineMs`
beside its call-count budget: these are sequential GraphQL calls, and a slow
endpoint can blow a client's own deadline well before the call count does.

**Stopping where two probed ends agree is a real blind spot, not a
guarantee.** An A -> B -> A round trip landing entirely between the two
checkpoints bisection probes — a capability handed out and returned, a kiosk
item taken out and placed back — reports zero transitions there,
indistinguishable from an object that never moved: `findOwnerTransitions`
cannot tell "nothing happened" from "happened and reversed" when both ends
agree. `trace_object_history` therefore (1) computes exact owner changes over
the shown `history` PAGE first, since it already holds every version and a
round trip inside it is never missed that way, (2) bisects only from the
page's LAST row to `current` — the actually-unknown gap, not from the page's
first row, which would waste the search budget re-deriving a transition the
page already shows — and (3) never reports a bisected span as complete.
`more_versions_note` and `owner_change_note` say whether a search actually
ran at all (some branches, like a busy+deleted object or a missing
checkpoint on `current`, page the oldest versions only and never search)
before ever claiming anything about the object's "full life".

`order: "newest"` pages back from the current version, so the versions just
before an incident are reachable on a busy shared object. The cursor is a
boundary version (`objectVersions` `filter: {afterVersion|beforeVersion}`,
both exclusive), and every page reads one version past its older edge only
to compute the owner change into its oldest listed row, so a change is never
lost at a page boundary. The search covers only the span beyond the page in
its paging direction: oldest first from the last shown row to `current`,
newest first from the earliest retained version to the version before the
page. `created` is always read from the earliest retained version, never from
the page's first row.

**The search reads both halves of a range at once, and the span's last
write first.** Volo's OperatorCap has three owner changes after its first 50
versions, the last made by the cap's latest write. Reading one probe at a
time, pinning all three took 77 reads one after another, so the check ran
past the 20 s time budget whenever the endpoint slowed. One read at the
checkpoint before the span's upper end pins a change made by that write, and
splitting each range into two concurrent searches makes wall time follow the
search's depth rather than its read count. A search the budget stops
lists every range it stopped inside in `owner_change_unpinned`, with the
owners at both ends: each holds a change not yet pinned to a transaction,
so a stopped search still says where the missing changes are. At most one
range per read, so the list is bounded by the budget.

`holder_kind` is three-valued — `wallet`, `kiosk_declared`, `mixed` — because
one address can hold some NFTs outright and others through a kiosk. Collapsing
it to two called a holder with three verified NFTs and one kiosk NFT a guess
outright, which a consumer filtering for chain-derived holders would drop.

Two smaller rules from the same path:

- **Select `ConsensusAddressOwner`.** Sampled 300 mainnet objects across five
  types and found none, so this is not fixing a live miscount: it is a schema
  variant the rest of the repo already selects (`trace-read.ts`, `watch-probe.ts`,
  and five more handlers) and the NFT query did not. Cost is three lines of
  query text. If party objects do appear, the alternative is counting a real
  party as an unresolvable owner.
- **`nft-collections.json` is package-keyed, so `collection_name` is
  mainnet-only.** Resolving a name off mainnet fed a mainnet type into another
  network's scan, which then found nothing and said so as though the collection
  were empty. Same rule as `coins.json` and `protocols.json`.

### Store writes: which fail soft, and which must not

A cache or cursor write that fails must never fail the read that produced it.
Those go through `tryWrite`, return a falsy value on failure, and report to
**stderr** — stdout is the MCP transport. `saveFanout`, `saveTransaction`,
`saveFirstFunder`, `saveLabel`, `saveWatch`, `removeWatch` and `advanceWatch`
are all this kind: the measurement already succeeded and the caller is entitled
to it, persisted or not.

This is not hypothetical. An older server process writing into a database a
newer build had migrated failed with `NOT NULL constraint failed:
fanout.sponsored_address_count`, and that took down `get_address_fanout`
entirely rather than returning the fan-out it had just measured. Process and
schema drift apart whenever the server is left running across a rebuild, which
is the normal case during development.

**`saveFinding` and `deleteFinding` are the exception and must keep throwing.**
There the write IS the operation, not a side effect of one: `save_finding`
reports `saved: true`, so a swallowed failure turns that into a claim about
evidence the store never took. "Wrap every writer" is the wrong generalisation,
and the distinction is cache-or-cursor versus record.

Guard the **statement**, not just its inputs. `saveTransaction` was read as
already guarded because it has a try/catch, but that one covers a payload that
will not serialise; the `.run()` beside it was unprotected. A guard over one
failure is not a guard over another.

Do NOT "fix" this by giving the sponsorship columns a DEFAULT. A cached row
reporting 0 there would be claiming "not a sponsor" from data it never read,
which is the failure the column comment already warns about.

**Failing soft is half the contract; the caller must surface it.** A swallowed
failure the tool then reports as success is worse than the crash it replaced,
because nothing anywhere says the write did not happen. Three that had to be
fixed after the guards went in:

- `manage_labels remove` reported the session result only, so a store delete
  that failed left the row to be seeded back at the next start — and a `cex`
  label the investigator believes they retracted keeps terminating traces.
- `manage_labels add` and `import` folded "store is off" and "the write failed"
  into one falsy value, telling the user to set an env var they had already set.
- `watch_addresses remove` rendered a failed delete as `not_watched`, asserting
  an address is not watched while it still is.

`false` from a guarded writer now means "not persisted" and the caller has to
consult `storeStatus()` to say which kind. Anything that reports `saved`,
`added`, `removed` or `deleted` must derive it from the write's result, and
`delete` must check `changes` rather than returning true for an id that matched
nothing.

### Never interpolate an unvalidated address into a batched query

A delta query in `watch-probe.ts` puts twenty addresses into one aliased
GraphQL document, and the service answers a single unparseable `SuiAddress`
with a top-level `data: null` — not a null for that one alias. Verified on
mainnet: a batch of two where one address was `not-an-address` returned no data
for either. So one mistyped address costs every other watched address its poll.

Same rule as digests in `get_transactions`, and it needs its own check for a
reason: `normalizeSuiAddress` **pads without validating**, turning
`not-an-address` into a well-formed-looking 66-character string. Only
`isValidSuiAddress` rejects it. `normalizeWatchAddress` in `src/utils/watch.ts`
is the pair, and it is applied both when a watch is added and when stored rows
are read back.

**There are two aliased-batch sites, not one.** `fetchAuthentication` in
`src/utils/identity.ts` builds the same construction over `transactions`, and
its chunk error is swallowed as "enrichment only" — so one bad address in a
seed list silently removed multisig and zkLogin detection from the other
nineteen, downgrading a real finding to an absent one. It filters before
batching for that reason. A comment asserting the inputs are "hex strings we
normalize" is not a validation; check that such a claim is backed by code.

**Validate the value you are about to SEND.** `normalizeSuiAddress` adds the
`0x` prefix, so `"2"` passes a check applied to the normalized form and is then
rejected by the service — which fails the whole batch, the exact outcome the
check was added to prevent. Both sites now batch the normalized value.

### Watching an investigation, without drowning the agent

`watch_addresses` / `poll_watch`, pure logic in `src/utils/watch.ts`, network in
`watch-probe.ts`. The constraint is arithmetic, and it decides the architecture:

Mainnet runs 4.25 checkpoints and ~74 transactions a second. Subscribing to the
checkpoint stream is **1.1 GB/hour, about 323 million tokens an hour** — a 200k
context fills in 2.2 seconds. Streaming chain data to a model is not expensive,
it is impossible. The same measurement gives the way out: only **160 distinct
addresses** were touched in those 30 seconds, so against a watch set of twenty
the signal is roughly one part in a million.

- **Poll, do not stream.** `afterCheckpoint` on the `transactions` filter is
  EXCLUSIVE — verified on a wallet dead since January: after its last
  checkpoint returns nothing, after the one before returns exactly one. So the
  high-water checkpoint per address gives a delta with no gaps or duplicates,
  at ~60 requests an hour against 1.1 GB. The latency traded away is latency
  nobody consumes. Streaming wins past roughly fifty watched addresses, where
  polling's per-address cost overtakes the stream's flat one.
- **Native gRPC `subscribeCheckpoints` works on the public fullnode** if that
  day comes. The gRPC-Web transport this server uses CANNOT do it (the call
  fails at `fetch`), and the archive answers UNIMPLEMENTED.
- **Two phases, forced by the service.** Measured: 20 aliases of digest +
  checkpoint is 3,917 bytes and accepted; 30 is 5,877 and rejected on the
  5,000-byte cap; 20 aliases WITH balance changes breaks the separate
  300-node limit. So the delta query carries a minimal selection and detail is
  a second fetch made only for digests that moved. That is also why a quiet
  poll costs 13 tokens and one request.
- **A new watch starts at the current checkpoint**, never zero. Seeding at zero
  replays the wallet's whole history into the context on the first poll, which
  is the cost the tool exists to avoid.
- **The cursor advances even when a trigger suppressed every hit.** A filtered
  transaction has still been seen; leaving the cursor behind re-reads it on
  every poll forever.
- **A full page means more happened than was reported.** Measured on a mainnet
  address doing a transaction every two seconds: it fills the cap on every
  poll. `more_pending` says so — a permanently lagging watch that reads as
  complete is the same failure class as everything else in this file.
- **`afterCheckpoint` is exclusive at CHECKPOINT granularity; the page cap cuts
  at TRANSACTION granularity.** So a full page usually ends part-way through a
  checkpoint, and advancing the cursor to that checkpoint excludes the rest of
  it from every future poll. Measured on one mainnet address: 30 transactions
  across 13 checkpoints, 8 of them holding more than one, so a boundary lands
  mid-checkpoint most of the time — and only on the busy addresses this feature
  is for. `safeAdvance` stops one checkpoint short of a saturated page. The
  boundary is then re-read and may be reported twice, which is the right trade:
  re-reporting is recoverable and silent loss is not. A full page inside ONE
  checkpoint has no safe advance at all, so it reports `stalled` rather than
  choosing between looping and dropping.
- **`lookalike_appeared` requires a WATCHED side.** Accepting any pair where
  either side was a new counterparty flagged two counterparties that merely
  resembled each other, and reported it as something impersonating the address
  under investigation.
- **Stored rows are NORMALIZED on read, not merely validated.** Balance changes
  come back canonical padded lowercase, so a row holding `0x2` polls fine and
  then matches none of its own changes: the watched address lands in its own
  counterparty list, every transaction reads as `appeared`, and `min_amount`
  can never apply.
- **`min_amount` is raw integer units and is validated on write AND on read.**
  `"0.5"` threw inside `BigInt` and fell back to no floor at all, so a caller
  asking to see only large movements saw everything and was told nothing. A
  re-add preserves an omitted floor and `"0"` clears one.
- **A FULL page is not the claim "there is more".** `fetchDeltas` asks for
  `perAddress + 1` and reports `perAddress`, so saturation is proven rather
  than inferred — the same bound-not-a-count trick `probeRecipients` uses.
  Reading "full" as "saturated" stalled the cursor on a single new transaction
  at `max_per_address: 1`, where every non-empty page is full and sits in one
  checkpoint.
- **Normalize for COMPARISON, key writes by what the store holds.** The cursor
  UPDATE is keyed on the stored address string, so normalizing a legacy row on
  read fixed balance-change matching and silently stopped the watch advancing:
  the statement matched no row, and `tryWrite` only notices a throw, so it
  reported success. `WatchEntry.store_key` carries the stored spelling, and
  `advanceWatch` returns `changes > 0`. The same trap sits in
  `fetchAuthentication`, whose result map is keyed by the address the CALLER
  passed while the query carries the canonical form.
- **`min_amount` filters VALUE only.** A labelled sink, a capability handover
  or any object move has no amount to measure, so a floor must never suppress
  one.
- **Detail reads object changes, not just balances.** A capability changes
  hands WITHOUT a balance change, which is the transfer most worth waking
  someone for. `affectedAddress` does return those transactions — verified on a
  real UpgradeCap handover, which appears in both parties' histories — so the
  watch already fired on them and only needed to say WHAT moved. Batch is 5
  digests, not 20: object changes are many nodes each and the 300-node limit
  binds long before the byte cap (8 digests = 4,767 bytes, rejected).
- **`flagLookalikes` costs no request.** The watch set and this poll's
  counterparties are already in hand. It fires only when a NEW counterparty
  resembles a WATCHED address — two watched addresses resembling each other is
  a fact about the set, not an event.
- **Every `HitReason` must actually be emitted.** The first version declared
  `capability_moved` and `lookalike_appeared` in the type and produced neither,
  which advertises detection that does not happen.

**Nothing triggers a watch except `poll_watch`.** There is no timer, no push and
no background process; the tool is cheap enough to call on a loop, which is not
the same as monitoring. Say so rather than implying otherwise.

### Address poisoning

`address-lookalike.ts` reports two addresses close enough to be mistaken for
one another. Six rules:

- **Normalize before looking activity up.** The ledger is keyed by the strings
  the chain returned; the subject is whatever the caller typed, and the
  GraphQL API accepts uppercase and unpadded short forms. Keying on the raw
  string lost the subject's own footprint, so it scored zero and the VICTIM was
  named the impostor. Reported addresses are emitted canonical so they match
  themselves in `save_finding` and `export_case`.
- **Direction needs a real margin** (`DIRECTION_MIN_MARGIN`). Dust repeating
  inside one page is the normal shape of this attack, so a 3-vs-1 count is not
  evidence — on the pinned mainnet case the live margin is 4-vs-1, and five
  dust sends invert it. Below the margin the pair is reported unordered.
- **`received` is only ever compared against ZERO.** Raw units are not
  comparable across coin types — 1 unit of an 18-decimal token outranks 5 SUI —
  which `funding.ts` already learned. What carries signal is "received
  nothing".
- **First seen is not existed first.** When footprint and receipts tie, which
  address appeared first in the result decides the pair only in the shape a
  poisoner leaves: the later one first appears in a transaction that credited
  the subject and credited it nothing, within `LIFECYCLE_MAX_GAP_MS` (10
  minutes) of the earlier one, the earlier one first appears some other way
  (being paid, in the payment the dust imitates), and the earlier one's first
  appearance is not the result's oldest row. When both first appear paying
  the subject, a real payer whose earlier payment is off the page and dust
  imitating it look alike, and the pair stays unordered. Plain first-seen order named the real recipient
  the impostor on the pinned pair when the victim paid the lookalike by
  mistake and then re-paid the real address, and again when a page opened on
  the dust after the payment it imitated. Measured gaps are 3.9 s on the
  pinned case and 16 s on both lookalikes that targeted the KONG rug wallets.
  Only `get_transaction_history` records timestamps and the subject, so only
  it can reach this rule.
- **Do not claim the addresses render identically.** At the 8+8 width this
  module itself renders, a 3+4 pair visibly differs. The true claim is that
  they match at both ends, which defeats a glance and a short truncation.
- **The report is always emitted.** `lookalikeReport` returns
  `addresses_compared` and `pairs: []` when nothing matched, and every tool
  that runs the check puts it in its response. An omitted block read as a
  check that never ran, or as a clean wallet. The empty report's note says it
  covers only the addresses in that result.

The rule is a floor of `MIN_PER_END` at each end, and the candidate bucketing
uses the same width. Making the rule asymmetric without changing the bucketing
would put a genuine pair in two buckets and report nothing.

`LookalikeIndex` applies the same rule and the same buckets to addresses met
one at a time, which is how `FlowEngine.connect` decides that a branch to an
address rendering like one already reached is never pruned. It replaced a
scan of every address seen so far, re-normalized on each call: quadratic in a
batch payout's width and synchronous, so a 3,000-recipient airdrop start
digest held the server for 14.6 s.

### Object flow: what moves that is not a coin

A balance change nets each owner's `Coin<T>` objects and address balance per
coin type, so **anything that is not a coin moves without producing one.**
`trace_funds` reads `objectChanges` for that reason; do not remove it on the
grounds that balance changes already cover value. Address-balance deposits and
withdrawals do appear in balance changes, and a coin folded into its owner's
address balance is deleted without any balance change at all.

Measured on mainnet, sampling the transaction that last touched each object:
`package::UpgradeCap` 30 of 30 and `package::Publisher` 30 of 30 produced no
non-gas balance change; `coin::TreasuryCap` 14 of 30.

Seven rules, every one of them a bug that shipped to `main` first:

- **The archive DOES report object changes.** Its gRPC `changedObjects`
  carries `objectType`, `inputOwner` and `outputOwner`, and the read mask
  already requests it. Verified against a digest the fullnode has pruned. Do
  not reintroduce a caveat saying otherwise.
- **Framework types are matched in FULL, never by suffix.** A package may name
  its module `package` and its struct `UpgradeCap`; suffix matching hands an
  airdropped fake the loudest output the tool has. The mirror is worse — naming
  a module `coin` and a struct `Coin` would get an object EXCLUDED as "already
  a balance change" while producing none, invisible in both channels.
  `baseType` pads the defining address so `0x2::` and the padded form meet.
- **Custody is not only address-to-address.** A kiosk-held NFT is owned by the
  Kiosk object, so the ordinary NFT trade reads `object -> object`. Measured
  against four real wallets, filtering to address-to-address missed 10 of 28
  genuine transfers, and `ObjectOwner -> ObjectOwner` was 538 of ~1,240 object
  changes in a recent sample. `custodyChanges` is the filter; there is no
  address-only variant.
- **A capability sent somewhere unspendable is RENOUNCED, not handed over.**
  `upgrade-cap.ts` measured 27 of 30 UpgradeCap departures going to `0x0`/`0x2`.
  Reporting those as handovers made the loudest output wrong ~90% of the time
  for the type that motivated the feature. `renounced_capabilities` is a
  separate field and carries the opposite reading.
- **Old effects do not record the input owner.** Before roughly March 2024
  mainnet returns `inputState: null` for EVERY change — 117 of 117 non-created
  changes at checkpoint 20,000,000. Reading that as "unwrapped" and dropping it
  loses every object transfer over the chain's first year, the era a backward
  trace reaches. It is reported as `appeared` with the ambiguity stated.
- **`appeared` is custody ONLY when it lands on a party** — an address, an
  object or a consensus owner. Admitting every `appeared` turned ordinary
  shared-object traffic into custody changes: a live Pyth price update reported
  three oracle objects as having changed hands, and 58 of 59 movements at
  checkpoint 10,000,000 were storage or shared-object churn. With no recorded
  source, a destination that is merely an ownership state carries no claim.
  After this, those checkpoints report 1 movement each, both genuine.
  `dynamic_field::Field` is excluded outright, like `Coin<T>` — it was 49 of
  those 59.
- **Who can use a capability after it leaves its holder.** Transfer to an
  unspendable address renounces it. Freezing (→ Immutable) renounces only a
  type no function takes by `&` to any effect (UpgradeCap, DenyCap,
  DenyCapV2); a frozen object still passes by `&`, so a frozen
  TreasuryCap (metadata setters, `token::new_policy`), Publisher (Display,
  TransferPolicy, and through a legacy Display the registry Display) or
  custom cap (`_: &AdminCap` checks) is `opened`: usable by every
  transaction. What a `&` function returns counts too: `display::new`'s
  Display reaches `display_registry::migrate_v1_to_v2` and `claim`, a
  `transfer_policy::new` policy clears any kiosk purchase of the type
  (`transfer_policy::confirm_request`), and a `token::new_policy` cap
  confirms any holder's token actions (`token::confirm_with_policy_cap`).
  Sharing (→ Shared) is always `opened`: any transaction can pass a shared
  object by `&mut`, or by value to a function that deletes it, so a shared
  TreasuryCap, DenyCap or UpgradeCap lets anyone mint, freeze or upgrade,
  and a shared DenyCap can be swapped for a pausing DenyCapV2
  (`coin::migrate_regulated_currency_to_v2`). Sharing only works in the
  creating transaction, so an opened cap is often a `created` change, and
  `custodyChanges` must keep it. `capabilities.ts` and `object-flow.ts`
  apply the same rule, both from `CAPABILITY_USES`: each framework function
  that takes a high-consequence type in any mode, what it grants, what a
  `&` grant's output unlocks, and the reviewed ones that grant nothing more.
  Notes name the functions from that table. `test/sui-framework.test.ts`
  checks it against the vendored framework source and fails on a callable
  function the table does not list; a claim about the framework without a
  `FrameworkClaim` is not checked by anything.
- **Classify a capability BEFORE a position name.** `POSITION_NAME` is
  unanchored and matches `Account`, `Obligation`, `Receipt`, `Vault` — testing
  it first turned `custodian_v2::AccountCap` and
  `lending_market::ObligationOwnerCap` into positions. The object that controls
  a position is not the position. `0x2` and `0x3` are curated, so every
  framework type reads as protocol-vouched; keep generic words like `Ticket`
  out of `POSITION_NAME` for that reason.
- **`objectChanges` is paginated, not truncated.** About 1 transaction in 400
  exceeds 50, and a real three-hop trace hit one with 101. The connection is
  ordered by object id, not importance, so keeping the first 50 drops a
  capability transfer on a coin flip. `readAllObjectChanges` walks up to
  `OBJECT_CHANGE_PAGES`, tracks `more` and `cursor` SEPARATELY (a connection
  can claim another page and return a null cursor), and states the cap when it
  hits one.
- **Object counterparties go through identity, labels and the poisoning check.**
  Whoever receives a capability is as much a party as whoever receives a coin.
  `address` AND `consensus` owners count — the query fetches the consensus
  address, so dropping it wastes what was already paid for. Unspendable
  addresses are excluded: a burn address is nobody.
- **The transaction cache is stamped with `TX_METHOD_VERSION`.** Chain data in
  a finalized transaction cannot go stale, but the fields DERIVED at fetch time
  can — object movements are classified on the way in. A row written by an
  earlier build carries that build's classification, so reading it back is not
  a cache hit. Bump the stamp whenever anything derived in `fetchTx` changes
  shape or meaning. Same reasoning as `FUNDING_METHOD_VERSION`.

Two exclusions: `Coin<T>` (already a balance change; reporting both
double-counts the case that always worked) and mutations (an object written to
has not changed hands; shared-object traffic is 92% of transactions).

**A DeFi position is not an asset, and the registry is what says so.** A type
named `Position` proves nothing; a type named `Position` DEFINED BY a package
`lookupProtocol` already vouches for is a financial position. Name-matching
alone would be the guessing this project refuses, so `categorize` promotes to
`defi-position` only behind a resolver.

`high_consequence` is only the five framework types whose powers are stateable
(`UpgradeCap`, `TreasuryCap`, `DenyCap`, `DenyCapV2`, `Publisher`). A protocol's
own `AdminCap` is a capability with no claim about what it grants.

`object_flow.capability_transfers` (`trace_funds`) is broader than
`high_consequence`: it is every custody change whose `category` is
`"capability"`, the same suffix-and-curated-type test `categorize` already
uses. Filtering it down to `high_consequence` alone reported an empty list
for a Volo `vault::OperatorCap` handover — a real capability handover, just
not one of the five 0x2 types — while the hop's own `object_transfers`
correctly named it `category: "capability"`.

Base rate is low and the sampling lesson is the bridge one again: 0 object
transfers between addresses in 700 consecutive mainnet transactions, because
recent traffic is DeFi mutating shared objects. Sample where caps and NFTs
live, not by volume.

### Detecting a bridge exit vs. resolving one

Keep these apart — conflating them is what makes "support every bridge" sound
impossible.

**Detection** (did value leave, through what?) generalizes cheaply and lives in
`src/utils/bridge/detect.ts`. Two tiers:

1. Curated `callMarkers` / `eventMarkers` per protocol, matched by
   `module::function` *suffix and prefix* so they survive package upgrades and
   name variants (mainnet CCTP calls
   `deposit_for_burn_with_caller_with_package_auth`, not the bare name). A
   call whose prefix would catch a sibling goes in `exactCallMarkers`:
   LayerZero's `endpoint_v2::send` shares a prefix with `send_compose`, which
   is not an exit. Event types are compared with their type arguments
   stripped, on the whole `::module::Name` tail: a generic event ends in its
   type argument. An event marker written `0xpkg::module::Name` also pins the
   package (`matchesEvent` in `event-type.ts`). Pinning is safe for events,
   because an event is typed at the package that defined it and an upgrade
   does not change that; it is not safe for calls, which name the version
   called. Generic names (`events::TokensSentEvent`, `peg_bridge::BurnEvent`,
   `init_order::OrderCreated`) are only ever matched pinned.
2. Any package `lookupProtocol` types as `bridge` **and that has no curated
   entry**. This is free and automatic: adding a bridge to `protocols.json`
   gives detection immediately, and via lineage roots it keeps working after
   that bridge upgrades. A protocol with curated markers is decided by its
   markers alone. Every Pyth price update calls Wormhole core's
   `vaa::parse_and_verify`, and a call into the package reported a NAVI
   deposit as value leaving Sui.

**Resolution** (where did it land?) does *not* generalize — each protocol has
its own identity scheme and its own index — so each resolver is bespoke.
`BridgeProtocol.resolution` records which a protocol has: `identifier` means
`resolve_bridge_transfer` reads its destination or its cross-chain identity,
`detect-only` means we can name it and no more (Meson). Never point a caller
at a resolver that cannot help them; `resolvableHit()` is the guard.

Markers must be **distinctive**, not merely present. A generic name like
`init_order` collides with DEX order books, which emit some of the
highest-frequency events on mainnet: the Mayan MCTP markers carry `mctp`, and
Mayan Swift's events are pinned to its package. Sample before adding.
`node scripts/find-unknown-packages.mjs` ranks by call count, but bridge
traffic is low-frequency relative to DEX and oracle activity, so volume
sampling will *not* surface bridges. Probe candidate event types by name
instead.

A redemption of a transfer arriving on Sui is never an exit. Detection has no
marker for one; `resolve_bridge_transfer` reports it under `*_inbound`.

A **failed transaction is checked before any of this.** A Move abort reverts
every effect but the gas charge, so a bridge call in the PTB's declared
commands never ran — but `detectBridges` reads calls from the PTB's shape,
which is present whether or not execution reached them. `resolve_bridge_transfer`
reads GraphQL's `effects.status`; `FAILURE` short-circuits before any
bridge section is built and reports `status`, `failure` (the same shape
`get_transactions` names, via the now-exported `failureFromGraphql`) and a
note that nothing crossed a bridge, rather than following the aborted call
into "the funds did leave". Verified against the Typus second wallet's
izg6h1Er…, which aborted with `INSUFFICIENT_COIN_BALANCE` inside a Mayan
MCTP order and moved nothing but gas.

Detection has deliberately **no heuristic tier**: `detectBridges` never calls
an unknown package a bridge, so no exit, carrier or beneficiary rests on a
guess. A bridge with no marker still has to say where its value goes, though,
so `cross-chain.ts` reads every event no curated reader or bridge-typed
registry package covers for a field named for a chain (`chain`, `domain`,
`eid`) holding a number, beside a 20- or 32-byte string (base64, a byte array,
or 20-byte hex; a 32-byte hex string is a Sui address and is skipped). 32
random bytes count only left-padded like a 20-byte address or under a field
named for a party: on the Volo LayerZero exit `GqFPRF2e…` the OFT app's own
`OFTSentEvent` carries `dst_eid` and a 32-byte `guid`, which read as a
recipient before that rule. A lead whose recipient a curated reader already
decoded from the same transaction restates that transfer and is dropped. The
pair is reported apart, as `cross_chain_leads` with evidence `heuristic`, the
recipient bytes raw and a direction from the field names: by
`resolve_bridge_transfer` over the whole transaction, by
`summarize_address_flows` over up to `LEAD_READ_LIMIT` (20) sends of the
subject in which value reached no address, and by the flow graph on each
consumed or retained terminal (`LEAD_READS`, 20 per graph), which graph_json
carries in the node's attributes. Without it an unknown bridge's
exit read as value consumed by a contract. A lead never ends a trace or names
a beneficiary.

`0xb` is in `protocols.json` as `Sui Bridge`, type `bridge`, so decoding and
identification name it and a call to it other than `send_token` is no exit
(the curated entry decides). The plumbing packages that four places leave out
(protocols named in a case diagram, events kept when a transaction's events
fold, calls ordered first on a command page, legs of a participant P&L) are
`isPlumbingPackage` in `system-packages.ts`: 0x1, 0x2 and 0x3. The bridge
(0xb) and DeepBook v1 (0xdee9) are system packages too, and `SYSTEM_PACKAGE`
in the same file matches them, but their shared objects hold users' value,
so a call into either is a leg like any protocol's and stays in all four.

Detect from **Move calls and events, not sink labels.** A bridge burns or
locks the coin and emits a message; it does not transfer value to a labelable
recipient wallet, so `isSink` never fires on a real bridge exit and only one
address label ships at all. `trace_funds` runs `detectBridges` over each hop's
calls and event types and emits `bridge_exits`. The events are not optional: a
wrapper such as Mayan's `bridge_with_fee` puts no marker call in the PTB, and
its CCTP burn and Wormhole message are only visible as events.

### How `trace_funds` picks the next hop

Pure logic in `src/utils/trace-hop.ts`; the transaction read and the searches
in `src/utils/trace-read.ts`, which `trace_flow_graph` shares.
Rules a change is likely to break:

- **Gas is removed before any SUI comparison.** The gas payer's SUI change
  includes gas, so without this every transaction reads as a SUI outflow.
- **Forward follows the tracked coin.** On a plain hop only recipients of the
  tracked coin are candidates, and the next hop is the recipient's first sent
  transaction that spends that coin (up to 500 scanned), not its next
  transaction of any kind.
- **The actor is followed when nobody else received anything**: a swap
  (`swap-follow`), an exploit, withdrawal or claim that credits only its caller
  (`self-credit`), or the actor turning one asset into another (`conversion`).
  None of these is a cycle.
- **A swap is read from the values, not only the name.** `isSwapShape`: the
  sender net spent the tracked coin, net gained a different one, and other
  addresses took less than half of what it spent in the tracked coin, so the
  rest went into an object. When both sides are priced the gains must be
  worth a tenth of the tracked coin no address took, so a reward claimed
  beside a deposit and a payment does not read as the swap and steal the
  payee's branch. That follows the swapper through a swap that also
  pays a fee collector, which without a call named `swap` sent the trace to
  the collector. `isSwapHop` still matches a named swap. A flash swap nets to
  nothing and matches neither. Backward, the actor paying another coin in for
  the tracked one is `swap-follow` by the same reading, and the flow graph
  labels the holder's own gains in a conversion `swap-follow` whatever the
  calls are named.
- **An object cannot send.** When the recipient has sent nothing since the hop,
  the next hop is the first later transaction in which its balance of the coin
  goes down, found through `affectedAddress` and marked
  `reached_via: "released-from-object"`; the custody check does not apply.
- **The next hop is the largest spend of what arrived.** `findNextForward`
  reads the holder's spends until they cover what the previous hop delivered
  (at most `MOVES_PER_NODE`, 20) and follows the largest; the others are the
  hop's `unfollowed_spends`. A small transfer sent before the bulk payment
  is not where the funds went. Without a delivered amount it takes
  the first spend.
- **A deposit the holder keeps a claim on is not a hop.** `claimCoinsKept`:
  the holder spent the tracked coin, no other address gained anything, and it
  gained a coin generic over the tracked one (`LP<SUI, X>`, `MarketCoin<SUI>`).
  The value is still the holder's while it holds the claim, so the search
  passes over it and lists it in the next hop's `kept_as_claim`. A later
  transaction the search reads that passes the claim coin to another address
  (`passesClaim`) turns the deposit back into a spend in its place, followed
  as a conversion into the claim coin; redeeming or burning the claim does
  not. Before this, an
  exploiter adding liquidity in the next attack batch was followed into the
  swap's dust output and reported as never having spent the SUI it later
  bridged. A deposit that leaves only a receipt object still reads as
  consumed.
- **Backward follows who paid the coin in**, which is the owner of the largest
  decrease, not the sender. Then the payer's most recent earlier inflow of that
  coin, walking newest to oldest. A `last` page arrives ascending, so taking
  its first element picks the oldest.
- **A hub ends the trace.** A new party with 100+ counterparties in its last
  200 transactions (`measureFanout`) pools other people's money, so its earlier
  inflows (backward) are not these funds. Forward, the pooling is on the inflow
  side: it stops only when 100+ distinct senders pay into it
  (`sender_classification`, the same cut on `sender_count`). A theft wallet or
  an operator's disperser, paid by a few and paying hundreds, passes on what
  those few sent, so its outflows are followed with the mixing flagged hop by
  hop. A sender count of unknown width stops, and a wallet labelled malicious
  never stops a forward trace. `stopsAsHub` in `trace-read.ts` is the one rule
  `trace_funds`, `trace_flow_graph` and `find_flow_path` share.
- **A transaction its sender did not sign ends a forward trace.** The signer
  acted for the sender (an alias or a protocol substitution), and following on
  would attribute its actions to the sender.
- **`stop_reason` is always set**, with the same name `find_funding_source`
  uses. A trace that just ends reads as "the money stopped here".

### Flow graphs: `trace_flow_graph` and `find_flow_path`

Pure split and accounting rules in `src/utils/flow-graph.ts`, the BFS in
`src/utils/flow-engine.ts`, renderers in `src/utils/flow-export.ts`. Rules a
change is likely to break:

- **The trunk reads as many moves as the start.** A node carrying more than
  half the traced value is the start's continuation and gets
  `MOVES_PER_START_ADDRESS` instead of `MOVES_PER_NODE`, both directions. At
  most one node per level can hold over half, so this adds at most one
  large read per level. Otherwise a wallet passing most of the value on in
  more than 20 lots ends as a budget stop before its later lots.
- **A path search that finds nothing names what the node limit left.**
  `FlowEngine.nodeLimited` records each job the node limit stopped, and
  `find_flow_path` reports them as `explored.node_limited`, per side
  (`forward` as a share of what `from` moved, `backward` of what `to`
  received), each node once with its arrivals summed. Reading the trunk's every lot fans a graph out, so the node
  limit, which a caller can raise, is often the bound that decided.
- **The default response fits a budget.** `trace_flow_graph` caps `nodes`
  (9k characters) and `edges` (11k) through `capPayload`, largest
  `traced_share` first, and keeps every non-address node (exits, consumed,
  retained), every node with a stop, label, non-wallet kind or lookalike, and
  every edge into one. Terminals, coverage and shares are computed over the
  whole graph first; `detail: "full"` returns every row. `unpriced_coins`
  groups coin types by the reason, which a graph through meme-coin pools
  repeats a hundred times.
- **Shares are first in, first out, and that is a convention.** A node's traced
  amount goes to the transactions that moved it in order until it is used up;
  each transaction's share goes to the parties it paid in proportion to the
  amounts. An edge carries `amount` (what the party gained or paid on chain,
  summed over its digests) and `traced` (the traced part): a wallet that
  received 400 and paid 1,000 passes on 400. Never follow the full 1,000 as if
  it were these funds, and never let `traced` exceed `amount`.
- **On a bridge exit the unpaid remainder is the exit.** Every Nemo CCTP burn
  pays its relayer a SUI gas drop, and without `bridgeExit` the USDC read as
  converted into the relayer's SUI and the graph walked off into a relayer
  wallet instead of reaching the exit. Backward, a bridge marker does not
  change the split: every marker `detectBridges` knows is outbound.
- **Swap proceeds follow the traced input's part of the input.** A swap that
  spent 0.1 SUI and 18,000 USDT for 18,000 USDC did not turn the SUI into
  18,000 USDC. `splitSpend` scales the proceeds by the traced coin's value
  share of what the holder put in that no address took in the same coin. The
  proceeds are the holder's own gains and what other addresses took out beyond
  what the holder paid them in the same coin, so a PTB that swaps SUI into
  USDC, adds USDC the holder held and pays it all out carries the swap on the
  SUI leg and the held USDC on the USDC leg. A direct recipient of the traced
  coin carries at most what the holder spent of it. `splitInflow` mirrors both
  rules backward: a payer carries at most the recipient's inflow, and the rest
  came from what went into the transaction that no address took, at the
  address that paid it in. That is the payer's own swap input when the payer
  swapped into the coin it paid, and the recipient's only when the recipient
  sent the transaction. When one side of a conversion has a part with no
  price and the other side is fully priced, that part is worth the difference
  (`conversionWeights`), so an unpriced coin bought or sold for a priced one
  keeps the swap's value. A transaction whose proceeds are worth less than a
  tenth of what the holder put in, both at market prices
  (`DUST_RETURN_RATIO`), converts only the part of the outflow the proceeds
  are worth, whatever its calls are named. Where the rest went is read from
  object flow (`FetchedTx.written`, from either transport's object changes).
  When the holder is left owning a non-coin object the transaction created,
  transferred or wrote in place (a receipt, or its existing obligation or
  position, `receivedClaim`), it is a deposit and the rest is `consumed`.
  `retained` needs the object changes to show the holder holds nothing: read
  in full, no such object, and no dynamic field written, since a table keyed
  by address keeps an account the changes cannot attribute. Then the
  counterparty kept it, a node named after the shared objects the
  transaction wrote, or the calls. Anything else, a row cached before these
  were recorded included, stays `consumed`. Reading only new objects called
  a deposit into an existing position with a small borrow `retained`. Converting a sale at a few percent of market value in
  full followed the proceeds and never showed the pool that kept 95%, which
  is how value sold into a pool the seller controls is later withdrawn from
  another address. The swap-name exemption and the deposit-name regex are
  gone. `splitInflow` mirrors the rule: inputs worth
  less than a tenth of what the conversion produced are a fee paid on a
  withdrawal, so they explain only their own worth of the inflow and the rest
  is `source`. A backward swap is not exempt, so an exploit that drains a pool
  through a swap-named call still ends at the pool.
- **A malicious label does not stop the graph**, and neither the start address
  nor the same actor continuing is checked against sinks, protocols or hubs. The
  shipped disclosed labels name both exploiters, so stopping there ended every
  graph at hop 1. Exchanges, bridges, mixers and burn addresses still end it.
  `malicious` is therefore not in `SINK_CATEGORIES`: every `is_sink` a tool
  reports must agree with what the traces do. Watches still alert on it
  through `isWatchAlert`.
- **Level order until the node limit binds, heaviest first after.** While
  the node limit left covers every queued node not yet expanded, the engine
  expands the shallowest job, so branches that reconverge on a wallet all
  merge into its job before it is expanded. Pure best-first expanded such a
  wallet once per arriving branch and cut the fifth arrival off at
  `EXPANSIONS_PER_NODE` as a truncating `budget`. Once the queued nodes
  outnumber the limit left, the job carrying the largest share goes next,
  whatever its depth. Level by level, a trunk that paid 25 light wallets a
  level before its heavy lots spent the node limit on the light wallets and
  never reached the lot that bridged out. `find_flow_path` interleaves its
  two engines one node at a time and keeps only paths within `max_hops`
  transfers. Arrivals at a node still queued merge into its job. A node reached again after it was expanded is expanded
  again from the new arrival, skipping transactions already allocated to it, unless the value
  left the address and came back along its own path, which is a `cycle`
  (`returnsTo`). A swap-follow edge stays at the holder, so value converting
  coins in place has not left: when the Volo attacker's SUI (swapped from
  XAUm) became USDC after its USDC node was expanded, reading the address
  alone as the path called 11.59% of the drain a cycle, though that USDC went
  out through the same CCTP burns. Value another address passes back to the
  start address of a coin-null address start is a `cycle` at any size, never
  pruned, when the start node read every move in the window: that node
  already counts every move of the address. A `coin_type` start counts only
  its own coin, and a start node that stopped at its move limit missed some
  moves, so there the returned value is expanded like any other arrival, and
  `returnsTo` does not end it as a cycle at the start address either. A
  search stopped by its cap before the last inflow of its oldest page has
  not read every move (`scanPriorInflows`), and one whose last spend was the
  last of its last page has (`scanForwardSpends`).
- **An address-start root traces every coin a transaction moved, and counts a
  conversion in place once.** Its scan reads every spend (or inflow) of every
  coin at the address, so each transaction is split once per coin it paid out
  (or took in), weighted by value. A later leg of the root that moves a coin
  the address converted into in place (forward, a spend of the proceeds;
  backward, an older inflow of the coin it paid in) already counts that
  value. `RootPools` takes the transactions in scan order, lets each leg in a
  coin draw on the in-place branches in that coin opened before it, and
  `rootPlan` drops the part drawn. What no leg drew stays at the start address
  in that coin with its share: `unspent` forward and `source` backward, or
  `budget` when the scan stopped at its move limit. Following the whole
  conversion to a coin node of the same address would give the drawn part a
  second share, which that node can only end as a `cycle` once it finds the
  root's claims. A transaction the root could not read is split from the
  balance changes of its search row, so it draws and opens conversions like
  any other, and ends as `read_failed` with the graph truncated whatever it
  weighed. A row carries no events, so a bridge marker cannot be seen there:
  when both sides are priced, the split converts only the part of the outflow
  its proceeds are worth (`capToProceeds`). When the row itself lacks some
  balance changes, every conversion still open when it drew may have been
  moved by it, and what stays of those ends as `read_failed`, never as held.
  A coin with no price is valued at the rate its draws carried before the leg
  is split, so a conversion with no price on either side keeps the value of
  the one it spent. A leg weighs the market USD of what it moved, then the
  priced side of its own split, then the rate its draws carried, and a branch
  back to the start address that carries no amount is never held.
- **`budget` is never an ending.** Depth, node, move and read limits are
  reported as `budget` with `coverage.truncated`; `below_threshold` is the
  pruned share, not where the money went. A start node has no amount to
  cover, so when its search stops at its move or page limit no share is
  uncovered and no `budget` share is recorded: it sets `coverage.truncated`
  and states the limit in `coverage.partial` and in the summary of both flow
  tools, which advise narrowing the window.
- **A graph from one transaction follows that transaction's coins.** From the
  Cetus exploit `DVMG3B2…` (SUI and haSUI) the value goes to the second wallet
  `0xcd8962…` and the validator-signed recovery (`signer_not_sender`), with no
  bridge exit: the attacker bridged USDC drained in other transactions. Start
  from the attacker's address after the exploit time to see every exit.
- **Beneficiaries are read per exit from the transaction's events**, GraphQL
  first and the archive's gRPC events for a transaction GraphQL answers without
  them, through `readBridgeEvents` (the same reading `resolve_bridge_transfer`
  uses). Exits are grouped by protocol and beneficiary account, and a
  transaction's beneficiaries join its exit once however many of its coins
  reach it.
- **A path is the shortest explored route.** `shortestPath` walks the
  explored edges from the roots, fewest edges first. The edge that first
  reached a node can lie on a heavier, longer route, and a path rebuilt from
  it can exceed `max_hops` while a shorter explored route exists.
- **`find_flow_path` joins in time order.** A forward node meets a backward node
  at the same address only when the forward side arrived no later than the
  backward side paid on toward the target. A foreign-chain target is reached
  forward only, through an exit whose beneficiary matches.
- **Mermaid ids are `n0`, `n1`, …, never the caller's ids**, and labels go
  through `mermaidText`, which escapes `#` before the entities it inserts.
  `test/flow-export.test.ts` checks the output line by line against the
  flowchart forms the renderer emits.

### Shipped labels, screening and scam lists

- **Shipped disclosed labels are first-party disclosures only**, generated into
  `src/data/disclosed-labels.json` by `npm run sync:disclosed-labels`: exchange
  proof-of-reserves lists (`proof-of-reserves-listed`), bridge deployment docs
  (`official-docs`), attackers named in the victim's own incident report
  (`victim-postmortem`). Every entry carries entity, evidence, source_url and
  retrieved_at, and the script drops any address not found in its document.
  Keys are `sui:mainnet:` or `eip155:1:`. OKX signs each address, but the
  scheme has not been reproduced, so OKX rows claim a listing, nothing more.
- **Every surface that shows a label shows its provenance** (`labelProvenance`).
- **Inferred deposit labels are a tier below every other label.**
  `npm run sync:labels` (`scripts/sync-deposit-labels.mjs`, rule in
  `src/utils/deposit-labels.ts`) writes `src/data/deposit-labels.json` from
  the senders into each disclosed exchange wallet: an address is kept when
  `classify_deposit_address` would read it `likely` against that disclosed
  wallet (the same `readDepositPattern` and `decideDepositVerdict`, so every
  outflow is a full-balance sweep into one wallet) with at least two sweeps.
  Sweeping whole balances into an exchange is also what a poisoner's
  lookalike does with dust and what an exchange's own operational addresses
  do, so a candidate is also dropped when it is one side of a lookalike pair
  among the wallet's counterparties (`lookalikeSuspects`), when everything it
  received in a coin it later swept (a SUI gas top-up does not count) came
  from its own sweep sponsor, the same exchange's wallets or
  where the swept-to wallet itself sweeps, and when a sweep sponsor measures
  as anything but a relayer (`sponsorRejection`; the exchange's own wallet
  may pay the gas, an unmeasured sponsor fails). A disclosed wallet that is
  deposit-shaped itself (`isDepositShaped`) is never a sweep target. A
  disclosed or curated address, an object, a curated protocol and an address
  sweeping to two exchanges are never labelled. The label names the exchange
  only (`<Exchange> deposit address (inferred)`, category `cex`, confidence
  medium, source `inferred`, evidence `sweep-pattern`) and carries
  `inferred_from` (the wallet, sweep count, latest sweep digests); an entry
  without it is not loaded. Precedence: session > override > curated >
  disclosed > inferred. It is a sink, and a stop at one says it was inferred
  and how to trace past it (`inferredLabelNote`). `classify_deposit_address`
  never counts an inferred label as an exchange destination, or a wallet
  paying into a deposit address would read as one, and `manage_labels export`
  leaves inferred labels out, since an import would make them session labels.
  Keys are `sui:mainnet:`. No private case address goes in: `--exclude FILE`
  drops the addresses in FILE before anything is read, so they are never
  stored in the progress file or counted per exchange, and the script refuses
  to run without `--exclude` or `--no-exclude` once a file was built with
  exclusions. The progress file is owner-only and reused only on the same
  day with the same bounds and rule inputs. A run with any candidate unread
  or sponsor unmeasured writes nothing, since the next run rechecks only the
  labels in the file; a same-day rerun retries only the failures.
- **A sponsor's SUI change is never a payment.** Sweeps delete coin objects and
  the storage rebate goes to the gas payer, so the sponsor shows a positive SUI
  change. `isSponsorGasChange` (`src/utils/sponsor-gas.ts`) is the one rule, and
  fan-out, the recipient probes, co-funding denominators, deposit detection,
  screening and `summarize_address_flows` all skip it. Only a sponsor that is
  not the sender is gas-only; a self-paid sender's SUI change carries payments.
- **A counterparty's side is read per coin.** `counterpartySides`
  (`src/utils/fanout.ts`) calls an address a recipient when it gained a coin
  the subject lost on net, and a sender when it lost a coin the subject gained.
  Fan-out and the wallet-edge probe used the first of the subject's rows
  GraphQL listed, whatever its coin, so a positive SUI row sorting first hid
  the payee of an IKA transfer (4b4KuDfY…). The change moved stored fan-out
  numbers, so `FANOUT_METHOD_VERSION` went to 5: a fan-out row is keyed on the
  account alone and served for 7 days, and a rule change that leaves the
  version alone keeps serving the old counts beside fresh ones.
- **Screening reads `sent` windows for outgoing value and bridge exits.** An
  exploiter's wallet collects airdrop spam afterwards; the Cetus attacker's
  last 100 affected transactions contain no exit, its last 100 sent ones
  contain 100+. Bridge exposure counts curated call and event markers, never
  the registry tier, which fires on price-VAA verification. Event markers
  matter because a wrapper such as Mayan's `bridge_with_fee` has no marker call.
- **OFAC lists zero Sui addresses** (SDN data as of 2026-09-23). Sanctions hits
  can only come from the chain-derived `beneficiaries` of a bridge exit, read
  once per exit transaction and attributed to the protocol that names them.
- **The Sui wallet blocklist is `flagged_by`, tier third-party**, never a label
  or a sink, and mainnet-only (package-keyed). Package ids are stored as
  16-hex prefixes to keep the file near 2 MB; domains are not synced.

### Historical prices

`priceUsdAtTime` (`src/utils/valuation.ts`) is the one historical path, and
`trace_funds`, `get_token_prices` with `at`, `analyze_attack_tx` and
`summarize_incident_losses` all use it. Six rules:

- **DefiLlama is the keyless source, and its key is the PADDED coin type.**
  `sui:0x2::sui::SUI` resolves, but a stripped leading zero does not:
  `sui:0x6864a6f9…::cetus::CETUS` returns nothing where `sui:0x06864a6f9…`
  returns CETUS. A replay that stripped zeros lost CETUS and priced 96 of 195
  Cetus-exploit coins; padded, it prices 103. `defiLlamaKey` pads; do not build
  the key anywhere else.
- **Pyth is asked about VERIFIED coins only.** Its feeds are found by symbol,
  so an impostor ending `::sui::SUI` would get SUI's price. DefiLlama keys on
  the full type and prices a coin as itself or not at all.
- **A Sui Bridge token with no DefiLlama price of its own is priced as its
  Ethereum asset.** `SUI_BRIDGE_ASSET` in `price-providers.ts` lists the four
  tokens `0xb::treasury::NewTokenEvent` registered (ids 1, 2, 4, 6), each
  minted 1:1 against the asset the bridge locks, keyed to that asset's
  `coingecko:` id; the quote carries `priced_as`. DefiLlama had no price for
  the Sui Bridge USDT or wBTC at 2025-05-22, which left 19.0M USDT out of the
  Cetus total. Only these exact types qualify: a coin named `USDT` elsewhere
  gets nothing.
- **`compare_oracle_price` stays Pyth-only** (`sources: ["pyth"]`). Comparing
  DeepBook against a market aggregate is not an oracle check. The market
  price is a candle's close, so the oracle is read at the candle's end (or the
  window's end for a candle still open), never at its open: read at the open,
  a `1d` candle compares a day's price move. Without `PYTH_API_KEY` nothing is
  compared: `oracle_unavailable` says so and `flagged_count` is null, because
  zero flagged candles reads as agreement.
- **The 24h change comes from DefiLlama's `/percentage`**
  (`fetchDefiLlamaChange24h`). Aftermath's `priceChange24HoursPercentage` is
  0.0 for every coin (SUI read 0 on a day it rose 17%), so `get_token_prices`
  and `analyze_token` never use it. A coin DefiLlama does not list gets null.
- **An unpriced coin carries a code.** `request_failed` says nothing about the
  coin and must not be reported the way `not_listed` is.

DefiLlama returns the sample it used, which can be hours from the second asked
for: 50 of 103 Cetus-exploit prices at 10:30 UTC were more than an hour away.
Report `price_offset_sec`; the stale flag is `PRICE_STALE_THRESHOLD_SEC`.

### Position value

What a wallet holds beyond plain coins is valued through one registry
(`src/utils/position-value.ts`). Each reader lives in
`src/utils/valuers/<name>.ts`, registers itself, and is loaded by
`src/utils/valuers/index.ts`; a tool imports that index and reads positions
only through `valuePositions` (an owner's holdings) or `valueObjects` (given
objects, e.g. ones a transaction moved). Shared helpers are in
`src/utils/valuers/common.ts`. Rules a change is likely to break:

- **A value past what any protocol holds is a reading error.** A position
  valued above `MAX_PLAUSIBLE_USD` ($10B) is moved to `unread` by
  `valuePositions` and `valueObjects`, never summed; a CLMM position whose
  amounts exceed its pool's reserves (liquidity minted through an overflow,
  as in the Cetus exploit) is left unread by the CLMM reader first.
- **Every value states its method and tier.** A `ValuedPosition` carries its
  asset legs, `usd_net` (null when any non-zero leg has no price, with
  `unpriced_reason`), a one-sentence `method` and a `tier`. Amounts read
  from chain and priced by a provider are `price-provider`; NFT values are
  `heuristic` and every total keeps them apart as estimates. A reader that
  throws, or an object it cannot read, goes to `unread` and never hides the
  others.
- **Historical state is read at the checkpoint.** With `atCheckpoint`,
  `readObjects` asks GraphQL `multiGetObjects` for each protocol object at
  that checkpoint (verified on 2024 checkpoints), falls back to the latest
  state for one it cannot give, and `stateNote` puts which in the method.
  Prices come at the checkpoint's time unless `atTime` is given. A request
  is capped at 5,000 bytes with its variables, so multi-gets are 40 keys.
- **One reader per object type, specific before broad.** `valueObjects`
  gives an object to the first reader whose `handles` accepts its type,
  `fallback` readers last (held balances, then NFTs); `readerFor` answers
  the same question, so a broad reader skips types another reader owns. A
  fallback reader whose answer rests on chain data (a type's field layout)
  reads it in `prepare`, which `valueObjects` runs first and a caller of
  `readerFor` about fallbacks runs through `prepareReaders`. When a fallback
  reader reaches an object a specific reader also valued (wrapped inside
  another object, say), `valuePositions` keeps the specific one.
- **A coin a position values is counted once.** A position backed by a coin
  the wallet holds (a liquid-staking or LP coin) names it in
  `detail.receipt_coin_types`; `get_wallet_overview` marks that holding
  `value_counted_in: "positions"` and leaves it out of the coin total when
  the position is priced.
- **Staked SUI is worth what `withdraw_stake` would pay.** The principal in
  pool tokens at the activation epoch's rate, converted back at the
  valuation epoch's rate, integer division at each step, reward never
  negative; a stake not yet active has none. Rates are entries of the
  pool's `exchange_rates` table keyed by epoch, written once, so a past
  epoch reads the same way (the latest entry at or below it, clamped to a
  deactivated pool's last epoch). Pools come from the validator set's
  JSON, then the inactive table's versioned wrapper, then
  `staking_pool_mappings` (pending, 1:1). Checked against four
  `UnstakingRequestEvent`s' `reward_amount`: exact. `FungibleStakedSui`
  converts its pool tokens at the epoch rate.
- **A liquid-staking coin is worth its issuer's own rate.** Rebuilt from the
  issuer's fields with its rounding: every SpringSui-framework LST from its
  `LiquidStakingInfo<T>` (the set listed by type and cached), afSUI,
  haSUI, and vSUI through Volo's stake pool (its older native pool before
  that pool existed). Checked against each issuer's view function and past
  mint events.
- **A CLMM position is its liquidity at the pool's sqrt price.** Cetus-family
  tick math (Cetus, Bluefin, Momentum, FlowX CLMM, Magma, Turbos, each
  checked from bytecode and against removal events), rounded down as on
  removal. Cetus and Magma read the pool's own record of the position,
  which the protocol's amounts view follows and which can differ from the
  object. Fees earned since the position was last touched are not
  computed; the method says so. AMM LP shares are the share of the pool's
  reserves (Aftermath, FlowX v2 with its pending fee mint, Kriya v2).
- **An object is worth the balances held inside it.** The held-balances
  reader (`valuers/held-balances.ts`) values an owned object no specific
  reader handles by its `Balance<T>` and `Coin<T>` fields, the entries of a
  `Table`, `ObjectTable`, `Bag`, `ObjectBag` or `LinkedTable` it holds or
  is, and its own dynamic fields, to bounded depths (six struct levels,
  two container levels, 200 entries a container, eight containers an
  object), and says in `detail.not_read` what a bound cut. A position it
  wraps (a farm-wrapped CLMM position) and a balance of a coin a reader
  values (an LP share) go to that reader, marked `detail.held_in`. Whether a
  type can hold value is its GraphQL `type { layout }`, cached for good; a
  layout is read only when the object's JSON has a u64 string or a nested
  struct with an `id`, the only ways a `Balance`, a container or a wrapped
  object renders. Priced coins and unpriced ones are two positions, so an
  unpriced spam balance never nulls the priced ones. Dynamic fields are
  read for at most 30 objects a call, 15 a request (the service rejects a
  query of over 300 nodes), framework types never, since only a type's own
  module can add fields to it.
- **A total says what it covers of the objects owned.** `owned-coverage.ts`
  sorts every object the wallet owns, coins aside, into read by a reader,
  unread, a kiosk key, an NFT estimate, or not recognised, and lists the
  last by type and count with the walk's bound (`OWNED_WALK_MAX`) and the
  objects whose dynamic fields were not read. `get_wallet_overview` and
  `get_defi_positions` put it in `coverage` and its sentence in the note.
- **A shared vault an address operates is a lead, not a holding.**
  `operated-objects.ts` reads the shared objects the address's last 20
  transactions used mutably and keeps those whose own fields name it in a
  control role (`members`, `owner`, `operator`, `admin`, `manager`,
  `trader`, `keeper`, `controller`, `signer`, `authorized`), with the
  balances held inside and the other addresses the field names. A bot
  trading through such a vault moves no balance of its own. What it holds
  is never in the address's totals. Framework objects (kiosks) are left to
  the NFT tools.

Consumers value what a transaction moved through `src/utils/moved-value.ts`:

- **An object counts for the address it left and the address it reached.**
  Transferred and deleted objects leave their holder at the input version;
  transferred and created objects reach theirs at the output version; each
  is read by version (`readObjectVersions`) and valued at the transaction's
  checkpoint, the first 50 per transaction, the rest listed as unread.
- **A change of form is listed, never counted.** An object wrapped into or
  unwrapped from another object (a farm, a gauge, collateral) is still its
  holder's in another form, so its row carries `custody` and stays out of
  every total; otherwise a window holding only the deposit or only the
  withdrawal reads as a loss or a gain of the whole position.
- **An object whose previous holder went unrecorded is resolved first.**
  Before about March 2024 effects stored no input owner, so every changed
  object reads `appeared`. Its holder is read at the input version: the same
  address makes it a kept object, another address a transfer, and an object
  or an unreadable version a `custody` row (`prior_holder_unknown` or
  `unwrapped`).
- **A kept object counts the change in its amounts, at one set of prices.**
  An object its holder kept but the transaction changed (liquidity added,
  a deposit into an obligation) is read after the transaction and before
  it, against protocol state as of the previous checkpoint since a reader
  may read the protocol's record rather than the object. Both sides are
  priced at the after side's prices, or the provider's at `atTime` when the
  caller prices everything at one moment (`keptDelta`), so an oracle refresh
  alone moves nothing. A side with no position is zero; null is kept for a
  state that could not be read, which is listed. A kept `Coin<T>` is a
  balance change and never a row. Several transactions of one checkpoint
  touching the same kept object read the same whole change when the reader
  values protocol state at the checkpoint, so a scan counts identical
  changes once (`same_checkpoint_digests`); a reader valuing the object's
  own JSON per version gives each its own change, and each counts. A
  position a reader finds inside the moved object (a farm-wrapped CLMM
  position, reported under its inner id with `detail.held_in`) counts for
  the moved object.
- **`analyze_attack_tx` weighs objects in every address's net.** With no
  attacker given, a sender that took nothing priced (a coin a third-party
  scam list flags is a decoy, not value) and gave valued objects away is set
  aside like a gas-only sender, and the largest priced gainer becomes the
  profit subject; an unpriced coin or object another address gained still
  blocks that default, unless the sender paid that coin out itself (a
  victim's dust swept with the rest is part of the drain, not hidden loot).
  The incident headline ranks only pool groups that moved priced value and
  whose pool type no scam list flags.
- **A consumed position explains the coins it paid out.** The value
  reconciliation sets what reached addresses unexplained against the valued
  positions the transaction deleted or drew down in place, per coin by the
  raw amounts they held (`coin_amounts` on each moved-object row,
  `positions_usd`): an unstake pays SUI out of a staking pool the state read
  does not reach, and the StakedSui it burned says how much. `summarize_incident_losses` applies the same default
  per transaction, counts objects the attacker received, consumed or kept
  changed, netted per object across the incident as coins are per coin
  type (a stake received and later unstaked counts once, as the coins the
  unstake paid; an object in several rows of one coin is netted by amounts
  at its first row's price, so a price move between them leaves nothing),
  and keeps objects it handed on out of the totals as coins
  sent on are, valuing at most `MAX_OBJECT_VALUE_TXS` transactions. Each
  object is priced at its own transaction's time unless `price_at` is
  given: coins default to the first transaction's time, before prices
  reacted, which fits an exploit and misstates a drainer campaign that ran
  for days. Objects
  that could not be valued make the total a lower bound, as in
  `analyze_attack_tx`'s `partial_note` and flows' `objects_partial`.
- **A scan values at most `SCAN_OBJECT_BUDGET` objects**, newest
  transactions first, whole transactions at a time; the rest are
  `objects_skipped_transactions` and the totals say `objects_partial`.
  Each object costs several reads (a lending market, a pool and its
  record, a stake pool's rates, at that checkpoint), so a collector holding
  hundreds of positions would otherwise take minutes. A scan reads every
  transaction's object versions and checkpoints in batched requests first,
  and `readObjects` sends the reads asked for in one tick as one multi-get
  whatever checkpoint each names: the Cetus attacker's 287 transactions went
  from about 450 requests to about 90.
- **Scans over many transactions value specific readers only.**
  `summarize_incident_losses` and `summarize_address_flows` pass
  `specificOnly`, so the NFT fallback never runs there: an estimate stays
  out of every total, and its historical market reads took 10 to 26 seconds
  per object, most of a scan's time. The call's valuations share one
  `ctx.memo`, so a price, a stake pool or an epoch's rate is read once.
- **`summarize_address_flows` reads objects for every successful
  transaction of the scan**, newest first, up to `MAX_OBJECT_TXS`, from
  gRPC `effects.changed_objects`. Filtering to transactions the address sent
  or that carry a `TransferObjects` command missed every position a drainer
  collected: a Move call inside a transaction the victim signed hands it
  over. A coin filter turns this off.
- **`trace_funds` follows objects worth more than the coin.** Forward, when
  the valued objects the actor handed to one address outweigh the priced
  coin flow the next-hop choice follows (basis `object`), the trace moves to
  that address and to the next transaction that touches one of the objects
  (`affectedObject`), then follows whatever that transaction pays out. The
  coin flow it must beat is the largest priced flow of one coin to one
  other address, not whichever flow the coin choice took (a bait coin minted
  to the signer). A transaction that leaves the tracked objects with their
  holder (fees collected, liquidity changed in part) keeps the trail on the
  objects, so the trace reaches the close that pays them out; one that
  leaves them holding no more than the coin flow (liquidity withdrawn in
  full, the position kept) follows the payout instead. A hop that follows
  objects skips the hub check: the next hop is the transaction touching those
  objects, which funds pooled at the holder cannot confuse.

### Lending and margin positions

Readers for Suilend, NAVI, Scallop, AlphaLend, Bucket and Bluefin Pro, one
file each in `src/utils/valuers/`, sharing `src/utils/valuers/lending.ts`
(keyed field reads at a checkpoint, owned and type-wide listings, oracle
pricing). Rules a change is likely to break:

- **Amounts come from the protocol's own records, with its arithmetic.**
  - Suilend: an `ObligationOwnerCap<P>` names an obligation inside market
    `P`. A cToken redeems for the reserve's available amount plus borrowed
    amount less unclaimed spread fees, over its cToken supply; a borrow
    grows by the reserve's cumulative borrow rate over the rate it last
    compounded at, rounded up.
  - NAVI: balances are keyed by address in every market's `Storage` (all
    listed by type, not only the main one), for the wallet itself and for
    the `owner` field of each `AccountCap` it holds. A scaled balance times
    the reserve index over 1e27 is an amount in NAVI's 9-decimal units,
    then converted to the coin's own decimals.
  - Scallop: an `ObligationKey` names a shared obligation whose collaterals
    are coin amounts and whose debts grow by the market's borrow index over
    the index they settled at. Supply receipts count too: `MarketCoin<T>`
    coins, sCoins (converted at their `SCoinTreasury<S, T>`'s market-coin
    balance over sCoin supply) and `SpoolAccount` stakes. A market coin
    redeems for the reserve's cash plus debt less revenue over its
    market-coin supply.
  - AlphaLend: a `PositionCap` names a position in the protocol's table.
    xTokens are worth the market's `xtoken_ratio`; loans grow by its
    compounded interest. LP-position collateral is valued by its CLMM
    reader through `valueObjects` and reported as its own row under the
    cap's id (the LP id in `detail.lp_position_id`), so a moved cap carries
    it; an LP object read at its latest state is valued at the latest state.
  - Bucket: positions are keyed by debtor address, the wallet's and, in v2,
    those of the `Account` objects it holds. v2 debt adds interest from a
    unit that rises linearly at the vault's rate since its last update; a
    v1 bottle adds its redistribution share (stake times the per-stake
    totals since its snapshot, over 2^64) and grows its debt by the
    bucket's interest index. A v1 surplus bottle is claimable collateral.
  - Bluefin Pro: an account in the exchange's `InternalDataStore` is worth
    its deposited assets, its isolated margin and each position's
    unrealized PnL at the perpetual's stored oracle price, in the
    settlement asset. Pending funding is listed in `detail`, not netted.
- **A protocol's oracle is trusted only as far as a provider confirms it.**
  The oracles read are Suilend's reserve price, NAVI's `PriceOracle`,
  Scallop's `XOracle`, AlphaLend's oracle table, Bucket v1's
  `SingleOracle<T>` and Bluefin Pro's stored prices. A leg is chain-derived
  only when a provider's price is within 2% of the oracle's. Further apart,
  however fresh the oracle price, the check fails: the provider's price
  values the leg, both go in `price_check`, and the method names the failed
  check. A fresh price proves nothing, because a protocol can price a coin
  with another asset's feed (Suilend prices FUD, SEND and other reserves it
  no longer lends against, open LTV 0, with the USDC feed, at about $1),
  and an oracle read at an attack's checkpoint can be the manipulated
  price. An oracle price no provider can confirm values the leg as an
  estimate (tier `heuristic`), which totals of moved value keep apart.
  Bucket v2 stores no price. A leg whose decimals nothing vouches for has
  no USD.
- **A borrowed feed is never used.** A Suilend reserve whose Pyth
  identifier an earlier reserve of another coin already uses, or a NAVI
  reserve whose oracle id an earlier reserve uses, is priced as that coin,
  so its oracle price is dropped (`feed_of`); the provider decides, or the
  leg is unpriced. A feed belongs to the first reserve listed with it.
- **A liquid-staking leg is SUI at its issuer's rate.** Protocols price
  such coins at SUI's feed (Suilend's sSUI came out 2.87% low); every
  reader values them through `suiPerLst` times the protocol's own SUI price
  (`priceLendingLegs`, `sui_oracle`), checked like any other leg against the
  coin's provider price or SUI's at the same rate.
- **`health` holds only what the protocol stores or defines.** Suilend's
  obligation USD figures and AlphaLend's position totals and flags, both as
  of the position's last refresh; Bucket's minimum collateral ratio beside
  the ratio at the prices used. NAVI, Scallop and Bluefin Pro store no
  per-account figure, and none is computed in their place.
- **Health ratios are named the same in every reader.** Where a protocol
  stores both a borrow side and its limits, `health` adds
  `borrow_limit_used` (weighted borrows over the borrow limit) and
  `liquidation_threshold_used` (weighted borrows over the liquidation
  line), 4 dp, from the protocol's own figures as its own health checks
  compare them; `detail.health_ratios` names the two figures of each
  (`HealthRatios`, `withHealthRatios`). Bucket's are its minimum
  collateral ratio over the collateral ratio at the legs' prices, since a
  CDP borrows down to that ratio and is liquidated below it. `healthLeads`
  turns a position at 95% of its borrow limit or more into a lead.
- **Stored totals and the legs' USD are reconciled, not merged.** When a
  reader passes the protocol's own deposit and borrow totals
  (`stored_totals`) and either side parts from the legs by more than
  `PRICE_CHECK_PCT` of the larger, `health_basis` states both nets and the
  gap: liquidation follows the protocol's figures at its own oracle
  prices, so `health` measures distance to liquidation and `usd` measures
  worth; with a recorded refresh time, the ratios are as of that refresh.
- **Interest accrues as far as the state read.** Suilend, NAVI, Scallop
  and AlphaLend amounts stop at the index's last update; Bucket computes to
  the time of the checkpoint read, as its own getters do, never to a later
  pricing time (`atTime`), which values the legs only.
- **A listing the service cannot give at a checkpoint is unread.** Owned
  objects and balances at a past checkpoint are only listable inside
  GraphQL's consistent range; outside it the reader names what it could
  not list, while address-keyed tables (NAVI, Bucket, Bluefin Pro) are
  still read at the checkpoint.
- **A request's variables count toward the 5,000-byte payload.**
  `readFields` packs dynamic-field keys into aliases by byte size
  (`chunkByBytes`, `PAYLOAD_BUDGET`); a TypeName key is about 150 bytes.
- **Request count is the cost under a rate limit.** A table's or object's
  id never changes, so NAVI's markets, Scallop's market tables and
  AlphaLend's protocol tables are read once at the latest state
  (`TABLE_IDS_TTL_MS`) and used at any checkpoint; the state inside them
  is still read at the checkpoint. `readFields` and `readObjectsBatched`
  send the calls made in one turn of the event loop for one state as one
  request, and retry each call alone when the combined read fails.

Checked live against each protocol's own figures: NAVI's
`user_collateral_balance`/`user_loan_balance`, Scallop's accrued debt after
`accrue_interest_for_market_and_obligation`, and Bucket's v1 and v2
position getters matched to the base unit or within interest accrued
between reads; Suilend legs matched the obligation's stored market values
when it had just been refreshed; valued at the checkpoint of its last
refresh, an AlphaLend position's loans matched its stored total and its
collateral came within 1.2%; Bluefin Pro matched the exchange's reported
account value.

### Attack analysis

`analyze_attack_tx` and `summarize_incident_losses` read over gRPC
(`src/utils/attack-read.ts`), pure logic in `src/utils/attack-analysis.ts`.

- **gRPC events carry their JSON.** `Event.json` is filled by the fullnode AND
  the archive (verified on the Cetus and Nemo exploits, both pruned from the
  fullnode), so a pruned transaction still has decoded event fields.
  GraphQL's nested connections page at 20; the Nemo exploit has 214 commands
  and 103 events.
- **`batchGetTransactions` is bounded by the 4 MiB response, not a count.** 100
  Cetus-exploit transactions fit in one call and 200 did not. Batches are 25,
  and an overflowing batch is re-read one digest at a time.
- **Flash pairing ignores framework singletons.** Nearly every DeFi call takes
  the Clock (`0x6`); counting it as the object a borrow and a repay share
  pairs any borrow with any repay.
- **A subject that lost value gets a loss line, not a profit.** When no
  attacker is given and the sender did more than pay gas without giving
  valued objects away (see Position value), the sender stays the subject; a
  victim who signed a coin transfer then reads "Loss for <sender> (the
  sender)", and the line and `profit.gained_elsewhere` name the addresses
  that gained. The reconciliation line reports value that came
  out of objects or mints: per coin every address's change is summed, so a
  transfer between addresses cancels, and with none it says so instead of
  printing "$0 reached addresses".
- **An event belongs to the changed shared object whose id it carries.**
  `poolOfEvent` matches the event's top-level id values against the shared
  objects the effects changed (`sharedObjectsOf`, from the input owner or a
  mutable shared input), whatever the field is named, preferring a
  pool-shaped type when several match. When no shared object matches, it
  falls back to any other changed object that is not a coin or a dynamic
  field (`eventTargetsOf`): a pool kept as a dynamic object field of a
  registry, as Typus's TLP pool is, is object-owned. Do not grow a key list:
  Scallop's `rewards_pool_id` fell through the last one. An attributed event with an
  amount field, or with a coin type beside a non-zero number, in an unread
  shape goes to `undecoded_events`; one with neither (opening a position)
  moves nothing and is not listed. `X_before`/`X_after`, `before_X`/
  `after_X`, `old_X`/`new_X` and `X_old`/`X_new` pairs go to
  `recorded_changes`; only `total_usd_value_*`, whose 1e9 USD scale is
  known, also feeds `recorded_loss_usd`.
- **A swap event that names its coins is read from those coins.** Typus's
  `lp_pool::SwapEvent` (`from_token_type`/`to_token_type`) and Nemo's
  `market::SwapEvent<T>` fill `coin_in`/`coin_out` in `readSwap`, and
  `poolFlows` credits them from there, not from an A/B order. Nemo's
  amounts are signed Q64.64: `sy_amount` is the market's own SY change,
  while `pt_amount` is negative in both directions, so only its magnitude
  counts. PT is keyed `PT<T>`, not a coin type: `isCoinTypeKey` keeps it out
  of every price lookup.
- **Amounts keyed by side and direction are read by that shape.** A field
  whose name, split at `_`, has `amount`, one side token (`x`/`a`, `y`/`b`)
  and one direction (`in`/`out`) is a pool's take or payout of that side's
  coin (`sidedAmounts`), whatever the struct is called: `token_x_amount_in`
  on an add, `amount_y_out` on a swap. The coin is the one a same-side
  non-amount field names (`token_x_name`), else the pool type's argument.
  Before this, BlueMove's `Add_Liquidity_Pool` and `Remove_Liqidity_Pool`
  were undecoded and every pool read `usd_net` 0.
- **State deltas read objects, not names** (`src/utils/state-read.ts`,
  pure rules in `src/utils/state-delta.ts`). Changed shared objects,
  dynamic fields whose value type keeps a `Balance<T>` or `Supply<T>`, other
  object-owned objects (`child`: a pool kept as a dynamic object field),
  created objects and address-held `TreasuryCap<T>`s are chosen from the
  effects' types, then read with `batchGetObjects` at their input and
  output versions, fullnode then archive. At most 24 shared objects, ranked
  by a storage-rebate-only read before any JSON is fetched; each kind has
  its own cap (48 coin-holding fields, 48 object-owned objects, 12 created
  objects and 12 treasury caps), and every candidate left unread (past a
  cap, or a field whose value type could not be read) is listed in
  `state_deltas.skipped`. `value_reconciliation.objects_unread` counts them,
  and the reconciliation line says the unexplained part may be theirs: a
  router touching twelve pools kept as dynamic object fields changes each
  pool and its escrow, and a cap of 12 read half of them.
  `getDatatype` says which struct fields are `Balance<T>` and `Supply<T>`
  (following nested structs, `Coin<T>` and `TreasuryCap<T>` two levels
  down, all types at once). Only a complete layout is cached, per type and
  depth: a failed read is retried, and a type whose nested structs could
  not all be read is named in `layout_unread`. Jumps read only shared
  objects; a child's numbers are often a user's own position. List
  entries are never compared, because their index is not their identity
  (order books, VecMaps), and neither are `{ bits }` two's-complement ints
  or values at or above 2^127.
- **`shared-state-jump` uses one factor, 100x, from the audit.** On the 113
  tuning negatives, before the rules below, a raw 100x-or-zero rule fired on
  17 jumps and 17 zeroings: order-book list slots, tick crossings flipping
  `fee_growth_outside`, a two's-complement u256 crossing zero, a keeper
  moving a vault's USDC between two balance fields, a counter reset to 0 and
  a staking buffer staked out. Each rule removes one of those shapes by
  structure, and each was chosen on those 113, so their rate there is
  in-sample; judge the rules by a held-out split. A move to or from zero
  counts only for a `Balance<T>` holding, summed per holder and coin with
  created and deleted fields, so a balance moved between two fields of one
  object nets out. A dynamic field's holder is a read object's own id or a
  collection UID nested in it (`{ id }` inside its JSON), never an id it
  only stores as a value, or a registry would absorb its pools' drains.
  A drained holding is info when its holder took back, in other coins,
  90% or more of the USD it paid out across all its coins (a market
  maker's pool selling its USDC reserve for SUI, `A667WCrJ`); otherwise it
  is high when addresses gained, net and in any coin, at least half of its
  USD (a drain swapped or repaid inside the PTB still reaches someone), or,
  unpriced, half of it in the same coin; otherwise info.
- **A holder losing most of its value counts under the factor.** A holding
  that fell by less than 100x is listed when its holder lost
  `VALUE_SHARE_LOST` (half) or more of its priced value across all its
  coins and addresses gained at least half of that loss; each such drop
  carries `value_share_lost`. A holder with a moved coin that has no price
  has no share and is judged by the factor alone. On the 113 tuning
  negatives the largest share a holder paid to addresses was 6.8% (a CLMM
  liquidity removal), and the holders that lost half or more paid it into
  other objects. A drain that leaves a vault's accrued fees behind can stop
  short of 100x: the Aftermath Perpetuals drains fell 13.9x to 776x, and six
  of eleven were under the factor.
- **The wrong-source rule compares an object with what it references.** A
  created or changed object's number (2^16 or more) that equals the same
  field of one shared object, while every object of that type it references
  by id holds another value, came from the wrong object. This is Scallop's
  `update_points` missing `assert_pool_id`, stated as data flow.
- **`caller-value-used` follows values, not oracle names.** A value from a
  pure input, or from a call built only from pure inputs
  (`create_from_raw_value`, a `MakeMoveVector`; `vector<u64>`/`vector<u128>`
  pures are decoded), passed to a call that operates on a changed shared
  object (as an argument, or inside an earlier command's result: a session
  or hot potato wrapping it), must be stored: fields of the object's output
  version changed to it (every such field is listed, since the effects do
  not say which command wrote which), or an event naming the object states
  it in a field that tracks the object's own (the last value any event
  states for it is the value the object holds after). A liquidity or amount
  field echoing a delta fails that test. The field need not change: a set,
  a use and a restore to the exact prior value leaves it unchanged, and its
  events still show the caller's value. A value equal to what an unchanged
  field held throughout, with no event stating another, wrote nothing.
  Equality is the only evidence of the flow, so a value below 2^16 (a flag,
  a status, zero) counts only when the field swings 10x, the floor the
  wrong-source rule applies too. Failing both, arithmetic counts: an event
  naming the object states a number that is the caller value times another
  number of that event over a power of ten, within one unit, in any
  two's-complement reading with the signs agreeing (`productMatch`: fee x
  notional / 10^18). The caller value and the factor need 2^16 in magnitude,
  the stated number 2^32 (a chance match within one unit is then about one
  in two billion), the factor may not be a power of ten and the caller
  value not a positive one, since multiplying by a scale converts units.
  Each event's (stated, factor) pairs are built once and filtered by
  logarithm before the integer check, and a transaction tries at most
  `MAX_PRODUCT_CHECKS` (8 million) triples; past it the search stops and the
  anomaly says so (an info `caller-value-used` when nothing matched). A
  500-call, 500-event batch had taken 16 s unbounded; the cap adds about
  0.4 s. A later command must operate on the object. It replaced
  `oracle-set-then-used` and keeps its tiers: high when the field's values
  across the PTB span 10x, medium otherwise, and a product is medium. A
  keeper's set-and-settle and a swap stopping at the caller's
  `sqrt_price_limit` read medium and are accepted false positives, not a
  reason to lower the grade. A 64-byte-or-longer pure on the writing call
  lowers the grade one step and never suppresses it. Every write is in
  `caller_value_writes`, with `value_signed` when the value reads negative
  and `product` when it arrived by arithmetic; the evidence keeps ten.
- **`outsized-mint` bounds come from the math, not from samples.**
  `maxLiquidity` takes the event's own tick range (any `*lower*`/`*upper*`
  tick field) and returns the most liquidity its amounts, plus one raw unit
  each for rounding, can buy at any price: the crossing of the coin-A and
  coin-B limits inside the range, found by bisection. It holds for adds and
  removals alike, so no struct-name gate is needed. An event without ticks
  falls back to 1e18 per raw unit (8.6e13 is the most at the Q64.64
  sqrt-price bound). The Nemo PY-mint branch is gone: `shared-state-jump`
  reads Nemo's inflated `py_index_stored` directly. For an object whose
  state keeps one `Supply<T>` (LP or vault shares), an event naming it that
  states a minted amount (a field with `lp`, `lsp`, `share`, `minted` or
  `liquidity`, and no total) and deposits (sided `in` amounts, or
  `amount_a`/`amount_b` on an add) is outsized when minted / supply exceeds
  `SHARE_MINT_FACTOR` (100) times every deposit's share of the object's own
  holdings of that coin at the input version. A proportional mint issues at
  most the smallest deposit share, and reserves outside the read balances
  only lower the minted share against them, so exceeding it needs an
  object holding 100 times more coin than its share price counts. Adds on
  one object run in order against what the earlier ones left; a first mint
  and a deposit into a coin the object held none of are not bounded.
- **`unreconciled-gain` is info.** Per coin, the sum of every address's
  change (address-to-address moves cancel) is set against the larger of
  what decoded events paid out and what the read state paid out: the
  `Balance<T>` holdings' net fall plus the `Supply<T>` totals' rise (a
  mint), net across objects so a route's hops cancel. What neither explains
  came from an object that was not read. An unpriced coin nothing paid out
  raises it too, and is counted in `unexplained_unpriced`, never valued at
  zero.
- **`price-off-market` calibrates each field on the provider before judging
  a coin by it.** `priceClaimsOf` takes every number stated next to exactly
  one coin: an event naming one coin type in a field (or as its only type
  argument), and a dynamic field keyed by a coin's `TypeName`, read after
  the transaction (`state.keyed`, at most 32 rows). A record naming two
  coins (a swap) is skipped. Per field (event or row type, and JSON path),
  the power of ten at which the most coins agree with the provider within
  5% makes the field a price only when at least two coins agree there and
  they are at least half the coins with a usable provider price; any number
  in the field 5x or more from its coin's price is flagged, high at 10x. A
  lone field cannot calibrate itself, and a counter, timestamp or amount
  agrees with the provider only by chance, for too few coins to pass the
  majority. The provider price must be within an hour of the block and, from
  DefiLlama, at its top confidence tier (0.95 and up; it prices YBTC, a BTC
  wrapper, at $10.6K with 0.9). It names both AlphaLend's slot and ALPHA's
  own row priced at the AVAX feed, and Full Sail's port price set 100x low
  and restored in the same PTB, which the state before and after cannot show.
- **`signing-key-replaced` reads byte strings, not field names.** A string
  outside lists that decodes from base64 to 33, 48, 64, 65 or 96 bytes, not
  all zeros, and not a decimal number, is a key; one a shared object held
  before and holds replaced after is flagged medium. 32 bytes is left out,
  since digests of the last transaction (Full Sail's ports, Pyth Lazer's
  `writer_digest`) change on every call; an ed25519 key change is missed
  for that. A key cleared to zeros or empty is not flagged. An operator's
  rotation reads the same as a swap.
- **`share-round-trip` compares a redemption with what its units cost.**
  `roundTripsOf` runs when the sender receives $0.10 or more of priced
  coins, gas taken out. A share is a coin whose `Supply<T>` the read state
  shows falling while the sender's balance of it falls; the sender's own
  transactions on the object holding that supply in the previous 24 hours
  (`sentAddress` with `affectedObject`, the last 50) that credited it the
  coin are the entries, priced per unit. A position is an owned non-coin
  input the sender created within 24 hours and nothing changed between its
  creation and this transaction (the first two transactions on it are its
  creation and this one), priced as the whole creating transaction. A
  like-for-like trip (the entry only paid, the exit only received, and every
  coin the entry paid comes back in the exit; the share coin aside) values
  both legs at this transaction's provider prices and flags 1.1x or more,
  high at 2x; the same prices leave a day's yield and rewards claimed on exit
  as its only ordinary sources of a gain. Any other trip (a zap from one coin
  into another, a leg that also borrows or repays) would measure one coin's
  move against another at one set of prices, so each leg is valued at its
  own time's prices (the 8 latest such entries per transaction) and it
  counts only from 2x (`basis: "own-time"`). An entry that paid an unpriced
  coin is not scored. Haedal's redeem DkDmwtpV is the one labelled trip that
  is not like-for-like: its v1 deposit paid DEEP and the redeem returns none.
- **`switched-before-execution` follows a shared input's last writes.**
  `recentForeignWrites` takes every shared object the transaction changed or
  read only (`readShared`, from the effects' read-only consensus objects),
  system objects aside, at most 8. From the version the transaction read it
  follows `previous_transaction` back up to 3 writes while each write's
  sender is not the signer and it ran within 60 s, and compares each write's
  input and output versions of the object, lists included. A write counts
  when it flipped a boolean, set an address to one that gains coins or
  objects in this transaction, or set a number equal to an amount this
  transaction moved; a pool's reserves or an oracle's price moved by another
  trader seconds earlier do neither. It reads nothing unless an address other
  than the signer gains here. The grade uses the latest counted write and what
  the signer lost that other addresses gained (coins and valued objects):
  high within 10 s at $1 or more, medium within 60 s at $1 or more, info
  otherwise. The claim-swaps drainer flipped `ClaimParams.initialized` 0.93
  to 1.06 s before each of its three labelled drains, after setting the
  recorded amounts to the signer's coins 4.4 to 4.7 s before.
- **An incident's take leaves out what the attacker sent on.** In
  `aggregateIncident`, a coin moved only between addresses in a transaction
  when every address's change in it sums to zero (for SUI, to minus the gas
  paid): no pool or vault took any in or paid any out. The attacker's outflow
  in such a coin is a transfer to the addresses that gained it, listed in
  `transfers_out` and kept out of `totals` and the groups; its gas stays in.
  A gain is never split off, because a drained wallet pays its thief the same
  way. Window mode used to net the transfers in: a meme-coin drainer's 714,000
  SUI moved to its own second wallet read as a loss and the window reported
  $17.3K, and a perpetuals exploiter's four 50,000 USDC laundering transfers
  took $200K off a 1,139,652 USDC total. A coin some object also moved in the
  same transaction (a swap, a fee paid beside a deposit) is not split.
- **A vault that emits no pool event is read from its holdings.** A
  successful transaction that changed a non-framework shared object and whose
  events decode into no pool amounts has its state read
  (`readObjectStates`), and is grouped under every holder whose `Balance<T>`
  holdings of some coin fell (`stateLossOf`), with `pool_basis: "state"` and
  the holders' net change as `pool`. At most 50 transactions are read per
  call, 2 to 4 requests each; the rest are named in `state_reads.unread`.
  Perpetuals market vaults drained through a negative fee emit no pool event,
  and used to leave every exploit transaction unattributed.

### Address flow summaries

`summarize_address_flows` (`src/tools/flows.ts`, pure logic in
`src/utils/address-flows.ts`) scans one address's transactions newest first
inside the window, with balance changes and commands completed, the gas
summary, and event types. Rules a change is likely to break:

- **Gas comes off before any SUI total**, through `withoutGas` from
  `trace-hop.ts`, and is reported as `gas`. A sponsor's SUI change is dropped
  by `isSponsorGasChange`.
- **A counterparty is never credited with more than the subject moved.** When
  the other side of a coin adds up to more than the subject's change (a PTB
  with a stranger's payment in it), the subject's amount is split in
  proportion. What no address accounts for is `unattributed`, never dropped.
- **Exits are read from event JSON fetched after the scan**, for transactions
  the address sent that carry a bridge marker or whose event list the scan cut
  at 50, in aliased batches of 20. Beneficiaries come from `readBridgeEvents`
  (`src/utils/bridge/exits.ts`), the same function `resolve_bridge_transfer`
  uses; do not decode bridge events a second way here. Wormholescan is not
  called. A Mayan order's Wormhole leg is not an unresolved message.
- **A bridge exit's `sent` is what left Sui, not the sender's whole outflow.**
  `readExit` nets the subject's own change per coin (`netOfGas`) against every
  other Sui address credited in the same coin in the same transaction
  (`splitBridgeOutflow`): whatever another address on Sui was credited never
  crossed the bridge, whatever it was for. `retained` (and `retained_on_sui`
  in the tool's output) carries those fee and relayer legs separately, at the
  transaction and bridge-group level. Verified on the Typus attacker's exits:
  a 40 USDC-per-400k CCTP fee and a LayerZero relayer payment inflated `sent`
  by 343 USDC and 8.34 SUI across 14 burns, and a Mayan leg's relayer fee
  added 0.12 SUI on top of the 120.72 SUI that actually bridged. `screen_address`
  (`bridgeSentPerCoin` in `src/utils/screening.ts`) shares the same split, so
  the two tools do not drift apart on what "sent" means.
- **One transaction is one exit, under the protocol that carried it.** A
  Mayan MCTP order fires Mayan's, Wormhole's and CCTP's markers together.
  `exitCarrier` (`src/utils/bridge/detect.ts`) picks the carrier from the
  `settlesOver` relation on `BRIDGE_PROTOCOLS` (Mayan MCTP over Wormhole and
  CCTP; Allbridge Core over CCTP on its CCTP route and over Wormhole on its
  pool route, each route selected by which of its markers fired), then the
  first hit. It reads markers only: `screen_address` groups before it reads
  any event JSON, and a rule that also asked which protocol named the first
  beneficiary filed a Sui Bridge deposit beside a CCTP burn under CCTP in
  `summarize_address_flows` and under Sui Bridge in the screen. Only the
  carrier's settlement legs are the exit's `route`; any other bridge in the
  same transaction is `alsoExited` (`also_exited` in output), a transfer with
  its own recipient, so a Sui Bridge deposit beside a Mayan order is never
  called a leg that pays Mayan. `readExit`, `screen_address`'s
  `bridgeExitsOf` and `resolve_bridge_transfer` all use it. Counting a hit
  per protocol gave the Typus attacker 17 exits for 15 transactions, with the
  Mayan order's SUI inside the CCTP total. Missing the pool route's Wormhole
  leg filed 0x22101391…'s Allbridge transfers under Wormhole.
- **Every beneficiary of an exit is a destination.** `screen_address` screens
  all of `readBridgeEvents`' beneficiaries for each exit it reads, whatever
  the carrier. `readBridgeEvents` already leaves out a settlement leg's
  recipient (the CCTP mint to Mayan's contract, the burn carrying an
  Allbridge transfer), so the carrier filter the screen used to apply only
  dropped the recipient of a second bridge: a CCTP burn to an OFAC-listed
  address beside an unrelated Wormhole message was never screened. The
  screen reads its ten destinations from each bridge group in turn: in
  arrival order, fourteen CCTP burns to one address used them all and left
  the Mayan group with none.
- **One price per coin, at the median transaction time.** The midpoint of the
  window put the Nemo attacker's prices at 12:57, three hours before the
  exploit.

`aggregate_events` `group_pnl` (`src/utils/participant-pnl.ts`) reads the
distinct transactions behind the matched events over gRPC with archive
fallback (`readAttackTransactions`), so no nested connection is a page. A
transaction is multi-leg when it calls a package outside the filter's whole
lineage (`fetchPackageVersions`); 0x1, 0x2 and 0x3 never count as a leg.

### Reading Move bytecode

`disassemble_module`, `diff_package_upgrade` and `analyze_package` read the
GraphQL disassembly through `src/utils/disassembly.ts`. The decompiler is
optional (`SUI_DECOMPILER_PATH`, an external binary), so every code question
must be answerable from these tools, and no case check calls
`decompile_module`. Rules a change is likely to break:

- **Annotations append, never rewrite.** `annotateLines` adds ` // …` to a line
  and changes no line's text or the line count. Case checks match the
  disassembly's own text (`LdU64\(0\)\n\t1: Abort`), and hunk line numbers
  refer to the same lines `disassemble_module` returns. `Shl` and `Shr`
  lines get a note that the bits shifted out are dropped without an abort
  (only a shift amount at or above the width aborts), since `Add`, `Sub` and
  `Mul` abort on overflow and the bare opcode reads as if a shift did too.
  `decompile_module` appends the same large-integer note to decompiled lines
  (`annotateSource`, `src/utils/move-source.ts`) under the same rule.
- **Both clever-abort indices are constant-pool indices.** The Move Book calls
  the name index an identifier-table index, but the compiler stores the error's
  name as a `vector<u8>` constant, and Sui's resolver
  (`sui-package-resolver`, `resolve_clever_error`) reads both from the
  constant pool. In Typus oracle v10 identifier 7 is `State` and constant 7 is
  `EInvalidVersion`. The top nibble is the version: 0b1100, which current
  compilers always write, or the older 0b1000. The next byte is the
  `#[error(code)]` value, 0xff when unset, so Typus v10's codes start
  `0xc0ff`. The compiler builds clever codes only as the operand of `abort` or
  `assert!`, so an `LdU64` is decoded only where the next instruction is
  `Abort`: a literal such as `1 << 63` fits the layout (version 0b1000, line
  0, indices 0 and 0) and resolves against any module whose constant 0 is a
  string.
- **A `use` line prints the dependency's original ID.** Passing that ID to
  `disassemble_module` reads version 1, and the latest ID reads the fix. The
  version a package runs comes from its linkage table, which
  `disassemble_module`, `get_package` and `get_upgrade_history`
  (`dependencies`) all report. A module imported under a second name is
  printed `use <addr>::pool as 0pool;` and called as `0pool::swap`, so
  `USE_LINE` and `extractFunction` read the alias. The `module` header drops
  leading zeros (`module 2.coin`) while `use` lines print 64 digits.
- **Declarations are matched by name, never by position.** `diffLines` splits
  each module at its declarations (`splitSections`) and diffs a function
  against its own old body. A whole-module line diff of an upgrade compiled in
  another order put one function's old body under another's hunk header.
- **A truncated diff sample is spent breadth first.** When a module's hunks
  do not fit `max_sample_lines` even without context, `sampleHunks` orders
  changed function bodies by the share of their lines that changed, gives
  each its largest hunk before any gets a second (a first hunk may take half
  the room left), and names the functions it leaves out in
  `unsampled_functions` and `partly_sampled_functions` with a
  `sample_next_call`. Cutting in hunk order let one long function with many
  small edits hide a short function rewritten to `abort` (Typus oracle
  9→10).
- **Renumbering is checked, not assumed.** Lines are aligned on
  `normalizeLines`, which masks offsets, labels, branch targets, local slots,
  field and struct indices (printed beside their names) and vector signature
  indices (the element type is fixed by the printed types around it), and
  replaces a constant load by its value. Variant handle indices stay: the
  index is the only thing naming the variant, and two variants of one enum
  have the same type, so masking it read `PackVariant` of another variant as
  renumbering. `reconcile` then keeps a matched pair as renumbered only if its
  branch target follows the old-to-new offset map and its locals follow the
  most-voted one-to-one slot mapping, a tie going to the slot that keeps its
  number; otherwise it is a removed and an added line. Local declarations list
  slots in order and match on type alone. Masking without the check would hide
  a jump retargeted to other code, or a read of the other operand.
  `test/package-diff-mutations.test.ts` mutates real disassemblies one
  instruction at a time and requires every function to be listed as changed.
- **The alignment cap is per declaration.** `MAX_EDIT_DISTANCE` (2,000) bounds
  one function's Myers run; a function past it is counted on its raw lines,
  named in the module's `note`, and the rest of the module is still aligned.
  Counting normal forms there would make a function whose only change is a
  retargeted branch count as nothing, since no offset map checks it.
- **`analyze_package`'s bytecode checks are data flow, not name lists.**
  `src/utils/code-guards.ts` interprets each function's stack abstractly: a
  value carries the parameters, reads of a parameter's object, the sender and
  the check results it was computed from. Locals are joined without regard
  to order, a reference to a local carries the slot so writes through it
  (`vector::append(&mut buf, …)`) reach it, and calls into the package's own
  modules go through per-function summaries (branch conditions, writes,
  guards, fields read and borrowed mutably) mapped from callee parameters to
  caller arguments. A call into another package uses every argument, and a
  call there that takes `&mut` alongside a value counts as comparing them,
  since it can abort on the pair (`balance::split`, `table::add`). Arities
  come from printed signatures and struct field counts; a variant handle,
  which the disassembly names only by index, is solved from the verifier's
  rule that every basic block leaves the stack empty. Over 182 package
  versions every one of 83,803 blocks balanced.
- **`discarded-check` follows the bool to any use.** A check is a comparison
  or a call whose one result is `bool` and whose parameters are immutable
  references or plain values, whatever its name. A branch, abort, return,
  store, pack or an argument the callee uses is a use; a `Pop`, a local never
  read, or a package function that never uses the parameter is not. A `&mut`
  call's status and a bool inside a tuple are not checks: counting them gave
  67 leads on 12 of 82 clean packages (getters' flags, overflow flags). A
  call into the package whose summary can abort is not a check either: a
  helper that asserts and returns `true` enforces its condition itself.
- **`sibling-guard-gap` compares public functions that mutate one type.** In
  a module, the public or entry functions that mutate a `&mut` object of a
  package key type are siblings; a guard is a call that only reads, returns
  nothing and can abort. A bool that reaches a branch is not a guard:
  `table::contains` and `option::is_some` drive control flow, and counting
  them raised the leads on 82 clean packages from 643 to 1,587. A missing guard is not a lead when the guard reads
  no object, when the function writes a field the guard reads (it maintains
  the guard's state: a version bump, an unpause), when the guard relates
  objects the function does not take, when it validates a capability type
  the function does not take, or when another guard the function calls reads
  most of the same fields. Strong needs a relating guard (two objects, one of
  them the mutated one) made by three quarters of the siblings; a check of
  one object's own state stays weak, because version and pause checks are
  often skipped on purpose.
- **`unchecked-state-write` needs a free value, a shared target and no gate.**
  A free value is a plain value or a struct or enum the package can copy
  (`copy` declared here, or a `CopyLoc` of it anywhere). The package's own
  enums are in its type table, so a copyable enum argument is not mistaken
  for another package's capability. Coins, capabilities and
  receipts cannot be copied. The target is a `&mut` of a type the package
  passes to `share_object`. A comparison linking the value to stored state,
  a branch on the sender, or an owned package object or witness among the
  parameters clears it. A comparison records which sources stood on each
  side (`q<a>|<b>` labels, mapped through callees like any other label), and
  a chain of them counts: a price concatenated into a message that must
  equal an argument verified against a stored key is bound. A figure
  computed from the value and stored state together and compared with a
  constant links nothing: Nemo's `log_proportion` asserts `index × total
  != 1` after `current_py_index` has stored the caller's index, and reading
  that assert as a stored-state check hid `get_market_state_cache` and three
  other public writers of the same index. A non-copyable struct from another
  package among the parameters, or a returned request or receipt, may gate
  it and makes it weak.
- **Measured on 10 exploited versions and 138 clean ones** (every curated
  root at its first and latest version, the framework, Typus oracle 10, 11,
  12 and 17, integer-mate 5, CLMM 11). Target leads over leads on clean
  packages: `discarded-check` strong 5/5 (Typus oracle 5 to 9, `update_v2`).
  `sibling-guard-gap` strong 2/3 (Scallop spool 2 and 4, `update_points`;
  the other is Volo's `update_curator_position_value`), strong or medium
  2/14. `unchecked-state-write` strong 2/2 (Nemo 1 and 10,
  `get_sy_amount_in_for_exact_py_out`), strong or medium 7/11, adding Typus
  `update_v2`; Nemo's other public writers of the index (four in version
  10, three in version 1) add medium leads and no clean package gains one.
  Integer-mate 3's wrong shift bound is arithmetic and none of
  the three checks it.
- **Every counted lead is listed somewhere.** Weak leads never raise a
  finding, and in round three Nemo's six and Aftermath's four were counted
  in every detail and listed in none.
  A finding lists its first eight leads and `detail: 'full'` lists them all;
  weak leads no finding lists go to `bytecode_scan.weak_leads`, capped by
  `capPayload` in the summary with `next_call` `detail: 'full'`, and
  `bytecode_scan.read` says how to read one. Across the 138 clean versions
  the most weak leads one package has is 64 (about 44 KB), so full mode
  lists them uncapped.
- **`ungated-older-version` compares a lineage's versions.** Every version
  of a package stays callable and its types are the lineage's types, so an
  older version runs against the objects the newest one manages.
  `ungatedOlderVersions` (code-guards.ts) takes the newest version's gate
  for each shared type: a check (read-only, returns nothing, can abort)
  reading a shared object, made by at least two and more than half of the
  public functions that mutate the type. An older version's public mutator
  of the type is gated when it makes that check or reads a stored field the
  check reads (UID fields excluded: reading one only reaches dynamic
  fields), so a version number checked inline since version 1 counts. A
  function comparing the sender (a `q` pair, never a `k` pair: BlueMove's
  v1 `add_liquidity` stores the sender in a new pool through
  `dynamic_object_field::add`) or taking an owned package object is left
  out, and so is one whose namesake in the newest version skips the check
  too. Consecutive versions exposing the same functions fold into one lead.
  `scanVersionGates` (version-gates.ts) reads up to 30 versions, the oldest
  and the newest, one at a time; the largest lineage among the curated
  roots has 28. On BlueMove (versions 1 to 6 and 11 against 12, gate
  `swap::assert_version_contract`) it flags the v1 `add_liquidity` and
  `remove_liquidity` the exploit used. Over 62 other lineages with more
  than one version (the curated roots, and the Aftermath Perpetuals, Typus
  oracle, Nemo, Scallop spool, integer-mate and Volo vault lineages) it
  raises a strong lead on two: Typus oracle 1 to 6 (`update_with_pyth` and
  siblings, before `version_check` existed) and AlphaLend 6 to 10 (two
  getters that borrow positions and markets mutably). Both are old
  versions left ungated, which the rule describes; neither is known to be
  exploitable. Two more are weak (the
  functions return a request the caller hands on). The other 58, Cetus
  CLMM, Suilend and NAVI lending among them, raise nothing.
  `analyze_package` runs it on any version it is given.
- **A blank `SUI_DECOMPILER_PATH` means no decompiler.** `execFile("")`
  throws synchronously, so `runDecompiler` refuses first and returns
  `MissingDecompiler`. `decompilerAvailable` looks the binary up the way
  `execFile` does, and the module-list mode reports `decompiler_available`.

## Key Patterns

- `@protobuf-ts` oneof uses `oneofKind` (not `case`)
- SDK `Event` has `eventType` (not `type`), `module`, no `parsedJson`. GraphQL's
  `Event` has neither `type` nor `json` at the top level — both live under
  `contents` (`contents.type.repr`, `contents.json`). Three shapes for one
  concept, which is why `get_transaction` fetches event fields over GraphQL
  (`src/utils/event-json.ts`) even though it reads the transaction over gRPC.
- **Protocols come from events as well as Move calls.** A transaction calling an
  obfuscated wrapper into DeepBook reported `protocols: []` while the registry,
  asked directly, resolved the event's own package by lineage. Event types are
  also harder to fake: a package picks its own name, but the event it emits
  carries the type of whoever defined it. `protocols_from_events_only` marks the
  gap, since a transaction whose calls are unreadable and whose events name a
  known protocol is what a router or wrapper looks like.
- SDK `BalanceChange` has `address` (not `owner`)
- **A party object is owned, not shared.** GraphQL's `ConsensusAddressOwner`
  (gRPC `CONSENSUS_ADDRESS`) has exactly one owner; select its
  `address { address }` wherever an owner union is read, and report it as
  `consensus` with that address. Mapping it to `shared` drops the one address
  that can use the object.
- **GraphQL's `ExecutionError` has no kind.** `abortCode` is set for Move aborts
  only; every other failure is named from `message` by
  `failureKindFromGraphql` (`src/utils/formatting.ts`), which returns
  `unknown` for a message it does not recognise rather than `MOVE_ABORT`.
  GraphQL also prefixes a command-level failure's message with `Error in Nth
  command, ` (1-based) — confirmed on mainnet: "Error in 1st command,
  Insufficient coin balance for operation." The MESSAGE_KINDS patterns anchor
  at `^` against sui-types' own text, which carries no such prefix, so every
  command-level failure read `unknown` over GraphQL until the prefix was
  stripped first; `get_transactions` reported `unknown` for a transaction
  `get_transaction` (gRPC) named INSUFFICIENT_COIN_BALANCE for the same digest.
- **An UpgradeCap is compared against the lineage root's publisher.** The caps
  `auditPackageCapabilities` finds were minted by version 1's publish; a later
  version's sender is whoever held the cap then. `analyze_package` reports
  both as `root_publisher` and `version_publisher`.
- **A capability held by every user is not protocol authority.**
  `AUTHORITY_NAME` (`src/utils/capabilities.ts`) matches any `key`-ability
  struct ending `Cap`/`Admin`/`Operator`/`Owner`/`Manager`/`Authority`, which
  also matches objects every user of a protocol holds — DeepBook v3's
  `balance_manager::{BalanceManager, TradeCap, DepositCap, WithdrawCap}`,
  0x2's `kiosk::KioskOwnerCap`, Suilend's `ObligationOwnerCap`. Checked live:
  all four DeepBook types hit the 50-instance scan cap. A type past
  `USER_HELD_MIN_INSTANCES` live instances, or that hits the scan cap, is
  reported as a count in `user_held_types` instead of one `capabilities`
  entry per holder, and its instances are never individually re-read with
  CAP_STATE_QUERY — the scan that found them already read their owner live.
  The threshold sits above Volo's vault `OperatorCap` (7 holders, a small
  operations team, checked live): a type this size stays in `capabilities`,
  one entry per holder, same as any other authority cap. A struct whose
  instance scan fails outright (429, timeout) is named in
  `incomplete_scans`, never silently read as having no live instances. So is
  every candidate when the package's `typeOrigins` read fails: an object is
  indexed under the version that DEFINED its struct (Volo's `OperatorCap`
  is defined at v1 while the pinned check audits v10), so scanning the
  requested id instead finds nothing. The origins are read once, before the
  per-struct fan-out, through `fetchTypeOrigins`, which throws.
- **A coin with no TreasuryCap in the publish transaction is still audited.**
  A cap stored inside another object during `init` never exists at top level,
  so the publish scan misses it. Checked live: wUSDC's went into Wormhole's
  `WrappedAssetSetup`, SRT's sits in its shared `TreasuryAccess`, and
  CLOWNPEPE's was turned into the `Supply` its shared `Storage` keeps.
  `auditPackageCapabilities` takes the package's coins from the publish
  transaction's created `CoinMetadata`, `TreasuryCap`, `Coin` and registry
  `Currency` of the lineage root's own types, and from the registry. A coin
  made through a one-time witness comes from `init`, which runs only at
  publish, but its effects show no coin object when `init` stored both the
  TreasuryCap and the CoinMetadata inside another object (live:
  `0x014fcd3b…::hopeless::HOPELESS`, both inside a
  `0x5c8657a6…::connector::Connector<HOPELESS>`; the cap is now frozen at
  top level). A coin made later comes only from `coin_registry::new_currency<T:
  key>`, called in the module defining `T`. A registered `Currency<T>` of
  either kind is shared at an id derived under `0xc` from `CurrencyKey<T>`
  (key BCS `[0]`, the dummy field; checked live against HFROG and wUSDC), so
  every non-generic `key` struct and every witness-shaped struct (module
  name in capitals, `drop` only) is read in one multi-get (live:
  `0x08f0b496…::currency::COIN`, cap created after publish). A witness the
  registry does not know is asked of `getCoinInfo`, one request each, since
  a coin nobody registered has no entry. A generic `key` struct's id depends
  on its type argument, so one in a module whose own functions take
  `CoinRegistry` (the only way it reaches a module) is named in
  `incomplete_scans` instead, under the id of the version that defined it
  (typeOrigins; the requested id only when they cannot be read, so the
  entry merges with step 1b's). That list holds one entry per type, with
  every reason a scan gave. For each coin
  without a cap it reads the registry's `treasury_cap_id`, then scans
  `TreasuryCap<T>` by type (`found_by`); GraphQL's type filter matches
  nothing for a partly instantiated type (`Currency<…::FToken>`), so it
  cannot stand in for the derivation. What is left is named in
  `coins_without_located_mint_authority` with what was checked; its `risk`
  says what the entry means: medium, who can mint is unknown; info, nothing
  can mint. A registry `Fixed`/`BurnOnly` supply means the cap was consumed
  (`make_supply_fixed` takes it by value), so that cap is reported destroyed
  without reading it: a cap created and consumed in one transaction appears
  in no effects and `readObjectEnd` cannot place it. SUI is an `info`
  entry: `sui::new` destroyed its Supply at genesis, and its registry entry
  records neither a cap nor a fixed supply.
- **A package upgrade can change behaviour through its linkage alone.**
  `diff_package_upgrade` reads each version's `linkage` and reports relinked
  dependencies; framework rows (0x1, 0x2 …) are `system: true` and change no
  behaviour.
- **`token_flow` is the sender's balance change.** `decodeTransaction` builds it
  from the sender alone, so on a row listed for another address an inflow reads
  as the sender's outflow. A row about an address carries that address's own
  side from `addressFlow` (`subject_flow` in history, keyed per involved address
  in a timeline). Keep the `token_flow` name; consumers read it.
- **Upgrade history joins on the UpgradeCap's versions.** Every upgrade takes
  the cap by `&mut`, so each upgrade is also a cap version, and top-level
  `objectVersions(address:)` lists them oldest first even after the cap is
  destroyed or wrapped (`object(address:)` is then null; the last
  `affectedObject` transaction's gRPC `idOperation` tells the two apart). The
  holder at an upgrade is the cap's INPUT owner, and `get_upgrade_history`'s
  usual holder is measured in time held, not versions, so an eleven-minute
  loan that shipped one version does not become the norm.
- `GrpcTypes` must be imported as value (not `import type`) when using enum values
- GraphQL max page size: 50
- **Guard the cursor on every paginated walk.** A connection can claim
  `hasNextPage: true` and hand back a null `endCursor`; assigning it sends the
  walk back to page one. `for(;;)` loops then never return, and loops bounded by
  a page counter or a collection target return duplicates that skew whatever
  they feed — signer-set frequencies, event rankings, denied-address lists. The
  idiom is `if (!cursor) break;` immediately after the assignment.
- Build copies `src/data/` to `dist/data/` — JSON files must exist in dist at runtime
- Chain-qualify anything persisted or reported; bare addresses are Sui-only and
  ambiguous the moment a second chain enters a case
