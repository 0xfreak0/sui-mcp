# sui-mcp

Read-only MCP server for Sui blockchain analytics. 48 tools covering wallets, DeFi positions, NFTs, token prices, transaction decoding, fund tracing, pool discovery, staking, Move bytecode decompilation, Move Registry (MVR) name resolution, and DeepBook v3 order books.

- **No API keys, no wallet, no private keys** — connects to public Sui mainnet endpoints
- **Protocol-aware** — decodes transactions from Cetus, Suilend, NAVI, Scallop, Bluefin, DeepBook, and more into human-readable actions
- **Multi-source architecture** — gRPC for low-latency reads, GraphQL for filtered queries, archive node fallback for historical data
- **Price aggregation** — Aftermath Finance, Pyth oracles, and CoinGecko in a single unified interface
- **Kiosk-aware** — resolves NFT ownership through Sui's kiosk system to actual wallet addresses

Transaction building tools return unsigned bytes for external signing — the server never handles keys.

## Setup

Requires Node.js >= 20 (22+ recommended).

```bash
npm install
npm run build
```

### Move Decompiler (optional)

The `decompile_module` tool requires the Revela `move-decompiler` binary. Requires a Rust toolchain ([rustup.rs](https://rustup.rs/)).

```bash
npm run build:decompiler
```

This clones [verichains/revela_sui](https://github.com/verichains/revela_sui), builds the decompiler, and copies the binary to `bin/move-decompiler`.

<details>
<summary>Manual setup</summary>

```bash
git clone --depth 1 https://github.com/verichains/revela_sui.git
cd revela_sui/external-crates/move
cargo build --release --bin move-decompiler
```

Then set `SUI_DECOMPILER_PATH` to the binary path.
</details>

## Installation

Add to your MCP client config (Claude Code, Claude Desktop, Cursor, etc.):

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

Replace `/absolute/path/to/sui-mcp` with the actual path to this repository. The `env` block is only needed for the decompilation tool — omit it if you don't need `decompile_module`.

See [`.env.example`](.env.example) for optional environment variables (network selection, custom RPC endpoints).

## Tools (48)

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
| `get_token_prices` | Current USD prices for tokens via Aftermath + CoinGecko |
| `get_historical_prices` | Historical prices at a point in time via Pyth oracle |

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
| `get_validators` | List validators with stake, commission, voting power |
| `get_validator_detail` | Detailed validator info including credentials and stats |
| `get_staking_summary` | Wallet's staking positions and pools |

### Names

| Tool | Description |
|---|---|
| `resolve_name` | SuiNS name resolution (forward and reverse) |

### DeepBook v3

[DeepBook](https://deepbook.tech/) is Sui's on-chain central limit order book (CLOB). Unlike AMM pools, DeepBook gives you real bid/ask depth, so quotes account for size and slippage. Tools below are read-only and powered by the [`@mysten/deepbook-v3`](https://www.npmjs.com/package/@mysten/deepbook-v3) SDK against the configured network.

| Tool | Description |
|---|---|
| `deepbook_get_pool_info` | List all DeepBook pools, or get full info for one: mid price, vault balances (base/quote/DEEP), trade params (taker/maker fees), book params (tick/lot/min size), DEEP price for fee calc, whitelisted/stable flags. |
| `deepbook_orderbook` | L2 order book with `N` ticks of bids and asks around mid price. Real depth, not a single spot price. |
| `deepbook_quote` | Price-impact-aware swap quote. Specify `base_to_quote` (e.g. SUI → USDC) or `quote_to_base` and an input amount; returns output, DEEP fee, effective price, and slippage % vs mid. |
| `deepbook_get_wallet_positions` | Find a wallet's DeepBook footprint: every BalanceManager and MarginManager owned by the wallet, plus per-coin balances for each BalanceManager. |

**Typical flows:**

- *"What's the depth on SUI/USDC right now?"* → `deepbook_orderbook(pool='SUI_USDC', ticks=10)`.
- *"What would I get for selling 5,000 SUI?"* → `deepbook_quote(pool='SUI_USDC', side='base_to_quote', amount=5000)`. Returns USDC out, DEEP fee, and slippage % vs mid.
- *"Does this wallet trade on DeepBook?"* → `deepbook_get_wallet_positions(owner=<addr>)`. Empty arrays = no DeepBook activity.
- *"What pools are available?"* → `deepbook_get_pool_info` with no args lists all 24 mainnet pools.

Pools can be referenced by **key** (e.g. `SUI_USDC`, `DEEP_USDC`) or by **raw pool object address**. DeepBook tools require `SUI_NETWORK=mainnet` or `testnet`; devnet returns a clear error.

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
| `get_package` | Move package modules, structs, and functions |
| `get_move_function` | Specific Move function signature and parameters |
| `get_package_dependency_graph` | Package dependency analysis with recursive traversal |
| `decompile_module` | Decompile Move bytecode to source (requires decompiler binary) |

### Transaction Building

| Tool | Description |
|---|---|
| `build_transfer_sui` | Build unsigned SUI transfer transaction |
| `build_transfer_coin` | Build unsigned coin transfer with auto coin selection |
| `build_stake_sui` | Build unsigned staking transaction |
| `build_unstake_sui` | Build unsigned unstake transaction |
| `simulate_transaction` | Dry-run a transaction to preview effects and gas cost |

### Advanced

| Tool | Description |
|---|---|
| `decode_ptb` | Decode a Programmable Transaction Block from BCS bytes |
| `trace_funds` | Multi-hop fund flow tracing (forward or backward) |
| `check_activity` | Monitor address or object for new activity since a checkpoint |

## License

[MIT](LICENSE)
