# Live checks

Thirteen scripts, run together by `npm run verify:live` from the repo root. Build
first — they drive the built tools, not the source.

```bash
npm run build && npm run verify:live && npm test
```

| Script | What it does |
|---|---|
| `dump-fixtures.mjs` | Regenerates `test/fixtures/signatures.json` from live mainnet. |
| `adversarial.mjs` | Reads `tools/list` and generates malformed input for every field of every tool: missing, wrong type, null, blank, out of range, hostile strings chosen by what the field holds, unknown and misspelt argument names. A call passes when it answers within 60s, leaves the server up, fails with one readable line, and never answers a malformed input as valid. Ends with a per-tool table; about 3,200 calls in under 5 minutes. `VERBOSE=1` prints every case. |
| `investigation.mjs` | Chained end-to-end run: a failed transaction, why it failed, who published the package, who they are, their fan-out and deny-list exposure. |
| `full-case.mjs` | Cross-tool consistency — two tools must not disagree about one fact. Committees, publishers, coin verification, deny-list directions. |
| `gap-pass.mjs` | Paths the other sweeps do not reach: a coin that really is regulated, a capped history. |
| `consistency-pass2.mjs` | Each feature since 1.13.0 against an INDEPENDENT source of the same fact — registry decimals vs on-chain metadata, gRPC vs GraphQL abort detail, our sponsor count vs a direct scan. |
| `incident-pass.mjs` | The incident tools replayed on the Cetus and Nemo exploits through the built server over stdio, each answer against a raw chain read taken in the same run: attack and incident-loss nets against the raw balance changes, trace and flow-graph hops against the payer and next debit on chain, every bridge's beneficiary against its event or payload bytes, flow totals against per-transaction sums, upgrade history and cap custody against package versions and object changes, signatures and bytecode against each exact version, diffs against a line diff of both versions, a deny list against its Config's fields, and prices against DefiLlama read directly. Records every call's latency and size. |
| `attribution-pass.mjs` | The attribution and history tools (funding, fan-out, deposit, screening, wallet edges, control groups, multisig, timelines, events, transactions, balances, holders, NFT sales, identity) against a raw GraphQL read of the same fact in the same run, plus one malformed input per tool. Prints each tool's slowest call and largest result, and fails on a call over 60s or a result over the tool's declared size. |
| `surface-pass.mjs` | The stateful tools (labels, findings, watches, `enable_tools`), the prompts and the `sui://case` resource, and the core, market and developer tools, each against a raw read of the same fact taken in the same run: staking principal vs raw StakedSui objects, pools vs a raw walk of every pool type, a decoded PTB vs the raw transaction, a simulated transfer vs its amount, MVR names vs the PackageInfo on chain. Every tool also gets one malformed call that must be refused, and each call's latency and size are checked. |
| `case-pass.mjs` | Replays every case in `cases/incidents/` (and in `$SUI_CASES_DIR` when set): each check's tool call through the built server, its answer against the value the incident's post-mortem or the chain gives. Validates each file against the format in `cases/README.md` first. A check marked `known_defect` that fails is reported as known; one that passes fails the run until the marker is removed. Prints each call's latency, size and estimated tokens, a total per case, and the tools/list size for the default profile and `SUI_TOOLS=all`; a call over its tool's budget in `lib/size-budget.mjs` fails. `--smoke` runs one check per tool plus the `critical` ones, and `--affected <git-range>` the checks a change can reach (see "Tiers" below). `--jobs <n>` runs n cases at once through one server, sharing its request budget; a check that fails there runs again alone before it counts. `--case <slug>` and `--check <id>` narrow any tier to one; `--summary <file>` writes the tallies, sizes, budgets and wall time as JSON, which `verify:live` turns into the size report in its closing summary. |
| `invariant-pass.mjs` | A seeded random sample of mainnet: transactions from checkpoints spread over the whole chain, plus the kinds random checkpoints rarely hold (system, failed, sponsored, multisig, zkLogin, address-balance, 100+ command PTBs, packages, shared objects, kiosks, bridge exits). Each is run through the tools and checked against rules that hold for any input, every value against a raw GraphQL read: balance changes against the effects, coin conservation, batch against single reads, balances against coin objects plus the address balance and against a forward sum at a past checkpoint, history and timeline pages against the raw query, flow totals, fan-out recounts, trace and attack nets, identity types, holder balances and bridge beneficiaries against the event bytes. Prints the seed; `--seed S --n N --tip T` redraws the same sample. Default n is 12, four to seven minutes; n 30 takes about ten. |
| `oracle-pass.mjs` | Tool answers on subjects drawn at random each run, each against the same fact read from the chain by another path, never through the helper the tool uses. Transactions come from three eras (effects version 1, before checkpoint 23,897,141; later; the newest million checkpoints), with Aftermath router transactions and coins from the on-chain coin registry. Six oracles: `get_transaction` swap labels against each pool's own swap event and the pool's type arguments, compared by coin type; liveness and the end of an object no longer at top level in `trace_object_history` and `get_upgrade_history` against gRPC `getObject` and `idDeleted` in the transaction that ended it; `get_transaction` object changes against GraphQL `objectChanges`, and under effects version 1 against the effects' own BCS lists; `analyze_package` mint authority against gRPC `getCoinInfo`, the registry's `treasury_cap_id` and a `TreasuryCap<T>` type query; `token_flow` and `balance_changes` against GraphQL `balanceChanges`; capability owners against each object's live owner read over gRPC. Where a truth read is a query the tool also runs (the `affectedObject` index for an end transaction the sample did not supply, the registry and type queries for a cap), the report says so beside it, and swap labels no event matched are listed and counted. Prints the seed and tip (`--seed S --tip T` redraws the same subjects), then per oracle the samples checked, the agreements, each disagreement with our answer, the truth and how it was read, and each skip with its reason. A disagreement fails the run unless `KNOWN_DEFECTS` in the script lists it. `--subjects` pins subjects instead of drawing them and `--dist` runs another build, so a fixed bug's subjects can be run against the build before the fix. The default bounds finish in under a minute; `--scan`, `--txs`, `--ends`, `--router` and `--coins` raise them. |
| `detector-pass.mjs` | Scores the anomaly detectors on the labelled set in `cases/detectors.json`: exploit and attack transactions from `cases/incidents/` as positives, and ordinary mainnet transactions as negatives, each in two splits, `tuning` (seen by rule authors) and `holdout` (incidents labelled after every current rule was written, and negatives drawn at random afterwards, never shown to them). Runs `analyze_attack_tx`, `decode_ptb` by digest and `decode_ptb` on the transaction's own BCS (the pre-sign mode) on each, and prints per tool and anomaly code the true positives, the false positives and their rate on each split, and a leave-one-out table: which detectors fire on each incident, and which of those were neither designed from it nor tuned while it was labelled, then every medium or high flag with its evidence on each holdout positive. Fails when a tuning negative gets a medium or high flag not listed in `accepted_fps`, when an accepted false positive stops firing, when a positive loses a `detected_by` detection, or, on a run of the whole holdout split, when any kind's medium-or-high count there differs from `holdout_ceilings`. `--write-ceilings` records the measured counts; `--json` prints the report as JSON; `--split`, `--only`, `--incident` and `--digest` run a subset. Reads through `SUI_REPLAY_DIR` when it is set, as case-pass does. |

Run an individual script from the repo root after building, for example:

```bash
node scripts/probe/adversarial.mjs
node scripts/probe/incident-pass.mjs
node scripts/probe/surface-pass.mjs
```

The adversarial event checks distinguish a budget-limited or resumed slice,
which reports missing values, from a complete nonempty window, which refuses
a numeric field that no event carries. A partial scan must also supply its
continuation.

The incident pass compares raw amounts exactly against the chain. Its
largest-pool comparison allows 0.1% USD difference between the incident's
per-coin hourly median leg times and the single transaction's pricing time.
For that historical pool, the different SUI quotes account for a 0.052%
valuation difference; the haSUI quote is the same.

`sample-negatives.mjs` is not a check: it draws fresh holdout negatives for
`cases/detectors.json` from random checkpoints (or by function with
`--function`), skipping every labelled sender, when the holdout split has to
be rotated.

`token-baseline.mjs` is not a check either: it measures what the server costs
a model's context, so a change meant to shrink it can be compared before and
after. It reports tools/list in characters and estimated tokens (chars / 4)
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

`npm run verify:live` runs every script. Two cheaper tiers pick a subset:

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
  `test/live-coverage.test.ts` credits a probe with), `oracle-pass` when a
  tool it checks was reached (`ORACLE_PROBES` in `lib/tiers.mjs`, since its
  random samples reach states no case does), and `detector-pass` when
  a tool it scores was reached or `cases/detectors.json` changed. A change it
  cannot place (a source file nothing imports, `package.json`, the lock file,
  `tsconfig.json`, `case-pass.mjs`, anything in `lib/` or `verify-live.mjs`)
  runs the full tier.
- `smoke` runs `case-pass --smoke`, one check per tool (its first that is not
  a known defect) plus the `critical` checks, and the fewest probe scripts
  that call every tool no case check names.

The `critical` checks are a handful across cases that exercise the engines
most tools share, so a change whose reach the file map misses still meets
them; `cases/README.md` lists them. The full tier stays the one to run at the
three moments below.

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

Replay cannot see a change on Mysten's side, such as a renamed GraphQL field,
so the full tier before a release runs without it.

## When to run them

The unit tests are offline by design — they pin real mainnet signatures and
shapes as fixtures so they stay fast and deterministic. That is exactly why
these exist: **a fixture cannot notice that the world moved underneath it.** It
keeps passing against a stale copy.

The full tier, at three moments:

- **After an `@mysten/sui` bump.** Signature parsing, protobuf field shapes and
  BCS key encoding all live in the SDK and all fail silently — a changed key
  encoding returns `null`, which is indistinguishable from "not found".
- **After Mysten changes the GraphQL schema.** A renamed field makes a query
  return `null` rather than an error, so a tool quietly starts reporting less
  than it did.
- **Before cutting a release.**

Run `npm test` immediately afterwards. `dump-fixtures` rewrites the fixtures, so
a drifted parse shows up there as a signature that no longer derives to its own
address — the loudest signal available.

## Not in CI

They need the network and mainnet's current state, so they would be flaky on a
schedule nobody chose. A flaky required check teaches people to ignore failures,
which costs more than the check is worth.

## Why there are only thirteen

There were seventy. The rest were one-off measurements — symbol-collision
counts, deny-list base rates, upgrade-cap destinations — and each produced a
number that now lives in `CLAUDE.md` or a commit message, which is where a
finding belongs. Nobody re-runs a script to rediscover a number they already
wrote down.

Keeping them had a real cost beyond clutter: they hit live mainnet with
hardcoded addresses and digests, so they rot. A script that fails for reasons
unrelated to the code, in a directory nobody has a reason to run, is worse than
no script at all.

If you need to measure something new, write a throwaway and delete it. Record
the number, not the scaffolding.
