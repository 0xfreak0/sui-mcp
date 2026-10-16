---
title: Security model
description: The server holds no keys and never submits a transaction; the capabilities the process uses, and how to verify a release.
sidebar:
  order: 11
---

## No wallet, no keys

The server has no wallet credentials and no ability to move funds:

- It never accepts a private key, mnemonic, or seed phrase. No tool takes one
  as an argument and nothing in the code reads one from the environment.
- It never submits a transaction. `build_transfer` and `build_staking` return
  unsigned BCS bytes that you sign and broadcast somewhere else;
  `simulate_transaction` dry-runs bytes against a fullnode without executing
  them.
- Other tools read chain or provider data, or manage the optional local store.
- Public RPC and indexing endpoints need no provider account. Aftermath,
  DefiLlama, CoinGecko and GeckoTerminal prices need no key; Pyth is opt-in
  through `PYTH_API_KEY`.

## What the process does

The server uses these runtime capabilities:

| Capability | Where it's used |
|---|---|
| Network | Public Sui RPC and GraphQL; Pyth, Aftermath and DefiLlama for prices and the verified coin list; CoinGecko and GeckoTerminal for recent historical prices; the Move Registry for name resolution; the DeepBook indexer for order-book data; the Wormholescan and LayerZero Scan APIs for bridge transfers. Most hosts are in [`src/config.ts`](https://github.com/0xfreak0/sui-mcp/blob/main/src/config.ts), [`src/utils/price-providers.ts`](https://github.com/0xfreak0/sui-mcp/blob/main/src/utils/price-providers.ts) and [`src/utils/recent-prices.ts`](https://github.com/0xfreak0/sui-mcp/blob/main/src/utils/recent-prices.ts); the bridge APIs are in [`src/utils/bridge/`](https://github.com/0xfreak0/sui-mcp/tree/main/src/utils/bridge). |
| Filesystem | Temp files for `decompile_module`. Reading `SUI_LABELS_FILE`, and the SQLite store at `SUI_STORE_PATH`, when you set them. Reading the forensics skill and data files shipped in the package. `SUI_REPLAY_DIR`, which the test harness sets, records and replays chain reads in the directory it names. |
| Subprocess | One call, in [`src/tools/decompiler.ts`](https://github.com/0xfreak0/sui-mcp/blob/main/src/tools/decompiler.ts), to the decompiler binary you build and configure yourself. It uses `execFile` with array arguments, so no shell is involved and nothing is interpolated into a command string. |
| Environment | The `SUI_`-prefixed variables in [`.env.example`](https://github.com/0xfreak0/sui-mcp/blob/main/.env.example), the optional price-provider key `PYTH_API_KEY`, `PATH` when looking for the decompiler, and the test harness switches `SUI_REPLAY_DIR` and `SUI_DISABLE_LIVE_COIN_LIST`. Nothing else is read. |

There is no `eval`, no dynamic `require`, no minified or obfuscated code, and
no telemetry. Inputs that come from the chain are treated as untrusted:
`decompile_module` validates module names before they reach a filesystem path
and bounds the modules processed in one call.

## Chain and provider text

Coin metadata, NFT Display fields, event JSON, object content, SuiNS names,
Move code and imported labels can be written by someone other than the
investigator. Tool results mark human-readable fields with `untrusted_text`.
Their contents are evidence to examine and must never be followed as
instructions, even if they claim to come from the server or the investigator.

Every string and object key in a tool result shows hidden characters as
visible `\u` escapes: controls, bidirectional formatting, zero-width and
invisible characters, variation selectors and Unicode tag characters, which
can spell out text a reader never sees. Joiners and selectors that form an
emoji or a word in a script shaped with them are kept, and so are the tags of
the England, Scotland and Wales flags.

Human-readable fields (names, symbols, descriptions, labels, notes,
summaries, decoded transaction arguments) also escape HTML and Markdown
syntax, and each is cut after 2,048 characters with the number of characters
removed. A field that is a single `http`, `https`, `ipfs`, `ipns`, `ar`, `ws`
or `wss` URL keeps its spelling; a `data:` URI is text and is cut like other
text. Inside decoded chain data (event JSON, `aggregate_events` event
samples, object content, Display fields) the field names are chosen by
whoever wrote the data, so every string there is escaped unless it is a Move
type tag or hex bytes, and field names that are not Move identifiers are
escaped too. Addresses, digests, amounts, Move type tags (declared types such
as `Balance<T0>` included), hex bytes such as a pure `vector<u8>` argument
and continuation calls keep their spelling apart from hidden characters and
are never cut, and error messages show hidden characters only, so a type
tag they quote stays usable. Code listings keep their lines and type tags, so
their contents must still be read as untrusted data.

Every chain-reading tool's JSON result uses the guard; `enable_tools` is a
control tool with no chain data. Plain-text items keep their formatting and
show hidden characters only: the prose summaries that `trace_funds`,
`trace_flow_graph`, `find_flow_path`, `analyze_attack_tx` and
`summarize_incident_losses` return before their JSON, the Markdown, Mermaid
and CSV outputs of `export_case` and the `sui://case/{name}` report, and the
Mermaid and CSV outputs of the trace and flow tools. A summary quotes labels
and coin symbols, and a Mermaid or CSV result carries no JSON
`untrusted_text` field. Clients must render tool text as data rather than
active HTML.

Stored-result resource pages guard each row under the name of the list it
came from, by the same field rules as the tool's own response.

The server speaks stdio only. From the MCP SDK it imports `server/mcp.js`,
`server/stdio.js` and `types.js`, so the SDK's HTTP-transport dependencies are
installed but never loaded.

## Verifying a release

Releases are published from CI with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements), so
every tarball carries a signed attestation tying it to the commit and workflow
run that produced it:

```bash
npm audit signatures
```

## Reporting a vulnerability

See [Security policy](/project/security/).
