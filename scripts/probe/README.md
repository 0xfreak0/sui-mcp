# Live checks

Twelve scripts, run together by `npm run verify:live` from the repo root. Build
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
| `case-pass.mjs` | Replays every case in `cases/incidents/` (and in `$SUI_CASES_DIR` when set): each check's tool call through the built server, its answer against the value the incident's post-mortem or the chain gives. Validates each file against the format in `cases/README.md` first. A check marked `known_defect` that fails is reported as known; one that passes fails the run until the marker is removed. Prints each call's latency, size and estimated tokens, a total per case, and the tools/list size for the default profile and `SUI_TOOLS=all`; a call over its tool's budget in `lib/size-budget.mjs` fails. `--case <slug>` and `--check <id>` run one; `--summary <file>` writes the tallies, sizes and budgets as JSON, which `verify:live` turns into the size report in its closing summary. |
| `invariant-pass.mjs` | A seeded random sample of mainnet: transactions from checkpoints spread over the whole chain, plus the kinds random checkpoints rarely hold (system, failed, sponsored, multisig, zkLogin, address-balance, 100+ command PTBs, packages, shared objects, kiosks, bridge exits). Each is run through the tools and checked against rules that hold for any input, every value against a raw GraphQL read: balance changes against the effects, coin conservation, batch against single reads, balances against coin objects plus the address balance and against a forward sum at a past checkpoint, history and timeline pages against the raw query, flow totals, fan-out recounts, trace and attack nets, identity types, holder balances and bridge beneficiaries against the event bytes. Prints the seed; `--seed S --n N --tip T` redraws the same sample. Default n is 12, four to seven minutes; n 30 takes about ten. |
| `detector-pass.mjs` | Scores the anomaly detectors on the labelled set in `cases/detectors.json`: exploit and attack transactions from `cases/incidents/` as positives, and ordinary mainnet transactions as negatives, each in two splits, `tuning` (seen by rule authors) and `holdout` (incidents labelled after every current rule was written, and negatives drawn at random afterwards, never shown to them). Runs `analyze_attack_tx`, `decode_ptb` by digest and `decode_ptb` on the transaction's own BCS (the pre-sign mode) on each, and prints per tool and anomaly code the true positives, the false positives and their rate on each split, and a leave-one-out table: which detectors fire on each incident, and which of those were neither designed from it nor tuned while it was labelled, then every medium or high flag with its evidence on each holdout positive. Fails when a tuning negative gets a medium or high flag not listed in `accepted_fps`, when an accepted false positive stops firing, when a positive loses a `detected_by` detection, or, on a run of the whole holdout split, when any kind's medium-or-high count there differs from `holdout_ceilings`. `--write-ceilings` records the measured counts; `--json` prints the report as JSON; `--split`, `--only`, `--incident` and `--digest` run a subset. |

`sample-negatives.mjs` is not a check: it draws fresh holdout negatives for
`cases/detectors.json` from random checkpoints (or by function with
`--function`), skipping every labelled sender, when the holdout split has to
be rotated.

`test/live-coverage.test.ts` runs with `npm test` and fails when a registered
tool is called by none of these scripts and named by no check in
`cases/incidents/`. `adversarial.mjs` does not count toward it: it proves input
handling, not answers. A new tool needs a live check here or a case.

## When to run them

The unit tests are offline by design — they pin real mainnet signatures and
shapes as fixtures so they stay fast and deterministic. That is exactly why
these exist: **a fixture cannot notice that the world moved underneath it.** It
keeps passing against a stale copy.

Three moments, and no others:

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

## Why there are only twelve

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
