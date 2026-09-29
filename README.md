# sui-mcp

**Documentation: [sui-mcp.vercel.app](https://sui-mcp.vercel.app/)**

[![CI](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml)

Read-only MCP server for investigating activity on Sui. Trace where funds went,
attribute wallets to their funding sources, rank addresses by protocol flow,
work out who can actually sign for a multisig treasury, and tell a coordinated
cluster from a crowd, then reconstruct it all on a timeline.

It also covers the ordinary things: wallet overviews, DeFi positions, NFTs,
prices and Move package analysis.

## Install

Add this to your MCP client config (Claude Code, Claude Desktop, Cursor, or anything else that speaks MCP over stdio):

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

No account, API key, or config file is required. The server reads public Sui endpoints and defaults to mainnet. Requires Node.js >= 22.13.

For investigative work, start with the forensics tools loaded:

```json
"env": { "SUI_TOOLS": "core,forensics" }
```

## What an investigation looks like

The first two steps on the 22 May 2025 Cetus CLMM exploit, starting from the
attacker wallet:

```
get_transaction_history(0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06, order: "oldest")
  → funded once with 9.98 SUI, one failed transaction, then the first
    success: DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x at 10:30:50 UTC

analyze_attack_tx(DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x)
  → attacker gained 10,024,321.28 haSUI and 5,765,124.46 SUI
    haSUI/SUI pool price moved -99.9999%
    anomalies: outsized-mint (high), shared-state-jump (high), …
```

Every value can be checked on chain. The
[full example](https://sui-mcp.vercel.app/examples/protocol-exploit/) goes on to
total the whole run, find where the proceeds left Sui, and check who funded the
wallet.

## Documentation

- [Start here](https://sui-mcp.vercel.app/start/): common tasks and the page for each
- [Examples](https://sui-mcp.vercel.app/examples/): real incidents worked through with the tools
- [Install](https://sui-mcp.vercel.app/start/install/): clients, forensics profile, running from source
- [Tool profiles](https://sui-mcp.vercel.app/guides/tool-profiles/): `SUI_TOOLS`, `enable_tools` and what each profile loads
- [Configuration](https://sui-mcp.vercel.app/guides/configuration/): environment variables, price sources, the optional local store
- [The forensics skill](https://sui-mcp.vercel.app/guides/forensics-skill/) and its investigation prompts
- [Multisig](https://sui-mcp.vercel.app/guides/multisig/): committees, signers, aliases
- [Watching addresses](https://sui-mcp.vercel.app/guides/watching-addresses/)
- [Move decompiler](https://sui-mcp.vercel.app/guides/decompiler/)
- [How to read results](https://sui-mcp.vercel.app/concepts/): verified coins, fund flows, lookalike addresses, truncated lists and more
- [Tool reference](https://sui-mcp.vercel.app/reference/tools/) and [capabilities](https://sui-mcp.vercel.app/reference/capabilities/)

## Everyday prompts

For people without investigation experience
([details](https://sui-mcp.vercel.app/guides/everyday-prompts/)):

- `was_i_scammed`: what left the wallet, where it went, and whom to report to
- `who_controls_this_token`: who can mint, freeze or upgrade a coin
- `who_controls_this_protocol`: who can upgrade a protocol's code or use its admin caps
- `who_is_this_wallet`: what kind of account an address is, its labels, funding and activity

## Security

Read-only: no wallet, no keys, and it never submits a transaction. See the
[security model](https://sui-mcp.vercel.app/concepts/security/)
and [SECURITY.md](SECURITY.md) for reporting a vulnerability.

## License

[MIT](LICENSE)
