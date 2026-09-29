---
title: Investigation examples
description: Worked investigations of public Sui incidents, each as the tool calls in order with the part of each answer that matters.
sidebar:
  label: Overview
  order: 0
---

Each example takes one public incident from the repository's
[`cases/incidents/`](https://github.com/0xfreak0/sui-mcp/tree/main/cases/incidents)
directory and answers one question about it. The steps are the tool calls in
the order an investigator would make them, with their arguments and a trimmed
excerpt of each answer. The case file for each incident holds the addresses,
the digests and the published sources the steps rely on.

| Example | Question it answers |
|---|---|
| [Cetus CLMM exploit](/examples/protocol-exploit/) | What did an exploit wallet take, from which pools, and where did it send the proceeds off Sui? |
| [KONG SUI rug pull](/examples/token-rug/) | Could the deployer still mint or upgrade, who sold into the pool, and where did the sale proceeds go? |
| [claim::swapS drainer kit](/examples/wallet-drainer/) | How did a drainer package take staked SUI while a dry run showed no loss, and who collected it? |
| [WAL claim farm](/examples/sybil-farm/) | Do the wallets that claimed and swept an airdrop to one address share a funder, and does a control group? |
| [Typus oracle authority check](/examples/package-authority/) | Which package version was live at an exploit, who could call the price update, and what did the fix change? |

## Reading the excerpts

- An excerpt keeps only the fields that answer the step's question. `…` marks
  what was cut. Full answers carry more fields, and USD values, which come from
  a price provider, are left out.
- Tool names link to the [tool reference](/reference/tools/). Several of these
  tools are outside the default `core` profile; see
  [Tool profiles](/guides/tool-profiles/) to load them.
- Anomaly flags, clusters and deposit-address verdicts are leads. A check that
  did not match clears nothing.
