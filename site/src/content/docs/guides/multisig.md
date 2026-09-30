---
title: Multisig wallets
description: Read a multisig wallet's committee from its address, see which keys sign, and find treasuries a set of keys controls.
sidebar:
  order: 5
---

A Sui address is the hash of whatever authenticates it. For a multisig, the
threshold, every member key and every weight are part of that hash, so the
committee can be read off the address and checked by deriving it and
confirming it reproduces the address.

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

`dormant_members` are keys that hold weight and have never used it.
`always_present` are keys the wallet currently cannot move without. Both are
reported against `transactions_examined`, since the claim is only as good as
the window.

It answers questions such as whether a 4-of-7 treasury is in practice run by
two people, and whether the set of keys that sign has changed. A key that
signed only before the examined window shows as dormant, so raise
`max_transactions` before calling a key unused.

Some committee keys can never sign. A public key written by hand, such as a
readable word followed by zero bytes, holds a long run of one byte that a
generated key practically never has. Nobody holds its private key, so the
member is listed in `unsignable_members` and `effective_committee` gives the
threshold against the keys that can sign: a 2-of-4 with one such member is
2-of-3. Such a member is dormant by construction, and the tool does not call
it a cold or lost key.

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

The set replaces the signer rather than extending it, so `owner_can_authorize`
decides who controls the wallet. When it is false the wallet's own key can no
longer sign for it and only `delegated_to` can move the funds.

An alias is control read from chain state, so you may write that the address
can authorize for the wallet. It is not evidence of shared ownership, since a
custodian holds authority for a client. A key acting for many wallets is a
service. The set is mutable, so it is true as of the read, and most wallets
have never enabled the feature.

The reverse answer, which wallets name a given key (`alias_delegate_for` on
`identify_address`, `signed_as_alias` on `get_transaction_history`), comes from
a cached scan, and `alias_scan_as_of` says when that scan read the chain. When
the scan could not finish, `signed_as_alias_unavailable` says so, also beside
rows it did find.

## Clustering

`build_wallet_edges` emits a `co_signer` edge for any key that can spend a
wallet on its own, and marks clusters built only from those `chain-derived`
rather than `heuristic`. Keys sitting on more committees than the limit are
treated as custody or wallet-provider keys and listed under
`excluded_co_signers` instead of linking everyone who uses that provider.

## Limits

These limits are also stated in the tool output.

Member order is part of the address, so `find_shared_multisig` is factorial in
committee size and refuses past five keys. It covers equal-weight committees
only, so a nil result is not a negative finding.

A wallet that has never sent a transaction cannot be classified at all,
because it has produced no signature. It comes back as unknown rather than as
an ordinary wallet.

## zkLogin and passkey wallets

zkLogin and passkey wallets go through the same path. zkLogin reports its
OAuth issuer, which is all the chain discloses about the account.
