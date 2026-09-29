---
title: Tool profiles
description: The server starts with a core set of tools and loads the rest on demand; SUI_TOOLS sets the starting profiles.
sidebar:
  order: 1
---

All 76 tools loaded at once cost about 29k tokens of context on every request
(117k characters of tool list; `core` alone is about 7k tokens and
`core,forensics` about 24k), and a large flat tool list makes models pick the
wrong tool. So the server starts with a core set of 18 and keeps the rest one
call away.

## Switching at runtime

When you ask for something outside the current set, such as "trace where these
funds went", the model calls `enable_tools` and the tracing tools appear
immediately, with no restart. You never have to pick a profile.
`enable_tools` names every tool that is still off, and the server's
`instructions` name the profiles and the main investigation tools, so a client
that shows them to the model knows what to ask for. Profile names are
case-insensitive.

## Setting profiles at startup

To start with more, set `SUI_TOOLS`:

```json
"env": { "SUI_TOOLS": "core,forensics" }
```

| Profile | Tools | Contents |
|---|---|---|
| `core` *(default)* | 18 | Wallets, balances, transactions (single and batched), tokens, NFTs, DeFi positions, staking, pools, names |
| `forensics` | 38 | Fund tracing and flow graphs, path finding between addresses, address flow summaries, exploit and incident-loss analysis, exposure screening, exchange deposit-address detection, upgrade history, funding-source attribution, cross-chain bridge resolution, wallet-edge clustering, package analysis, control-group sampling, timelines, object provenance, labels, events, oracle-vs-market deviation, live address watching, NFT marketplace sales |
| `developer` | 18 | Move packages, disassembly, decompilation, upgrade diffing, dependency graphs, PTB decoding, unsigned transaction building, Move Registry |
| `market` | 6 | DeepBook order book and fills, pool stats, token search, validators |
| `all` | 76 | Everything |

The [tool reference](/reference/tools/) lists every tool with its profile and
parameters.

## Clients that cache the tool list

Runtime switching relies on `notifications/tools/list_changed`, sent once per
`enable_tools` call. Claude Code and Claude Desktop honour it; some clients
cache the tool list and will only see the change after a restart. `SUI_TOOLS`
always works, so set it explicitly if your client doesn't refresh.

## Upgrading from 1.1.x

Version 1.1.x loaded every tool at startup. Set `SUI_TOOLS=all` to keep that
behaviour.
