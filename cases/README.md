# Investigation cases

Three formats live here.

- `incidents/<slug>.json`: one file per public incident, with the questions an
  investigator asks about it and the answers the post-mortem or the chain
  gives. `scripts/probe/case-pass.mjs` replays every check through the built
  server on each `npm run verify:live`. The format is below.
- `public-example.json` and its `.baseline.json`: input for
  `scripts/investigation-regression.mjs`, which reports any fact the last
  build found that this one no longer finds.
- `detectors.json`: labelled transactions for
  `scripts/probe/detector-pass.mjs`, which scores the anomaly detectors on
  them. The format is under "Detector labels" at the end.

Only public, published incidents go in `incidents/`. Private cases use the same
format in a directory named by `SUI_CASES_DIR`; the runner reads both.

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

- `slug`: lower-case letters, digits and dashes. The file is `<slug>.json`.
- `kind`: one of `protocol-exploit`, `address-poisoning`, `wallet-drainer`,
  `token-rug`, `sybil-farm`, `key-compromise`, `nft-theft`, `laundering`,
  or `other`.
- `network`: `mainnet`, `testnet` or `devnet`. The runner passes it as each
  tool's `network` argument unless a check sets one.
- `sources`: at least one. `url` is the published document, `publisher` who
  published it, and `kind` one of `victim-postmortem`, `security-firm`,
  `official`, `exchange`, `news`.
- `subjects`: named addresses, digests and CAIP-10 accounts. `{name}` anywhere
  in `args`, or in a string inside an `expect.value`, is replaced by
  `subjects[name]`. A name that is not in `subjects` is an error.
- `checks[].id`: unique within the case, no spaces.
- `checks[].tool`: a registered tool name. `args` are its real arguments; an
  argument the tool does not take, or a required one left out, is an error.
- `checks[].expect`: every entry must hold.
  - `path`: dot path into the tool's JSON result. `a.b[0].c` indexes;
    `a[*].b` collects across an array, and nested `[*]` flattens. Elements that
    lack the rest of the path contribute nothing. An empty path (`""`) is the
    whole result. `_text` is the text of the result (all of it, JSON or not),
    and `_isError` is true when the tool returned an error.
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
    - `approx`: numeric, within `tolerance` of `value`, relative
      (`0.01` is 1%). `tolerance` is required.
    - `exists`, `absent`: whether the path resolves to anything non-null. They
      take no `value`.
    - `count_gte`, `count_lte`: the number of collected values, or the length
      of the array at the path.
- `checks[].tier`: the evidence tier of the fact the check pins, one of
  `chain-derived`, `code-derived`, `indexer-attested`, `price-provider`,
  `heuristic`. `code-derived` is a fact read from a package's code: the
  function an exploit called, the check it lacks, the version that fixed it.
- `checks[].basis`: where the expected value comes from. It names one of the
  case's `sources[].publisher` values or the chain (the word "chain").
- `checks[].known_defect`: optional, one line. See the rules.
- `checks[].timeout_s`: optional, default 120. A slower call fails.
- `checks[].max_chars`: optional. A larger result fails.
- `checks[].critical`: optional, `true` or left out. A critical check runs in
  every tier. It cannot also be a `known_defect`, since a known defect cannot
  fail the run.

Any other key is an error, so a misspelt `tolerance` cannot pass unnoticed.
Put explanations in `summary` or `basis`.

## How the runner evaluates

- A path that does not resolve fails every op except `exists` and `absent`.
  Use `absent` to assert that something is missing.
- `includes`, `excludes`, `count_gte` and `count_lte` need a `[*]` path or a
  path to an array.
- `iequals`, `contains`, `matches`, `gte`, `lte` and `approx` need one value
  at the path, and the first three need a string.
- Each case runs on its own server with a throwaway store, unless `--jobs`
  shares one (below). Each check prints its status, latency, result size and
  estimated tokens (chars / 4), and each case prints its total. The run also prints the tools/list size for the
  default profile and for `SUI_TOOLS=all`.
- A result over its tool's budget in `scripts/probe/lib/size-budget.mjs`
  fails, as one over `max_chars` does. A call with `detail: "full"` or a
  `commands` pick is held to the 500k ceiling instead.
- The run fails on any failed check, any case file that breaks this format,
  and any `known_defect` check that now passes.
- Every check runs by default. `--smoke` runs each tool's first check that is
  not a known defect, plus the critical checks. `--affected <git-range>` runs
  the checks whose tool a changed file can reach through the source imports,
  every check of a changed case file, and the critical checks; a change it
  cannot place runs every check. `scripts/probe/README.md` ("Tiers") has the
  rules. Every case file is validated in every tier.
- `--jobs <n>` runs n cases at once through one server, so they draw on one
  rate limit and one in-flight cap per endpoint instead of n. A case that
  calls a tool which writes the store runs afterwards on a server of its own.
  A check's latency then includes waiting for the shared budget, which can
  pass its `timeout_s`, and a tool with a wall-clock budget (the holder scan,
  the object-history owner search) reads less in that time. So a check that
  fails in the shared run runs again alone on a fresh server and fails the
  run only if it fails there too.
- With `SUI_REPLAY_DIR` set, reads whose answer cannot change are answered
  from the recordings in that directory and recorded on their first live
  answer. `scripts/probe/README.md` ("Replaying fixed reads") has the rules.

## Critical checks

A critical check is a safety net for a change whose reach the file map
misses. Each one exercises an engine that many tools share, on a fact that
cannot drift, so the set stays small:

| Case | Check | Engine |
|---|---|---|
| `cetus-2025-05` | `first-exploit-profit` | attack analysis: balance changes, valuation, detectors |
| `cetus-2025-05` | `incident-losses` | loss totals across a window |
| `nemo-2025-09` | `cctp-exits` | address flows and bridge exits |
| `typus-2025-10` | `attacker-flow-graph-exit` | the flow graph |
| `typus-2025-10` | `fix-diff-names-rewritten-functions` | package versions, bytecode and the diff |
| `scallop-2026-04` | `first-funder` | the funding walk through history |

Add one only for an engine none of these reaches.

## Rules

- Pin facts that cannot drift: past incidents, old transactions, immutable
  packages. Do not pin current balances or prices.
- A check asserts the answer an investigator needs, and the one the
  post-mortem or the chain gives. "Returned something" is not a check.
- A check that fails on the current server because the tool is wrong stays in
  the file, marked `"known_defect": "<one line>"`. The runner reports it as
  `known` and the run still passes. When the tool is fixed the check passes,
  the runner reports `FIXED` and fails the run, and the marker comes out.

## Detector labels

`detectors.json` holds the transactions every anomaly detector is scored on,
so a rule fitted to one incident is judged on the others and on ordinary
traffic its author never saw. `detector-pass.mjs` runs `analyze_attack_tx`,
`decode_ptb` by digest and `decode_ptb` on the transaction's own BCS
(`decode_ptb_bytes`, the pre-sign mode, which sees no effects) on each one;
`test/detector-eval.test.ts` validates the file with `npm test`.

```bash
npm run build
node scripts/probe/detector-pass.mjs                     # text report, both splits
node scripts/probe/detector-pass.mjs --json > report.json
node scripts/probe/detector-pass.mjs --split tuning      # tuning positives and negatives
node scripts/probe/detector-pass.mjs --incident scallop-2026-04
node scripts/probe/detector-pass.mjs --only negatives
```

- `incidents`: keyed by incident id. `title`, and `cases`: the files in
  `incidents/` that describe it. One campaign told in two case files is one
  incident.
- `detector_origins`: keyed by anomaly code. `incidents` lists the incidents
  the rule was designed from; `tuned_with` lists the incidents whose
  positives were labelled while its thresholds, grades or exclusions were
  set, which for a rule changed while this file existed is every incident in
  it. `basis` names the commits and audit items that show both. A detection
  counts as held out only when the incident is in neither list.
- `positives[]`: `digest`, `incident`, `case`, `role`, `split`, `sender`,
  `timestamp` (the transaction's time, UTC), `source` (the case subject it
  comes from, or the chain read that ties it to one), and `detected_by`: the
  medium or high flags reviewed as pointing at the attack, each
  `{ tool, code }` with an optional `evidence` string the flag's title,
  detail or evidence must contain, such as the exploited package. `tool` is
  `analyze_attack_tx`, `decode_ptb` or `decode_ptb_bytes`. `split` is
  `tuning` for an incident some rule was designed from or tuned with, and
  `holdout` for one added after the rules were written. All of one
  incident's positives share a split, and no `detector_origins` entry may
  list a holdout incident. A drain the victim signed carries
  `sender_withheld` (why the signer is not recorded) in place of `sender`,
  so no victim address enters the file.
- `negatives[]`: `digest`, `split`, `protocol`, `shape`, `sender`,
  `timestamp`, `calls` (its Move calls) and `source` (how it was sampled, and
  when). `split` is `tuning` for the negatives rule authors have looked at,
  and `holdout` for ones drawn afterwards that they have not. A negative
  whose signer is a known victim carries `sender_withheld` in place of
  `sender`, as a victim-signed positive does.
  `scripts/probe/sample-negatives.mjs` draws holdout negatives from random
  checkpoints, or by function with `--function`, skipping every sender
  already labelled.
- `accepted_fps[]`: `digest`, `tool`, `code` and `reason` for a medium or high
  flag on a tuning negative that is a known false positive. Holdout negatives
  never get entries here.
- `holdout_ceilings`: `measured_on` (build and date), `negatives` (the size of
  the holdout split it was measured on) and `kinds`, mapping `tool:code` to
  the number of holdout negatives on which that kind fires at medium or high.
  A kind that fires on none is left out, so its ceiling is 0.

Rules:

- Label only past transactions. A digest appears once, as a positive or a
  negative. Only exploit and attack transactions are positives; the
  attacker's funding, swaps and bridge exits are neither.
- A negative is ordinary activity by a party with the right to do it. A
  legitimate call of a function an exploit used (a keeper refreshing the
  oracle an attacker later set) is the most useful negative there is.
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
