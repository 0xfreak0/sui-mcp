# sui-mcp

MCP server for querying the Sui blockchain. Provides 19 tools for reading chain state, transactions, objects, coins, packages, events, SuiNS names, and more.

Connects to Sui mainnet public endpoints — no API keys or environment variables required.

## Setup

Requires Node.js >= 20 (22+ recommended).

```bash
npm install
npm run build
```

## Installation

Add to your MCP client config:

**Claude Code** (`~/.claude/settings.json` or project `.mcp.json`):

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

**Claude Desktop** (`claude_desktop_config.json`):

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

**Cursor** (`.cursor/mcp.json`):

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

Replace `/absolute/path/to/sui-mcp` with the actual path to this repository.

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
