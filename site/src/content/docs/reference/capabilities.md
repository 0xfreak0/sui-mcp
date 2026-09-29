---
title: Capabilities
description: Per-call network selection, MCP tool metadata, and the areas the tools cover.
sidebar:
  order: 1
---

- **Per-call network** — every chain tool takes an optional `network` arg (`mainnet` / `testnet` / `devnet`); query multiple networks in one session (e.g. compare a testnet value to mainnet). `SUI_NETWORK` sets only the default. Tools that only use the local store (`list_findings`, `export_case`, `delete_finding`) do not take it.
- **MCP metadata** — every tool has a title and annotations: chain reads are `readOnlyHint: true`, tools that write the local store are not, and the ones that delete also carry `destructiveHint`. `trace_funds`, `build_wallet_edges` and `screen_address` also return their JSON as `structuredContent`. Tools whose complete result is the point declare `anthropic/maxResultSizeChars`, so Claude Code keeps a large result inline instead of writing it to a file and showing the model a preview. Each tool's entry in the [tool reference](/reference/tools/) lists its annotations and metadata.
- **Protocol-aware** — decodes transactions from Cetus, Suilend, NAVI, Scallop, Bluefin, DeepBook, and more into human-readable actions
- **Incident investigation** — labeled fund tracing, batch funding attribution with fan-out controls, multi-address timelines, object provenance, exploit-transaction breakdown and incident loss totals in USD at block time, PTB anomaly triage, oracle-vs-market deviation
- **Multisig** — a Sui address is the hash of its authenticator, so the committee is read off the address itself. Names every member, says which keys are live and which have never signed, and shows who signed a given transaction. Also handles zkLogin and passkey wallets. See [Multisig](/guides/multisig/).
- **Move package analysis** — disassembly, heuristic risk scan, capability audit, publisher attribution, upgrade-cap holder status, and upgrade diffing, none of which need an external binary. See [Packages and upgrade authority](/concepts/packages/).
- **Asset verification** — a curated coin registry, so a trace says whether the asset it followed is the real one rather than an imitator wearing its symbol. See [Coin identity and scale](/concepts/coins/).
- **Multi-source architecture** — gRPC for low-latency reads, GraphQL for filtered queries, archive node fallback for historical data
- **Price aggregation** — Aftermath, DefiLlama, Pyth and CoinMarketCap behind one interface, current or at a past block time, with no key required for the default sources. See [Price sources](/guides/configuration/#price-sources).
- **Kiosk-aware** — resolves NFT ownership through Sui's kiosk system to actual wallet addresses. See [Kiosk-held NFTs](/concepts/nft-ownership/).
- **Move Registry (MVR)** — resolves names like `@deepbook/core` to package addresses, and back. See the [Move Registry tools](/reference/tools/move-registry/).
