# Investigation cases

Case files, investigation regression inputs and detector labels live here:

- `incidents/<slug>.json` contains published incident checks replayed by
  `scripts/probe/case-pass.mjs` during `npm run verify:live`.
- `public-example.json` and `public-example.baseline.json` are inputs to
  `scripts/investigation-regression.mjs`, which compares findings across builds.
- `detectors.json` labels transactions for `scripts/probe/detector-pass.mjs`.

Only public, published incidents go in `incidents/`. Keep private cases, in
the same format, in a directory named by `SUI_CASES_DIR`; case-pass reads both.

```bash
npm run build
node scripts/probe/case-pass.mjs                          # every case
node scripts/probe/case-pass.mjs --case nemo-2025-09      # one case
node scripts/probe/case-pass.mjs --case nemo-2025-09 --check cctp-exits
node scripts/probe/case-pass.mjs --smoke                  # one check per tool, plus the critical ones
node scripts/probe/case-pass.mjs --affected main..HEAD    # the checks a change can reach, plus the critical ones
node scripts/probe/case-pass.mjs --jobs 4                 # four cases at once, one request budget
SUI_REPLAY_DIR=~/.cache/sui-replay node scripts/probe/case-pass.mjs   # replay reads that cannot change
SUI_CASES_DIR=~/private-cases node scripts/probe/case-pass.mjs
```

`CONTRIBUTING.md` ("Running a blind investigation") says how a case is made.

## Format

```json
{
  "slug": "nemo-2025-09",
  "kind": "protocol-exploit",
  "title": "Nemo Protocol exploit, 7 September 2025",
  "network": "mainnet",
  "summary": "Two or three plain sentences: what happened and what is known.",
  "sources": [
    { "url": "https://…", "publisher": "Nemo", "kind": "victim-postmortem" }
  ],
  "subjects": {
    "attacker": "0x01229b3c…c724",
    "exploit_tx": "19Zkat1x…",
    "cctp_destination": "0x135477aa…"
  },
  "checks": [
    {
      "id": "cctp-exits",
      "question": "How much left Sui through CCTP, and to whom?",
      "tool": "summarize_address_flows",
      "args": { "address": "{attacker}", "from": "2025-09-07T00:00:00Z", "to": "2025-09-08T00:00:00Z" },
      "expect": [
        { "path": "bridge_exits.by_bridge[*].destinations[*].address", "op": "includes", "value": "{cctp_destination}" },
        { "path": "bridge_exits.transaction_count", "op": "gte", "value": 8 }
      ],
      "tier": "chain-derived",
      "basis": "Nemo report V1.1 names the CCTP destination; 8 DepositForBurn events on chain."
    }
  ]
}
```

`incidents/nemo-2025-09.json` is a complete example.

## Fields

- `slug`: lower-case letters, digits and dashes; begins with a letter or digit.
  The file must be `<slug>.json`, unique across both case directories.
- `kind`: one of `protocol-exploit`, `address-poisoning`, `wallet-drainer`,
  `token-rug`, `sybil-farm`, `key-compromise`, `nft-theft`, `laundering`,
  or `other`.
- `title`, `summary`: non-blank strings.
- `network`: `mainnet`, `testnet` or `devnet`. The runner adds it to each
  tool call whose schema accepts `network`, unless the check sets one.
- `sources`: at least one published source. Each has an HTTP(S) `url`, a
  non-blank `publisher`, and a `kind`: `victim-postmortem`, `security-firm`,
  `official`, `exchange` or `news`.
- `subjects`: a map of names to non-blank strings (addresses, digests or
  CAIP-10 accounts). Names begin with an ASCII letter or underscore and
  contain only ASCII letters, digits and underscores. `{name}` in any string
  under `args` or `expect.value` expands to `subjects[name]`; an unknown
  name fails validation.
- `checks`: a non-empty list. Each check requires a non-blank `question`.
  `id` must be unique within the case, non-blank and contain no whitespace.
  `tool` is a registered name; `args` is an object checked against that tool's
  input schema for unknown and missing required arguments.
- `checks[].expect`: a non-empty list; every entry must hold.
  - `path`: dot path into the tool's JSON result. `a.b[0].c` indexes;
    `a[*].b` collects across an array, and nested `[*]` flattens. Elements that
    lack the rest of the path contribute nothing. An empty path (`""`) selects
    the first JSON text block, or the full text when none parses as JSON.
    `_text` is all text blocks joined with newlines; `_isError` is true when
    the tool returned an error or the RPC call failed.
  - `op`:
    - `equals`: deep equality; strings compared exactly.
    - `iequals`: case-insensitive string equality.
    - `includes`: the collected values, or the array at the path, contain
      `value` (case-insensitive for strings, deep equality otherwise).
    - `excludes`: the reverse.
    - `contains`: the string at the path contains `value` (case-insensitive).
    - `matches`: the string at the path matches the regex in `value`.
    - `gte`, `lte`: numeric, from numbers or numeric strings. Two integers
      are compared as BigInt, so raw `u64` amounts compare exactly.
    - `approx`: numeric, within `tolerance` of `value` relative to the
      magnitude of `value` (`0.01` is 1%). `tolerance` must be positive.
    - `exists`, `absent`: whether the path resolves to anything non-null.
      A collected path exists when at least one collected value is non-null.
      They take no `value`.
    - `count_gte`, `count_lte`: the number of collected values, or the length
      of the array at the path; `value` is a non-negative integer.
- `checks[].tier`: the evidence tier of the fact the check pins, one of
  `chain-derived`, `code-derived`, `indexer-attested`, `price-provider`,
  `heuristic`. `code-derived` identifies a fact read from package code.
- `checks[].basis`: a non-blank string naming a `sources[].publisher` or
  "chain" as the source of the expected value.
- `checks[].known_defect`: optional, one line saying what the tool gets wrong.
- `checks[].timeout_s`: optional, default 120. A slower call fails.
- `checks[].max_chars`: optional positive integer. A larger result fails.
- `checks[].critical`: optional `true` (otherwise omitted). It runs in
  every tier and cannot also be a `known_defect`.

Unknown keys are validation errors at every level. `tolerance` is valid only
for `approx`; `exists` and `absent` take no `value`.

## How the runner evaluates

- A path that does not resolve fails every op except `absent`.
  Use `absent` to assert that something is missing.
- `includes`, `excludes`, `count_gte` and `count_lte` need a `[*]` path or a
  path to an array.
- `iequals`, `contains`, `matches`, `gte`, `lte` and `approx` need one value
  at the path, and the first three need a string.
- Each case runs on its own server with a throwaway store unless `--jobs`
  shares one. The run prints each check's status, latency, result size and
  estimated tokens (chars / 4), each case's total, and tools/list size for
  the default profile and `SUI_TOOLS=all`.
- A result over its tool's budget in `scripts/probe/lib/size-budget.mjs`
  fails, as one over `max_chars` does. `detail: "full"` uses the
  500,000-character ceiling; an explicit `commands` array uses the
  60,000-character pick budget.
- The run fails on any failed check, invalid case file or `known_defect` check
  that passes.
- Every check runs by default. `--smoke` runs each tool's first check that is
  not a known defect, plus the critical checks. `--affected <git-range>` runs
  the checks whose tool a changed file can reach through the source imports,
  every check of a changed case file, and the critical checks; a change it
  cannot place runs every check. `scripts/probe/README.md` ("Tiers") has the
  rules. Every case file is validated in every tier.
- `--jobs <n>` runs n cases at once through one server, so they draw on one
  rate limit and one in-flight cap per endpoint instead of n. A case that
  calls a tool which writes the store runs afterwards on a server of its own.
  Shared rate limits and in-flight caps can increase a check's latency or
  shorten a wall-clock-limited scan. A check that fails in a shared run runs
  again alone on a fresh server and fails the run only if it fails there too.
- With `SUI_REPLAY_DIR` set, reads whose answer cannot change are answered
  from the recordings in that directory and recorded on their first live
  answer. `scripts/probe/README.md` ("Replaying fixed reads") has the rules.

## Critical checks

Critical checks run in every tier to cover shared engines beyond the file
reachability map. Each pins a fact that cannot drift. Add one only when no
existing critical check covers the engine.

| Case | Check | Engine |
|---|---|---|
| `cetus-2025-05` | `first-exploit-profit` | attack analysis: balance changes, valuation, detectors |
| `cetus-2025-05` | `incident-losses` | loss totals across a window |
| `nemo-2025-09` | `cctp-exits` | address flows and bridge exits |
| `typus-2025-10` | `attacker-flow-graph-exit` | the flow graph |
| `typus-2025-10` | `fix-diff-names-rewritten-functions` | package versions, bytecode and the diff |
| `scallop-2026-04` | `first-funder` | the funding walk through history |

## Rules

- Pin facts from past incidents, transactions and immutable packages. Avoid
  checks that depend on current balances or prices.
- Assert the specific answer an investigator needs, as a published source or
  the chain gives it. A check that passes on any non-empty result pins
  nothing.
- Keep a check that fails because the tool is wrong, marked
  `"known_defect": "<one line>"`. The runner reports it as `known` and the run
  still passes. Once the tool is fixed the runner reports `FIXED` and fails
  the run until the marker is removed.

## Detector labels

`detectors.json` contains labelled transactions scored by `detector-pass.mjs`.
The runner calls `analyze_attack_tx`, `decode_ptb` by digest and `decode_ptb`
on the transaction's BCS (`decode_ptb_bytes`, without effects).
`test/detector-eval.test.ts` validates the labels with `npm test`.

```bash
npm run build
node scripts/probe/detector-pass.mjs                     # text report, both splits
node scripts/probe/detector-pass.mjs --json > report.json
node scripts/probe/detector-pass.mjs --split tuning      # tuning positives and negatives
node scripts/probe/detector-pass.mjs --incident scallop-2026-04
node scripts/probe/detector-pass.mjs --only negatives
```

- `about`: non-blank description of the labelled set. All other top-level
  keys listed below are required. Unknown keys are rejected throughout.
- `incidents`: keyed by lower-case incident id. Each entry has a non-blank
  `title` and non-empty `cases` list of slugs present in `incidents/`. One
  campaign told in two case files is one incident.
- `detector_origins`: keyed by anomaly code. Each entry has `incidents`
  (incidents the rule was designed from), `tuned_with` (incidents whose
  positives were labelled while its thresholds, grades or exclusions were
  set; for a rule changed while this file existed, every incident labelled
  at the time), and a non-blank `basis` citing the commits or audit items
  that show both. Both incident lists are required arrays, empty when none
  applies. A detection is held out only if the incident appears in neither
  list.
- `positives[]`: `digest` (base58, 32–44 characters), `incident`, `case`,
  non-blank `role`, `split`, a full lower-case 64-hex-digit `sender` address
  or non-blank `sender_withheld`, UTC ISO `timestamp`, non-blank `source`,
  and `detected_by`: the medium or high flags reviewed as pointing at the
  attack (an array, empty when none does). Each `detected_by` entry requires
  `{ tool, code }` and may add a non-blank `evidence` string, such as the
  exploited package, matched case-insensitively against the flag's title,
  detail and evidence.
  `tool` is `analyze_attack_tx`, `decode_ptb` or `decode_ptb_bytes`.
  `incident` must name an entry in `incidents`, and `case` must occur in
  that incident's `cases`. `split` is `tuning` for an incident some rule was
  designed from or tuned with, and `holdout` for one labelled after the
  rules were written; all positives from one incident share a split. No
  `detector_origins` entry may list a holdout incident. A drain the victim
  signed carries `sender_withheld` (why the signer is not recorded) in place
  of `sender`, so no victim address enters the file.
- `negatives[]`: `digest`, `split`, non-blank `protocol`, non-blank `shape`,
  `sender` or `sender_withheld`, `timestamp`, `calls` (an array of non-blank
  Move-call strings), and non-blank `source` (how and when it was sampled).
  `split` is `tuning` for negatives rule authors have looked at and
  `holdout` for ones drawn afterwards that they have not. A negative whose
  signer is a known victim carries `sender_withheld` in place of `sender`.
  `scripts/probe/sample-negatives.mjs` draws holdout negatives from random
  checkpoints, or by function with `--function`, skipping every labelled
  sender.
- `accepted_fps[]`: a negative's `digest`, detector `tool`, non-blank `code`
  and non-blank `reason` for an accepted medium or high flag on a tuning
  negative. Each digest/tool/code combination is unique; holdout negatives
  have no entries here.
- `holdout_ceilings`: non-blank `measured_on` (build and date), `negatives`
  (equal to the number of holdout negatives in the file), and `kinds`.
  `kinds` maps `tool:code` to the number of holdout negatives where that
  kind fires at medium or high. Omit kinds with zero hits.

Rules:

- Label only past transactions. A digest appears once, as a positive or a
  negative. Only exploit and attack transactions are positives; the
  attacker's funding, swaps and bridge exits are neither.
- A negative describes ordinary activity by a party authorized to perform
  it. Include legitimate calls of functions used in an exploit.
- The run fails when a tuning negative gets a medium or high flag that
  `accepted_fps` does not list, when an accepted false positive stops firing
  (remove the entry), when a positive loses a `detected_by` entry, or when a
  tool call fails. On a run of the whole holdout split it also fails when any
  kind's medium-or-high count differs from `holdout_ceilings`: a rise is a
  regression, and a fall means the ceiling comes down so a later rise cannot
  hide under it. `--write-ceilings` records the measured counts after a run
  with no other failure; a raised ceiling needs its reason in the commit. A
  medium or high flag on a positive that `detected_by` does not list is
  printed as a note: add it when it names the attack.
- A new detector, or a change to one, is judged on the holdout split: its
  false-positive rate there, the holdout incidents it detects, and the
  incidents it detects that are in neither its `incidents` nor its
  `tuned_with`. Iterate with `--split tuning`; run the holdout once, at the
  end. The report lists every medium or high flag on each holdout positive,
  so a reviewer can tell a flag that names the flaw from one that names only
  the loss.
- Whoever looks at holdout flags while changing a rule has tuned against
  them. Move those holdout negatives to `tuning`, draw as many fresh ones with
  `sample-negatives.mjs`, and add the incidents in view to the rule's
  `tuned_with`. A holdout incident a rule was changed for moves to `tuning`
  in the same commit, with its id in that rule's `incidents` or
  `tuned_with`.
