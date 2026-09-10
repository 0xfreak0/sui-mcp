# Multisig / authentication probes

Throwaway scripts kept because each one pins a claim in `src/utils/multisig.ts`
to something measured against mainnet, and because an `@mysten/sui` bump is
exactly the kind of change that would break the parse silently. They hit the
network, so they are not part of `npm test`.

Run from the repo root: `node scripts/probe/<name>.mjs`.

## Re-run these after an SDK bump

| Script | What it establishes |
|---|---|
| `dump-fixtures.mjs` | Regenerates `test/fixtures/signatures.json` from live mainnet. The offline tests derive every fixture back to its own address, so if the parse drifts, they fail. |
| `smoke-identity.mjs` | End-to-end `describeAddresses({ authentication: true })` against the four known multisigs plus controls. Needs `npm run build` first. |
| `verify-gov.mjs` | Re-derives the three governance committees and reports which members have their own transaction history. |

## What each claim rests on

| Script | Claim |
|---|---|
| `derive.mjs` | A committee hashes to its own address — the basis for calling membership chain-derived rather than inferred. |
| `pubkey-extract.mjs` | A member's committee entry is byte-identical to the public key that member signs its own transactions with. |
| `committee-stability.mjs` | 200 sent transactions from one multisig, one committee, one bitmap. Membership cannot rotate; the bitmap says who actually signs. |
| `sponsor.mjs` | A gas-sponsored transaction carries `[sender, sponsor]`, so a signature must be matched to an address by re-derivation, not position. |
| `enumerate.mjs` | Two known keys generate four candidate addresses (2 orderings × 2 thresholds) and exactly one exists. Member order is part of the identity. |
| `upgradecaps.mjs` | Multisigs are found by looking where admin authority is: 3 in 353 `UpgradeCap` owners (0.85%), against roughly 1 in 39,500 signatures sampled at random. |
| `zk-derive.mjs` | zkLogin addresses re-derive from `(iss, addressSeed)`. Both derivations exist on chain, so both are tried. |
| `zklogin-owners.mjs` | zkLogin discloses the OAuth issuer on chain, and nothing else about the account. |
| `alias-batch.mjs` | GraphQL alias batching caps at 20 store-backed queries and 5000 bytes of query text — the same two limits as package lineage. Sets `AUTH_BATCH_SIZE`. |
| `malformed.mjs` | `parseSerializedSignature` types a truncated signature from its flag byte without validating length; the key constructor rejects it, so no address is invented. |

## Base-rate scans

`probe-sig.mjs` → `scan-multisig.mjs` → `scan-wide.mjs` → `scan-wide2.mjs` are
successive widenings of the same random-checkpoint scan. The last one is the
one to run (it retries, and reports the 429s the earlier versions swallowed).
The conclusion they produced is that **random sampling is the wrong
instrument**: 79,052 signatures turned up 2 multisig signatures, both from the
same wallet. `upgradecaps.mjs` is the instrument that works.

`gql-sig*.mjs`, `gql-filter.mjs`, `gql-objfilter.mjs` and `is-multisig.mjs` are
the GraphQL schema spelunking that found `transaction.signatures`, the
`sentAddress` filter, and the `AddressOwner` shape. Kept for the next time the
schema moves.
