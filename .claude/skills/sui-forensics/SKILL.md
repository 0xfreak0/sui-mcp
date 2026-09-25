---
name: sui-forensics
description: Method for investigating activity on the Sui blockchain with sui-mcp: how to open a case, which tool answers which question, what each evidence tier licenses you to claim, and the conclusions to refuse. Use when tracing stolen or laundered funds, attributing a wallet, identifying an unknown package, or assessing whether addresses share an operator.
---

# Investigating on Sui

The hard part of this work is not fetching data. It is knowing what the data
does **not** say. Chain data is complete and public, which makes a wrong
conclusion look exactly like a right one: fluent, specific, and sourced.

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
   ship nearly empty on purpose, since attribution is case-specific and mostly
   not publishable. Add what you know with `manage_labels`, or point
   `SUI_LABELS_FILE` at a private file for a whole case. A trace that runs past
   a known exchange, or stops at one you never told it about, is usually this.
2. **Identify before you trace.** `identify_address`. A hop that is a package or
   a shared object is not "someone the funds went to", and a trace that treats a
   DEX pool as a person is wrong from that point on.
3. **Trace with `trace_funds`.** Read `stop_reason` and `unfollowed` *before* the
   path: a trace follows one branch, and splitting across wallets is the ordinary
   laundering move.
4. **Attribute with `find_funding_source`**, or `find_funding_sources` for
   several addresses at once, which also reports co-funding and its denominators.
   Then measure the funder with `get_address_fanout` before believing anything.
5. **Cluster only once you have a reason to.** `build_wallet_edges` answers
   "is this a new party or the same one", not "who is this".
6. **Record with `save_finding`**, one claim per finding, with its `digests`
   and its `evidence_tier` (default `heuristic`). `export_case` groups the
   report by tier when the case outlives the session.

## The control question

**Before treating any shared ancestry as meaningful, ask what the base rate is.**

Several wallets tracing to one funder is damning until you measure the funder:
29,000 recipients is an exchange and the convergence carries no information.

How to actually run the control:

1. `sample_control_addresses` for a comparison group: addresses drawn the same
   way as your subjects but with no reason to be related.
2. Run the *same* test on them. If you are quoting "4 of 6 of these wallets share
   a funder", the number is meaningless until you know what 6 unrelated wallets
   score.
3. Quote both numbers or neither.

The same applies to co-funding. A payout to exactly the two addresses under
investigation is close to decisive; one paying twenty, of which two are yours, is
a list an unrelated wallet lands in by chance. The denominator is
`transaction_recipient_count`. Read it before the group.

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
- **`excluded_co_signers`** — keys sitting on more committees than the limit,
  i.e. custody or wallet-provider keys. Such a key genuinely can spend every
  wallet it signs for, and you may write that. It says nothing about whether
  those wallets share an owner, so do not cluster on it.

## A coin's symbol is not its identity

8,008 mainnet coins share a symbol with another. 585 claim `SUI`, 100 claim
`DEEP`. The imitators are named to be mistaken, for example "Sui v2 (migrate
asset: suiv2.com)", and nothing cheap tells them apart: the fake USDC's supply is
LARGER than Circle's, and `::usdc::USDC` costs a scammer nothing to copy.

- **`verified: false` means nothing vouches for this coin**, not that it is
  fake. It is still the coin the transaction moved. What you may not write is
  "the attacker moved 10,000 USDC", because you do not know which USDC.
- **A balance change carries `coin_verified`.** Use it. A trace through an
  imitator reads exactly like a trace through the real asset.
- **`assumed scale` means the amount itself may be wrong.** Decimals for an
  unverified coin are a guess; 47 of 289 imitators declare a different scale
  from the coin they imitate, one of them by 10^9.
- **An ambiguous symbol is an answer.** Several legitimate coins share `USDC` —
  Circle's, Wormhole's, Celer's. `analyze_token` returns candidates rather than
  picking. Pass a full coin type; it is the only unambiguous identifier.

## A holder scan is not a ranking unless it finished

`get_top_holders` and `analyze_token` walk coin objects in **object-id order**,
which has nothing to do with balance. A scan that hits its budget returns the
largest holder it happened to see.

Measured on SUI: the reported top holder was 66 SUI at `max_scan` 200, 522 at
400, 3,454 at 800 and 25,000 at 5,000. **Zero of the top five at 200 survived
to 800**, and the real top holder holds millions. The number climbs with effort
and never converges.

- **Check `complete_ranking` before writing any concentration claim.** False
  means the result is `sampled_holders`, carries no rank and no percentage of
  supply, and cannot support "the top 10 hold X%".
- **A complete scan is a real ranking** and may be used as one. That is only
  reachable for coins and collections small enough to enumerate.
- **Never compare two truncated scans.** Different budgets sample different
  objects, so a difference between them says nothing about the chain.

## A balance change only sees coins

Sui is object-based. A balance change is derived from `Coin<T>`, so everything
else (an NFT, a Kiosk, an admin capability) changes hands invisibly to fund
tracing. Measured: of 90 sampled capability objects, 74 had a last transfer with
no non-gas balance change at all.

`trace_funds` reports `object_flow` for this. What it changes about method:

- **`gas only` is no longer a conclusion.** It used to mean both "nothing
  moved" and "something moved that cannot be seen here". A hop showing no coin
  movement is only empty if `object_flow` is also absent.
- **A capability transfer is the finding, and the coin movement may come
  later.** Someone who takes a `TreasuryCap` mints afterwards; someone who
  takes an `UpgradeCap` changes the code afterwards. Trace forward from the
  recipient, not from the money.
- **A renounced capability is the opposite finding.** A cap sent to an
  unspendable address appears in `renounced_capabilities`, not
  `capability_transfers`: 27 of 30 real UpgradeCap departures go that way, and
  it is a risk reduction. Do not write it up as a handover.
- **`high_consequence` is narrow on purpose.** Only `UpgradeCap`,
  `TreasuryCap`, `DenyCap`, `DenyCapV2` and `Publisher` carry a stated power. A
  protocol's own `AdminCap` is flagged as a capability with no claim about what
  it grants. Read the package with `analyze_package` before asserting one.
- **Kiosk moves are custody changes.** A kiosk-held NFT is owned by the Kiosk
  object, so the trade reads `object -> object`. The controlling wallet is not
  named by the movement itself; resolve it before attributing.
- **`appeared` means the previous holder is not recorded**, which is normal
  before roughly March 2024. It is not evidence of an unwrap, and not evidence
  of a transfer. The chain did not say.

## An address's rendering is not its identity

Wallets and explorers truncate a 32-byte address to something like
`0xd649a4d5…57127127`. Address poisoning exploits exactly that: an attacker
grinds an address matching the leading and trailing characters of one the victim
already deals with, sends dust from it, and waits for a human to copy the wrong
row out of their own transaction history.

`get_transaction_history` and `trace_funds` report `address_poisoning` when two
addresses they touched are close enough to be mistaken for one another.
Measured on mainnet: zero flags
across 75 random active wallets and 265 pages of history.

- **The lookalike is not a counterparty.** It *sends* dust, so it appears only
  as a transaction's sender with a negative balance change. Anything that reads
  the `counterparties` list alone will not see it.
- **The pair is usually hops apart.** In a trace the comparison runs over the
  whole chain, including recipients the trace declined to follow. An
  unfollowed branch imitating a followed one is the branch picked by eye.
- **`direction_known: false` means the roles are not assigned.** The address
  with the larger footprint is named as established, and only when the gap is
  wide enough to carry the claim: dust repeating inside one page is the normal
  shape of this attack, so a 3-vs-1 count is not evidence. Where nothing
  separates them, both are reported and neither is called the fake.
- **A flag is about rendering, not intent.** It says two addresses collide in
  a truncated view. The corroboration is the lifecycle: a poisoning wallet is
  funded, fires dust, and sweeps its change back, often inside ten seconds.
  Check the suspect with `get_transaction_history` before writing it up.
- **A clean result covers what was read.** One page of history is not a
  statement that the wallet was never targeted; the field is absent rather than
  empty for that reason. The default page is the most recent activity; page
  back with `next_cursor` to cover more of it.

## Packages: who deployed it, and who can change it

- **`publisher`** (`identify_address`) and **`root_publisher`**
  (`analyze_package`) are the sender of the transaction that created the
  lineage ROOT: the original deployer, the address a trace can follow.
  `analyze_package` also reports **`version_publisher`**, the sender of the
  upgrade that created the version you passed. That is who pushed that code,
  which is the question to ask of an exploited version. The UpgradeCap's
  holder is judged against the root publisher.
- **A party-held cap is held, not shared.** Owner `consensus` is a party
  object: one address owns it and only that address can use it.
- **`holder_status` on the UpgradeCap** answers whether the code can still
  change. `burned` means the cap went somewhere unspendable and upgrade rights
  are renounced. **That is a REDUCTION in risk**, and 27 of every 30 caps that
  leave their publisher are burned rather than transferred. `transferred` is
  the uncommon one (about 2%), and even then it is not wrong on its own: teams
  move caps to treasuries and multisigs deliberately. Identify the holder.
- **`unresolved` is not `publisher`.** Publish transactions are frequently
  pruned. A failed lookup is "could not check", never "still with the deployer".
- **Diff the upgrade, and its dependencies.** `diff_package_upgrade` returns
  each changed module as unified hunks, the functions that were added,
  removed or made more reachable (`visibility_changes` with `widened: true`),
  and `linkage_changes`. An upgrade can change behaviour by relinking a
  dependency while its own modules barely change; each relinked dependency
  carries the `diff_package_upgrade` call that shows what changed inside it.

## Why a transaction failed

`get_transaction` returns `failure` with the abort code, and the package,
module and function that raised it. `get_transactions` names the same kinds
(`MOVE_ABORT` only when there is an abort code; `INSUFFICIENT_GAS` and the
rest from the node's message). Two readings to get right:

- **An abort code is meaningless across packages.** Every package numbers its
  own aborts from zero, so `3` only means something beside the module that
  raised it. A `clever_error`, when present, names the constant the author
  wrote. That is the answer, and the raw code is an implementation detail.
- **Some failures are not rejections.** Congestion cancellation means the
  transaction was never invalid and a retry may succeed; out-of-gas says
  nothing about intent. Do not read either as an attempt that was stopped.

`ADDRESS_DENIED_FOR_COIN` is the exception worth chasing: it means an issuer
had already frozen the sender, which is attribution.

## Frozen addresses

`check_coin_restrictions` reads the on-chain deny list. A freeze is
**chain-derived attribution of an unusual kind**: not a protocol rule, but an
issuer's own decision, recorded on chain and reversible by whoever holds the
DenyCap. Somebody with authority over an asset concluded something about this
address. Note it, and attribute it to the issuer rather than to the
chain.

A freeze by validators, who refuse an address's transactions through their
node configuration, is off chain and in no deny list, so a clean result here
does not rule it out. What shows on chain is indirect: the address stops
sending, and any later movement of its funds is in transactions its owner did
not sign.

- **A frozen address usually holds NONE of the coin that froze it.** Freezing
  and holding are anti-correlated, so an empty balance is not evidence.
- **A global pause is not about any holder.** It says the issuer stopped the
  whole asset.
- **`active: false` is recorded but not in force.** A denial takes effect the
  epoch after it is written.

## Sponsorship

`get_address_fanout` reports `sponsor_shape` alongside value fan-out, because
paying someone's gas moves no value of your own, so a relayer looks narrow by
balance changes and is anything but.

**`relayer` is proven; `private_sponsor` is provisional.** Breadth only grows
with the window, and on one mainnet sponsor the count went 1 to 86 between a
100- and an 800-transaction scan, crossing the threshold. If
`sponsor_shape_provisional` is set, raise `max_transactions` before writing
"narrow", and never treat shared sponsorship through a relayer as a link.

## Multisig

`identify_address` tells you a wallet is a multisig and names its committee
members. That is chain-derived and costs one query. Three things follow that the
plain reading gets wrong:

- **The committee is fixed by the address.** It is part of the address hash, so
  a member cannot be rotated out the way a Gnosis Safe owner can. Who may spend
  is a separate question: address aliases let a wallet authorize other addresses
  after the fact, so check `aliases` before writing that a committee is the only
  way to move these funds. See "Address aliases" below.
- **Who signs is per-transaction; who is authorised is not.** `get_transaction`
  gives `authorization.signed_by` for one transaction. A member under
  `did_not_sign` is still authorised and may have signed others, so do not
  generalise from one. Use `analyze_multisig` for the wallet-level picture:
  which keys are live, which have never signed, whether the active set shifted.
- **A wallet that has never SENT cannot be classified at all.** No signature, no
  committee. `authentication: null` with a caveat means unknown, not ordinary —
  a receive-only treasury multisig looks exactly like a fresh personal wallet.

A dormancy claim is only as good as the count behind it. "Member 5 has never
signed" over 8 transactions and over 200 are different claims; the tool reports
`transactions_examined` and you should carry it into anything you write.

`find_shared_multisig` searches the other way: given addresses you already
suspect are related, it finds a multisig they jointly control even if it never
appeared in your trace. A hit is proof. A **nil result is not**, because it tests
equal-weight committees of exactly the keys you passed, so it cannot rule out a
weighted committee or one with a member you did not supply.

## Address aliases

An address can authorize up to eight others to act for it (`0x2::address_alias`,
state at `0xa`). `identify_address` reports this as `aliases`.

- **An alias is chain-derived control.** You may write "this address can
  authorize for that wallet" as a fact. You may NOT write that they are the same
  person: a custodian holds authority for a client, the same distinction
  `co_signer` draws.
- **Read `delegated_to`, not `aliases`.** `enable` seeds the set with the
  wallet's own address, so a set holding only the owner means the feature is on
  and nobody else was authorized. `delegated_to` is the set without the owner,
  and an empty one widens nothing. Two of the 63 mainnet sets are that shape.
- **Check `owner_can_authorize` before saying who controls the wallet.** The set
  replaces the signer rather than extending it, so a wallet absent from its own
  set cannot authorize for itself and only `delegated_to` can move its funds.
  Measured: 50 of 63 mainnet sets are in that state.
- **A key acting for many wallets is a service.** Treat it the way
  `excluded_co_signers` treats a custody key. Two mainnet keys already act for
  22 owners each.
- **A wallet with no `AddressAliases` object has never enabled the feature**,
  which is the common case. That is an absent field, not a denial.
- **The set is mutable.** `remove` and `replace_all` exist, so an alias is true
  as of the read, not forever. Quote the answer against when you took it.
- **Check it before concluding a multisig committee is the only spender.** The
  committee cannot rotate; the wallet's alias set can.

Measured on mainnet 2026-09-15: 63 wallets had enabled aliases. It is new, so
absence is unremarkable and presence is worth a second look.

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
| Did it touch anything, when it moved no coin? | `get_transaction` → `command_count`, `object_changes`, `object_transfers` |
| Several digests at once? | `get_transactions` — up to 50 in one call |
| What does this unknown package do? | `analyze_package` — struct shapes, API, capability audit |
| Who deployed this package, and who pushed this version? | `analyze_package` → `root_publisher`, `version_publisher` (`identify_address` → `publisher`) |
| What did an upgrade change? | `diff_package_upgrade` → hunks, `visibility_changes`, `linkage_changes` |
| Can the code still be changed, and by whom? | `analyze_package` → the UpgradeCap's `holder_status` |
| Why did this transaction fail? | `get_transaction` → `failure` (abort code, module, function) |
| Has an issuer frozen this address? | `check_coin_restrictions` |
| Is this coin the real one? | `analyze_token` → `verified`; traces carry `coin_verified` per balance change |
| Is this address the one it looks like? | `get_transaction_history` and `trace_funds` → `address_poisoning` |
| Did something move that was not a coin? | `trace_funds` → `object_flow` |
| Who can mint / upgrade / freeze, and did that change hands? | `trace_funds` → `object_flow.capability_transfers` |
| Does this address pay other people's gas? | `get_address_fanout` → `sponsor_shape` |
| Events of a given type across time? | `query_events` — returns decoded fields |
| What happened between two times? | `query_transactions`, `query_events`, `build_timeline` and `aggregate_events` take ISO bounds; `get_checkpoint {timestamp}` gives the checkpoint |
| Did value leave the chain? | `trace_funds` reports `bridge_exits`; then `resolve_bridge_transfer` |
| Where did this object come from? | `trace_object_history` |
| Who holds this token? | `get_top_holders` — a ranking ONLY when `complete_ranking` is true |
| Has anything moved since I looked? | `watch_addresses` then `poll_watch` |
| What is this address doing over time? | `build_timeline` |
| Write it down / hand it over | `save_finding`, `list_findings`, `export_case` |

If a tool seems missing, call `enable_tools`. It is probably disabled rather
than absent. It takes `profile: "developer"` or `profiles: ["forensics",
"developer"]`. Calling a disabled tool returns the profile to enable.

Address arguments take any case, a short form or a SuiNS name. A name is
resolved at call time and reported as `resolved_from`; it points wherever its
owner set it today, so cite the address, not the name.

A field set to `null` with a `*_unavailable` note beside it (`sui_balance`,
`sui_name`, `token_count`, `staked_sui_count`, `kiosk_count`) means the read
failed. It is
unknown, not zero, and not evidence of an empty or unused wallet. Retry before
drawing anything from it.

**Cost, roughly.** Clustering one seed is ~50 queries and rises with
`expand_budget`. A fan-out measurement is up to 20. Batch digests through
`get_transactions` rather than looping `get_transaction`. Ten separate calls is
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
  narrow, and a single narrow funder is all `medium` confidence rests on.
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
  goes silent once a name lapses, so `names_held` carries former aliases. The
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
- **A package ID names one version.** An event's type carries the package that
  defined its struct, which is often an older version than the one called;
  `query_events` and `aggregate_events` rewrite such a type and report
  `event_type_resolution`. A `function` or `module` filter matches calls through
  one version only, and each version holds its own share of a protocol's calls:
  read `function_scope` / `module_scope`, and use `all_versions: true` on
  `query_transactions` to read the lineage as one list.
- **Lists start at the newest row.** History, `query_transactions` and
  `query_events` page back from the present unless `order: "oldest"` is set;
  every page states its `order` and the `oldest_shown` / `newest_shown` times.
- **A timeline walk has a budget.** In `build_timeline`, `coverage[].truncated`
  means `per_address` ended that address's walk inside the window. Past its
  `reached_checkpoint` the timeline is missing that address's activity; rerun
  with its `continue_with` bound or a higher `per_address`.

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
source, with its fan-out measurement. **Not** the 17-member cluster, where every edge
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

When a result rests on a single intermediary (one shared funder, one sponsor), say
so. Sixteen edges through a single address is one fact stated sixteen times, and
if that address turns out to be a payout service the whole thing falls at once.

Say which tier each claim sits at. A reader who cannot tell your `chain-derived`
statements from your `heuristic` ones will treat them alike, and that is how a
lead becomes an accusation.
