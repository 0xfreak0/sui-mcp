# Contributing

Contributions should preserve read-only chain access and distinguish observed
facts from attribution.

## Getting started

```bash
git clone https://github.com/0xfreak0/sui-mcp.git
cd sui-mcp
npm install
npm run build
npm test
npm run hooks:install
```

Git does not copy hook settings with a clone. `hooks:install` sets
`core.hooksPath` to `.githooks/` for this checkout; run it to enable the
local checks.

## Never publish

Keep these out of the public repository:

- **Private session links.** Do not include `claude.ai/code/session_...` URLs
  or `Claude-Session:` trailers in commits or PRs. Keep `Co-Authored-By:`.
- **A maintainer's own wallet addresses or SuiNS names**, in code, tests,
  fixtures, docs or commit messages. Use neutral placeholders (`0xw1`).

`.githooks/pre-commit` scans staged content and checks the author and
committer identities. `.githooks/commit-msg` scans commit messages, checks
both identities and validates every `Co-authored-by:` trailer. Both hooks
check identities against the private patterns as well as the public identity
rules. They reject the bare `noreply@users.noreply.github.com` address,
machine-local email domains and GitHub noreply IDs that disagree with a
known login. CI checks identities in the pushed or proposed commits and
verifies unfamiliar GitHub logins against GitHub's user API.

To use GitHub's account-specific noreply address, find your numeric account
ID in GitHub's email settings and configure it for this checkout:

```bash
git config user.email '<ID>+<login>@users.noreply.github.com'
```

`noreply@github.com` is allowed for GitHub's web-flow committer, and
`noreply@anthropic.com` is allowed in a Claude co-author trailer.

Patterns live in two files:

| File | Tracked | For |
|---|---|---|
| `.githooks/patterns` | yes | patterns that are safe to publish |
| `.githooks/patterns.local` | **no** | patterns that are themselves the secret |

Keep private patterns in the ignored `.githooks/patterns.local`, not in the
tracked pattern file. Copy `.githooks/patterns.local.example` and add the
patterns there, including any personal email address you do not want in a
commit identity. The hook reports a match without printing a private pattern.

CI checks tracked patterns in commit messages and files. It cannot read local
patterns, so install the hooks for those checks.

## Development

- `npm run dev` — watch mode (recompiles on save)
- `npm test` — run tests
- `npm run test:watch` — watch mode for tests

## Adding a new tool

1. Create a file in `src/tools/` (one file per logical group of tools).
2. Export a `register*` function that takes an `McpServer` and calls `server.tool()`.
3. Import and call it from `src/tools/index.ts`.
4. Use Zod schemas for input validation. For numbers and booleans use `numArg()`
   and `boolArg()` from `src/tools/args.ts`, not bare `z.number()` / `z.boolean()`.
   These helpers accept quoted numbers and booleans from model-generated JSON.
   For a Sui address, object ID or package ID use `addressArg()` /
   `addressListArg()`. They canonicalize hex addresses and resolve SuiNS names
   on the selected network before the handler runs. Compare canonical
   addresses against chain data. A coin or struct type is `coinTypeArg()`;
   a time or checkpoint given as text is `timePointArg()` (or
   `.superRefine(refinePoint)` on a string-or-number field); a `u64` carried
   as text (an epoch, a version, a raw amount) is `u64StringArg()`. Every tool
   refuses unknown argument names and blank strings through `toolArgsSchema`.
5. Add the tool to a profile in `src/tools/profiles.ts`. An unassigned tool
   remains enabled regardless of profile selection, and
   `test/profiles.test.ts` rejects unassigned registrations.
6. Regenerate the tool reference and the profile list: run `npm run build`,
   then `cd site && npm run gen:tools`, and commit the regenerated files under
   `site/src/content/docs/reference/` and `site/src/content/docs/project/`.
   Put the tool in a group in `GROUPS` in
   `site/scripts/tool-reference.mjs` first; the generator rejects ungrouped
   tools. `test/site-tool-reference.test.ts` fails when the committed pages
   are stale.
7. If the tool writes a record to the store, or never reads the chain, add it
   to `OVERRIDES` in `src/tools/tool-meta.ts`. Every other tool registers as a
   read-only chain read with a `network` argument and a title derived from its
   name. `test/tool-annotations.test.ts` fails when a tool that writes is
   marked read-only.
8. Add tests in `test/` for any non-trivial logic.
9. Give the tool a live check: a probe call in `scripts/probe/` that checks
   its answer, or a case check in `cases/incidents/`.
   `test/live-coverage.test.ts` fails and names a tool without either.
   `adversarial.mjs` checks input handling and does not count as answer coverage.

## Guidelines

- Keep tools read-only where possible. Transaction building tools should return unsigned bytes, never sign or execute.
- Use the existing clients in `src/clients/` rather than creating new HTTP connections.
- Add entries to `src/data/*.json` registries for new tokens, protocols, or collections.
- Run `npx tsc --noEmit`, `npm run build` and `npm test` before submitting a
  PR; packaging tests inspect built output.
- Run `npm run verify:live` after bumping `@mysten/sui`, after a Sui GraphQL
  schema change, or before a release. The offline tests pin mainnet fixtures and
  cannot notice that the chain or the SDK moved underneath them. While working
  on a change, `npm run verify:live -- --tier affected` runs only the live
  checks the change can reach, and `SUI_REPLAY_DIR=<dir>` lets case-pass and
  detector-pass replay the chain reads that cannot change
  (`scripts/probe/README.md`).
- Run `node scripts/probe/oracle-pass.mjs` to compare sampled tool answers
  across eras against the same fact read from the chain by another path: swap
  labels, object ends and object changes, mint authority, flows, cap owners,
  first funding, holder rankings for small coins, staking rewards, native
  bridge beneficiaries, past balances and checkpoint lookups. The report names
  any truth read that is the tool's own query. A sample that cannot be checked
  is counted as skipped; a drawn oracle that checks nothing fails. Use
  `--subjects` to repeat its printed live-state subjects.
  `node scripts/probe/consistency-pass.mjs --seed 17
  --tip 334000000` compares overlapping transaction, funding, balance, flow
  and identity answers on the same subjects, reporting bounded reads as skips.
  The affected tier runs either pass when a tool it checks changes
  (`scripts/probe/lib/tiers.mjs`).
- For a new measurement, use a temporary script and delete it after recording
  the result. Retain scripts that serve a repeatable check or workflow.

For context-size comparisons, build the server and save a case-pass summary:

```bash
npm run build
npm run verify:live -- --keep-summary /tmp/case-pass.json
node scripts/probe/token-baseline.mjs --summary /tmp/case-pass.json --out /tmp/token-baseline
```

The report measures tool definitions by profile selection and answer sizes
from the saved run without repeating its tool calls. It reports characters
and estimated tokens. The script is a manual comparison tool, not a
`verify:live` check.

## Running a blind investigation

Use `scripts/probe/blind-investigation.md` for the investigation rules. Each
investigation uses the MCP tools to check a published incident against its
post-mortem and chain data. Add verified checks to a case file under
`cases/incidents/`; `npm run verify:live` replays them.

1. **Pick an incident** with a published post-mortem that names Sui addresses,
   digests or coin types: the affected project's own report, a security firm's
   analysis, or an official or exchange statement. Prefer an incident old
   enough that its facts cannot drift.
2. **Investigate with the MCP tools only.** During the blind phase, do not
   read `src/`, `test/` or `scripts/`. Running the MCP client snippet in
   `scripts/probe/blind-investigation.md` is allowed, and the brief lists the
   other files you may read. Raw GraphQL or an explorer may verify an answer
   after a tool gave it, and may not be used to find it first.
3. **Grade every answer** against the post-mortem and the chain: `CORRECT`,
   `WRONG`, `MISSING`, `MISLEADING`, `UNUSABLE`, or `GAP` when no tool answers
   the question. Keep the exact call and an excerpt of the output.
4. **Write the case file** in the format `cases/README.md` defines. The blind
   investigation brief asks for 8 to 20 checks; each pins a fact from the
   post-mortem or chain. A check on a wrong answer keeps the correct expected
   value and gets a `known_defect` line. Build the server, then run the case
   from the external directory before copying it into `cases/incidents/`:

   ```bash
   npm run build
   SUI_CASES_DIR="/path/to/case-files" node scripts/probe/case-pass.mjs --case "case-slug"
   ```

5. **Turn each wrong answer into a fix, a regression test and a check.** Fix
   the tool in `src/`. Add a test in `test/` built from the real response
   shape (see "Mocks must be shapes the service can actually produce") that
   fails without the fix. Remove the check's `known_defect`: until you do,
   `case-pass` reports it as `FIXED` and fails the run. A `GAP` becomes an
   issue or a new tool, and a new tool needs its own check.

6. **Label attack transactions.** Add the exploit, drain or drainer
   transactions to `cases/detectors.json` as positives under their incident
   and case. Set `"split": "holdout"` only if no rule was written or tuned
   using that incident. `detector-pass.mjs` scores the detectors against
   those labels.

## Changing an anomaly detector

A rule passes the incidents and negatives it was written or tuned from, so
its own figures on them show only that it fits them. `cases/detectors.json`
keeps those transactions in the `tuning` split and holds back a `holdout`
split that rule authors have not examined.

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
- Make sure CI passes its type checks and tests on the supported Node versions.

## Keeping the protocol registry current

`src/data/protocols.json` maps package IDs to protocols. New protocols need
entries, and upgrades produce new package IDs.

`src/data/protocol-roots.json` records the upgrade-lineage root (the first
version's package ID) and curated name and category for each lineage
represented in `src/data/protocols.json`, and under `custody` every address
that signed a publish or upgrade of that lineage. Runtime lineage lookup
identifies later versions by the same root. Regenerate it after adding
curated entries:

```bash
npm run sync:protocol-roots                # rewrites src/data/protocol-roots.json
```

It refuses to write when two curated entries in one lineage disagree about the
protocol's name or category, since that would mislabel every future version.
`test/protocols-data.test.ts` fails if a curated protocol has no lineage
coverage, which catches a forgotten re-run.

A protocol that redeploys rather than upgrades mints an unrelated root.
Use `find-unknown-packages` below to discover new lineages.

## Keeping curated coins current

The curated verified coin registry vouches for exact coin types, not symbols.
Keep curated entries current with `npm run sync:verified-coins`. The sync
reads Aftermath metadata in batches of at most 100 coin types. A failed or
incomplete batch leaves `coins.json` unchanged. Uncurated mainnet names and
symbols are searched through two DexScreener queries
(ticker and `ticker SUI`), with GeckoTerminal queried when results are absent,
capped or unavailable. Candidate coin types are checked against their exact
on-chain metadata. Results are cached for 10 minutes, including cap-only
`partial` ones; provider outages and failed confirmations are not cached.
Provider failures and provider/local caps report `partial`, and failed confirmations
report `unconfirmed` rather than claiming absence. At most 25 coin types are
confirmed, ranked by verified type, exact symbol, then pool liquidity.
A bounded CoinMetadata scan is the fallback when no live
candidate is confirmed and is also used off mainnet. Neither search path is
a complete coin inventory; no release-time symbol sync is required.

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

To refresh the pinned framework at its recorded commit, run
`npm run sync:framework`. To move it to an upstream ref, pass that ref with
`npm run sync:framework -- REF`. Both commands rewrite
`test/fixtures/sui-framework`; then check its claims:

```bash
npx vitest run test/sui-framework.test.ts
```

A failure names the claim or the function. Decide what the new function
allows before listing it; a function that lets any transaction do something
with a shared or frozen capability belongs in a grant, and the notes then say
so.

## Mocks must be shapes the service can actually produce

Mocks must match the service's page limits, pagination fields and error
statuses. Use the builders in `test/helpers/service-shapes.ts` rather than
hand-writing response literals. They reject responses the service cannot
produce:

```ts
gqlPage(nodes)                    // always has pageInfo; throws above 50 nodes
gqlPages(all)                     // splits into linked, in-cap pages
notFoundError()                   // gRPC NOT_FOUND: an absent object
grpcError("UNAVAILABLE")          // transport failure: no answer
httpOk(body) / httpError(401)     // fetch-shaped responses
```

Keep absence separate from read failures. `notFoundError()` represents a
gRPC `NOT_FOUND` status; `grpcError("UNAVAILABLE")` means the read failed.
`identify_address` can conclude that an address is a wallet from absent
object data, but not from an outage. If a builder rejects a response, correct
the fixture rather than bypassing the builder.

## Adding a bridge

Bridges live in `src/utils/bridge/detect.ts`. Verify both detection and
direction before adding an entry.

Find the package, list its modules and structs, and sample mainnet events to
confirm field names and payloads before adding a bridge. Keep a captured
transaction as a test fixture.
`test/sui-native-bridge.test.ts` and `test/cctp.test.ts` use transactions named
in their comments. `test/fixtures/bridge-transactions.json` holds
`resolve_bridge_transfer`'s GraphQL response for each bridge it covers, keyed
by digest. Capture a new one with the query in `src/tools/bridge.ts` and add
it there.

Check direction and marker specificity:

- **Direction.** Check which events mean leaving Sui. An inbound claim must
  not be detected as an exit.
- **Marker specificity.** Prefer a distinctive module or event name over a
  generic one. Add a test that a similarly named non-bridge call or event
  does not match.
  When the only exit event has a generic name
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

Volume sampling can miss bridges among DEX and oracle activity. Probe
candidate event types by name.

Set `resolution` to what the resolver can follow. `identifier` means
`resolve_bridge_transfer` reads the destination or an id quoted on both
chains, so the hop can be followed;
`detect-only` means the exit is recognised and no more (Meson, whose recipient
is not in Sui data). Use `resolvableHit()` to avoid suggesting a resolver that
cannot follow the exit.

```bash
npm run find-unknown-packages              # sample mainnet, rank unknowns by call count
npm run find-unknown-packages -- --checkpoints 100 --network testnet
```

The script samples recent checkpoints, filters out packages already in the
registry, ranks the remaining packages by call count and prints
`protocols.json` stubs. It does not write registry entries. Verify each
package's identity and category before adding it.

Before adding an entry, get evidence. Never assert a package ID from memory:

- **Move Registry**: `https://mainnet.mvr.mystenlabs.com/v1/resolution/@org/app`
  resolves a registered name to its package ID. Verify the package against
  on-chain data before curating it; registered names alone do not establish
  protocol identity.
- **On-chain module list**: query `package(address:){ modules { nodes { name } } }`
  over GraphQL and inspect the modules.

MVR does not cover every protocol. The registry is hand-maintained and MVR is
only a fallback:
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
`io.github.0xfreak0/sui-mcp`. Use the npm name for installation and the
registry name for MCP discovery.

The weekly data sync opens a pull request for material changes. When
`CHANGELOG.md` already has entries under Unreleased, that PR adds a Data note
there without changing the version; merging does not publish. The data ships
with the next normal release after a full `npm run verify:live`. When no
Unreleased entries are pending, the data PR bumps the patch version and
merging dispatches the publish workflow. Review the PR's source changes and
failed syncs before merging either kind.

The scheduled sync runs from `main` and refreshes disclosed and validator
labels, sanctions, the guardians blocklist, verified coins and protocol roots.
Inferred exchange deposit labels are included only when the sync is dispatched
with `deposit_labels`. Changes consisting only of known run stamps or source
ordering open no PR. A maintainer must approve the bot PR's required CI runs;
manually dispatched checks do not satisfy the PR checks. Data-only patch
merges dispatch the provenance-signed publish workflow only when their version
changed, and an existing version tag for another commit stops the release.

Releases are cut by pushing a version tag. `.github/workflows/publish.yml` runs
the tests, publishes to npm, publishes to the MCP Registry, installs the
result from npm to confirm it starts, and creates the GitHub release from the
version's `CHANGELOG.md` section.

Add the release's notes to `CHANGELOG.md` under a `## X.Y.Z (YYYY-MM-DD)`
heading, then set the version and regenerate the site:

```bash
VERSION=X.Y.Z                     # the version being released
npm run set-version -- "$VERSION" # package.json, server.json, package-lock.json
npm run build
(cd site && npm run gen:tools)
npm test
git add package.json package-lock.json server.json CHANGELOG.md site/src/content/docs/
git commit -m "Release $VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin HEAD
git push origin "v$VERSION"
```

Both publish steps use OIDC authentication; no publishing token is stored in
the repo.
npm side requires trusted publishing to be configured once for the package
(npmjs.com -> the package -> Settings -> Trusted publisher -> this repo +
`publish.yml`); registry side uses `mcp-publisher login github-oidc`.

Check these release requirements:

- **Three version strings have to agree**: `package.json` `version`, and
  `server.json`'s `version` and `packages[0].version`. The registry rejects a
  `server.json` whose version doesn't resolve to a published npm version.
  `npm run set-version` writes all of them; `test/packaging.test.ts` fails if
  they ever drift apart, and CI additionally refuses to publish when the git tag
  disagrees with `package.json`.
- **Verify the published version.** The dist-tag can propagate later than
  the package version, so the workflow installs the exact version.
- **Capture a failed command's output when inspecting it.**
  `stdio: "inherit"` leaves `err.stdout` and `err.stderr` null.
- **An existing npm version cannot be overwritten.** The tag check runs
  before `npm publish`.
- **Local npm lifecycle scripts depend on npm settings.** The `prepublishOnly`
  script runs build and tests unless `ignore-scripts=true` disables it. Check
  with `npm config get ignore-scripts`; use the CI release workflow rather
  than relying on a local publish.
- **`dist/` is git-ignored.** npm falls back to `.gitignore` when there's no
  `.npmignore`, so the `files` allowlist in `package.json` is what actually gets
  the build output into the tarball. Don't remove it.
- **`npm pack --dry-run`** lists exactly what would ship without publishing
  anything. The packaging test runs this too.
- **npm publishes asynchronously.** The release workflow waits until the
  version is readable before submitting to the MCP Registry, which validates
  against npm and rejects a version it cannot see.
- **A rerun skips an npm version already published.** The workflow checks npm
  for the exact version before trying to publish it again.
- **`npm run verify:published -- X.Y.Z`** installs that published version
  (`@latest` when no version is given) in a temporary directory and completes
  an MCP handshake. The packaging tests check the working tree; this check
  inspects the installed package.
- **The decompiler binary is never published.** `bin/move-decompiler` is a
  platform-specific Rust build. `decompile_module` requires a separately built
  binary configured through `SUI_DECOMPILER_PATH` or `PATH`; it works with
  npm installs as well as source builds.

### What needs a new release

Release changes to published package contents, including the `description` in
`package.json` and `server.json` displayed by package directories. Changes
only to the README, CI or documentation do not require a package release.
