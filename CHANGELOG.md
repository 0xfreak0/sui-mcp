# Changelog

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
