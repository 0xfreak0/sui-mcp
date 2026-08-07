# sui-mcp

MCP server for querying the Sui blockchain over stdio.

## Stack

- TypeScript (ES2022, NodeNext modules, strict mode)
- `@mysten/sui` gRPC client + `graphql-request` for filtered queries
- `@modelcontextprotocol/sdk` for MCP server framework
- `zod` for input validation
- `vitest` for tests

## Architecture

```
src/
├── index.ts              # MCP server entry point (stdio transport)
├── config.ts             # Network endpoints, constants
├── clients/              # gRPC + GraphQL client setup
├── tools/                # One file per tool category (41 tools total)
├── protocols/            # Protocol registry for tx decoding
├── data/                 # Static JSON data (token registry, etc.)
├── utils/                # Shared helpers (formatting, SuiNS, etc.)
├── discovery.ts          # Token discovery (static + Aftermath fallback)
├── discovery-nft.ts      # NFT collection discovery
└── resources.ts          # MCP resources
```

Per-call network selection. `SUI_NETWORK` sets only the *default* (mainnet if
unset); every tool also takes an optional `network` arg ("mainnet" | "testnet"
| "devnet"), so a single session can query multiple networks (e.g. compare a
testnet value to mainnet).

- `src/tools/with-network.ts` wraps `server.tool` once: it injects the `network`
  arg into every tool's schema and runs each handler inside
  `runWithNetwork(network)` (an `AsyncLocalStorage` context in `config.ts`).
  Individual tool files are untouched.
- `sui` / `archive` (grpc) and `gqlQuery` (graphql) are **proxies** over
  per-network client caches (`getClients`, `getGraphqlClient`). They re-resolve
  against `getNetwork()` on every access, so the same imported reference targets
  whichever network the active call selected. Clients are built lazily and cached
  per network. `getNetwork()` reads the async context, falling back to the default.
- Never use JSON-RPC. Fullnode JSON-RPC is deprecated/removed; all on-chain reads
  go through gRPC (`@mysten/sui/grpc`) or GraphQL. `@mysten/sui/client` may only be
  imported for types (`import type`), never as a runtime client.

### Which transport to use

Pick by the *shape of the read*, not by preference:

| Read shape | Transport | Why |
|---|---|---|
| Point lookup by key (object ID, tx digest, checkpoint, epoch, package) | **gRPC** (`sui`) | `ledgerService` is get-by-key and lower latency; there is no filter API to need. |
| Filtered or paginated set (txs by sender, events by type, holders, NFTs) | **GraphQL** (`gqlQuery`) | Only GraphQL exposes filter arguments and cursors. Max page size is 50. |
| Anything historical enough to be pruned | **gRPC via `withArchiveFallback`** | See below. |
| Non-Sui service (Aftermath, Pyth, MVR) | `fetch` + `EXTERNAL_HTTP_TIMEOUT_MS` | `fetch` has no default timeout; always pass the shared one. |

If both transports could serve a read, prefer gRPC — GraphQL's 50-item page cap
turns anything list-shaped into a pagination loop.

### Archive fallback

`archive` exists on **mainnet and testnet**; devnet has none, so `getClients()`
returns the fullnode client under both names there.

The archives speak **native gRPC over TLS, not gRPC-Web**, so `NetworkConfig.archive`
is a `host:port` target for `GrpcTransport`, not an `https://` URL like the other
endpoints. That inconsistency is load-bearing: a gRPC-Web client aimed at
`https://archive.mainnet.sui.io` gets a 404. Don't "fix" it.

Do not hand-roll the fallback. Use `withArchiveFallback(call, isEmpty)` from
`src/utils/archive-fallback.ts`.

Pruned and nonexistent data both surface as a gRPC **`NOT_FOUND` throw**, not as
an empty response — verified against mainnet for `getObject`, `getTransaction`,
`getCheckpoint` and `getEpoch`. The throw path is therefore the one that matters.
The `isEmpty` predicate guards the other shape (a response missing the field the
caller needs); no probe has made it fire, so keep it narrow and don't design
around it. Skipping the fallback entirely on devnet is deliberate — `archive` is
the fullnode there.

## Commands

```bash
npm run build     # tsc + copy data files to dist/
npm test          # vitest run
npm run dev       # tsc --watch
npm start         # node dist/index.js
```

## Key Patterns

- `@protobuf-ts` oneof uses `oneofKind` (not `case`)
- SDK `Event` has `eventType` (not `type`), `module`, no `parsedJson`
- SDK `BalanceChange` has `address` (not `owner`)
- `GrpcTypes` must be imported as value (not `import type`) when using enum values
- GraphQL max page size: 50
- Build copies `src/data/` to `dist/data/` — JSON files must exist in dist at runtime
