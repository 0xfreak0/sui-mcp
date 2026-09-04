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

Every claim you make should be traceable to one of these. Say which.

| tier | means | you may write |
|---|---|---|
| `chain-derived` | Read from Sui itself | "X sent 5 SUI to Y in transaction Z" |
| `indexer-attested` | A third party asserts it | "Wormholescan reports this VAA was redeemed on Ethereum" — a lead to confirm, not a finding |
| `heuristic` | An inference from patterns | "These addresses may share an operator" — never "they do" |

`build_wallet_edges` is the only tool that emits `heuristic`. Its **edges** are
facts with digests attached; its **clusters** are inference. Do not collapse the
two, and never record a cluster as a finding without confirming it yourself.

## Opening a case

1. **Identify before you trace.** `identify_address` first. A hop that is a
   package or a shared object is not "someone the funds went to", and a trace
   that treats a DEX pool as a person is wrong from that point on.
2. **Trace with `trace_funds`.** Read `stop_reason` and `unfollowed` before the
   path itself: a trace follows one branch, and splitting across wallets is the
   ordinary laundering move.
3. **Attribute with `find_funding_source`.** Then measure the funder with
   `get_address_fanout` before believing anything about it.
4. **Record with `save_finding`**, one claim per finding, with its digests.

## The control question

**Before treating any shared ancestry as meaningful, ask what the base rate is.**

Several wallets tracing to one funder is damning until you measure the funder:
29,000 recipients is an exchange and the convergence carries no information.
`get_address_fanout` answers this, and `sample_control_addresses` draws a
comparison group. Run the same test against the control before quoting a rate.

The same applies to co-funding. A payout to exactly the two addresses under
investigation is close to decisive; one paying twenty, of which two are yours,
is a list an unrelated wallet lands in by chance. The denominator is
`transaction_recipient_count` — read it.

## Which tool answers what

Reaching for raw GraphQL is almost always a sign you missed a tool. Two of the
worst bugs this server has shipped were found that way, and hand-written queries
get the schema wrong in ways that fail silently.

| question | tool |
|---|---|
| What is this address? | `identify_address` |
| Where did the money go / come from? | `trace_funds`, `find_funding_source` |
| Is this funder an exchange? | `get_address_fanout` |
| Do these wallets share an operator? | `build_wallet_edges` |
| What did this transaction do, with event values? | `get_transaction` |
| Several digests at once? | `get_transactions` (up to 50, one call) |
| What does this unknown package do? | `analyze_package` — struct shapes, API, capability audit |
| Events of a given type across time? | `query_events` — returns decoded fields |
| Did value leave the chain? | `trace_funds` reports `bridge_exits`; then `resolve_bridge_transfer` |
| Who holds this token? | `get_top_holders` |
| What is this address doing over time? | `build_timeline` |

If a tool seems missing, call `enable_tools` — it is probably disabled rather
than absent. It accepts `profile: "developer"` or `profiles: ["forensics",
"developer"]`.

## Conclusions to refuse

- **"No edge found, so they are unrelated."** Every signal comes from a capped
  scan of public data. Two wallets funded out-of-band and never co-appearing
  produce no edge no matter who controls them. Absence is not evidence.
- **"The trace ended, so the money stopped."** A forward trace stops when the
  recipient has not spent *yet*. Check `stop_reason`.
- **"Nothing was found, so nothing exists."** A pruned transaction and a wrong
  digest look identical. `not_found` is "could not look", not "not there".
- **"They share a funder, therefore an operator."** Only if that funder is
  narrow, and only alongside a second, independent signal.
- **"The exchange deposit means they cashed out."** A deposit on Sui and a
  withdrawal elsewhere cannot be linked from chain data. That is a subpoena,
  not a query.
- **Naming a real person or company** from chain data plus a matching username.
  Handles are not unique and squatting is routine.

## Traps that produce confident wrong answers

- **An expired SuiNS name is still attribution.** Reverse lookup returns only
  the current default name and goes silent once a name lapses, so a wallet's
  former aliases vanish. The investigation flows report `names_held` including
  expired ones — the address was known by that name at the time of the activity.
- **Dust is not funding.** A 1-MIST spam send is not who funded a wallet, and an
  inflow in a coin nobody prices is spam at any size. Skipped inflows appear as
  `dust_skipped`; read them rather than assuming nothing was filtered.
- **The gas sponsor is not the sender.** Gas folds into the payer's net SUI, so
  raw-magnitude comparison across coins picks the sponsor over the real funder.
- **Obfuscated packages are named by their events.** A transaction calling
  `h86261::h8b64d` and emitting DeepBook events *is* DeepBook.
  `protocols_from_events_only` marks that gap, and it is a signal worth
  following: wrappers are what routers and laundering paths look like.
- **A batch payout is not shared control.** Twenty addresses paid 5 SUI each in
  one transaction share a list, not an operator.

## Reporting

Say what you checked, what you found, and what you could not determine. A
finding that names someone should carry the transaction digests that support it,
so a reader can verify it without trusting you.

When a result rests on one intermediary — one shared funder, one sponsor — say
so. Sixteen edges through a single address is one fact stated sixteen times, and
if that address turns out to be a payout service the whole thing falls at once.
