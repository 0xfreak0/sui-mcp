---
title: Examples
description: Tool calls and selected results for investigations based on public Sui cases.
sidebar:
  label: Overview
  order: 0
---

These examples use public incidents from
[`cases/incidents/`](https://github.com/0xfreak0/sui-mcp/tree/main/cases/incidents).
Each case file records its subjects, checks and sources. Results below show
selected fields; consult the full tool response before drawing a conclusion.

| Example | Reads |
|---|---|
| [Cetus CLMM exploit](/examples/protocol-exploit/) | Exploit gains, pool state and bridge exits |
| [KONG SUI rug pull](/examples/token-rug/) | Mint authority, deployer swap and SUI transfers |
| [claim::swapS drainer kit](/examples/wallet-drainer/) | Shared-state changes and collector payments |
| [WAL claim farm](/examples/sybil-farm/) | Shared first funding and a control sample |
| [Typus oracle authority check](/examples/package-authority/) | Called version, UpgradeCap holder and missing authorization check |

## Reading the excerpts

- Excerpts show selected response fields. `…` marks omitted fields or rows.
  USD values rely on external price providers and are omitted here.
- Tool names link to the [tool reference](/reference/tools/). Several of these
  tools are outside the default `core` profile; see
  [Tool profiles](/guides/tool-profiles/) to load them.
- Anomaly flags, clusters and deposit-address verdicts are leads. A check that
  did not match clears nothing.
