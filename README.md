# sui-mcp

[![CI](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/0xfreak0/sui-mcp/actions/workflows/ci.yml)

Read-only MCP server for investigating activity on Sui. Trace where funds went,
attribute wallets to their funding sources, rank addresses by protocol flow,
work out who can actually sign for a multisig treasury, and tell a coordinated
cluster from a crowd, then reconstruct it all on a timeline.

It has 76 tools. They also cover the ordinary things: wallet overviews, DeFi
positions, NFTs, prices and Move package analysis.

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

Testing whether a cluster of wallets is coordinated:

```
find_funding_sources(addresses: [...25], depth: "first_hop")
  → 23 of 25 share one funder, funded in three bursts of under a minute

get_address_fanout(<that funder>)
  → 1,623 recipients, classified "distributor", so shared funding alone
    proves nothing here; the second-level timing clusters carry the case
```

Several wallets tracing back to one funder looks decisive until you measure the
funder itself. Every funding result includes the fan-out measurement for this
reason. The [full example](https://sui-mcp.vercel.app/start/first-investigation/)
starts from ranking a protocol's wallets.

## Documentation

Full documentation: <https://sui-mcp.vercel.app/>

- [Install](https://sui-mcp.vercel.app/start/install/): clients, forensics profile, running from source
- [Tool profiles](https://sui-mcp.vercel.app/guides/tool-profiles/): `SUI_TOOLS`, `enable_tools` and what each profile loads
- [Configuration](https://sui-mcp.vercel.app/guides/configuration/): environment variables, price sources, the optional local store
- [The forensics skill](https://sui-mcp.vercel.app/guides/forensics-skill/) and its investigation prompts
- [Multisig](https://sui-mcp.vercel.app/guides/multisig/): committees, signers, aliases
- [Watching addresses](https://sui-mcp.vercel.app/guides/watching-addresses/)
- [Move decompiler (optional)](https://sui-mcp.vercel.app/guides/decompiler/)
- [What a result tells you about itself](https://sui-mcp.vercel.app/concepts/): verified coins, fund flows, lookalike addresses, truncated lists and more
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
