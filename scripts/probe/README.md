# Multisig / authentication probes

Each script pins a claim in `src/utils/multisig.ts` to something measured
against mainnet. They exist because an `@mysten/sui` bump is exactly the kind of
change that would break signature parsing silently — the unit tests are offline
and would keep passing against stale fixtures.

They hit the network, so they are not part of `npm test`. Run from the repo
root: `node scripts/probe/<name>.mjs`.

## After an SDK bump, run these three

| Script | What it checks |
|---|---|
| `dump-fixtures.mjs` | Regenerates `test/fixtures/signatures.json` from live mainnet. The offline tests derive every fixture back to its own address, so a drifted parse fails loudly. |
| `investigation.mjs` | End-to-end run of every multisig tool — `identify_address`, `analyze_multisig`, `get_transaction` authorization, `find_shared_multisig`. Needs `npm run build` first. |
| `smoke-cluster.mjs` | `build_wallet_edges` against a multisig seed, including the service-key filter. Takes an address argument. |

## What each claim rests on

| Script | Claim |
|---|---|
| `derive.mjs` | A committee hashes to its own address. This is the basis for calling membership chain-derived rather than inferred. |
| `pubkey-extract.mjs` | A member's committee entry is byte-identical to the public key that member signs its own transactions with. |
| `committee-stability.mjs` | 200 sent transactions from one multisig, one committee. Membership cannot rotate. |
| `signer-history.mjs` | The signer bitmap DOES vary per transaction — a 4-of-7 used 3 sets across 8 transactions with 2 keys never signing. This is why `analyze_multisig` exists. |
| `sponsor.mjs` | A gas-sponsored transaction carries `[sender, sponsor]`, so a signature is matched to an address by re-derivation, not position. |
| `enumerate.mjs` | Member order is part of the identity: two keys generate four candidate addresses and exactly one exists. |
| `upgradecaps.mjs` | Multisigs are found where admin authority is — 3 of 353 `UpgradeCap` owners (0.85%) against roughly 1 in 39,500 signatures sampled at random. |
| `scan-wide2.mjs` | The base rate that makes the above the right instrument: 79,052 signatures yielded 2 multisig signatures, both from one wallet. Writes `multisig-hits.json` (gitignored). |
| `zk-derive.mjs` | zkLogin addresses re-derive from `(iss, addressSeed)`. Both derivations exist on chain, so both are tried. |
| `zklogin-owners.mjs` | zkLogin discloses the OAuth issuer on chain and nothing else about the account. |
| `alias-batch.mjs` | GraphQL alias batching caps at 20 store-backed queries and 5000 bytes — the same two limits as package lineage. Sets `AUTH_BATCH_SIZE`. |
| `malformed.mjs` | `parseSerializedSignature` types a truncated signature from its flag byte without validating length; the key constructor rejects it, so no address is invented. |
| `smoke-identity.mjs` | `describeAddresses({ expandMembers: true })` against all four known multisigs plus a plain wallet, a zkLogin wallet and a never-sent address. |

## Schema spelunking

`gql-sig3.mjs` and `gql-objfilter.mjs` are how `transaction.signatures`, the
`sentAddress` filter and the `AddressOwner` shape were found. Kept for the next
time the GraphQL schema moves; they are introspection, not assertions.

## Conventions

Write output beside the script (gitignored), never to an absolute path — these
run on other people's machines. No maintainer wallets or SuiNS names: every
address here was found by scanning public `UpgradeCap` owners.
