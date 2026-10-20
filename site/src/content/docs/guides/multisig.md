---
title: Multisig wallets
description: Read a multisig wallet's committee from its address, see which keys sign, and find treasuries a set of keys controls.
sidebar:
  order: 5
---

A multisig address hashes its threshold, member keys and weights. The tools
read the committee from a wallet transaction's signature and verify it by
deriving the address again. A wallet with no sent transaction has no signature
from which to read its authentication.

## Identify a wallet and its committee

`identify_address` returns the shape, every member address, and each member
resolved to its own name, labels and SuiNS history.

```
identify_address(0x045dadba…)
  → authentication: multisig, 4-of-7, verified: true
    committee_members: 7, each with name/label/kind
```

## See which keys are actually used

The committee is fixed by the address, but who signs varies per transaction.
`analyze_multisig` reads that across the wallet's most recent sent
transactions, newest first, up to `max_transactions`.

```
analyze_multisig(0x045dadba…, max_transactions: 200)
  → transactions_examined: 8
    signer_sets: [0,1,3,4] x4, [1,2,3,4] x2, [0,2,3,4] x2
    always_present: [3, 4]
    dormant_members: [5, 6]
    active_signers_meet_threshold: true
```

`dormant_members` are keys absent from the examined transactions.
`always_present` are keys present in every examined signature. Both fields
refer to `transactions_examined`, and earlier activity may differ.

It answers questions such as whether a 4-of-7 treasury is in practice run by
two people, and whether the set of keys that sign has changed. A key that
signed only before the examined window shows as dormant, so raise
`max_transactions` before calling a key unused.

A committee key holding a run of more than seven identical bytes, such as a
readable word followed by zero bytes, was written by hand. A generated key
has such a run with probability below 1e-15, and finding the private key for
a chosen public key is the discrete-logarithm problem, so that member can
never sign. It is listed in `unsignable_members`, and `effective_committee`
gives the threshold against the keys that can sign: a 2-of-4 with one such
member is 2-of-3. The dormancy note leaves such members out of its cold or
lost key reading.

## See who authorised one transaction

`get_transaction` returns an `authorization` block naming the keys that signed
and the members that did not, plus the gas sponsor when there is one.

```
get_transaction(oxrJ3Bppuk…)
  → authorization[0]: sender, multisig 4-of-7
      signed_by:     [0, 1, 3, 4]
      did_not_sign:  [2, 5, 6]
```

## Search backwards from keys to a treasury

Given addresses a trace has already linked, `find_shared_multisig` derives
every committee they could form and returns the ones that exist on chain. This
finds multisigs that never appeared in the trace, since a wallet is only
visible if it transacted with something you looked at.

```
find_shared_multisig([0xafe2fafa…, 0xc848c5cc…])
  → candidates_checked: 4, found: 1
    0xcf4e7b88… 1-of-2, evidence_tier: chain-derived
```

## See who else can spend it

A wallet can authorize other addresses to act for it through
`0x2::address_alias`. `identify_address` returns that set, so a fixed
committee does not have to be read as the only way to move the funds.

```
identify_address(0x434d9c12…)
  → aliases: [0x66b816ed…, 0x33a86fba…]
    delegated_to: [0x66b816ed…, 0x33a86fba…]
    owner_can_authorize: false
```

`aliases` is the set as the chain holds it and `delegated_to` is that set
without the wallet itself. Enabling the feature seeds the set with the
wallet's own address, so an empty `delegated_to` means nobody else was
authorized.

The alias set replaces the signer. When `owner_can_authorize` is false,
the wallet's own key cannot sign for it; addresses in `delegated_to`
are the ones authorized by the current set.

An alias can authorize transactions for the wallet according to the alias set
read from chain state. That authority alone does not establish shared
ownership: a custodian holds authority for its clients, so one key acting for
many wallets does not link them. The set is mutable, so the result describes
its state at the time of the read.

The reverse answer, which wallets name a given key (`alias_delegate_for` on
`identify_address`, `signed_as_alias` on `get_transaction_history`), comes from
a cached scan, and `alias_scan_as_of` says when that scan read the chain. When
the scan could not finish, `signed_as_alias_unavailable` says so, also beside
rows it did find.

## Clustering

`build_wallet_edges` emits a `co_signer` edge for a key that can spend a
wallet on its own. Clusters resting entirely on those edges are tagged
`chain-derived`. A key present on more committees than the limit is
reported under `excluded_co_signers` instead of connecting all of those
wallets.

## Limits

These limits are also stated in the tool output.

Member order is part of the address, so `find_shared_multisig` is factorial in
committee size: four addresses give 192 candidate committees, five give 1,560,
and six are refused. It covers equal-weight committees only, so a nil result
is not a negative finding.

A wallet that has never sent a transaction has no signature from which to
classify its authentication. The result reports it as unknown.

## zkLogin and passkey wallets

zkLogin and passkey wallets go through the same path. zkLogin reports its
OAuth issuer; the chain discloses nothing else about the account.
