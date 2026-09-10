---
name: sui-forensics
description: Method for investigating activity on the Sui blockchain with sui-mcp — how to open a case, which tool answers which question, what each evidence tier licenses you to claim, and the conclusions to refuse. Use when tracing stolen or laundered funds, attributing a wallet, identifying an unknown package, or assessing whether addresses share an operator.
---

# Investigating on Sui

The hard part of this work is not fetching data. It is knowing what the data
does **not** say. Chain data is complete and public, which makes a wrong
conclusion look exactly like a right one — fluent, specific, and sourced.

Everything below exists because the plain reading was wrong at least once.

## Evidence tiers, and what each licenses

Every claim should be traceable to one of these. Say which.

| tier | means | you may write |
|---|---|---|
| `chain-derived` | Read from Sui itself | "X sent 5 SUI to Y in transaction Z" |
| `indexer-attested` | A third party asserts it | "Wormholescan reports this VAA was redeemed on Ethereum" — a lead to confirm, not a finding |
| `heuristic` | An inference from patterns | "These addresses may share an operator" — never "they do" |

`build_wallet_edges` is the tool that tags its output `heuristic`. Its **edges**
are facts with digests attached; its **clusters** are inference. Do not collapse
the two, and never record a heuristic cluster as a finding without confirming it
yourself.

One exception, and it is a different KIND of claim rather than a stronger guess.
A Sui address **is the hash of its authenticator**, so a multisig's committee is
read from the address itself, not inferred from behaviour. Clusters built only
from full-weight `co_signer` edges carry `evidence_tier: "chain-derived"` per
cluster, and you may write "this key can spend that wallet" as a fact. You may
not write that it is the same person: a key is **control**, and a custodian
holds one for a client.

## Opening a case

1. **Set your sinks first.** Labels decide where a trace stops. Curated ones
   ship nearly empty on purpose — attribution is case-specific and mostly not
   publishable — so add what you know with `manage_labels`, or point
   `SUI_LABELS_FILE` at a private file for a whole case. A trace that runs past
   a known exchange, or stops at one you never told it about, is usually this.
2. **Identify before you trace.** `identify_address`. A hop that is a package or
   a shared object is not "someone the funds went to", and a trace that treats a
   DEX pool as a person is wrong from that point on.
3. **Trace with `trace_funds`.** Read `stop_reason` and `unfollowed` *before* the
   path: a trace follows one branch, and splitting across wallets is the ordinary
   laundering move.
4. **Attribute with `find_funding_source`** — or `find_funding_sources` for
   several addresses at once, which also reports co-funding and its denominators.
   Then measure the funder with `get_address_fanout` before believing anything.
5. **Cluster only once you have a reason to.** `build_wallet_edges` answers
   "is this a new party or the same one", not "who is this".
6. **Record with `save_finding`**, one claim per finding, with its digests.
   `export_case` when the case outlives the session.

## The control question

**Before treating any shared ancestry as meaningful, ask what the base rate is.**

Several wallets tracing to one funder is damning until you measure the funder:
29,000 recipients is an exchange and the convergence carries no information.

How to actually run the control:

1. `sample_control_addresses` for a comparison group — addresses drawn the same
   way as your subjects but with no reason to be related.
2. Run the *same* test on them. If you are quoting "4 of 6 of these wallets share
   a funder", the number is meaningless until you know what 6 unrelated wallets
   score.
3. Quote both numbers or neither.

The same applies to co-funding. A payout to exactly the two addresses under
investigation is close to decisive; one paying twenty, of which two are yours, is
a list an unrelated wallet lands in by chance. The denominator is
`transaction_recipient_count` — read it before the group.

## What a cluster actually asserts

`build_wallet_edges` merges a pair on **one** signal at weight ≥ 1.0. It does not
require corroboration, and `medium` confidence is exactly what that looks like.
Do not read a cluster as having cleared a two-signal bar; read the edges.

| signal | what it means |
|---|---|
| `co_signer` (1.5) | A key that can spend the multisig **alone**. Read from the address hash — not behavioural, and the only signal here that isn't |
| `co_signer` (0.6) | On the committee but cannot spend alone. Below the merge floor: a lead, never a cluster by itself |
| `cofunded` | Same first funder, and that funder is not a service |
| `funding_edge` | One address sent the first funding that made the other exist |
| `reciprocal` | Value moved **both** ways, and the counterparty is not a service |
| `sponsor` | Same gas payer — 0.7, cannot merge alone |

Three fields decide how much weight a cluster carries:

- **`independent_intermediaries`** — 1 means every edge runs through a single
  address. That is one fact stated many times, not corroboration, and the whole
  cluster falls if that address turns out to be a payout service.
- **`used_intermediaries[].scan_complete`** — `false` means "narrow" is
  provisional. Confirm it with `get_address_fanout` before relying on the cluster.
- **`notes`** — unverified sibling candidates are listed, not dropped. Raise
  `expand_budget` to resolve them.
- **`excluded_co_signers`** — keys sitting on more committees than the limit.
  These are wallet-provider or custody keys, not operators. One real mainnet key
  was on 31 separate 1-of-2 committees; without the filter it fused 31 strangers
  into one cluster. That key genuinely can spend all 31 wallets — write that if
  it matters — but it says nothing about whether those wallets share an owner.

## Multisig

`identify_address` tells you a wallet is a multisig and names its committee
members. That is chain-derived and costs one query. Three things follow that the
plain reading gets wrong:

- **The committee never changes.** It is part of the address hash, so a member
  cannot be rotated out the way a Gnosis Safe owner can. If you need a different
  committee, you have a different address.
- **Who signs is per-transaction; who is authorised is not.** `get_transaction`
  gives `authorization.signed_by` for one transaction. Do not generalise from
  it — a mainnet 4-of-7 used three different signer sets across eight
  transactions. Use `analyze_multisig` for the wallet-level picture: which keys
  are live, which have never signed, whether the active set shifted.
- **A wallet that has never SENT cannot be classified at all.** No signature, no
  committee. `authentication: null` with a caveat means unknown, not ordinary —
  a receive-only treasury multisig looks exactly like a fresh personal wallet.

A dormancy claim is only as good as the count behind it. "Member 5 has never
signed" over 8 transactions and over 200 are different claims; the tool reports
`transactions_examined` and you should carry it into anything you write.

`find_shared_multisig` searches the other way: given addresses you already
suspect are related, it finds a multisig they jointly control even if it never
appeared in your trace. A hit is proof. A **nil result is not** — it tests
equal-weight committees of exactly the keys you passed, so it cannot rule out a
weighted committee or one with a member you did not supply.

## Which tool answers what

Reaching for raw GraphQL is almost always a sign you missed a tool. Two of the
worst bugs this server has shipped were found that way, and hand-written queries
get the schema wrong in ways that fail silently.

| question | tool |
|---|---|
| What is this address? | `identify_address` |
| Where did the money go / come from? | `trace_funds`, `find_funding_source` |
| Several addresses at once? | `find_funding_sources` — shares work, reports co-funding |
| Is this funder an exchange? | `get_address_fanout` |
| Do these wallets share an operator? | `build_wallet_edges` |
| Who really runs this multisig treasury? | `analyze_multisig` — live vs dormant keys across its history |
| Which keys signed THIS transaction? | `get_transaction` → `authorization.signed_by` |
| Do these wallets share a multisig I haven't seen? | `find_shared_multisig` |
| Is this wallet automated? | `build_timeline` with `activity_hours` |
| Where does this trace stop, and why? | `manage_labels` — sinks are yours to set |
| What did this transaction do, with event values? | `get_transaction` |
| Several digests at once? | `get_transactions` — up to 50 in one call |
| What does this unknown package do? | `analyze_package` — struct shapes, API, capability audit |
| Events of a given type across time? | `query_events` — returns decoded fields |
| Did value leave the chain? | `trace_funds` reports `bridge_exits`; then `resolve_bridge_transfer` |
| Where did this object come from? | `trace_object_history` |
| Who holds this token? | `get_top_holders` |
| What is this address doing over time? | `build_timeline` |
| Write it down / hand it over | `save_finding`, `list_findings`, `export_case` |

If a tool seems missing, call `enable_tools` — it is probably disabled rather
than absent. It takes `profile: "developer"` or `profiles: ["forensics",
"developer"]`.

**Cost, roughly.** Clustering one seed is ~50 queries and rises with
`expand_budget`. A fan-out measurement is up to 20. Batch digests through
`get_transactions` rather than looping `get_transaction` — ten separate calls is
ten round trips for the same data.

## Conclusions to refuse

- **"No edge found, so they are unrelated."** Every signal comes from a capped
  scan of public data. Two wallets funded out-of-band and never co-appearing
  produce no edge no matter who controls them. Absence is not evidence.
- **"The trace ended, so the money stopped."** A forward trace stops when the
  recipient has not spent *yet*. Check `stop_reason`.
- **"Nothing was found, so nothing exists."** A pruned transaction and a wrong
  digest look identical. `not_found` is "could not look", not "not there".
- **"They share a funder, therefore an operator."** Only if that funder is
  narrow — and a single narrow funder is what `medium` confidence is made of.
  Corroboration is what moves it past that.
- **"A batch payout means shared control."** Twenty addresses paid 5 SUI each in
  one transaction share a list, not an operator.
- **"The exchange deposit means they cashed out."** A deposit on Sui and a
  withdrawal elsewhere cannot be linked from chain data. That is a subpoena,
  not a query.
- **"Flat activity means a bot."** Only above a real rate. A wallet transacting
  twice a week cannot show a daily rhythm whoever is behind it, and
  `automation_indicated` stays false for exactly that reason.
- **Naming a real person or company** from chain data plus a matching username.
  Handles are not unique and squatting is routine.
- **An expired SuiNS name is still attribution, not the reverse.** Reverse lookup
  goes silent once a name lapses, so `names_held` carries former aliases — the
  address was known by that name at the time of the activity. Do not read the
  current name as the only one.

## Traps in the data itself

- **Dust is not funding.** A 1-MIST spam send is not who funded a wallet, and an
  inflow in a coin nobody prices is spam at any size. Skipped inflows appear as
  `dust_skipped`; read them rather than assuming nothing was filtered.
- **The gas sponsor is not the sender.** Gas folds into the payer's net SUI, so a
  raw comparison across coins picks the sponsor over the real funder.
- **Obfuscated packages are named by their events.** A transaction calling
  `h86261::h8b64d` and emitting DeepBook events *is* DeepBook.
  `protocols_from_events_only` marks that gap, and it is worth following:
  wrappers are what routers and laundering paths look like.

## A worked case

Subject: one address, reported as the destination of a theft.

```
identify_address              → a wallet, not a package. Safe to read as a party.
manage_labels                 → label the two exchanges already known to the case,
                                so a trace stops there instead of running into
                                deposit-sweep noise.
trace_funds                   → 4 hops, stop_reason "reached a labeled entity".
                                unfollowed lists two recipients not taken —
                                note them, they are branches, not noise.
find_funding_source           → first funded by 0xaec…, 355 SUI.
get_address_fanout  0xaec…    → 33 recipients, narrow. Worth pursuing.
build_wallet_edges  subject   → 17 members, medium, independent_intermediaries 1.
get_transaction     <digest>  → the funding tx paid 20 addresses 5 SUI each.
```

What gets written down: the trace, with digests, `chain-derived`. The funding
source, with its fan-out measurement. **Not** the 17-member cluster — every edge
ran through one funder, and that funder made a twenty-way uniform payout, which
is a list rather than an operator. The finding records the payout as a fact and
says the cluster was not relied upon.

That last step is the job. The tools were right; the reading would have been
wrong.

## When you are done

Stop when the next query cannot change what you would write. Concretely: the
trace has reached a sink you can name, or a party you cannot go past without a
subpoena; the funder is measured rather than assumed; and every claim in the
report carries either a digest or an explicit statement that it could not be
determined.

If you are still collecting because more is available, you are past the point.

## Reporting

Say what you checked, what you found, and what you could not determine. A finding
that names someone should carry the transaction digests that support it, so a
reader can verify it without trusting you.

When a result rests on one intermediary — one shared funder, one sponsor — say
so. Sixteen edges through a single address is one fact stated sixteen times, and
if that address turns out to be a payout service the whole thing falls at once.

Say which tier each claim sits at. A reader who cannot tell your `chain-derived`
statements from your `heuristic` ones will treat them alike, and that is how a
lead becomes an accusation.
