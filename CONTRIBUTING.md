# Contributing

Thanks for your interest in contributing to sui-mcp.

## Getting started

```bash
git clone https://github.com/0xfreak0/sui-mcp.git
cd sui-mcp
npm install
npm run build
npm test
```

## Development

- `npm run dev` — watch mode (recompiles on save)
- `npm test` — run tests
- `npm run test:watch` — watch mode for tests

## Adding a new tool

1. Create a file in `src/tools/` (one file per logical group of tools).
2. Export a `register*` function that takes an `McpServer` and calls `server.tool()`.
3. Import and call it from `src/tools/index.ts`.
4. Use Zod schemas for input validation.
5. Add tests in `test/` for any non-trivial logic.

## Guidelines

- Keep tools read-only where possible. Transaction building tools should return unsigned bytes, never sign or execute.
- Use the existing clients in `src/clients/` rather than creating new HTTP connections.
- Add entries to `src/data/*.json` registries for new tokens, protocols, or collections.
- Run `npm test` and `npx tsc --noEmit` before submitting a PR.

## Pull requests

- One feature or fix per PR.
- Include a short description of what changed and why.
- Make sure CI passes (type check + tests on Node 20 and 22).
