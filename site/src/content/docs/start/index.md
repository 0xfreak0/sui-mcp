---
title: Start here
description: What sui-mcp is, and which page to read for the task in hand.
sidebar:
  order: 1
---

sui-mcp is a read-only MCP server for investigating activity on Sui. It gives
an AI assistant tools to trace funds, attribute wallets, read who controls a
token or a package, and decode transactions. It holds no keys and never
submits a transaction; see [Security model](/concepts/security/).

The npm package is `sui-analytics-mcp`, MIT licensed. It runs over stdio in any
MCP client, needs no account or API key, reads public Sui endpoints and
defaults to mainnet.

## Common tasks

- **Install the server**: [Install](/start/install/). For investigations, load
  the `forensics` profile as that page shows.
- **Investigate a hack or exploit**: the
  [Cetus exploit example](/examples/protocol-exploit/), then the
  [forensics skill](/guides/forensics-skill/), which sets the order to work in.
- **Check who controls a token**: the
  [KONG rug pull example](/examples/token-rug/), or the
  `who_controls_this_token` [everyday prompt](/guides/everyday-prompts/).
- **Check who controls a protocol**: the
  [Typus authority example](/examples/package-authority/) and
  [Packages and upgrade authority](/concepts/packages/).
- **Check a wallet or a suspect address**: the
  [drainer kit example](/examples/wallet-drainer/), or the `was_i_scammed` and
  `who_is_this_wallet` [everyday prompts](/guides/everyday-prompts/).
- **Test whether wallets share an operator**: the
  [claim farm example](/examples/sybil-farm/) and
  [Shared funders](/concepts/shared-funders/).
- **Trace where funds went**: the
  [Cetus exploit example](/examples/protocol-exploit/) and
  [Fund flows](/concepts/fund-flows/).
- **Read a result's warnings**:
  [How an investigation runs](/start/first-investigation/#reading-the-marks-on-an-answer)
  lists the marks tools put on their own answers, such as `truncated`,
  `complete` and `lower_bound`. [How to read results](/concepts/) explains the
  ones specific to coins, transactions, fund flows and packages.
- **Read Move packages or build unsigned transactions**: load the `developer`
  profile ([Tool profiles](/guides/tool-profiles/)).
- **Look up a tool's parameters**: the [tool reference](/reference/tools/).

Every worked investigation is listed under [Examples](/examples/).
