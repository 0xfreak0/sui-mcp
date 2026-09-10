# Live checks

Three scripts, run together by `npm run verify:live` from the repo root. Build
first — they drive the built tools, not the source.

```bash
npm run build && npm run verify:live && npm test
```

| Script | What it does |
|---|---|
| `dump-fixtures.mjs` | Regenerates `test/fixtures/signatures.json` from live mainnet. |
| `adversarial.mjs` | Feeds every tool malformed and hostile input; passes only when they refuse or say "unknown". |
| `investigation.mjs` | Chained end-to-end run: a failed transaction, why it failed, who published the package, who they are, their fan-out and deny-list exposure. |

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

## Why there are only three

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
