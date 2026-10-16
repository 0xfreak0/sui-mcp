# Live checks

Run `npm run verify:live` from the repo root after building. The scripts call
the built server.

```bash
npm run build && npm run verify:live && npm test
```

| Script | What it does |
|---|---|
| `dump-fixtures.mjs` | Regenerates `test/fixtures/signatures.json` from live mainnet. |
| `adversarial.mjs` | Generates malformed input for every tool field and checks rejection, response time and server survival. `VERBOSE=1` prints every case. |
| `investigation.mjs` | Chained end-to-end run: a failed transaction, why it failed, who published the package, who they are, their fan-out and deny-list exposure. |
| `full-case.mjs` | Checks cross-tool consistency for committees, publishers, coin verification and deny-list directions. |
| `gap-pass.mjs` | Checks a regulated coin and capped history. |
| `consistency-pass2.mjs` | Compares registry decimals, abort details and sponsor counts with independent reads. |
| `consistency-pass.mjs` | Compares overlapping tool answers on a seeded recent transaction and public-case subjects: single/batch transactions, PTB counts and Move call targets, object custody, first funding, liquid and historical balances, history source amounts and flow nets, graph root outflows, bridge exits, object classification and single-transaction profit. Each comparison uses the same subject and complete scope. Bounded or incomparable reads are reported as skips; unexpected disagreements fail. `--seed S --tip T` reproduces the recent draw. |
| `incident-pass.mjs` | The incident tools replayed on the Cetus and Nemo exploits through the built server over stdio, each answer against a raw chain read taken in the same run: attack and incident-loss nets against the raw balance changes, trace and flow-graph hops against the payer and next debit on chain, every bridge's beneficiary against its event or payload bytes, flow totals against per-transaction sums, upgrade history and cap custody against package versions and object changes, signatures and bytecode against each exact version, diffs against a line diff of both versions, a deny list against its Config's fields, and prices against DefiLlama read directly. Records every call's latency and size. |
| `attribution-pass.mjs` | The attribution and history tools (funding, fan-out, deposit, screening, wallet edges, control groups, multisig, timelines, events, transactions, balances, holders, NFT sales, identity) against a raw GraphQL read of the same fact in the same run, plus one malformed input per tool. Prints each tool's slowest call and largest result, and fails on a call over 60s or a result over the tool's declared size. |
| `surface-pass.mjs` | The stateful tools (labels, findings, watches, `enable_tools`), the prompts and the `sui://case` resource, and the core, market and developer tools, each against a raw read of the same fact taken in the same run: staking principal vs raw StakedSui objects, pools vs a raw walk of every pool type, a decoded PTB vs the raw transaction, a simulated transfer vs its amount, MVR names vs the PackageInfo on chain. Every tool also gets one malformed call that must be refused, and each call's latency and size are checked. |
| `case-pass.mjs` | Replays every case in `cases/incidents/` (and in `$SUI_CASES_DIR` when set): each check's tool call through the built server, its answer against the value the incident's post-mortem or the chain gives. Validates each file against the format in `cases/README.md` first. A check marked `known_defect` that fails is reported as known; one that passes fails the run until the marker is removed. Prints each call's latency, size and estimated tokens, a total per case, and the tools/list size for the default profile and `SUI_TOOLS=all`; a call over its tool's budget in `lib/size-budget.mjs` fails. `--smoke` runs one check per tool plus the `critical` ones, and `--affected <git-range>` the checks a change can reach (see "Tiers" below). `--jobs <n>` runs n cases at once through one server, sharing its request budget; a check that fails there runs again alone before it counts. `--case <slug>` and `--check <id>` narrow any tier to one; `--summary <file>` writes the tallies, sizes, budgets and wall time as JSON, which `verify:live` turns into the size report in its closing summary. |
| `invariant-pass.mjs` | Checks a seeded sample across chain eras and uncommon transaction shapes against raw reads: effects, conservation, batch and single reads, balances, history and timeline pages, flows, fan-out, identity, holders and bridge beneficiaries. Prints the seed; `--seed S --n N --tip T` reproduces the sample. |
| `oracle-pass.mjs` | Draws subjects across chain eras and checks tool answers against the same fact read by another path: swap labels against pool events, object ends and changes, mint authority, balance changes, capability owners, first funding (`find_funding_source`), complete holder rankings of small coins (`get_top_holders`), staked SUI rewards against withdrawal events (`get_staking_summary`), native bridge deposits against their event BCS (`resolve_bridge_transfer`), balances below the consistent range (`get_balance`) and checkpoints by number and by time (`get_checkpoint`). Truth is read through raw GraphQL, gRPC or the effects' own BCS, never through the helper the tool uses; where a truth read is the same query the tool makes, the report says so. The report also lists disagreements, unmatched swap labels and skips. `--seed S --tip T` reproduces the draws of the first six oracles; the funding, holder, staking and balance draws also read live state, so the run prints their subjects for `--subjects` to pin. `--dist` runs another build. `--scan`, `--txs`, `--ends`, `--router` and `--coins` set sample bounds; `--router` is per router, and `--routers` picks routers by name (Aftermath, Cetus aggregator v1 and v3 contexts, 7k, FlowX, Astros), each tallied separately in the report. A disagreement fails the run unless `KNOWN_DEFECTS` in the script lists it, and so does a drawn oracle that checked nothing. |
| `detector-pass.mjs` | Scores the anomaly detectors on `cases/detectors.json`: exploit and attack transactions as positives, ordinary mainnet transactions as negatives, each in the `tuning` split (seen by rule authors) or `holdout` (labelled or drawn afterwards, never shown to them). Runs `analyze_attack_tx`, `decode_ptb` by digest and `decode_ptb` on the transaction's BCS. Reports per tool and anomaly code the true and false positives and their rate on each split, a leave-one-out table of which detectors fire on each incident without having been designed from or tuned with it, and every medium or high flag on each holdout positive. `--write-ceilings` records holdout counts; `--json` emits JSON; `--split`, `--only`, `--incident` and `--digest` select a subset. Reads through `SUI_REPLAY_DIR` when set. See `cases/README.md`. |

Run an individual script from the repo root after building, for example:

```bash
node scripts/probe/adversarial.mjs
node scripts/probe/incident-pass.mjs
node scripts/probe/surface-pass.mjs
node scripts/probe/consistency-pass.mjs --seed 17 --tip 334000000
```

Run the full tier with its default `--jobs 1`. Concurrent cases share the Sui
endpoint's request budget but can exhaust public historical-price providers,
leaving valuations and price-dependent detector checks incomplete. The full
runner refuses `--jobs` above 1; `case-pass --jobs <n>` remains available for
shorter diagnostic runs. Every case and detector still runs in the full tier.

The adversarial event checks distinguish a budget-limited or resumed slice,
which reports missing values, from a complete nonempty window, which refuses
a numeric field that no event carries. A partial scan must also supply its
continuation.

The incident pass compares raw amounts exactly against chain data. Its
largest-pool comparison allows a 0.1% USD difference between hourly-median
incident prices and the transaction's pricing time.

Use `sample-negatives.mjs` to draw fresh holdout negatives for
`cases/detectors.json` from random checkpoints, or by function with
`--function`, when the holdout split is rotated. It skips every labelled
sender. `verify:live` does not run it.

Use `token-baseline.mjs` to compare server context costs across builds.
It reports tools/list in characters and estimated tokens (chars / 4)
for `core`, `core` plus each other profile, and `all`; each tool's
definition (description, input schema, whole entry), largest first; each
tool's median and largest answer over case-pass calls; and the ten largest
answers with their args. The answer sizes come from a case-pass `--summary`
file (`--summary <file>`), or from a case-pass run it starts, `--smoke`
unless `--full` is given, reading through `SUI_REPLAY_DIR` when set.
`--out <prefix>` writes `<prefix>.json` and `<prefix>.md`, and keeps the
summary of a run it started as `<prefix>.case-pass.json` for a later
`--summary`; otherwise the Markdown goes to stdout.
The definitions checkout commit is separate from the output run's provenance:
the summary's absolute path, file modification time and `build_identity` (or
`commit` if present). A summary without a build identity reports `unknown`;
its file modification time need not be the run time. Arguments are reconstructed
from the current case files and schemas, not recorded by the saved run.

`test/live-coverage.test.ts` runs with `npm test` and fails when a registered
tool is called by none of these scripts and named by no check in
`cases/incidents/`. `adversarial.mjs` does not count toward it: it proves input
handling, not answers. A new tool needs a live check here or a case.

## Tiers

`npm run verify:live` runs all checks. Two cheaper tiers pick a subset:

```bash
npm run verify:live -- --tier affected                  # what this branch changed, uncommitted work included
npm run verify:live -- --tier affected --range main..HEAD
npm run verify:live -- --tier smoke
```

Add `--keep-summary <path>` to retain that run's case-pass summary for
`token-baseline.mjs --summary <path>`, without repeating its calls. The path
is relative to the invoking directory and its parent must exist. The file is
overwritten if present. A summary is saved even when checks fail; if case-pass
writes none, no file is saved. Without this option the temporary summary is
deleted after the closing size report.

- `affected` maps each changed file to the tools it can reach and runs only
  their checks. `lib/tiers.mjs` reads which tools each `src/tools/*.ts` file
  registers and follows the source imports from there, so a change to a
  utility reaches every tool whose registration imports it, directly or not.
  A file that `src/tools/index.ts` wraps every tool with reaches them all. It
  runs `case-pass --affected` (the checks calling a reached tool, every check
  of a changed case file, and the `critical` checks), each probe script that
  changed or that calls a reached tool no case check names (by the rule
  `test/live-coverage.test.ts` credits a probe with), `oracle-pass` and
  `consistency-pass` when a tool either checks was reached (`ORACLE_PROBES`
  in `lib/tiers.mjs`), and `detector-pass` when a tool it scores was reached
  or `cases/detectors.json` changed. A change it
  cannot place (a source file nothing imports, `package.json`, the lock file,
  `tsconfig.json`, `case-pass.mjs`, anything in `lib/` or `verify-live.mjs`)
  runs the full tier.
- `smoke` runs `case-pass --smoke`, one check per tool (its first that is not
  a known defect) plus the `critical` checks, and the fewest probe scripts
  that call every tool no case check names.

The `critical` checks in `cases/README.md` run in every tier. Run the full
tier at the points listed below.

## Replaying fixed reads

`SUI_REPLAY_DIR=<dir>` makes case-pass, oracle-pass and detector-pass read through a
recording of every chain read whose answer cannot change: a transaction by
digest once it is in a checkpoint, an object at a version or as of a past
checkpoint, a package at a version (GraphQL resolves a package asked for by
address alone to its newest upgrade, so only `packageAt(version:)` under it
replays), a checkpoint by number, and events or transactions over a
checkpoint range closed at both ends whose upper end is at least 1,000
checkpoints before the latest one the endpoint serves. The first run
records them; later runs answer them from disk and fetch everything else
live. A GraphQL query replays only when every field it selects is fixed under
its root, so a latest balance asked for under a transaction's sender still
goes out. A read that fails or finds nothing is never recorded. Entries are
keyed by the endpoint and the exact request, so a changed query or SDK
encoding records afresh. `verify:live` passes the variable to those three
scripts only; oracle-pass sends its own raw reads of fixed data through the
same recording. The rules are in `src/clients/replay.ts`.

Replay does not detect server-side API changes. Run the full tier before a
release without `SUI_REPLAY_DIR`.

## When to run them

Offline unit tests use fixed signatures and response fixtures. Run the full
live tier:

- After an `@mysten/sui` upgrade. Signature parsing, protobuf field shapes and
  BCS key encoding live in the SDK, and a changed key encoding returns `null`,
  which reads the same as "not found".
- After a GraphQL schema change. A renamed field returns `null` rather than an
  error, so a tool reports less without failing.
- Before a release.

Run `npm test` after the live pass. `dump-fixtures.mjs` updates the signature
fixtures; the offline tests check that parsed signatures derive to their
recorded addresses.

## Scheduled drift check

`.github/workflows/drift.yml` runs the full live pass and offline tests
weekly and supports manual dispatch. It opens or updates a `drift` issue on
failure. The live pass is not a required pull-request check.

## One-off measurements

Keep one-off measurements as facts in a commit message or the relevant
project guidance. Remove temporary scripts after recording the result to
avoid leaving live-chain probes with stale assumptions.
