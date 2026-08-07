# sui-mcp

[![CI](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml)

Read-only MCP server for Sui blockchain analytics. 50 tools for wallets, DeFi positions, NFTs, token prices, transaction decoding, Move package analysis, and incident investigation.

## Install

Add this to your MCP client config — Claude Code, Claude Desktop, Cursor, or anything else that speaks MCP over stdio:

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

No account, API key, or config file is required. The server reads public Sui endpoints and defaults to mainnet. Requires Node.js >= 20.

## Tool profiles

All 50 tools loaded at once cost about 14k tokens of context on every request, and a large flat tool list makes models pick the wrong tool. So the server starts with a **core** set of 17 and keeps the rest one call away.

When you ask for something outside the current set — "trace where these funds went" — the model calls `enable_tools` and the tracing tools appear immediately, no restart. You never have to pick a profile.

To start with more, set `SUI_TOOLS`:

```json
"env": { "SUI_TOOLS": "core,forensics" }
```

| Profile | Tools | Contents |
|---|---|---|
| `core` *(default)* | 17 | Wallets, balances, transactions, tokens, NFTs, DeFi positions, staking, pools, names |
| `forensics` | 9 | Fund tracing, funding-source attribution, timelines, object provenance, labels, events, oracle-vs-market deviation |
| `developer` | 18 | Move packages, disassembly, decompilation, upgrade diffing, dependency graphs, PTB decoding, unsigned transaction building, Move Registry |
| `market` | 6 | DeepBook order book and fills, pool stats, token search, validators |
| `all` | 50 | Everything |

Runtime switching relies on `notifications/tools/list_changed`. Claude Code and Claude Desktop honour it; some clients cache the tool list and will only see the change after a restart. `SUI_TOOLS` always works, so set it explicitly if your client doesn't refresh.

Upgrading from 1.1.x, where every tool loaded at startup? Set `SUI_TOOLS=all` to keep that behaviour.

## No wallet, no keys

The server has no credentials and no ability to move funds:

- It never accepts a private key, mnemonic, or seed phrase. No tool takes one as an argument and nothing in the code reads one from the environment.
- It never submits a transaction. `build_transfer` and `build_staking` return unsigned BCS bytes that you sign and broadcast somewhere else; `simulate_transaction` dry-runs bytes against a fullnode without executing them.
- Every remaining tool is a read.
- No provider accounts. RPC, indexing, and price data all come from public endpoints.

### What the process actually does

Supply-chain scanners report the capabilities a package uses, without the reason. Here is the full list for this one:

| Capability | Where it's used |
|---|---|
| Network | Public Sui RPC and GraphQL, plus Pyth, Aftermath and the Move Registry for prices and name resolution. Hosts are listed in [`src/config.ts`](src/config.ts). |
| Filesystem | Temp files for `decompile_module`, and reading `SUI_LABELS_FILE` if you set it. |
| Subprocess | One call, in [`src/tools/decompiler.ts`](src/tools/decompiler.ts), to the decompiler binary *you* build and point at. `execFile` with array arguments, so no shell is involved and nothing is interpolated into a command string. |
| Environment | Six variables, all prefixed `SUI_`, all listed in [`.env.example`](.env.example). Nothing else is read. |

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
- **Incident investigation** — labeled fund tracing, funding-source attribution, multi-address timelines, object provenance, PTB anomaly triage
- **Move package analysis** — disassembly, heuristic risk scan, capability audit, and upgrade diffing, none of which need an external binary
- **Multi-source architecture** — gRPC for low-latency reads, GraphQL for filtered queries, archive node fallback for historical data
- **Price aggregation** — Aftermath Finance, Pyth oracles, and CoinGecko in a single unified interface
- **Kiosk-aware** — resolves NFT ownership through Sui's kiosk system to actual wallet addresses
- **Move Registry (MVR)** — resolves names like `@deepbook/core` to package addresses, and back

## Configuration

All environment variables are optional. See [`.env.example`](.env.example) for the full list; the common ones are `SUI_NETWORK` (default network), `SUI_FULLNODE_URL` / `SUI_GRAPHQL_URL` (custom RPC endpoints), and `SUI_LABELS_FILE` (address attribution labels for fund tracing).

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

49 of the 50 tools need nothing beyond the install above. Only `decompile_module` requires an external binary, and there are lighter options before you reach for it:

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

Without `SUI_DECOMPILER_PATH` the server falls back to looking for `move-decompiler` on `PATH`. Prefer the absolute path: desktop clients often launch servers with a minimal environment that doesn't include your shell's `PATH`, so a binary you can run in a terminal may still be invisible to the server. If it's found in neither place, `decompile_module` returns an error explaining how to fix it, and the other 49 tools are unaffected.

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

## Tools (50)

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

DeepBook v3 is a central limit order book, so it has no reserves — depth, spread and traded price come from the [DeepBook indexer](https://docs.sui.io/standards/deepbookv3-indexer) rather than from a pool object. Mainnet and testnet only.

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
| `get_top_holders` | Top holders of an NFT collection or token |

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
| `find_funding_source` | Walk an address back to its funding source(s) for attribution; stops at labeled exchanges/bridges |
| `build_timeline` | Merge multiple addresses' activity into one checkpoint-ordered, protocol-decoded timeline |
| `trace_object_history` | Object provenance: version history + ownership transitions (who created/held an object when) |
| `manage_labels` | Address-label registry (exchanges, bridges, mixers, malicious wallets) used by the tracing tools |
| `diff_package_upgrade` | Diff two package versions to detect malicious upgrades / backdoors |

## License

[MIT](LICENSE)
