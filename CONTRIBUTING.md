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

## Keeping the protocol registry current

`src/data/protocols.json` maps package IDs to protocols, and it drifts two ways:
new protocols launch, and — the one that bites — **existing protocols upgrade**.
A package upgrade produces a new package ID, so a protocol we already support
silently stops decoding, with no error and no signal.

Upgrades are handled by lineage rather than by hand. `src/data/protocol-roots.json`
maps each curated package back to the root of its upgrade lineage (its version-1
package ID), which is the same for every version a protocol will ever publish,
so an upgrade nobody has curated still identifies — with its real category, not
just a name. Regenerate it whenever you add entries:

```bash
npm run sync:protocol-roots                # rewrites src/data/protocol-roots.json
```

It refuses to write when two curated entries in one lineage disagree about the
protocol's name or category, since that would mislabel every future version.
`test/protocols-data.test.ts` fails if a curated protocol has no lineage
coverage, which is what catches a forgotten re-run.

Lineage resolution is a lookup, not a guarantee of freshness: a protocol that
*redeploys* rather than upgrades mints an unrelated root that no lineage walk
will find, so `find-unknown-packages` below is still how new lineages get
discovered.

## Adding a bridge

Bridges live in `src/utils/bridge/detect.ts`, and the bar for adding one is
higher than for a protocol entry: a marker that never fires is dead weight, and
one that fires on the wrong call is worse than nothing.

**Verify on mainnet before adding anything.** Find the package, list its
modules and structs, then sample real events to confirm the field names and see
what a live payload actually contains. Every entry currently in the registry was
added only after a real transaction was captured, and the payloads are the test
fixtures — `test/sui-native-bridge.test.ts` and `test/cctp.test.ts` are built
from transactions named in their comments.

Two things that sampling catches and guessing does not:

- **Direction.** An inbound claim is not an exit. Detecting one as an exit sends
  an investigator to the wrong chain. Check which events mean *leaving*.
- **Marker specificity.** `init_order` looked like a good Mayan marker; it would
  have collided with DEX order books, which emit some of the highest-frequency
  events on mainnet. The markers carry `mctp` instead. Prefer a distinctive
  module or event name over a generic one, and add a test asserting the
  lookalike does *not* match.

Note that volume sampling will **not** surface bridges. A survey of 1200 recent
mainnet events turned up 180 `order::OrderCanceled` and not one bridge event —
bridge traffic is rare next to DEX and oracle activity. Probe candidate event
types by name instead.

Set `resolution` honestly. `identifier` means a shared id is quoted on both
chains and the hop can be followed; `detect-only` means the exit is recognised
and no more. Never point a caller at a resolver that cannot help them —
`resolvableHit()` is the guard.

```bash
npm run find-unknown-packages              # sample mainnet, rank unknowns by call count
npm run find-unknown-packages -- --checkpoints 100 --network testnet
```

The script samples recent checkpoints, filters out packages already in the
registry, and ranks what's left by how often it was actually called, so the
top of the list is what users are most likely to hit. It prints
ready-to-edit `protocols.json` stubs but never writes to the registry:
identifying the protocol behind an address and choosing its category are
judgement calls.

Before adding an entry, get evidence — never assert a package ID from memory:

- **Move Registry**: `https://mainnet.mvr.mystenlabs.com/v1/resolution/@org/app`
  returns the authoritative `package_id`. This is the best source when it works.
- **On-chain module list**: query `package(address:){ modules { nodes { name } } }`
  over GraphQL. Module names are usually self-identifying (`alphafi_*`,
  `batch_price_attestation`, `guardian_set`).

MVR coverage is thin — roughly half of even our own curated registry is
unregistered, and some large protocols (AlphaFi) have no MVR presence at all.
That is why the registry is hand-maintained and MVR is only a fallback:
`lookupProtocolDisplay` will show an MVR name for an unknown package, but
`lookupProtocol` stays curated-only because fund tracing makes pass-through
decisions from it. The lineage tier is on the curated side of that line — only
the `UpgradeCap` holder can add a version, so a lineage is a fact the chain
enforces, unlike a name anybody may register.

`test/protocols-data.test.ts` checks the JSON against the `ProtocolType` union
(plain JSON is otherwise unchecked by tsc), so adding a category means adding it
in both `registry.ts` and that test's list.

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
