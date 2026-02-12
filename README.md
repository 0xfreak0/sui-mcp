# sui-mcp

MCP server for querying the Sui blockchain. Provides 38 tools for reading chain state, transactions, objects, coins, packages, events, SuiNS names, wallet analysis, DeFi positions, token prices, NFTs, pool discovery, and decompiling Move bytecode back to source code.

Connects to Sui mainnet public endpoints — no API keys required.

## Setup

Requires Node.js >= 20 (22+ recommended).

```bash
npm install
npm run build
```

### Move Decompiler (optional)

The `decompile_module` tool requires the Revela `move-decompiler` binary. Requires a Rust toolchain ([rustup.rs](https://rustup.rs/)).

**Quick setup:**

```bash
npm run build:decompiler
```

This clones [verichains/revela_sui](https://github.com/verichains/revela_sui), builds the decompiler, and copies the binary to `bin/move-decompiler`.

**Manual setup:**

```bash
git clone --depth 1 https://github.com/verichains/revela_sui.git
cd revela_sui/external-crates/move
cargo build --release --bin move-decompiler
```

Then set `SUI_DECOMPILER_PATH` to the binary path.

## Installation

Add to your MCP client config. All tools except `decompile_module` work without the decompiler — omit the `env` block if you don't need decompilation.

**Claude Code** (`~/.claude/settings.json` or project `.mcp.json`):

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

**Claude Desktop** (`claude_desktop_config.json`):

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

**Cursor** (`.cursor/mcp.json`):

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

Replace `/absolute/path/to/sui-mcp` with the actual path to this repository. The `env` block is only needed for the decompilation tool.

## Tools (38)

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
