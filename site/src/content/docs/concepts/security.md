---
title: Security model
description: The server holds no keys and never submits a transaction; the capabilities the process uses, and how to verify a release.
sidebar:
  order: 10
---

## No wallet, no keys

The server has no credentials and no ability to move funds:

- It never accepts a private key, mnemonic, or seed phrase. No tool takes one
  as an argument and nothing in the code reads one from the environment.
- It never submits a transaction. `build_transfer` and `build_staking` return
  unsigned BCS bytes that you sign and broadcast somewhere else;
  `simulate_transaction` dry-runs bytes against a fullnode without executing
  them.
- Every remaining tool is a read.
- No provider accounts. RPC, indexing, and price data all come from public
  endpoints.

## What the process does

Supply-chain scanners report which capabilities a package uses but not why.
The full list for this one:

| Capability | Where it's used |
|---|---|
| Network | Public Sui RPC and GraphQL; Pyth, Aftermath, DefiLlama and, when `CMC_API_KEY` is set, CoinMarketCap for prices and the verified coin list; the Move Registry for name resolution; the DeepBook indexer for order-book data; the Wormholescan and LayerZero Scan APIs for bridge transfers. Most hosts are in [`src/config.ts`](https://github.com/0xfreak0/sui-mcp/blob/main/src/config.ts) and [`src/utils/price-providers.ts`](https://github.com/0xfreak0/sui-mcp/blob/main/src/utils/price-providers.ts); the bridge APIs are in [`src/utils/bridge/`](https://github.com/0xfreak0/sui-mcp/tree/main/src/utils/bridge). |
| Filesystem | Temp files for `decompile_module`. Reading `SUI_LABELS_FILE`, and the SQLite store at `SUI_STORE_PATH`, when you set them. Reading the forensics skill and data files shipped in the package. `SUI_REPLAY_DIR`, which the test harness sets, records and replays chain reads in the directory it names. |
| Subprocess | One call, in [`src/tools/decompiler.ts`](https://github.com/0xfreak0/sui-mcp/blob/main/src/tools/decompiler.ts), to the decompiler binary you build and configure yourself. It uses `execFile` with array arguments, so no shell is involved and nothing is interpolated into a command string. |
| Environment | The `SUI_`-prefixed variables in [`.env.example`](https://github.com/0xfreak0/sui-mcp/blob/main/.env.example), two optional price-provider keys (`PYTH_API_KEY`, `CMC_API_KEY`), `PATH` when looking for the decompiler, and two switches the test harness uses (`SUI_REPLAY_DIR`, `SUI_DISABLE_LIVE_COIN_LIST`). Nothing else is read. |

There is no `eval`, no dynamic `require`, no minified or obfuscated code, and
no telemetry. Inputs that come from the chain are treated as untrusted:
`decompile_module` validates module names before they reach a filesystem path,
and bounds how many modules one call will process.

Most of the dependency tree is the MCP SDK. This server speaks stdio only and
imports just `server/mcp.js` and `server/stdio.js`, so the SDK's
HTTP-transport dependencies are installed but never loaded.

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
