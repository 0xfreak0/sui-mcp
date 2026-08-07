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

## Releasing

The npm package is `sui-analytics-mcp`; the MCP Registry entry is
`io.github.0xfreak0/sui-mcp`. They are different names on purpose — `sui-mcp` was
already taken on npm by an unrelated package.

Releases are cut by pushing a version tag. `.github/workflows/publish.yml` runs
the tests, publishes to npm, publishes to the MCP Registry, and then installs the
result from npm to confirm it starts.

```bash
npm run set-version -- 1.1.0      # package.json + server.json + lockfile
npm run build && npm test
git commit -am "Release 1.1.0"
git tag -a v1.1.0 -m "v1.1.0"
git push && git push --tags       # CI does the rest
```

Both publish steps authenticate over OIDC, so there are no secrets in the repo.
npm side requires trusted publishing to be configured once for the package
(npmjs.com -> the package -> Settings -> Trusted publisher -> this repo +
`publish.yml`); registry side uses `mcp-publisher login github-oidc`.

Things that are easy to get wrong here:

- **Three version strings have to agree**: `package.json` `version`, and
  `server.json`'s `version` and `packages[0].version`. The registry rejects a
  `server.json` whose version doesn't resolve to a published npm version.
  `npm run set-version` writes all of them; `test/packaging.test.ts` fails if
  they ever drift apart, and CI additionally refuses to publish when the git tag
  disagrees with `package.json`.
- **npm versions are permanent.** A version can be deprecated but not replaced,
  so the tag check runs before `npm publish`, not after.
- **`npm publish` may skip `prepublishOnly` when run locally.** The
  `prepublishOnly` script runs build + tests as a guard against publishing a
  stale `dist/`, but npm skips all lifecycle scripts when `ignore-scripts=true`
  is set in `.npmrc` (a reasonable supply-chain precaution that some
  contributors set globally). Check with `npm config get ignore-scripts`. This is
  a large part of why releases go through CI, which has clean settings.
- **`dist/` is git-ignored.** npm falls back to `.gitignore` when there's no
  `.npmignore`, so the `files` allowlist in `package.json` is what actually gets
  the build output into the tarball. Don't remove it.
- **`npm pack --dry-run`** lists exactly what would ship without publishing
  anything. The packaging test runs this too.
- **`npm run verify:published`** installs the published package from npm into a
  temp directory and completes an MCP handshake against it. The packaging tests
  only see the working tree; this is what catches a tarball that installs but
  won't start.
- **The decompiler binary is never published.** `bin/move-decompiler` is a
  platform-specific Rust build, so a tarball could only ever carry one
  architecture. `decompile_module` requires a clone plus `SUI_DECOMPILER_PATH`;
  keep its error message accurate for people who installed from npm and have no
  local checkout.

### What needs a new release

Only changes to published code. Editing the README, CI, or docs doesn't require
one — but note that `description` in `package.json` and `server.json` is what
directory pages display, and updating it does mean a release.
