# Live checks

Eight scripts, run together by `npm run verify:live` from the repo root. Build
first — they drive the built tools, not the source.

```bash
npm run build && npm run verify:live && npm test
```

| Script | What it does |
|---|---|
| `dump-fixtures.mjs` | Regenerates `test/fixtures/signatures.json` from live mainnet. |
| `adversarial.mjs` | Feeds every tool malformed and hostile input; passes only when they refuse or say "unknown". |
| `investigation.mjs` | Chained end-to-end run: a failed transaction, why it failed, who published the package, who they are, their fan-out and deny-list exposure. |
| `full-case.mjs` | Cross-tool consistency — two tools must not disagree about one fact. Committees, publishers, coin verification, deny-list directions. |
| `gap-pass.mjs` | Paths the other sweeps do not reach: a coin that really is regulated, a capped history. |
| `consistency-pass2.mjs` | Each feature since 1.13.0 against an INDEPENDENT source of the same fact — registry decimals vs on-chain metadata, gRPC vs GraphQL abort detail, our sponsor count vs a direct scan. |
| `incident-pass.mjs` | The 1.19 investigation tools replayed on the Cetus and Nemo exploits through the built server over stdio: attack net vs the raw balance change, a reconstructed balance vs the sum of earlier changes, CCTP exits and beneficiaries, upgrade authority at the exploit, per-version disassembly, the case diagram. Both incidents are history, so the pinned facts cannot drift. |
| `attribution-pass.mjs` | The attribution and history tools (funding, fan-out, deposit, screening, wallet edges, control groups, multisig, timelines, events, transactions, balances, holders, NFT sales, identity) against a raw GraphQL read of the same fact in the same run, plus one malformed input per tool. Prints each tool's slowest call and largest result, and fails on a call over 60s or a result over the tool's declared size. |

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

## Why there are only eight

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
