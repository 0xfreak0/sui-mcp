# Investigation cases

Two formats live here.

- `incidents/<slug>.json`: one file per public incident, with the questions an
  investigator asks about it and the answers the post-mortem or the chain
  gives. `scripts/probe/case-pass.mjs` replays every check through the built
  server on each `npm run verify:live`. The format is below.
- `public-example.json` and its `.baseline.json`: input for
  `scripts/investigation-regression.mjs`, which reports any fact the last
  build found that this one no longer finds.

Only public, published incidents go in `incidents/`. Private cases use the same
format in a directory named by `SUI_CASES_DIR`; the runner reads both.

```bash
npm run build
node scripts/probe/case-pass.mjs                          # every case
node scripts/probe/case-pass.mjs --case nemo-2025-09      # one case
node scripts/probe/case-pass.mjs --case nemo-2025-09 --check cctp-exits
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
  `chain-derived`, `indexer-attested`, `price-provider`, `heuristic`.
- `checks[].basis`: where the expected value comes from. It names one of the
  case's `sources[].publisher` values or the chain (the word "chain").
- `checks[].known_defect`: optional, one line. See the rules.
- `checks[].timeout_s`: optional, default 120. A slower call fails.
- `checks[].max_chars`: optional. A larger result fails.

Any other key is an error, so a misspelt `tolerance` cannot pass unnoticed.
Put explanations in `summary` or `basis`.

## How the runner evaluates

- A path that does not resolve fails every op except `exists` and `absent`.
  Use `absent` to assert that something is missing.
- `includes`, `excludes`, `count_gte` and `count_lte` need a `[*]` path or a
  path to an array.
- `iequals`, `contains`, `matches`, `gte`, `lte` and `approx` need one value
  at the path, and the first three need a string.
- Each case runs on its own server with a throwaway store. Each check prints
  its status, latency and result size.
- The run fails on any failed check, any case file that breaks this format,
  and any `known_defect` check that now passes.

## Rules

- Pin facts that cannot drift: past incidents, old transactions, immutable
  packages. Do not pin current balances or prices.
- A check asserts the answer an investigator needs, and the one the
  post-mortem or the chain gives. "Returned something" is not a check.
- A check that fails on the current server because the tool is wrong stays in
  the file, marked `"known_defect": "<one line>"`. The runner reports it as
  `known` and the run still passes. When the tool is fixed the check passes,
  the runner reports `FIXED` and fails the run, and the marker comes out.
