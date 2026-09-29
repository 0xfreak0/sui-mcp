---
title: Overview
description: sui-mcp is a read-only MCP server for investigating activity on the Sui blockchain.
sidebar:
  order: 1
---

sui-mcp is a read-only MCP server for investigating activity on Sui. Trace
where funds went, attribute wallets to their funding sources, rank addresses by
protocol flow, work out who can actually sign for a multisig treasury, and tell
a coordinated cluster from a crowd, then reconstruct it all on a timeline.

It also covers the ordinary things: wallet overviews, DeFi positions, NFTs,
prices and Move package analysis.

The npm package is `sui-analytics-mcp`. It runs over stdio in any MCP client,
needs no account or API key, reads public Sui endpoints and defaults to
mainnet. It holds no keys and never submits a transaction; see
[Security model](/concepts/security/).

## Who it is for

- Investigators tracing funds, attributing wallets and testing whether
  addresses share an operator. Load the `forensics` profile
  ([Tool profiles](/guides/tool-profiles/)) and the
  [forensics skill](/guides/forensics-skill/), or use its three investigation
  prompts.
- People without investigation experience. Four
  [everyday prompts](/guides/everyday-prompts/) answer questions such as
  "was I scammed" and "who controls this token" in plain words.
- Developers reading Move packages, upgrades and transactions. The `developer`
  profile covers disassembly, upgrade diffing, PTB decoding and unsigned
  transaction building.

## Where to start

- [Install](/start/install/) adds the server to your MCP client.
- [What an investigation looks like](/start/first-investigation/) walks
  through a funding-cluster check.
- [What a result tells you about itself](/concepts/) explains the marks tools
  put on their own answers.
- The [tool reference](/reference/tools/) lists every tool and its arguments.

## License

MIT. See [LICENSE](https://github.com/0xfreak0/sui-mcp/blob/main/LICENSE).
