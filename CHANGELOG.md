# Changelog

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
