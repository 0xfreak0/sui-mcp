---
title: Capabilities
description: Per-call network selection, MCP tool metadata, and the areas the tools cover.
sidebar:
  order: 1
---

- **Per-call network** — every chain tool takes an optional `network` arg (`mainnet` / `testnet` / `devnet`); query multiple networks in one session (e.g. compare a testnet value to mainnet). `SUI_NETWORK` sets only the default. Tools that only use the local store (`list_findings`, `export_case`, `delete_finding`) do not take it.
- **MCP metadata** — every tool has a title and annotations: chain reads are `readOnlyHint: true`, tools that write the local store are not, and the ones that delete also carry `destructiveHint`. `trace_funds`, `build_wallet_edges` and `screen_address` also return their JSON as `structuredContent`. Tools whose complete result is the point declare `anthropic/maxResultSizeChars`, so Claude Code keeps a large result inline instead of writing it to a file and showing the model a preview. Each tool's entry in the [tool reference](/reference/tools/) lists its annotations and metadata.
- **JSON output** — tool JSON responses, graph JSON exports and SuiNS resolution annotations use compact encoding without indentation. The encoding retains all fields, rows, caveats and continuations; resource bodies, stored results and non-JSON exports keep their own formats.
- **Protocol-aware** — decodes transactions from Cetus, Suilend, NAVI, Scallop, Bluefin, DeepBook, and more into human-readable actions
- **Incident investigation** — labeled fund tracing, batch funding attribution with fan-out controls, multi-address timelines, object provenance, exploit-transaction breakdown in USD at block time, incident coin totals using historical prices at movement times, PTB anomaly triage and oracle-vs-market comparison.
- **Multisig** — derives a committee from a transaction signature and verifies it against the address. Reports members, observed signers and members absent from the examined transaction history. Also reports zkLogin and passkey authentication. See [Multisig](/guides/multisig/).
- **Move package analysis** — disassembly, heuristic risk scan, capability audit, publisher attribution, UpgradeCap holder status and upgrade diffs without an external binary. See [Packages and upgrade authority](/concepts/packages/).
- **Asset verification** — curated coin types identify assets the project has reviewed. An unverified symbol alone does not establish a coin's identity. See [Coin identity and scale](/concepts/coins/).
- **Chain reads** — gRPC for point lookups, GraphQL for filtered queries and archive fallback for historical data.
- **Price sources** — Aftermath for current prices, DefiLlama for current and historical prices, and CoinGecko and GeckoTerminal for recent historical dates when needed. Pyth requires `PYTH_API_KEY` and is used only for verified coins. See [Price sources](/guides/configuration/#price-sources).
- **Kiosk-aware** — resolves an individual kiosk's current cap holder; collection-wide holder scans also use sale-derived ownership and mark owners inferred from a kiosk's mutable owner field. See [Kiosk-held NFTs](/concepts/nft-ownership/).
- **Move Registry (MVR)** — resolves names like `@deepbook/core` to package addresses, and back. See the [Move Registry tools](/reference/tools/move-registry/).
