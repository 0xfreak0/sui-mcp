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
└── resources.ts          # MCP resources (chain reads, sui://case/{name})
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
`fetchModuleNames`) or `package { packageAt(version:) }` (`diff_package_upgrade`).
gRPC reads by object ID and is exact.

### Archive fallback

`archive` exists on **mainnet and testnet**; devnet has none, so `getClients()`
returns the fullnode client under both names there.

The archives speak **native gRPC over TLS, not gRPC-Web**, so `NetworkConfig.archive`
is a `host:port` target for `GrpcTransport`, not an `https://` URL like the other
endpoints. That inconsistency is load-bearing: a gRPC-Web client aimed at
`https://archive.mainnet.sui.io` gets a 404. Don't "fix" it.

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

A Sui upgrade mints a new package ID, and two kinds of filter bind to one
version:

- **Event types carry the DEFINING package**, the version that introduced the
  struct. DeepBook margin's `LiquidationEvent` queried at the latest ID returned
  nothing and at the original returned the liquidations. `resolveEventTypeFilter`
  (`src/utils/package-versions.ts`) reads `typeOrigins` and rewrites the filter;
  a module- or package-level type spanning several defining IDs keeps one and
  lists the rest. Type origins never change, so they are cached per network.
- **`function` and `module` filters match calls through that exact version.**
  Each version sees a disjoint share of the calls, so a non-empty answer is
  still partial. `versionScopeNote` names the lineage; `all_versions` on
  `query_transactions` reads every version as aliased connections and merges
  them (`src/utils/version-fanout.ts`), with a cursor recording each version's
  position so no call is skipped or repeated across pages.

## Address identity in investigation flows

`src/utils/identity.ts` resolves name, label, kind and historical names for a
whole result set in two batched calls, and `trace_funds`, both funding tools and
`build_wallet_edges` all use it. `identify_address` stays the thorough
single-address tool; it costs about five requests each and cannot run per hop.

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
  any.

## Completeness beats payload size

`get_transaction` returns decoded fields for **every** event by default.
`max_event_field_bytes` exists but is unset unless a caller asks for it.

**Do not add a default cap.** It would let an investigation reach a conclusion
from a subset of the events without the reader having chosen that, and it would
almost never fire: the 99th percentile of transactions with events carries 12 KB
of decoded fields, against 53 KB (~13k tokens) for a 59-event outlier. Paying
for the outlier is the right trade. Bounding the payload is the caller's
decision, and when they make it the response says plainly that it is not the
complete event data.

Tools whose complete result is the point declare
`_meta['anthropic/maxResultSizeChars']` (500k, Claude Code's ceiling) in
`tool-meta.ts`. Claude Code otherwise writes a result over ~50k characters to a
file and shows the model a 2 KB preview, which is a default cap by another
route.

A default view is different from a cap when nothing is dropped from the answer,
only moved behind an argument that the response names. `analyze_package` and
`get_package` return a per-module summary (counts, entry and public function
names) and compact JSON, because the full listing of `0x2` is 272k characters;
`modules: [...]` or `detail: 'full'` returns struct shapes and signatures.
`analyze_package` folds caps of one type and ownership into one entry that still
lists every object and holder. `find_funding_sources` keeps each result's origin,
first funder and first hop, and `include_chains` returns every hop; shared
funders, co-funding and payments are computed from the full chains either way.

A list row folds repeats: `get_transaction_history` and `build_timeline`
actions and `query_transactions` `move_calls` go through `foldRepeats`, each
distinct entry once with ` ×N`. The Nemo exploit's 214-command PTBs made a
30-minute `build_timeline` 195k characters. `get_transaction` keeps every
action in order, so the sequence is one call away.

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

`withNetworkParam` also wraps every field so `null` means unset (an optional
field gets its default, a required one reports "Required") and a bare string
where a list is expected becomes a one-item list. This runs as a `z.preprocess`
on each field, so the JSON schema is the field's own.

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
  `structuredContent`. It is opt-in because the payload then travels twice.
  `trace_funds` puts its prose summary in the first item and its JSON in the
  second, and the JSON is what becomes structured content.

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
most. A not-found names the network it was looked up on and the other networks
to try. The same cleaning runs over an `isError` result a tool built itself.

`gqlQuery` retries 429, 5xx and connection resets (`GRAPHQL_TRANSPORT` in
`config.ts`: 4 attempts, jittered exponential backoff, `Retry-After` honoured up
to 8s), gives each attempt a 30s `AbortSignal.timeout`, and allows 8 requests in
flight per network. An exhausted 429 reports the endpoint and suggests
`SUI_GRAPHQL_URL`; a GraphQL error reports its first message. Callers never see
`ClientError`.

A read that fails must not render as empty or zero. When the core read of a
tool fails, return `isError`. When a secondary read fails, set its value to
`null` and add a `*_unavailable` string saying what is unknown, as
`identify_address` does for `sui_balance`, `sui_name`, `token_count` and
`aliases`, and `get_wallet_overview` for `staked_sui_count` and `kiosk_count`.

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

Not in CI. It needs the network and mainnet's current state, so it would be
flaky on a schedule nobody chose, and a flaky required check teaches people to
ignore failures.

Measuring something new is a throwaway script you then delete. Record the
number in a commit message or here; a script kept only to rediscover a number
already written down rots against live mainnet and fails for reasons unrelated
to the code.

### Protocol identification

Three tiers, cheapest first, all behind `prefetchProtocolNames` +
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

Tiers 1–2 are curated and carry a verified category, so `lookupProtocol` (which
gates behaviour: fund-tracing pass-through, pool parser selection) uses them.
Tier 3 is a name anybody can register, so only `lookupProtocolDisplay` sees it.

Lookups are synchronous and read caches only. Without a prefetch they degrade to
tier 1; they never block. Lineage resolution batches 20 packages per GraphQL
request — the service rejects 21+ store-backed queries in one request, and caps
the payload at 5000 bytes.

### What counts as funding

`pickFundingTx` decides which inflow made a wallet exist, and that answer names
someone in a report. Three rules, in `src/utils/funding.ts`:

- **An unpriced coin is spam at any size.** Nobody funds a wallet with a token
  that has no market, and a scam token can mint any quantity. This is a signal,
  not a threshold. Only a *known* lack of price counts; with no price oracle at
  all the inflow is accepted rather than evidence discarded.
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
the parties that paid gas for transactions the address sent, reported as
`sponsored_by` at a dead end: gas can be paid from an address balance, so a
relay wallet can run on zero SUI of its own with ~1,900-MIST inflows, and its
operator then appears as sponsor and nowhere else. Inflow ranking is by USD
where a price exists, for the same decimals reason.

Scam NFTs need no handling here — they move no coin, so they never appear as an
inflow. This is about coin dust only.

### Where a funding walk stops

Rules for `walkFunding` and the batch tool, in `src/tools/funding.ts`:

- **A service-scale funder ends the walk.** Each hop's funder goes through
  `probeRecipients` with `DEFAULT_POPULARITY_LIMIT`, the probe and the limit
  `build_wallet_edges` uses to discard an intermediary, so the two tools cannot
  disagree about whether an address is a service. More than 50 recipients stops
  the walk: that funder's own first funding says who funded the exchange, not
  who funded the subject. On the Nemo attacker the walk went four hops past a
  261-recipient funder and called a 2023 wallet a narrow origin. Probes are
  cached per call and share one `Budget`; a funder the budget did not reach is
  `unmeasured`, and narrow off an incomplete probe is `provisional`.
- **A hub origin is not re-measured with `measureFanout`.** Its 300-transaction
  bidirectional window can classify a 60-recipient distributor as `narrow`,
  which restores the reading the stop exists to prevent. For shared funders the
  probe's verdict overrides the interpretation, not the measured numbers.
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
`classification_provisional` and loses the "meaningful" reading.

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
  cached forever does not transfer.
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

| Signal | Weight | Basis |
|---|---|---|
| `co_signer` | 1.5 | A key that can spend the wallet ALONE (`weight >= threshold`), read from the address hash |
| `co_signer` (cannot spend alone) | 0.6 | On the committee but needs others — below the merge floor |
| `cofunded` | 1.0 | Same first funder, funder passed the popularity check |
| `cofunded` (same tx, ≤3 paid) | 1.2 | Bespoke payout — built for these addresses |
| `cofunded` (same tx, ≥10 paid) | 0.8 | Batch payout — list membership, needs corroboration |
| `funding_edge` | 1.0 | One address first-funded the other, and is a seed or passed the popularity check |
| `reciprocal` | 1.0 | Value moved BOTH ways, counterparty passed the popularity check |
| `sponsor` | 0.7 | Same gas payer |
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
- **Narrow and popular are not symmetric.** Popular is proven by what was seen.
  Narrow off an incomplete scan is provisional, because the probe reads recent
  activity while the fundings it filters are historical. `used_intermediaries`
  carries `scan_complete`. The same rule governs `sponsor_shape` in
  `measureFanout`: `relayer` is proven, `private_sponsor` off a truncated scan
  only means "not far enough" and carries `sponsor_shape_provisional`. Measured
  on one mainnet sponsor, the distinct-payee count went 1 to 86 between a 100-
  and an 800-transaction window, crossing the threshold.
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
  `recipient_wallet_address`. The live route burns through CCTP with the same
  nonce; the burn's mint recipient is where USDC lands (a token account on
  Solana), so the CCTP leg is marked `carries: "Allbridge Core"` and the
  wallet is the beneficiary.
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

Three ways a walk stops, and only one of them is completion. Both walks follow
the same rules:

- `hasNextPage: false` — the end. `complete_ranking: true`.
- **A null `endCursor` while `hasNextPage` is true — TRUNCATION.** The
  connection said there is more and would not say where. The guard that stops
  the walk there was added to prevent a restart from page one, and leaving
  `truncated` alone on that path published a known-incomplete scan as a
  complete ranking, ranks and percentages restored.
- The `max_scan` budget — truncation, already handled.

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

Four rules for extending it:

- **A sale event rarely names the collection.** Measured: 70 of 73 mainnet
  sales carry no `nft_type`, and the few that do emit the defining address
  unprefixed and unpadded (`2dcd5252…::m::T`), which never compares equal to
  the `0x`-padded form every other surface here uses. `canonicalType` fixes the
  comparison; the missing field cannot be fixed, so those sales are counted in
  `unattributable_sales` and a filtered result that found little says why.

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
one another. Four rules:

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
- **Do not claim the addresses render identically.** At the 8+8 width this
  module itself renders, a 3+4 pair visibly differs. The true claim is that
  they match at both ends, which defeats a glance and a short truncation.

The rule is a floor of `MIN_PER_END` at each end, and the candidate bucketing
uses the same width. Making the rule asymmetric without changing the bucketing
would put a genuine pair in two buckets and report nothing.

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
- **A capability can be given up three ways, not one.** Transfer to an
  unspendable address, `public_freeze_object` (→ Immutable) and
  `public_share_object` (→ Shared) all end exclusive control. All three set
  `renounced`; `capabilities.ts` already distinguished these owners.
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

There is deliberately **no heuristic tier**. Guessing that an unknown package
looks bridge-shaped would manufacture exactly the unverifiable attribution this
project refuses to ship.

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
- **An object cannot send.** When the recipient has sent nothing since the hop,
  the next hop is the first later transaction in which its balance of the coin
  goes down, found through `affectedAddress` and marked
  `reached_via: "released-from-object"`; the custody check does not apply.
- **Backward follows who paid the coin in**, which is the owner of the largest
  decrease, not the sender. Then the payer's most recent earlier inflow of that
  coin, walking newest to oldest. A `last` page arrives ascending, so taking
  its first element picks the oldest.
- **A hub ends the trace.** A new party with 100+ counterparties in its last
  200 transactions (`measureFanout`) pools other people's money, so its earlier
  inflows (backward) and its next outflow (forward) are not these funds.
- **A transaction its sender did not sign ends a forward trace.** The signer
  acted for the sender (an alias or a protocol substitution), and following on
  would attribute its actions to the sender.
- **`stop_reason` is always set**, with the same name `find_funding_source`
  uses. A trace that just ends reads as "the money stopped here".

### Flow graphs: `trace_flow_graph` and `find_flow_path`

Pure split and accounting rules in `src/utils/flow-graph.ts`, the BFS in
`src/utils/flow-engine.ts`, renderers in `src/utils/flow-export.ts`. Rules a
change is likely to break:

- **Shares are first in, first out, and that is a convention.** A node's traced
  amount goes to the transactions that moved it in order until it is used up;
  each transaction's share goes to the parties it paid in proportion to the
  amounts. An edge carries `amount` (what moved) and `traced` (the traced part):
  a wallet that received 400 and paid 1,000 passes on 400. Never follow the
  full 1,000 as if it were these funds.
- **On a bridge exit the unpaid remainder is the exit.** Every Nemo CCTP burn
  pays its relayer a SUI gas drop, and without `bridgeExit` the USDC read as
  converted into the relayer's SUI and the graph walked off into a relayer
  wallet instead of reaching the exit.
- **Swap proceeds follow the traced input's part of the input.** A swap that
  spent 0.1 SUI and 18,000 USDT for 18,000 USDC did not turn the SUI into
  18,000 USDC. `splitSpend` scales the gain by the traced coin's value share of
  everything the holder put in.
- **A malicious label does not stop the graph**, and neither the start address
  nor the same actor continuing is checked against sinks, protocols or hubs. The
  shipped disclosed labels name both exploiters, so stopping there ended every
  graph at hop 1. Exchanges, bridges, mixers and burn addresses still end it.
- **Level by level.** Every inflow found at one depth reaches a node before it
  is expanded. A node reached again later is expanded again from the new
  arrival, skipping transactions already allocated to it, unless the value came
  back to an address on its own path, which is a `cycle`.
- **`budget` is never an ending.** Depth, node, move and read limits are
  reported as `budget` with `coverage.truncated`; `below_threshold` is the
  pruned share, not where the money went.
- **A graph from one transaction follows that transaction's coins.** From the
  Cetus exploit `DVMG3B2…` (SUI and haSUI) the value goes to the second wallet
  `0xcd8962…` and the validator-signed recovery (`signer_not_sender`), with no
  bridge exit: the attacker bridged USDC drained in other transactions. Start
  from the attacker's address after the exploit time to see every exit.
- **Beneficiaries are read per exit from the transaction's events**, GraphQL
  first and the archive's gRPC events for a transaction GraphQL answers without
  them, through `readBridgeEvents` (the same reading `resolve_bridge_transfer`
  uses). Exits are grouped by protocol and beneficiary account.
- **`find_flow_path` joins in time order.** A forward node meets a backward node
  at the same address only when the forward side arrived no later than the
  backward side paid on toward the target. A foreign-chain target is reached
  forward only, through an exit whose beneficiary matches.
- **Mermaid ids are `n0`, `n1`, …, never the caller's ids**, and labels go
  through `mermaidText`, which escapes `#` before the entities it inserts.
  `test/flow-export.test.ts` checks the output line by line against the
  flowchart forms the renderer emits.

### Shipped labels, screening and scam lists

- **Shipped labels are first-party disclosures only**, generated into
  `src/data/disclosed-labels.json` by `npm run sync:disclosed-labels`: exchange
  proof-of-reserves lists (`proof-of-reserves-listed`), bridge deployment docs
  (`official-docs`), attackers named in the victim's own incident report
  (`victim-postmortem`). Every entry carries entity, evidence, source_url and
  retrieved_at, and the script drops any address not found in its document.
  Keys are `sui:mainnet:` or `eip155:1:`. OKX signs each address, but the
  scheme has not been reproduced, so OKX rows claim a listing, nothing more.
- **Every surface that shows a label shows its provenance** (`labelProvenance`).
- **A sponsor's SUI change is never a payment.** Sweeps delete coin objects and
  the storage rebate goes to the gas payer, so the sponsor shows a positive SUI
  change. `isSponsorGasChange` (`src/utils/sponsor-gas.ts`) is the one rule, and
  fan-out, the recipient probes, co-funding denominators, deposit detection,
  screening and `summarize_address_flows` all skip it. Only a sponsor that is
  not the sender is gas-only; a self-paid sender's SUI change carries payments.
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
`summarize_incident_losses` all use it. Four rules:

- **DefiLlama is the keyless source, and its key is the PADDED coin type.**
  `sui:0x2::sui::SUI` resolves, but a stripped leading zero does not:
  `sui:0x6864a6f9…::cetus::CETUS` returns nothing where `sui:0x06864a6f9…`
  returns CETUS. A replay that stripped zeros lost CETUS and priced 96 of 195
  Cetus-exploit coins; padded, it prices 103. `defiLlamaKey` pads; do not build
  the key anywhere else.
- **Pyth is asked about VERIFIED coins only.** Its feeds are found by symbol,
  so an impostor ending `::sui::SUI` would get SUI's price. DefiLlama keys on
  the full type and prices a coin as itself or not at all.
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
- **Pool losses come from the pool's own events, read by field name.** An event
  naming a pool with amount fields in an unread shape goes to
  `undecoded_events`. One with no amount field (opening a position) moves
  nothing and is not listed.

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
- **One price per coin, at the median transaction time.** The midpoint of the
  window put the Nemo attacker's prices at 12:57, three hours before the
  exploit.

`aggregate_events` `group_pnl` (`src/utils/participant-pnl.ts`) reads the
distinct transactions behind the matched events over gRPC with archive
fallback (`readAttackTransactions`), so no nested connection is a page. A
transaction is multi-leg when it calls a package outside the filter's whole
lineage (`fetchPackageVersions`); 0x1, 0x2 and 0x3 never count as a leg.

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
- **An UpgradeCap is compared against the lineage root's publisher.** The caps
  `auditPackageCapabilities` finds were minted by version 1's publish; a later
  version's sender is whoever held the cap then. `analyze_package` reports
  both as `root_publisher` and `version_publisher`.
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
