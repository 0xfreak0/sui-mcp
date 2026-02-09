# sui-mcp

MCP server for querying the Sui blockchain. Provides tools for reading chain state, transactions, objects, coins, packages, events, SuiNS names, wallet analysis, and decompiling Move bytecode back to source code.

Connects to Sui mainnet public endpoints — no API keys required.

## Setup

Requires Node.js >= 20 (22+ recommended).

```bash
npm install
npm run build
```

### Move Decompiler (optional)

The `decompile_module` and `decompile_package` tools require the Revela `move-decompiler` binary. Requires a Rust toolchain ([rustup.rs](https://rustup.rs/)).

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

Add to your MCP client config. All tools except `decompile_module` and `decompile_package` work without the decompiler — omit the `env` block if you don't need decompilation.

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

Replace `/absolute/path/to/sui-mcp` with the actual path to this repository. The `env` block is only needed for decompilation tools.

## Tools

| Tool | Description |
|---|---|
| `get_chain_info` | Current chain ID, epoch, and checkpoint |
| `get_checkpoint` | Checkpoint details by sequence number |
| `get_epoch` | Epoch details by number |
| `get_object` | Object by ID (type, owner, content) |
| `list_owned_objects` | Objects owned by an address |
| `list_dynamic_fields` | Dynamic fields of an object |
| `get_balance` | Balance of a coin type for an address |
| `list_balances` | All coin balances for an address |
| `get_coin_info` | Token metadata: name, symbol, decimals, supply |
| `get_transaction` | Transaction by digest |
| `query_transactions` | Filter transactions by sender, address, object, function |
| `query_events` | Filter events by type, sender, or module |
| `get_package` | Move package modules and functions |
| `get_move_function` | Details of a specific Move function |
| `simulate_transaction` | Dry-run a transaction |
| `execute_transaction` | Submit a signed transaction |
| `resolve_name` | SuiNS name resolution (forward and reverse) |
| `explain_transaction` | Human-readable transaction summary |
| `analyze_wallet` | Comprehensive wallet overview (balances, staking, activity) |
| `decompile_module` | Decompile a single Move module to source (or list modules) |
| `decompile_package` | Decompile all modules in a package to source |
