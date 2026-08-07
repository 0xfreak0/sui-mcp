# sui-mcp

[![CI](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml)

Read-only MCP server for Sui blockchain analytics. 47 tools for wallets, DeFi positions, NFTs, token prices, transaction decoding, Move package analysis, and incident investigation.

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

## No wallet, no keys

The server has no credentials and no ability to move funds:

- It never accepts a private key, mnemonic, or seed phrase. No tool takes one as an argument and nothing in the code reads one from the environment.
- It never submits a transaction. `build_transfer` and `build_staking` return unsigned BCS bytes that you sign and broadcast somewhere else; `simulate_transaction` dry-runs bytes against a fullnode without executing them.
- Every remaining tool is a read.
- No provider accounts. RPC, indexing, and price data all come from public endpoints.

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

## Running from source

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

### Move decompiler (optional, source installs only)

Reading and analyzing Move code works with no extra setup: `disassemble_module` returns Move bytecode assembly via the GraphQL endpoint, and `analyze_package` summarizes a package's API and runs a heuristic risk scan. The decompiler is only needed for higher-level, source-like output from `decompile_module`.

It is a separate Rust binary and is deliberately not bundled in the npm package — a published tarball could only ever carry one platform's build. Getting it requires a clone and a Rust toolchain ([rustup.rs](https://rustup.rs/)):

```bash
npm run build:decompiler
```

This clones [verichains/revela_sui](https://github.com/verichains/revela_sui), builds the decompiler, and copies the binary to `bin/move-decompiler`. Point `SUI_DECOMPILER_PATH` at it:

```json
{
  "mcpServers": {
    "sui": {
      "command": "node",
      "args": ["/absolute/path/to/sui-mcp/dist/index.js"],
      "env": {
        "SUI_DECOMPILER_PATH": "/absolute/path/to/sui-mcp/bin/move-decompiler"
      }
    }
  }
}
```

<details>
<summary>Building the decompiler manually</summary>

```bash
git clone --depth 1 https://github.com/verichains/revela_sui.git
cd revela_sui/external-crates/move
cargo build --release --bin move-decompiler
```

Then set `SUI_DECOMPILER_PATH` to the binary path.
</details>

An npx install can still use the decompiler by building the binary from a clone and pointing `SUI_DECOMPILER_PATH` at it. Without that variable the server looks for `move-decompiler` on `PATH`; if it isn't there, only `decompile_module` fails, and it says how to fix it. The other 46 tools are unaffected.

## Tools (47)

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
| `get_pool_stats` | Pool reserves, fees, and prices for a given pool object ID |

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
