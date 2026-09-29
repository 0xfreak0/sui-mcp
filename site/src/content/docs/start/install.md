---
title: Install
description: Add sui-mcp to an MCP client with npx, or run a build from source.
sidebar:
  order: 2
---

## Add it to your client

Add this to your MCP client config (Claude Code, Claude Desktop, Cursor, or
anything else that speaks MCP over stdio):

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

No account, API key, or config file is required. The server reads public Sui
endpoints and defaults to mainnet. Requires Node.js >= 22.13.

## Load the forensics tools

For investigative work, start with the forensics tools loaded. Add an `env`
block beside `command` and `args`:

```json
"env": { "SUI_TOOLS": "core,forensics" }
```

Without it the server starts with the `core` profile, and the model turns on
other tools with `enable_tools` when a question needs them.
[Tool profiles](/guides/tool-profiles/) lists what each profile contains.

## Optional extras

- The [forensics skill](/guides/forensics-skill/) gives Claude the
  investigation method. Copy it once into `~/.claude/skills`.
- `SUI_STORE_PATH` turns on the local store. Labels and fan-out measurements
  then persist across sessions, and the case tools (`save_finding`,
  `export_case`) and watch tools (`watch_addresses`, `poll_watch`) need it.
  See [Optional local store](/guides/configuration/#optional-local-store).
- `decompile_module` needs an external binary. Every other tool works without
  it. See [Move decompiler](/guides/decompiler/).

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

See [CONTRIBUTING.md](https://github.com/0xfreak0/sui-mcp/blob/main/CONTRIBUTING.md)
for the development and release workflow.
