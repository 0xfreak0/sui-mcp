# Contributing

Thanks for your interest in contributing to sui-mcp.

## Getting started

```bash
git clone https://github.com/0xfreak0/sui-mcp.git
cd sui-mcp
npm install
npm run build
npm test
npm run hooks:install
```

`hooks:install` points `core.hooksPath` at `.githooks/`. Git does not clone
hooks, so this is per-checkout and opt-in. A fresh clone has no protection
until you run it.

## Never publish

Two things must not reach this repo, and both have reached it before:

- **`claude.ai/code/session_...` URLs.** The repo is public; the transcript is
  not. Coding agents offer a `Claude-Session:` commit trailer. Do not accept
  it, and keep `Co-Authored-By:`.
- **A maintainer's own wallet addresses or SuiNS names**, in code, tests,
  fixtures, docs *or commit messages*. Use neutral placeholders (`0xw1`).

`.githooks/commit-msg` and `.githooks/pre-commit` enforce both. The message
hook is the one that matters: every leak this repo has actually had was in a
commit message, where a pre-commit hook never looks.

Patterns live in two files:

| File | Tracked | For |
|---|---|---|
| `.githooks/patterns` | yes | patterns that are safe to publish |
| `.githooks/patterns.local` | **no** | patterns that are themselves the secret |

The split is not optional. A hook that blocks your wallet address has to name
it, and naming it in a tracked file publishes exactly what the hook exists to
protect. Copy `patterns.local.example` and fill it in; the hook reports only
that *a* private pattern matched, never which.

CI re-runs the tracked patterns on every pull request, so `--no-verify` does
not get a session URL merged. It cannot check the private list, since those
patterns are deliberately not in the repo, so that half rests on the local hook.

## Development

- `npm run dev` — watch mode (recompiles on save)
- `npm test` — run tests
- `npm run test:watch` — watch mode for tests

## Adding a new tool

1. Create a file in `src/tools/` (one file per logical group of tools).
2. Export a `register*` function that takes an `McpServer` and calls `server.tool()`.
3. Import and call it from `src/tools/index.ts`.
4. Use Zod schemas for input validation. For numbers and booleans use `numArg()`
   and `boolArg()` from `src/tools/args.ts`, not bare `z.number()` / `z.boolean()` —
   a model composing JSON will sometimes quote a value, and strict validation
   turns that into a hard failure over nothing. For a Sui address, object ID or
   package ID use `addressArg()` / `addressListArg()`, which return the
   canonical form and accept SuiNS names; comparing a raw argument against chain
   data fails silently on upper-case or short input. A coin or struct type is
   `coinTypeArg()`, a time or checkpoint given as text is `timePointArg()` (or
   `.superRefine(refinePoint)` on a string-or-number field), and a `u64` carried
   as text (an epoch, a version, a raw amount) is `u64StringArg()`. Every tool
   refuses unknown argument names and blank strings; that happens in
   `toolArgsSchema`, so a new tool gets it without doing anything.
5. Add the tool to a profile in `src/tools/profiles.ts`. A tool in no profile
   still exists but nobody loads it by default.
6. Update the advertised tool counts: the intro in `README.md`, the total and
   the per-profile table in `site/src/content/docs/guides/tool-profiles.md`,
   the total in `site/src/content/docs/guides/decompiler.md`, and the
   `description` in both `package.json` and `server.json`.
   `test/packaging.test.ts` checks these against `PROFILES` and will fail the
   build if they drift.
7. Regenerate the tool reference: run `npm run build`, then
   `cd site && npm run gen:tools`, and commit the regenerated files under
   `site/src/content/docs/reference/`. `test/site-tool-reference.test.ts`
   fails when the committed reference is stale.
8. If the tool writes a record to the store, or never reads the chain, add it
   to `OVERRIDES` in `src/tools/tool-meta.ts`. Every other tool registers as a
   read-only chain read with a `network` argument and a title derived from its
   name. `test/tool-annotations.test.ts` fails when a tool that writes is
   marked read-only.
9. Add tests in `test/` for any non-trivial logic.
10. Give the tool a live check: a call in one of the `scripts/probe/` scripts
    that compares its answer with a raw chain read, or a check in a case in
    `cases/incidents/`. `test/live-coverage.test.ts` fails, naming the tool,
    until one exists. `adversarial.mjs` does not count toward it, since it
    tests input handling and not answers.

## Guidelines

- Keep tools read-only where possible. Transaction building tools should return unsigned bytes, never sign or execute.
- Use the existing clients in `src/clients/` rather than creating new HTTP connections.
- Add entries to `src/data/*.json` registries for new tokens, protocols, or collections.
- Run `npm test` and `npx tsc --noEmit` before submitting a PR.
- Run `npm run verify:live` after bumping `@mysten/sui`, after a Sui GraphQL
  schema change, or before a release. The offline tests pin mainnet fixtures and
  cannot notice that the chain or the SDK moved underneath them. While working
  on a change, `npm run verify:live -- --tier affected` runs only the live
  checks the change can reach, and `SUI_REPLAY_DIR=<dir>` lets case-pass and
  detector-pass replay the chain reads that cannot change
  (`scripts/probe/README.md`).
- Measuring something new? Write a throwaway script and delete it. Record the
  number in a commit message or `CLAUDE.md`. A script kept to rediscover a
  number you already wrote down just rots against live mainnet.

## Running a blind investigation

A blind investigation tests the tools the way a user meets them: a real
incident, worked with the MCP tools alone, every answer graded against a
published post-mortem. Each one leaves a case file in `cases/incidents/` that
`npm run verify:live` replays from then on. `scripts/probe/blind-investigation.md`
is the brief to hand a person or an agent, with the full rules.

1. **Pick an incident** with a published post-mortem that names Sui addresses,
   digests or coin types: the victim's own report, a security firm's analysis,
   or an official or exchange statement. Prefer one old enough that its facts
   cannot drift.
2. **Investigate with the MCP tools only.** Do not read `src/`, `test/` or
   `scripts/`. Raw GraphQL or an explorer may verify an answer after a tool
   gave it, and may not be used to find it first.
3. **Grade every answer** against the post-mortem and the chain: `CORRECT`,
   `WRONG`, `MISSING`, `MISLEADING`, `UNUSABLE`, or `GAP` when no tool answers
   the question. Keep the exact call and an excerpt of the output.
4. **Write the case file** in the format `cases/README.md` defines, with 8 to
   20 checks. Each pins a fact from the post-mortem or the chain. A check on
   an answer the tool gets wrong keeps the correct expected value and gets a
   `known_defect` line. Run it, then copy it into `cases/incidents/`:

   ```bash
   npm run build
   SUI_CASES_DIR=<dir> node scripts/probe/case-pass.mjs --case <slug>
   ```

5. **Turn each wrong answer into a fix, a regression test and a check.** Fix
   the tool in `src/`. Add a test in `test/` built from the real response
   shape (see "Mocks must be shapes the service can actually produce") that
   fails without the fix. Remove the check's `known_defect`: until you do,
   `case-pass` reports it as `FIXED` and fails the run. A `GAP` becomes an
   issue or a new tool, and a new tool needs its own check.

6. **Label its attack transactions.** Add the exploit, drain or drainer
   transactions to `cases/detectors.json` as positives, under the incident
   and case they belong to, with `"split": "holdout"` when no rule was
   written or tuned while looking at the incident. `detector-pass.mjs` then
   scores every detector on them; a holdout incident is the only evidence
   that a rule generalises.

## Changing an anomaly detector

A rule written from one incident catches that incident by construction, so its
own case passing proves little. The same holds for negatives: a rule whose
exclusions were added to clear a set of ordinary transactions passes that set
by construction. `cases/detectors.json` therefore splits its negatives into
`tuning`, which rule authors look at, and `holdout`, which they do not.

```bash
npm run build
node scripts/probe/detector-pass.mjs --split tuning           # while you iterate
node scripts/probe/detector-pass.mjs --json > before.json     # once, on the base commit
node scripts/probe/detector-pass.mjs --json > after.json      # once, when done
```

- **A detector change is judged on the holdout split**: its false-positive rate
  there, and the incidents it detects that are in neither its `incidents` nor
  its `tuned_with`. The tuning figures show only that the rule fits what it
  was fitted to.
- **Iterate on tuning only.** Do not read the holdout digests or their flags
  while you change a rule. `--split tuning` leaves the holdout positives out
  too. If you change a rule to catch a holdout incident, move its positives
  to `tuning` and record it in the rule's origins in the same commit.
- **Rotate the holdout when it has been tuned against.** If you changed a rule
  after reading holdout flags, move those negatives to `tuning` and draw as
  many fresh ones with `node scripts/probe/sample-negatives.mjs`.
- **Record what the rule saw.** Put the incidents it was designed from in
  `detector_origins[code].incidents`, and every incident labelled while you
  set its thresholds, grades or exclusions in `tuned_with`.
- A new medium or high flag on a tuning negative fails the run until the flag
  is fixed or listed in `accepted_fps` with a reason.
- **Holdout is gated by rate, not by entry.** `holdout_ceilings` records, per
  tool and code, how many holdout negatives get a medium or high flag. Any
  change fails the run. When a count falls, lower its ceiling with
  `--write-ceilings`. When it rises, fix the rule, or raise the ceiling
  with a commit that says why the new flags are worth their cost.

Prefer invariants and data-flow rules over names, protocols and thresholds.

## Pull requests

- One feature or fix per PR.
- Include a short description of what changed and why.
- Make sure CI passes (type check + tests on Node 20 and 22).

## Keeping the protocol registry current

`src/data/protocols.json` maps package IDs to protocols, and it drifts two ways:
new protocols launch, and (the case that actually bites) **existing protocols upgrade**.
A package upgrade produces a new package ID, so a protocol we already support
silently stops decoding, with no error and no signal.

Upgrades are handled by lineage rather than by hand. `src/data/protocol-roots.json`
maps each curated package back to the root of its upgrade lineage (its version-1
package ID), which is the same for every version a protocol will ever publish,
so an upgrade nobody has curated still identifies, with its real category, not
just a name. Regenerate it whenever you add entries:

```bash
npm run sync:protocol-roots                # rewrites src/data/protocol-roots.json
```

It refuses to write when two curated entries in one lineage disagree about the
protocol's name or category, since that would mislabel every future version.
`test/protocols-data.test.ts` fails if a curated protocol has no lineage
coverage, which catches a forgotten re-run.

Lineage resolution is a lookup, not a guarantee of freshness: a protocol that
*redeploys* rather than upgrades mints an unrelated root that no lineage walk
will find, so `find-unknown-packages` below is still how new lineages get
discovered.

## Keeping the coin symbol index current

`src/data/coin-symbols.json` lists every mainnet coin by symbol, so
`analyze_token` and `search_token` can answer a symbol that several coins use
(30 coins use `KONG`) without a live scan that cannot reach them. It goes stale
as coins launch: a coin published after the sync is found only by the bounded
live scan, and tools say which date the index has. Regenerate it before a
release:

```bash
npm run sync:coin-symbols                  # rewrites src/data/coin-symbols.json, about 13 minutes
```

The script walks every `CoinMetadata` and coin registry `Currency` object. It
refuses to write when the walk returns fewer coins than the shipped file holds,
which means it was cut short, and when the file would exceed the size budget
stated at the top of the script. Raise the budget on purpose if the chain has
outgrown it; the tarball carries the file.

## Claims about the Sui framework cite its source

A rule that depends on what the Sui framework does (a function taking a
capability by `&` or `&mut`, a function being package-private, a struct's
abilities or field names) states that as a claim beside the rule: a
`FrameworkClaim` from `src/utils/framework-claims.ts`, or an entry in
`CAPABILITY_USES` in `src/utils/object-flow.ts`. `test/sui-framework.test.ts`
parses every non-test framework source, vendored under
`test/fixtures/sui-framework`, and fails on any claim the source
contradicts. For each high-consequence capability it also fails on a
callable function that takes it in any mode, or that consumes what a
function taking it by `&` returns (settling a request with it counts), when
`CAPABILITY_USES` neither grants, covers nor marks it inert, and it checks
that the shared and frozen readings, and the notes, follow from those
functions. It also fails when a parameter naming a capability does not
resolve to the capability's defining module, so a `use` form the parser
misreads cannot hide a function.

Move the pinned framework to a new release and run the test:

```bash
npm run sync:framework -- mainnet-v1.80.1   # rewrites test/fixtures/sui-framework
npx vitest run test/sui-framework.test.ts
```

A failure names the claim or the function. Decide what the new function
allows before listing it; a function that lets any transaction do something
with a shared or frozen capability belongs in a grant, and the notes then say
so.

## Mocks must be shapes the service can actually produce

A mock is an assertion about the outside world. When it asserts something
false, the test stops testing anything. It also keeps passing, which is worse
than failing.

Three bugs shipped green this way:

- `activeValidators(first: 200)` was mocked as one page with no `pageInfo`.
  Mainnet rejects that query outright ("Page size is too large: 200 > 50"),
  so `identify_address` had **never once** detected a validator and
  `get_staking_summary` failed on every call naming one. Every test passed.
- Absence was mocked as `new Error("not found")`. The service signals it with a
  gRPC `NOT_FOUND` **status**, so code that correctly checks the status looked
  broken while a catch-everything looked correct.
- Both let a completely dead code path report success.

Use the builders in `test/helpers/service-shapes.ts` rather than hand-writing
response literals. They encode the constraints the services impose and **throw**
instead of building something impossible, so a false assumption fails at
authoring time:

```ts
gqlPage(nodes)                    // always has pageInfo; throws above 50 nodes
gqlPages(all)                     // splits into linked, in-cap pages
notFoundError()                   // gRPC NOT_FOUND — absence, which is an answer
grpcError("UNAVAILABLE")          // a failure, which is not
httpOk(body) / httpError(401)     // fetch-shaped responses
```

The distinction `notFoundError()` and `grpcError()` draw is load-bearing, not
stylistic. Absence is an answer callers conclude things from —
`identify_address` reports a wallet on it, while an outage means the question
could not be asked. A test that blurs them proves nothing about the code that
keeps them apart.

If a builder rejects the response you wanted, that is the finding. Do not
work around it by writing the literal by hand.

## Adding a bridge

Bridges live in `src/utils/bridge/detect.ts`, and the bar for adding one is
higher than for a protocol entry: a marker that never fires is dead weight, and
one that fires on the wrong call does more harm than none at all.

**Verify on mainnet before adding anything.** Find the package, list its
modules and structs, then sample real events to confirm the field names and see
what a live payload actually contains. Every entry currently in the registry was
added only after a real transaction was captured, and the payloads are the test
fixtures. `test/sui-native-bridge.test.ts` and `test/cctp.test.ts` are built
from transactions named in their comments; `test/fixtures/bridge-transactions.json`
holds `resolve_bridge_transfer`'s own GraphQL response for one real
transaction per newer bridge, keyed by digest. Capture a new one with the query
in `src/tools/bridge.ts` and add it there.

Two things that sampling catches and guessing does not:

- **Direction.** An inbound claim is not an exit. Detecting one as an exit sends
  an investigator to the wrong chain. Check which events mean *leaving*.
- **Marker specificity.** `init_order` looked like a good Mayan marker; it would
  have collided with DEX order books, which emit some of the highest-frequency
  events on mainnet. The markers carry `mctp` instead. Prefer a distinctive
  module or event name over a generic one, and add a test asserting the
  lookalike does *not* match. When the only exit event has a generic name
  (`events::TokensSentEvent`), pin it to its package with a
  `0xpkg::module::Name` marker; events keep the defining package's id across
  upgrades. When a call marker's prefix would catch a sibling function, list
  it in `exactCallMarkers`.

To resolve a new bridge, write its decoder in `src/utils/bridge/<name>.ts`,
pinned to the emitting package, and add it to `readBridgeEvents` in
`src/utils/bridge/exits.ts`. Its beneficiary then reaches
`resolve_bridge_transfer`, `screen_address` and any other caller of
`readBridgeEvents` together. Give it a section in the tool and add its name to
`SECTIONED` in `src/tools/bridge.ts`.

Note that volume sampling will **not** surface bridges. A survey of 1200 recent
mainnet events turned up 180 `order::OrderCanceled` and not one bridge event —
bridge traffic is rare next to DEX and oracle activity. Probe candidate event
types by name instead.

Set `resolution` honestly. `identifier` means `resolve_bridge_transfer` reads
the destination or an id quoted on both chains, so the hop can be followed;
`detect-only` means the exit is recognised and no more (Meson, whose recipient
is not in Sui data). Never point a caller at a resolver that cannot help them —
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

Before adding an entry, get evidence. Never assert a package ID from memory:

- **Move Registry**: `https://mainnet.mvr.mystenlabs.com/v1/resolution/@org/app`
  returns the authoritative `package_id`. This is the best source when it works.
- **On-chain module list**: query `package(address:){ modules { nodes { name } } }`
  over GraphQL. Module names are usually self-identifying (`alphafi_*`,
  `batch_price_attestation`, `guardian_set`).

MVR coverage is thin. Roughly half of even our own curated registry is
unregistered, and some large protocols (AlphaFi) have no MVR presence at all.
That is why the registry is hand-maintained and MVR is only a fallback:
`lookupProtocolDisplay` will show an MVR name for an unknown package, but
`lookupProtocol` stays curated-only because fund tracing makes pass-through
decisions from it. The lineage tier sits on the curated side of that line: only
the `UpgradeCap` holder can add a version, so a lineage is a fact the chain
enforces, unlike a name anybody may register.

`test/protocols-data.test.ts` checks the JSON against the `ProtocolType` union
(plain JSON is otherwise unchecked by tsc), so adding a category means adding it
in both `registry.ts` and that test's list.

## Releasing

The npm package is `sui-analytics-mcp`; the MCP Registry entry is
`io.github.0xfreak0/sui-mcp`. The names differ on purpose, because `sui-mcp` was
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
- **The post-publish check runs against the EXACT version, not `@latest`.** The
  dist-tag is a second thing that has to propagate, so verifying `@latest` can
  fail while the version itself is already installable, and it would silently
  pass against the previous release if the tag lagged.
- **Anything that inspects a failed command's output must CAPTURE it.**
  `stdio: "inherit"` prints to the console and leaves `err.stdout`/`err.stderr`
  null, so a check that greps them sees only "Command failed: …". That is how
  the publish retry sat broken through several releases while appearing to
  exist.
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
- **npm publishes asynchronously.** `npm publish` answers 202 Accepted and the
  version becomes readable some minutes later. Measured on 1.17.0: about six
  minutes. The release workflow waits for it before submitting to the MCP
  Registry, which validates against npm and rejects a version it cannot see.
- **The publish step skips a version already on npm.** Re-running the job is the
  only recovery GitHub offers and it restarts from the top, so without that a
  re-run dies on "cannot publish over" before reaching the step that failed.
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
one, but note that `description` in `package.json` and `server.json` is what
directory pages display, and updating it does mean a release.
