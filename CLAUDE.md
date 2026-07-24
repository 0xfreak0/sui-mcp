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
- `archive` (native gRPC) exists on mainnet only; on testnet/devnet it falls back
  to the fullnode. Archive fallback pattern: try fullnode first, catch and retry
  with archive.
- Never use JSON-RPC. Fullnode JSON-RPC is deprecated/removed; all on-chain reads
  go through gRPC (`@mysten/sui/grpc`) or GraphQL. `@mysten/sui/client` may only be
  imported for types (`import type`), never as a runtime client.

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
