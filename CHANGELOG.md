# Changelog

## 1.5.1 (2026-08-09)

All fixes, no new tools. Every item is 1.5.0 changing how fan-out is measured
without the surface around it following: the description, the comments, the
cache schema and the embedded summary were all still answering the 1.4.x
question.

Upgrading discards cached fan-out rows once, on first open. They were written
by the paths fixed below, so re-measuring is the point.

### Fixed
- **The cache discarded the feature the release was built on.** Only
  `recipient_count` was persisted, so any cache hit returned `-1` for
  `sender_count` and `coin_type_count`, `null` for `out_in_ratio` and
  `"unknown"` for `flow_shape`. It also wrote `counterparty_count` into the
  `recipient_count` column, so a cached read disagreed with a fresh one about
  the same address. Worst on the documented path: `find_funding_sources` warms
  the cache, so the follow-up `get_address_fanout` on a shared funder was
  always a hit — the example in the README could not produce a flow shape.
- **Cached scans could be shallower than the one requested.**
  `find_funding_sources` measures funders at 300 transactions and the cache is
  keyed on address alone, so a later call asking for 1,500 got the
  300-transaction reading back for a week, more truncated than asked for and
  silent about it. A cached row is now used only when it scanned at least as
  deep, or when it was untruncated and had already reached the end of the
  address's history.
- **`find_funding_sources` surfaced a quarter of what it measured**, dropping
  `counterparty_count`, `sender_count`, `out_in_ratio` and `flow_shape`. That
  is the tool deciding whether shared funding means anything, and a count alone
  cannot decide it — an exchange and a sybil funder can carry near-identical
  counterparty counts and opposite flow.
- **Two migration bugs**, both invisible to tests that each used a fresh
  database and so never exercised an upgrade. `CREATE TABLE IF NOT EXISTS`
  leaves an existing table's columns alone, so adding columns kept the old
  shape and every write failed; and a migration that bumped the version stamp
  then failed left a store claiming to be current while holding old columns,
  which a stamp-only check could never repair. The schema version and the
  actual column list are now both checked, so such a store heals on next open.
- **`get_address_fanout`'s description still documented the 1.4.x contract** —
  "sent value to", "Outbound transactions to scan" — teaching the very
  misconception 1.5.0 fixed, in the text a model reads to decide how to call
  it. Two module comments had the same problem, one of them arguing that
  counting both directions would be wrong.
- `classifyFanout` accepted a `coinTypes` argument it never read, with callers
  passing it as though it changed the result.

### Changed
- The container image no longer builds the Move decompiler by default. It is a
  Rust build over the Move crates taking tens of minutes, long enough to risk a
  directory's sandbox build timeout — and a timeout yields no image and no
  introspection, losing all 57 tools to keep one. Opt in with
  `docker build --build-arg WITH_DECOMPILER=1`. The image also now loads every
  tool by default, since an unset `SUI_TOOLS` published the 18-tool `core`
  profile as the server's public capability record.
- The shipped `Dockerfile` was `node:20-slim`, which cannot run this server at
  all: `node:sqlite` does not exist there, it is below the declared
  `>=22.13.0` floor, and Node 20 is EOL. Rebuilt as a three-stage image that
  drops to a non-root user and ships only `dist/` and production dependencies.

## 1.5.0 (2026-08-08)

Minor rather than patch: fan-out numbers change meaningfully, so a figure from
1.4.x and one from 1.5.0 are not comparable.

### Fixed
- **`get_address_fanout` was measuring the wrong end of history.** Sui's GraphQL
  `first` returns the OLDEST transactions, so every fan-out figure described an
  address's genesis rather than what it does now — a 2023-era address was
  sampled entirely from its first weeks, and an address that only became an
  exchange recently would have read as narrow. It now walks backwards from the
  most recent transaction. Numbers change: one funder reported at 1,623
  recipients measures 792 counterparties over its recent history.
- **Fan-out counted outbound counterparties only**, which cannot see a
  custodial cold wallet — it receives from thousands and sends to almost
  nobody, so it classified as "narrow". Both directions are now counted, and
  the response carries `sender_count`, `counterparty_count` and
  `coin_type_count` alongside the recipients.
- **The fan-out cache kept serving the old measurements after the upgrade.** It
  is keyed on address alone, so a row carries no record of *how* it was taken
  and the 7-day TTL would have handed back 1.4.x numbers for a week. Cached
  fan-out is now stamped with a method version (`PRAGMA user_version`) and
  discarded when the method changes — once, on first open, and only the cache:
  labels and findings are user data and are never touched.

### Added
- **`out_in_ratio` and `flow_shape`** on fan-out results. Shape separates cases
  size cannot: measured the same day, a known exchange and a sybil funder had
  399 and 431 counterparties respectively — indistinguishable by count — but
  ratios of 0.73 (balanced custodian) and 9.78 (disperser).
- Thresholds recalibrated against measured wallets: exchanges land at 205–440
  counterparties per 600 recent transactions, ordinary wallets at 6–12. The
  20x gap is what makes a coarse cut defensible; the boundaries themselves are
  not precise and the code says so.
- `labeled-addresses.example.json` now distinguishes **behavioural** claims you
  can derive and stand behind from **named** claims that must cite a source,
  since no measurement distinguishes Binance from Bybit.
- **Findings capture.** `save_finding`, `list_findings`, `export_case` and
  `delete_finding`. An investigation used to end as a chat transcript — the
  conclusions were real but lived somewhere nobody would read again, and
  re-deriving them cost as much as the original work. Findings are recorded
  against a named case and `export_case` renders the whole thing as Markdown,
  highest-confidence first, with a full-address appendix. Needs
  `SUI_STORE_PATH`.
- **`sort_order` and distribution on `aggregate_events`.** Value sorted
  descending only and `top` caps at 200, so a dust swarm was invisible: 919
  wallets each borrowing ~$0.20 never appeared behind twenty large depositors.
  `sort_order: "asc"` reaches the small end, and every response now carries
  min/p25/median/p75/p95/max computed over *all* groups rather than the
  returned page.
- **Labels persist** when a store is configured. `manage_labels` previously
  told you to hand-edit a JSON file; session labels now survive restarts, and
  `action: "import"` / `"export"` round-trip a labels file so a team can share
  attribution.
- **`get_address_fanout` suggests a label** when fan-out is at hub scale — as a
  suggestion the human confirms, never applied automatically. Labels decide
  where fund traces stop, so an auto-applied one would let a measurement
  silently redirect an investigation.

### Notes
- No seeded labels. DefiLlama was proposed as a source for exchange addresses;
  checking it, their Sui CEX address book is literally empty (`sui: []`), so
  shipping any would have been fabricated attribution. The mechanism is here;
  the data is yours to supply.

## 1.4.1 (2026-08-07)

### Fixed
- Setting `SUI_STORE_PATH` to a path whose parent directory did not exist
  disabled persistence with only a line on stderr — the store looked configured
  but silently kept nothing. Naming a store path means "keep a store there", so
  the parent directory is now created. Only the parent, never the file, and a
  path that genuinely cannot be opened still degrades to disabled rather than
  taking the server down.

## 1.4.0 (2026-08-07)

### Changed
- **Minimum Node is now 22.13.** `node:sqlite` (which backs the optional store)
  landed in 22.5 and stopped needing a flag in 22.13, and Node 20 reached EOL on
  2026-04-30. CI's matrix moves from 20/22 to 22/24.

### Added
- **`aggregate_events`** — rank wallets or event types by activity or value over
  a time window, in one call instead of paginating thousands of events by hand.
  Validated against a manual investigation that took 19 minutes: two calls
  reproduced its top wallets in the same order with matching magnitudes
  (`0x8c90d1c1…` $343,983 vs its $344k, `0x808fb10d…` $193,547 vs $194k).
  - Bounds accept **ISO timestamps or checkpoints**, so "today" no longer means
    hand-probing for the checkpoint at midnight.
  - Called without `value_field`, it returns each event type with its count and
    numeric fields. That is the discovery step which otherwise requires
    reverse-engineering a protocol's payload — and it makes visible that user
    actions are usually far rarer than bookkeeping events (AlphaLend: 642
    reward-refresh events to 61 deposits). Deliberately not a per-protocol
    schema registry: one hand-maintained registry already drifts.
  - Reports `truncated` loudly. A ranking from a partial scan looks exactly
    like a complete one, which is how a wrong answer gets believed.
- **Optional local store** via `SUI_STORE_PATH`, using Node's built-in
  `node:sqlite` — no dependency, no native build, nothing new for a
  supply-chain scanner to flag. Persists address labels (previously in-memory
  only, with the tool telling you to hand-edit JSON) and fan-out measurements
  (the expensive measurement here, and a stable one). Off by default: an
  investigation store records which addresses you looked at, and that should
  not land on disk because someone ran `npx`. Fund traces are deliberately not
  cached — a trace is a function of labels, so a stored one would silently
  disagree with a fresh run.

### Notes
- Two traps found while building this, both encoded in the tool: `event_type`
  filters on the struct's **defining** package, which for many protocols is not
  the package you call (AlphaLend calls `0xe48b33ef…` but defines its events at
  `0xd631cd66…`), so `module` is usually the filter you want; and a zero-result
  response now says so rather than looking like "nothing happened".
- Added a static test that fails on a bare `require()` in `src/`. The build
  output is ESM where `require` is undefined, but vitest's transform provides
  one — so that bug passes every unit test and only surfaces when the built
  server runs. It did exactly that here.

## 1.3.0 (2026-08-07)

Everything here came out of a real investigation — ranking AlphaLend wallets by
flow and attributing their funding — where the walls hit were specific enough
to fix.

### Fixed
- **`query_events` reported the wrong event type.** It used
  `transactionModule.fullyQualifiedName`, the module whose function was
  *called*, not the event's own struct. Through an aggregator those are
  different packages: a DeepBook `OrderCanceled` came back labelled with the
  router's module, and `DepositEvent` was indistinguishable from `BorrowEvent`
  in the same page. Now reports the real struct type, with the old value kept
  as `emitting_module`.
- **`enable_tools` described profiles in prose, not tool names.** "DeepBook
  order book and fills" never matched a search for `deepbook_trades`, so an
  agent reimplemented a gated tool by hand instead of enabling it. The gate now
  lists every tool name — a disabled tool is only reachable if its name is
  visible.

### Added
- `get_address_fanout` — how many distinct addresses a funder has paid.
  Shared ancestry is the classic false positive in attribution: several wallets
  tracing to one funder looks decisive until the funder turns out to have
  ~29,000 recipients and be an exchange. Returns a classification
  (`hub` / `distributor` / `narrow`) so the reading comes with the number.
- `find_funding_sources` — batch attribution for up to 100 addresses, sharing
  a memo across the batch. Funding chains converge hard, so per-address calls
  re-derive the same ancestors repeatedly. Reports funders shared across the
  batch and measures their fan-out, which a per-address call cannot see.
  `depth: "first_hop"` skips the tail, which reliably dead-ends in 2023-era
  distribution wallets.
- `query_transactions` now returns `gas_sponsor` and `gas_sponsored`. Sponsored
  gas is one of the strongest coordination signals on Sui and was invisible in
  every tool.
- `query_transactions` gains `include_functions`, returning every Move call in
  a transaction plus `matched_calls` / `total_calls`.
- `deepbook_trades` reports `truncated` when it returns a full page. The
  indexer has no cursor, so a full page was previously indistinguishable from
  "that was all of them".

### Changed
- `query_transactions`' description now carries an attribution warning: the
  `function` filter matches PTBs where the package is one leg among several,
  and transaction balance changes cover the whole PTB. Summing them per
  protocol over-attributes — in the investigation above, a Bluefin LP open was
  counted as AlphaLend volume. A live check on a Cetus-filtered transaction
  shows `matched_calls: 3 / 12`, so the over-attribution is now measurable
  rather than assumed.

## 1.2.0 (2026-08-07)

Minor, and it changes default behaviour: the server now starts with 17 tools
instead of all 50. Nothing is removed — `enable_tools` turns the rest on
mid-session, and `SUI_TOOLS=all` restores the previous startup surface.

### Added
- **Tool profiles.** The full tool manifest is ~14k tokens and MCP sends it on
  every request; a large flat tool list also degrades tool selection. The
  server now starts with a `core` profile (17 tools, ~4.6k tokens) and exposes
  `enable_tools` to turn on `forensics`, `developer`, `market` or `all`
  mid-session — the client picks up the new tools via
  `notifications/tools/list_changed`, no restart. `SUI_TOOLS` sets the startup
  surface for clients that cache the tool list. Same approach GitHub's MCP
  server takes with `GITHUB_TOOLSETS`.
- **DeepBook v3 tools**, backed by the [DeepBook indexer](https://docs.sui.io/standards/deepbookv3-indexer)
  (mainnet and testnet; devnet runs none):
  - `deepbook_orderbook` — live bid/ask depth, spread, mid, and resting-liquidity
    imbalance. Omit `pool_name` to list pools.
  - `deepbook_trades` — recent fills with maker/taker balance manager IDs, so
    trading can be attributed to an account during an incident window.
  - `compare_oracle_price` — Pyth oracle price against the price DeepBook
    actually traded at, over a window. Lending protocols liquidate on oracle
    prices, so divergence is the signature of a stale feed, a manipulation
    window, or liquidations priced where the market never printed.

### Fixed
- `get_pool_stats` reported DeepBook vault balances under `reserves`. DeepBook
  is a central limit order book with no reserves — the vaults are custody for
  resting orders and say nothing about tradable depth. It now reports
  `protocol_type: "clob"`, a null `reserves`, and points at `deepbook_orderbook`.

### Notes
- The DeepBook indexer has two undocumented quirks, both encoded in the client:
  the OHLCV path is `/ohclv` (transposed upstream, `/ohlcv` returns empty), and
  it takes milliseconds while `/trades` takes seconds. Its `depth` parameter
  counts levels across both sides, so callers pass per-side and the client
  doubles it.
- Margin and `/portfolio` endpoints are deliberately not wired up: the
  `@backfill_collateral` pipelines were ~197 days behind when this was written.

## 1.1.1 (2026-08-07)

Patch: both changes harden `decompile_module` against hostile input. No tool
signatures or output shapes change, except that a truncated `all_modules` run
now says so explicitly.

### Security
- `decompile_module` built a temp-file path from the on-chain module name
  without validating it (`join(dir, \`${mod.name}.mv\`)`). Module names come
  from whoever published the package, relayed by whatever RPC the user
  configured, so a name like `../../../evil` was an arbitrary file write with
  attacker-controlled contents. Move's verifier should prevent it, but a
  hostile `SUI_FULLNODE_URL` removes that guarantee. Names are now checked
  against the Move identifier grammar before touching the filesystem.
- Bounded `all_modules`, which previously ran one subprocess per module with no
  ceiling on either count or total output — a package with a few hundred
  modules turned one call into tens of minutes and hundreds of megabytes
  buffered in memory. Now capped at 32 modules, a 120s whole-call budget and
  8MB of combined output, with `complete: false` and a `notes` array in the
  response so a truncated result is never mistaken for a full one.

### Documentation
- README documents every capability a supply-chain scanner reports — network,
  filesystem, subprocess, environment — with the reason for each, plus how to
  verify a release's provenance with `npm audit signatures`.

## 1.1.0 (2026-08-07)

Minor rather than patch: `protocol_type` can now return categories that did not
exist in 1.0.0 (`oracle`, `bridge`, `yield`, `farm`, and `unknown` for
runtime-resolved packages), and decoded output changes for packages the registry
previously missed — a DeepBook call that rendered as a truncated address in
1.0.0 now renders as a named action.

### Fixed
- **Testnet never used its archive.** `archive.testnet.sui.io` exists, but the
  config had testnet as archive-less, so every testnet call silently fell back
  to the fullnode and returned `NOT_FOUND` for anything pruned. Testnet reads of
  historical epochs, checkpoints, objects and transactions now work.
- MVR requests had no timeout, unlike every other external call. An
  unresponsive registry hung the tool call for ~300s instead of 10.
- SpringSui was categorized as `lending`; it is a liquid staking protocol.

### Added
- Move Registry fallback for unknown packages. Decoded output now shows an MVR
  name (`@deepbook/core`) instead of a truncated address. Display only —
  `lookupProtocol`, which fund tracing uses to decide pass-through addresses,
  stays curated-only so a registered name can't change where a trace stops.
- `npm run find-unknown-packages` samples recent checkpoints and ranks packages
  missing from the registry by call count. Catches protocol upgrades, which
  otherwise degrade decoding silently.
- 27 protocol package IDs, each resolved via Move Registry or verified against
  its on-chain module list: AlphaFi, Volo, Momentum, Mole, Kai Finance, Ember,
  WaterX, Pyth, Wormhole, plus current package IDs for DeepBook, Cetus,
  Bluefin, FlowX, Bucket, SpringSui and Haedal that had drifted past the
  registry. New categories: `oracle`, `bridge`, `yield`, `farm`, `rwa`.
- `EXTERNAL_HTTP_TIMEOUT_MS` — one timeout policy for all non-Sui HTTP calls.
- `test/protocols-data.test.ts` validates the registry JSON against the
  `ProtocolType` union, which tsc cannot check.

### Changed
- The four hand-inlined fullnode→archive fallbacks are now one tested helper,
  `withArchiveFallback`. This is a consolidation, not a bug fix: all four call
  sites already handled the case that actually occurs. Probing mainnet shows
  pruned and nonexistent data throw gRPC `NOT_FOUND` rather than resolving with
  an empty payload, so the pre-existing empty-result retries in `get_object`,
  `get_checkpoint` and `get_chain_info` appear to be unreachable, and
  `get_transaction` lacking one was not a defect. The helper keeps that
  defensive path and skips both retries on devnet, where `archive` is the same
  client as the fullnode and the second call was a duplicate request.
- `CLAUDE.md` documents which transport to use for which read shape. The
  gRPC/GraphQL split was consistent in practice but written down nowhere.

## 1.0.0 (2026-08-07)

First release published to npm and the [MCP Registry](https://registry.modelcontextprotocol.io).

### Distribution
- Published to npm as **`sui-analytics-mcp`**. The unscoped name `sui-mcp` was
  already taken on npm by an unrelated package, so `npx -y sui-analytics-mcp` is
  the install path; the registry name remains `io.github.0xfreak0/sui-mcp`.
- Added `server.json` for the official MCP Registry and `mcpName` to
  `package.json` for npm package-ownership verification.
- Added a `files` allowlist. `dist/` is git-ignored, and npm falls back to
  `.gitignore` when there's no `.npmignore`, so without the allowlist the
  tarball would have shipped no build output.
- Build now sets the executable bit on `dist/index.js`; `npx` execs the bin
  directly and `tsc` does not preserve the mode.
- Server version is read from `package.json` instead of a second hardcoded copy,
  which the registry requires to match the published npm version.

### Fixed
- `decompile_module`'s missing-binary error pointed at `scripts/build-decompiler.sh`,
  a path that doesn't exist for anyone installing from npm. It now names the repo
  and suggests `disassemble_module` as the no-binary alternative.

### Security
- Updated `@modelcontextprotocol/sdk` to `^1.30.0` and refreshed the lockfile,
  clearing all production-dependency advisories (previously 1 critical, 7 high).

## 0.1.0 (2026-02-14)

Initial public release.

### Tools (38)
- **Wallet**: `identify_address`, `get_wallet_overview`, `get_transaction_history`
- **Chain**: `get_chain_info`, `get_checkpoint`
- **Objects**: `get_object`, `list_owned_objects`, `list_dynamic_fields`
- **Coins**: `get_balance`, `get_coin_info`, `search_token`, `get_token_prices`, `get_historical_prices`, `analyze_token`
- **Transactions**: `get_transaction`, `query_transactions`, `query_events`
- **DeFi**: `get_defi_positions`, `find_pools`, `get_pool_stats`
- **NFTs**: `list_nfts`, `list_nft_collections`, `get_top_holders`
- **Staking**: `get_validators`, `get_validator_detail`, `get_staking_summary`
- **Names**: `resolve_name`
- **Packages**: `get_package`, `get_move_function`, `get_package_dependency_graph`, `decompile_module`
- **Transaction building**: `build_transfer_sui`, `build_transfer_coin`, `build_stake_sui`, `build_unstake_sui`, `simulate_transaction`
- **Advanced**: `decode_ptb`, `trace_funds`, `check_activity`

### Highlights
- gRPC + GraphQL dual client architecture with archive fallback
- Protocol-aware transaction decoding (Cetus, DeepBook, Suilend, NAVI, Scallop, Bluefin, and more)
- Kiosk-aware NFT resolution
- SuiNS name enrichment across wallet, history, and holder tools
- Token price aggregation via Aftermath Finance, Pyth, and CoinGecko
- Move bytecode decompilation via Revela
