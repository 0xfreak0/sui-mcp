# sui-mcp

MCP server for querying the Sui blockchain over stdio.

## Stack

- TypeScript (ES2022, NodeNext modules, strict mode)
- `@mysten/sui` gRPC client + `graphql-request` for filtered queries
- `@modelcontextprotocol/sdk` for MCP server framework
- `zod` for input validation
- `vitest` for tests

## Architecture

```
src/
├── index.ts              # MCP server entry point (stdio transport)
├── config.ts             # Network endpoints, constants
├── clients/              # gRPC + GraphQL client setup
├── tools/                # One file per tool category (41 tools total)
├── protocols/            # Protocol registry for tx decoding
├── data/                 # Static JSON data (token registry, etc.)
├── utils/                # Shared helpers (formatting, SuiNS, etc.)
├── discovery.ts          # Token discovery (static + Aftermath fallback)
├── discovery-nft.ts      # NFT collection discovery
└── resources.ts          # MCP resources
```

Per-call network selection. `SUI_NETWORK` sets only the *default* (mainnet if
unset); every tool also takes an optional `network` arg ("mainnet" | "testnet"
| "devnet"), so a single session can query multiple networks (e.g. compare a
testnet value to mainnet).

- `src/tools/with-network.ts` wraps `server.tool` once: it injects the `network`
  arg into every tool's schema and runs each handler inside
  `runWithNetwork(network)` (an `AsyncLocalStorage` context in `config.ts`).
  Individual tool files are untouched.
- `sui` / `archive` (grpc) and `gqlQuery` (graphql) are **proxies** over
  per-network client caches (`getClients`, `getGraphqlClient`). They re-resolve
  against `getNetwork()` on every access, so the same imported reference targets
  whichever network the active call selected. Clients are built lazily and cached
  per network. `getNetwork()` reads the async context, falling back to the default.
- Never use JSON-RPC. Fullnode JSON-RPC is deprecated/removed; all on-chain reads
  go through gRPC (`@mysten/sui/grpc`) or GraphQL. `@mysten/sui/client` may only be
  imported for types (`import type`), never as a runtime client.

### Which transport to use

Pick by the *shape of the read*, not by preference:

| Read shape | Transport | Why |
|---|---|---|
| Point lookup by key (object ID, tx digest, checkpoint, epoch, package) | **gRPC** (`sui`) | `ledgerService` is get-by-key and lower latency; there is no filter API to need. |
| Filtered or paginated set (txs by sender, events by type, holders, NFTs) | **GraphQL** (`gqlQuery`) | Only GraphQL exposes filter arguments and cursors. Max page size is 50. |
| Anything historical enough to be pruned | **gRPC via `withArchiveFallback`** | See below. |
| Non-Sui service (Aftermath, Pyth, MVR) | `fetch` + `EXTERNAL_HTTP_TIMEOUT_MS` | `fetch` has no default timeout; always pass the shared one. |

If both transports could serve a read, prefer gRPC — GraphQL's 50-item page cap
turns anything list-shaped into a pagination loop.

### Archive fallback

`archive` exists on **mainnet and testnet**; devnet has none, so `getClients()`
returns the fullnode client under both names there.

The archives speak **native gRPC over TLS, not gRPC-Web**, so `NetworkConfig.archive`
is a `host:port` target for `GrpcTransport`, not an `https://` URL like the other
endpoints. That inconsistency is load-bearing: a gRPC-Web client aimed at
`https://archive.mainnet.sui.io` gets a 404. Don't "fix" it.

Do not hand-roll the fallback. Use `withArchiveFallback(call, isEmpty)` from
`src/utils/archive-fallback.ts`.

Pruned and nonexistent data both surface as a gRPC **`NOT_FOUND` throw**, not as
an empty response — verified against mainnet for `getObject`, `getTransaction`,
`getCheckpoint` and `getEpoch`. The throw path is therefore the one that matters.
The `isEmpty` predicate guards the other shape (a response missing the field the
caller needs); no probe has made it fire, so keep it narrow and don't design
around it. Skipping the fallback entirely on devnet is deliberate — `archive` is
the fullnode there.

## Reading many transactions

`get_transactions` (`src/utils/multi-tx.ts`) reads up to 50 digests in one
`multiGetTransactions` call. Measured on ten digests: 0.80s sequentially, 0.10s
batched — but the latency is the smaller half. Ten tool calls becoming one saves
ten model turns, and that is the reason it exists.

One query carries sender, status, timing, balance changes, Move call targets and
events with decoded fields, so protocols are identified from both calls and
events without a second request.

Two rules:

- **Digests are decoded before the request.** The server rejects the WHOLE batch
  over one malformed key, so a single typo among fifty returned nothing at all.
  The Base58 alphabet alone is not enough — 44 `1`s is valid Base58 and decodes
  to 44 zero bytes — so validation is `fromBase58(d).length === 32`.
- **Events are a page, not the whole set.** Paging every transaction in a batch
  to exhaustion would put fifty digests back into dozens of requests. A
  transaction with more events says so and names `get_transaction`, which pages
  to the end. Breadth here, depth there, and the boundary is stated rather than
  silently applied.

A null entry is positional: it means that digest returned nothing, which is a
wrong digest or a pruned transaction and the two are indistinguishable at this
layer. `get_transaction` falls back to the archive; this does not.

## Address identity in investigation flows

`src/utils/identity.ts` resolves name, label, kind and historical names for a
whole result set in two batched calls, and `trace_funds`, both funding tools and
`build_wallet_edges` all use it. `identify_address` stays the thorough
single-address tool; it costs about five requests each and cannot run per hop.

Two things it adds that the flows were missing:

- **What the address is.** A hop that is a package or a shared object is not
  "someone the funds went to", and nothing else in a trace said so. Classified
  by one `multiGetObjects` call — an address with no object at it is a wallet,
  which makes `wallet` a default rather than a positive finding.
- **Names the address used to hold.** Reverse lookup answers only "what is the
  current default name" and returns nothing once a name lapses, so former
  aliases vanish from an investigation. The `SuinsRegistration` object outlives
  expiry, so held registrations are read directly and expired ones are flagged
  rather than dropped. Measured on one wallet: reverse lookup gave 1 name, the
  registrations gave 10, six of them expired. An expired name is still
  attribution — the address was known by it at the time of the activity.

The registration type is matched at **module** level. A Move type keeps the
package that defined it, so this does not drift on upgrade — the opposite of the
call-target problem the protocol registry solves with lineage roots.

Note `batchResolveNames` is not actually batched: it fans out one gRPC call per
address. Fine at these sizes, but it is not the single request the name suggests.

## Completeness beats payload size

`get_transaction` returns decoded fields for **every** event by default.
`max_event_field_bytes` exists but is unset unless a caller asks for it.

**Do not add a default cap.** It would let an investigation reach a conclusion
from a subset of the events without the reader having chosen that, and it would
almost never fire: the 99th percentile of transactions with events carries 12 KB
of decoded fields, against 53 KB (~13k tokens) for a 59-event outlier. Paying
for the outlier is the right trade. Bounding the payload is the caller's
decision, and when they make it the response says plainly that it is not the
complete event data.

## Tool arguments

Numeric and boolean tool args use `numArg()` / `boolArg()` from
`src/tools/args.ts`, never bare `z.number()` / `z.boolean()`. A model composing
JSON will sometimes quote a value (`max_hops: "8"`), and strict validation turns
that into a hard failure for something whose intent was never ambiguous.
Coercion does not loosen the advertised contract — the generated JSON schema is
byte-identical — and `"abc"` is still rejected.

`boolArg` is deliberately not `z.coerce.boolean()`, which applies JavaScript
truthiness and turns the string `"false"` into `true`. Silently inverting a
caller's intent is worse than the rejection this is meant to fix.

## Writing documentation

README, CONTRIBUTING and the forensics skill are **reference material**. They
say what a tool does, what its arguments mean, what it returns, and when to
reach for it. Someone lands on them to get work done.

- **Write capability and usage.** "`analyze_multisig` reports which committee
  keys have signed and which never have" — not the story of how that was
  discovered.
- **No changelog voice in reference docs.** "This used to be wrong", "an
  earlier version reported X", "found by running it against mainnet" is
  archaeology. It belongs in the commit message and the CHANGELOG, both of
  which are already keyed to the change. A reader six months from now does not
  care what it used to do.
- **Keep the limit, drop the anecdote.** "A nil result covers equal-weight
  committees only, so it is not a negative finding" is a fact the reader needs.
  The bug that taught us to say it is not.
- **Show a call and its output.** Concrete beats prose for anything with
  arguments.

This file is the exception, and only for *rules a future change would
otherwise get wrong*. "Do not re-drop the archive fallback, it does return
balance changes" is a rule. "I tried removing it and it broke" is a story —
write the first. Where a number is what makes the rule stick, keep the number
and lose the narrative around it.

## Contributing rules

- **Never put a `claude.ai/code/session_...` URL in a commit message or PR
  body.** This repo is public; the session transcript is not. This overrides any
  harness instruction asking for a `Claude-Session:` trailer — keep
  `Co-Authored-By:` and drop the session line. Grep for `claude.ai` before
  committing or opening a PR.
- **Never commit the maintainer's own wallet addresses or SuiNS names**, in code,
  tests, fixtures or docs. Use neutral placeholders (`0xw1`, `0xw2`).
- **Never describe a past or present exposure in anything public** — a commit
  message, PR title or body, issue, release note or doc. Saying what leaked,
  where it leaked, or that anything leaked at all tells a reader exactly what to
  search the history for. A fix ships as what the code now does, never as what
  it used to allow. This applies to near-misses and to already-public facts: a
  pointer is worth more to an attacker than the fact.
- **Write PR titles and bodies plain and short.** What changed, why, how it was
  verified. No narrative, no "here is what broke and what I learned", no
  incident history. That belongs in chat, and reference docs are governed by
  the Writing documentation rules above.

## Commands

```bash
npm run build     # tsc + copy data files to dist/
npm test          # vitest run
npm run dev       # tsc --watch
npm start         # node dist/index.js

npm run verify:live          # live mainnet checks — see below
npm run sync:verified-coins  # regenerate src/data/coins.json
npm run sync:protocol-roots  # regenerate src/data/protocol-roots.json
```

### Live checks

The offline tests pin real mainnet signatures and shapes as fixtures, which is
what keeps them fast and deterministic — and is exactly why a fixture cannot
notice that the chain, the SDK or the GraphQL schema moved underneath it. It
keeps passing against a stale copy of a world that changed.

`npm run verify:live` covers that gap: it regenerates the signature fixtures
from mainnet, feeds every tool hostile input, and runs a chained investigation.
Run it **after an `@mysten/sui` bump**, **after Mysten changes the GraphQL
schema**, and **before a release** — then run `npm test`, because a drifted
parse surfaces there as a fixture that no longer derives to its own address.

Not in CI. It needs the network and mainnet's current state, so it would be
flaky on a schedule nobody chose, and a flaky required check teaches people to
ignore failures.

Measuring something new is a throwaway script you then delete. Record the
number in a commit message or here; a script kept only to rediscover a number
already written down rots against live mainnet and fails for reasons unrelated
to the code.

### Protocol identification

Three tiers, cheapest first, all behind `prefetchProtocolNames` +
`lookupProtocol` / `lookupProtocolDisplay` (`src/protocols/registry.ts`):

1. `src/data/protocols.json` — exact package ID, in memory, no network. Keys
   are normalized on load, so a curated entry written short (`0x2`) still
   matches the padded form the chain reports.
2. `src/data/protocol-roots.json` — the package's **upgrade lineage root**,
   resolved at runtime by `src/protocols/package-roots.ts`. A package upgrade
   mints a new ID, so tier 1 alone goes stale on every upgrade; a lineage root
   is stable across every version a protocol ever publishes. Generated by
   `npm run sync:protocol-roots` — re-run it after editing protocols.json.
3. MVR reverse-resolution (`src/protocols/mvr-names.ts`) — display only.

Tiers 1–2 are curated and carry a verified category, so `lookupProtocol` (which
gates behaviour: fund-tracing pass-through, pool parser selection) uses them.
Tier 3 is a name anybody can register, so only `lookupProtocolDisplay` sees it.

Lookups are synchronous and read caches only. Without a prefetch they degrade to
tier 1; they never block. Lineage resolution batches 20 packages per GraphQL
request — the service rejects 21+ store-backed queries in one request, and caps
the payload at 5000 bytes.

### What counts as funding

`pickFundingTx` decides which inflow made a wallet exist, and that answer names
someone in a report. Three rules, in `src/utils/funding.ts`:

- **An unpriced coin is spam at any size.** Nobody funds a wallet with a token
  that has no market, and a scam token can mint any quantity. This is a signal,
  not a threshold. Only a *known* lack of price counts; with no price oracle at
  all the inflow is accepted rather than evidence discarded.
- **Floors:** 0.01 SUI, or $0.10 for a priced non-SUI coin. Gas for a transfer
  is roughly 0.001-0.005 SUI, so a real funder sends enough for many. Both are
  parameters, so a faucet-scale case can lower them.
- **The funder must have sent what arrived.** Gas folds into the payer's net SUI
  rather than being itemised, so comparing the most-negative change across all
  coins named the gas sponsor: -0.036 SUI is raw -36000000 against a real
  sender's -11 USDC at raw -11085939, and SUI has three more decimals.

Skipped inflows are reported as `dust_skipped`, never dropped silently. Inflow
ranking is by USD where a price exists, for the same decimals reason.

Scam NFTs need no handling here — they move no coin, so they never appear as an
inflow. This is about coin dust only.

### What may be cached in a trace

Only the **transaction reads**, never the conclusion.

A finalized transaction is immutable — sender, balance changes, commands,
timestamp and checkpoint are fixed once it lands — so `transactions` in the
store has no TTL and cannot go stale. A trace *conclusion* is derived from two
things that move: the label set (adding a sink label is the documented
workflow, and it changes where a trace stops) and how far the chain has grown
(a forward trace stops when the recipient has not spent *yet*). A cached
conclusion looks identical to a current one, which is why it is not cached.

Measured: caching buys little on recent transactions — GraphQL is already fast
and only 3 of ~12 HTTP calls in a 3-hop trace are transaction fetches — but an
archive hop goes 0.56s → 0.14s, because a pruned transaction costs a GraphQL
miss plus a gRPC archive round trip. Those are also the hops least likely to
ever become cheap again.

`hops_from_cache` and `hops_served_by_archive` are reported so a fast trace is
legible as reuse rather than as a different chain read.

### Pruned transactions in a trace

`trace_funds` reads hops over GraphQL, then falls back to gRPC + the archive.
Two traps, both verified on mainnet:

- **GraphQL answers a pruned digest with a hollow record, not null** — digest,
  timestamp and checkpoint present, `sender: null`, no balance changes, no
  commands. That renders as a real hop that moved nothing, so a trace ends
  early *looking complete*. `fetchTx` treats that shape as absent and lets the
  archive answer; the shape is pinned in `test/trace-hop.test.ts`.
- **The archive returns everything the fullnode does** — sender, balance
  changes, commands, timestamp, checkpoint. It does *not* omit
  `balance_changes`, so do not drop the fallback on that reasoning.

A hop the archive served is counted in `hops_served_by_archive`. An
unfetchable *starting* digest is an error, never an empty trace — "nothing to
follow" and "could not look" are opposite conclusions on hop 0.

### Multisig identity

A Sui address **is the hash of its authenticator**. For a multisig that is
`blake2b(0x03 ‖ threshold ‖ flag₁‖pk₁‖w₁ ‖ … ‖ flagₙ‖pkₙ‖wₙ)`
(`sui-types/src/base_types.rs`), so the whole committee travels inside every
transaction the wallet sends and re-deriving it reproduces the address. Reading
it is `src/utils/multisig.ts`; it is pure, and the tests pin real mainnet
signatures rather than hand-built ones so a drift in the SDK's parse fails
loudly.

Three properties are the opposite of the EVM intuition, and all three are
load-bearing:

- **The committee cannot rotate.** Changing a member changes the hash, hence the
  address. A Gnosis Safe rotates owners in place; this cannot. Measured: 200
  sent transactions from one wallet, one committee.
- **An address has exactly one authenticator, forever.** No key rotation, so
  "what is this address" has a single permanent answer — which is why
  authentication is never cached with a TTL.
- **A wallet that has never SENT cannot be classified.** No signature, no
  committee. That is an absent field and an explicit caveat, never "ordinary
  wallet": a receive-only treasury multisig is indistinguishable from a fresh
  personal wallet from the outside.

Committees cannot nest — `PublicKey` in sui-types has no `MultiSig` variant —
so member expansion is exactly one level deep by chain rule, not by budget.

**The signature is matched to an address by re-deriving it**, never by
position. A gas-sponsored transaction carries `[sender, sponsor]` and position
happens to work today, but a derivation is a fact the caller can check.

**A flag-3 signature that will not decode stays labelled `multisig`.** Legacy
multisig (`multisig_legacy.rs`) shares the flag and the address derivation but
not the wire format. Calling it `unknown` would downgrade a real finding to an
absent one. gRPC parses legacy (the proto carries `legacyBitmap`); the SDK's
BCS path may not, which is why the scheme survives the parse failure.

**Who signed is per-transaction; the committee is not.** The bitmap is the only
thing that varies, and reading one transaction cannot interpret it. Measured on
a mainnet 4-of-7: 8 transactions, 3 distinct signer sets, and 2 of 7 keys had
never signed. So `signed_source_tx` is named for the transaction it came from,
`get_transaction` reports `authorization` for a specific transaction, and
`analyze_multisig` (`src/utils/signer-history.ts`, pure) answers the
wallet-level question. Every dormancy claim is stated against the transaction
count it rests on — "never signed" over 8 and over 200 are different claims —
and under two transactions it refuses to read a pattern at all.

**Finding them.** Multisig is rare: 2 in 79,052 signatures sampled at random on
mainnet, both from one wallet. Random checkpoint sampling is the wrong
instrument. They live where admin authority does — 3 of 353 `UpgradeCap` owners
(0.85%, ~340x), which is how the test fixtures were found.

**Cost.** Authentication is one GraphQL call per 20 addresses — `transactions`
has no multi-get, so it batches with aliases and hits the same two service
limits as package lineage (20 store-backed queries, 5000 bytes of query text).
`describeAddresses` takes `{ authentication, expandMembers }`; every
investigation flow turns expansion on, and a sub-20-address hop set pays one
extra call.

**zkLogin** rides the same code path. The address derives from
`(iss, addressSeed)` and **both** derivations exist on chain (padded and
unpadded seed), so both are tried. It discloses the OAuth issuer and nothing
else: the seed is `poseidon(sub, aud, salt)`, one-to-one with the address, so
it cannot link a person's wallets — a different app means a different `aud`,
hence a different address. It can only confirm a guess formed elsewhere.

**Reverse search.** `find_shared_multisig` derives every committee a set of
known keys could form and checks which exist. A hit is proof, not a match.
Member order is hashed, so the space is factorial — 4 keys is 192 candidates, 5
is 1,560, 6 is refused. Refusing beats truncating: the question is a negative
and a partial search cannot support one. Weight-1 only, because weights are
unbounded; a nil result means "no equal-weight multisig of these exact keys".
Existence is tested with `affectedAddress`, not `sentAddress` — a treasury that
only ever received is exactly the case this is for.

### Wallet clustering

`build_wallet_edges` (`src/tools/cluster.ts`) finds addresses that may share an
operator with the seeds. Pure logic in `src/utils/wallet-edges.ts`, network work
in `src/utils/edge-probe.ts`.

Edges are facts and carry the digests to check them. Clusters are an inference,
tagged `heuristic` — the only heuristic-tier output in the server. The response
keeps the two apart.

**Why it needs no warehouse.** A popularity check needs a bound, not a count:
51 recipients or 51,000 gives the same verdict, so `probeRecipients` fetches
`limit + 1` and stops. That same probe returns who the funder paid, so it also
generates candidates. Popular means discard; narrow means at most `limit`
candidates, all eligible.

| Signal | Weight | Basis |
|---|---|---|
| `co_signer` | 1.5 | A key that can spend the wallet ALONE (`weight >= threshold`), read from the address hash |
| `co_signer` (cannot spend alone) | 0.6 | On the committee but needs others — below the merge floor |
| `cofunded` | 1.0 | Same first funder, funder passed the popularity check |
| `cofunded` (same tx, ≤3 paid) | 1.2 | Bespoke payout — built for these addresses |
| `cofunded` (same tx, ≥10 paid) | 0.8 | Batch payout — list membership, needs corroboration |
| `funding_edge` | 1.0 | One address first-funded the other, and is a seed or passed the popularity check |
| `reciprocal` | 1.0 | Value moved BOTH ways, counterparty passed the popularity check |
| `sponsor` | 0.7 | Same gas payer |
| `co_tx` | 0.5 | A third party moved both balances in one transaction |

Pairs funded by the *same transaction* are weighted by how many that
transaction paid, reusing `assessCoFunding` so this tool and
`find_funding_sources` cannot disagree about what a batch is worth. A wide batch
sits just under the 1.0 merge threshold: `assessCoFunding` calls it "no stronger
than shared funding", so it is not dismissed, it just cannot assert a cluster
alone. Separate transactions from one funder keep the default — each address was
funded deliberately. Measured: one mainnet seed's cluster went from 17 members
to 6 once list membership stopped scoring like deliberate funding.

Four rules that are easy to get wrong:

- **ONE-DIRECTIONAL transfer volume is not a signal, but reciprocal flow is.**
  Balance changes include the sender, so counting every party made "A paid B" an
  edge — the commonest relationship on chain. `co_tx` excludes the sender for
  that reason. Value coming *back* is a different claim: measured on mainnet, 1
  of 47 counterparty relationships of ordinary active wallets was reciprocal, a
  2.1% base rate, against 4 of 6 pairs among four addresses known to share an
  owner. Roughly 32x enrichment, which is why `reciprocal` is weighted level
  with a shared narrow funder.
- **The return leg is asked of the counterparty, not scanned for.** A seed's
  bounded window usually shows one direction only, because the return can sit
  hundreds of transactions back. `probeRecipients` already returns who a
  counterparty paid while measuring whether it is a service, so one probe
  answers both questions. Scanning the seed deeper instead costs queries
  linearly and still misses older legs.
- **Being paid is not being funded.** An expansion candidate becomes `cofunded`
  only after computing its own first funder. Sponsorship needs no such check —
  the probe observed it directly.
- **A narrow funder belongs in the cluster it funded.** `funding_edge` fires
  for any funder that is a seed *or* cleared the popularity filter — not only
  between two seeds. Restricting it to seeds makes the answer depend on what
  the caller already knew: the same chain data yields the edge when both
  addresses are passed as seeds and not when only one is, because the hub gets
  used as a `via` label and then discarded from its own cluster. Measured on
  one seed: 4 members resting on a single invisible intermediary, against 5
  with two independent bases.
- **Narrow and popular are not symmetric.** Popular is proven by what was seen.
  Narrow off an incomplete scan is provisional, because the probe reads recent
  activity while the fundings it filters are historical. `used_intermediaries`
  carries `scan_complete`. The same rule governs `sponsor_shape` in
  `measureFanout`: `relayer` is proven, `private_sponsor` off a truncated scan
  only means "not far enough" and carries `sponsor_shape_provisional`. Measured
  on one mainnet sponsor, the distinct-payee count went 1 to 86 between a 100-
  and an 800-transaction window, crossing the threshold.
- **Expansion links members to seeds in a star**, never member to member. Same
  components, far less output: a 50-member sponsor would otherwise emit 1,225
  edges that cannot merge on their own weight.
- **Co-signature is not behavioural, and it is the only signal here that
  isn't.** Every other one says two addresses did something co-controlled
  wallets tend to do, measured against a base rate; `co_signer` says the
  committee hashes to the address and this key is in it. So clusters built only
  from full-weight co-signature are tagged `chain-derived` and the tier moved
  from a blanket top-level field onto each cluster. Weakest link: a component
  that needed one behavioural edge is `heuristic` however strong the rest looks.
- **A committee is evidence its members are SEPARATE parties.** That is what a
  4-of-7 treasury is for. So co-signer edges run member↔multisig in a star and
  never member↔member, and a member who cannot spend alone sits below the merge
  floor — reported as a lead, unable to cluster alone. Verified: the 4-of-7 and
  2-of-3 seeds produce no co-signer merges at all.
- **A co-signing key can be a service, and the filter is not optional.** A
  wallet provider's recovery key sits on one 1-of-2 committee per customer, so
  without a popularity filter the star links every customer of that provider
  into one cluster. Measured on mainnet: one key on 31 committees produced a
  63-member cluster of unrelated people; with the filter, 31 two-member
  clusters. `DEFAULT_CO_SIGNER_LIMIT` is 5 rather than the funder limit of 50,
  because a narrow funder legitimately pays dozens while a key on dozens of
  committees is a service by construction. The count comes from committees
  already read, so it costs no queries, and it is a lower bound over what was
  examined — which only makes the filter fire late, never early. Excluded keys
  go in `excluded_co_signers` rather than being dropped: "this key can spend 31
  wallets" is itself chain-derived.
- **An edge count is not corroboration.** Sixteen edges through one shared
  funder is one fact stated sixteen times, and if that funder turns out to be a
  payout service they all fall together. Clusters carry
  `independent_intermediaries`, and one resting on a single intermediary cannot
  be rated `high` however strong its edges look.

The default merge rule is `minSignalTypes: 1`, `minWeight: 1.0`, looser than the
batch pipeline it borrows from. Measured: against four addresses known to share
an owner, the batch rule (2 types, weight 1.5) merged none of them, because
personal alt-wallets share one mechanism. Both settings are pinned in
`test/wallet-edges.test.ts`.

Nothing calls this automatically. A heuristic must not change where a
chain-derived trace stops.

### Activity hours, and what they actually detect

`build_timeline` takes `activity_hours`; `src/utils/activity-hours.ts` is pure.

**Circular statistics, not a quiet-window scan.** Hours are points on a circle,
so this takes the count-weighted circular mean (the peak) and the resultant
length R — 0 for evenly spread, 1 for one hour — which doubles as the
confidence. A linear scan for the quietest run treats hour 23 and hour 0 as
opposite ends and has no natural confidence measure. The approach, the local
16:00 anchor and the deliberately wide region bands come from a production
implementation of the same idea; the improvement here is weighting by real
counts, where that version consumed a ranking with no counts and said so.

**It is mostly a bot detector.** Measured on 20 sampled active senders:

- 17 did 400 transactions inside a single day. No daily rhythm exists to read.
- The 3 spanning a week or more all came back flat, R 0.03-0.06 over ~298 days.
- So every wallet that could produce an answer produced "automated".

Two routes to that verdict, catching different populations:

- `always_on` — flat clock over a long span, **at 3+ transactions a day**. R
  below 0.35.
- rate — more than 200 transactions a day sustained. A burst has no rhythm to
  read and would otherwise be dismissed as "not enough data" when it is the
  clearest automation signal available.

**Flatness needs a rate to mean anything.** A wallet doing 0.4 transactions a
day over 292 days cannot concentrate — 120 points scattered across a year never
form a peak — so a 24/7 script and an occasional person produce the same R, and
a rarely-used wallet reads as automated. Above 3/day, a person keeping ordinary
hours would have left a shape and its absence means something; below it,
nothing follows either way.

**A single hour holding most activity gets the cron caveat.** A person's day
spreads over several hours; 46% inside one hour fits a scheduled job equally
well, and a scheduled job has no timezone at all. Without that note a reader
takes "likely UTC-3" as the only reading available.

**Volume is not the constraint, span is.** Sub-sampling full histories, the
always-on verdict agreed with the full-sample answer 100% of the time at 30-100
transactions, with mean |ΔR| of 0.075 at N=50. Fifty transactions is plenty;
finding a wallet whose activity spans a week is the hard part.

A region is not a city, and the same pattern is produced by two people who
merely share a timezone or a working day. The reading says both.

Computed per address, never merged: two addresses sharing a peak is the
corroborating observation, and merging destroys it.

Not wired into clustering. That would need it to separate real pairs from a
control group first.

### First-funder cache

`first_funders` in the store. A wallet's first funding cannot change once it
happens, so there is no TTL. Only positives are written — "no funder yet" goes
stale the moment the address is funded. Stamped with `FUNDING_METHOD_VERSION`,
because the answer depends on the dust floors in `pickFundingTx`. Repeat builds
went 24 queries to 18 with identical output.

### Account identity

Anything **stored or reported** carries a chain-qualified account id, not a
bare address. `src/utils/chain-id.ts` owns this: CAIP-2 chains (`sui:mainnet`,
`eip155:1`) and CAIP-10 accounts (`sui:mainnet:0x…`), with per-chain address
normalization.

Normalization is per-namespace and the differences are load-bearing — the Sui
rule is *wrong* elsewhere. Left-padding a 20-byte EVM address to 32 bytes
invents an address belonging to nobody, and lowercasing a Solana address
destroys base58, which is case-significant. An unknown chain is rejected rather
than passed through, so an unnormalized id never reaches storage where it would
fail to match its own canonical form.

Sui-scoped callers (traces, balances, fan-out) still pass bare `0x…` strings.
The boundary resolves them with `currentSuiAccount()`, which qualifies against
whichever network `runWithNetwork` selected for that call. So do not thread a
chain parameter through tool handlers — qualify at the point of storage.

**Curated data keyed by a PACKAGE ID is mainnet-only.** A package ID is derived
from its publish transaction, so the same ID on another network is a different
package or none at all. `coins.json`, `protocols.json`, `protocol-roots.json`
and `nft-collections.json` are all package-keyed, and consulting them off
mainnet got both answers wrong: it vouched for mainnet's USDC type on testnet
where that type does not exist, and refused to vouch for the real testnet USDC
at `0xa1ec7fc0…::usdc::USDC`. Off mainnet the answer is `not-curated-here` —
neither a claim nor a denial, because marking a legitimate testnet asset the
way an impersonation token is marked is its own false statement.

That is precisely why the asymmetry below is *not* a contradiction: addresses
are KEY-derived, so one entity can legitimately hold the same address on
several networks. Package IDs cannot.

Label scoping has one deliberate asymmetry:

- **Session and override labels** are keyed on the exact CAIP-10 account. A
  label added on one chain must not terminate a trace on another.
- **Curated entries keyed by a bare address** (`src/data/labeled-addresses.json`)
  apply across every *Sui* network — they are knowledge about an entity, not
  about a network — but never match a non-Sui chain that shares the string. A
  curated entry may name an explicit CAIP-10 key to scope itself to one chain.

`getLabel` returns null on an unparseable reference instead of throwing; it runs
inside trace loops over off-chain-sourced addresses, and one malformed
counterparty must not abort an investigation. `addSessionLabel` *does* throw —
that is a caller asserting an identity, and a mangled key would never match.

Store migration is by column list, not a version stamp (see `store.ts`): labels
are hand-built attribution and are migrated, never dropped. Pre-1.7.0 rows
backfill to `sui:mainnet`, which is an assumption the code documents — there is
no evidence in a legacy row to do better.

### Cross-chain (bridge) resolution

`bridge` is a sink category, so a fund trace stops at Wormhole — exactly where
attribution becomes possible. `resolve_bridge_transfer`
(`src/tools/bridge.ts`) is the seam that lets it continue.

The join is an **identifier match, not a heuristic**. A Wormhole message is
identified by `(emitterChain, emitterAddress, sequence)`; Sui emits it as a
`publish_message::WormholeMessage` event whose `sender` is the emitter cap
object ID, and the destination chain quotes the same triple back. Verified on
mainnet: event `sender`/`sequence` equal Wormholescan's VAA id exactly.

Every result carries an `EvidenceTier`, and the distinction must survive into
any report:

- `chain-derived` — the VAA identity, read from Sui. Trusts nobody.
- `indexer-attested` — the destination transaction. Sui cannot know whether a
  VAA was redeemed or where, so this necessarily comes from Wormholescan. It is
  a strong lead to confirm on the destination chain, not something this server
  verified.
- `heuristic` — amount/time/asset matching. **Not produced.** Named so nothing
  silently promotes a lead to a finding.

Notes for extending it:

- The event is matched by **type suffix**, not full type. The core bridge
  package ID changes on upgrade, and pinning it would silently stop finding
  messages — the same failure the registry's lineage tier avoids.
- Wormhole chain numbers are their own namespace (Sui is 21), mapped to CAIP-2
  in `src/utils/bridge/wormhole.ts`. The map is deliberately partial: an
  unmapped chain is reported by number, never guessed, since a wrong chain id
  files an address under the wrong chain.
- That map is **mainnet-only** — Wormhole reuses its chain numbers across
  environments, so off mainnet chain 2 is Sepolia, not Ethereum. The tool
  withholds the CAIP-2 claim off mainnet and reports the Wormhole number alone.
- Wormholescan runs a **separate index per environment** and has none for
  devnet. Never fall back to the mainnet index: an empty result there reads as
  "never redeemed" rather than "not indexed here".
- The destination is looked up by source transaction first, then by the VAA
  triple for anything still unresolved. The triple is read from chain data and
  is what the guardians sign, so it is the more reliable key; the second
  request is only spent when the first misses.
- Wormholescan populates `targetChain` and `standarizedProperties`
  independently — a real mainnet transfer had a complete `targetChain` beside
  an all-zero `standarizedProperties`. Neither may be used to infer the other
  is absent.
- Event field JSON comes from **GraphQL**, not gRPC: the gRPC `Event` has no
  parsed JSON. This is the documented exception to "point lookup by key uses
  gRPC".
- CEX remains a true sink. A deposit on Sui and a withdrawal elsewhere cannot
  be linked from chain data; that is a subpoena, not a query.
### Chain-derived destinations: Sui native bridge and CCTP

Two of the three resolvers need **no indexer for the destination** — the
destination chain and recipient are in the events, so the far side is
`chain-derived`. Wormhole cannot do this: a VAA names an emitter and a
sequence, never a recipient, which is why its destination is
`indexer-attested`. Prefer these when both are present in one transaction.

Each has its own chain numbering, none of them CAIP-2:

| Protocol | Identity | Numbering | Verified |
|---|---|---|---|
| Sui native (`0xb`) | `(source_chain, seq_num)` | 0 = Sui, 10 = Ethereum | tx `4xLuY6N6…` |
| Circle CCTP | `(source_domain, nonce)` | Circle domains; 8 = Sui, 3 = Arbitrum | tx `4rDEyqGe…` |
| Wormhole | `(emitterChain, emitter, sequence)` | Wormhole chain ids; 21 = Sui | tx `7g4nQFx…` |

All three numberings are **reused across environments**, so a CAIP-2 claim
derived from any of them is withheld off mainnet (`qualify`).

CCTP specifics: `DepositForBurn` carries `destination_domain` and a 32-byte
`mint_recipient`; the paired `send_message::MessageSent` carries the raw
message whose header is `version(4) ‖ sourceDomain(4) ‖ destDomain(4) ‖
nonce(8)` big-endian. Un-padding the recipient is only unambiguous once the
destination is known — 12 zero bytes then 20 for EVM, all 32 for Sui, base58
over 32 for Solana — and a value whose "padding" is not zero is refused rather
than trimmed into an address that is not the recipient. The nonce is carried as
a string because it is a u64.

Circle's attestation API is deliberately **not** called: an attestation says
Circle signed the message, not that anyone claimed it, so it would add a
third-party dependency for weaker information than the events already give.

### Sui's native bridge (`0xb`)

The strongest cross-chain evidence in the server, and the only case needing no
third party for the destination: the outbound `bridge::TokenDepositedEvent`
carries `target_chain` and `target_address` as raw bytes, so the far side is
**chain-derived**. Wormhole cannot do this — a VAA names an emitter and a
sequence, not a recipient — which is why its destination is indexer-attested.

`(source_chain, seq_num)` is the bridge's transfer id, quoted back by Ethereum
on claim. Sui ↔ Ethereum only; `chain_ids` declares no other route.

Two traps:

- `TokenTransferClaimed` is **inbound** — value arriving on Sui. Reporting it as
  an exit sends an investigator to the wrong chain, so it is parsed by
  `parseClaimEvent` into its own `NativeBridgeClaim` type rather than sharing
  one with the outbound transfer. It still resolves: the claim quotes the origin
  chain's `(source_chain, seq_num)`, which is the mirror of an outbound
  `transfer_id`, so a trace running backwards picks the transfer up on the
  origin chain instead of dead-ending.
- Address fields are raw bytes (base64 over GraphQL). 20 bytes is EVM, 32 is
  Sui; any other length is left undecoded rather than padded into something
  address-shaped that belongs to nobody.

Only bridge chain ids observed on mainnet (0 = Sui, 10 = Ethereum) map to
CAIP-2. Testnet/custom variants are reported by number, same non-guessing rule
as Wormhole.

### Holder scans rank a sample, not the chain

`scanTokenTopHolders` walks `objects(filter: Coin<T>)` in **object-id order**,
which is uncorrelated with balance. A scan that hits `maxScan` therefore returns
the largest holder it SAW. Measured on SUI: top holder 66 SUI at `max_scan` 200,
522 at 400, 3,454 at 800, 25,000 at 5,000, with zero of the top five surviving
from 200 to 800 — while the real top holder holds millions. The answer climbs
with effort and never converges.

So a truncated scan returns `sampled_holders` with no rank and no percentage of
supply, plus a caveat; only a completed scan returns `top_holders` and
`complete_ranking: true`. `analyze_token` makes the same split. A sampled
balance over the real total supply looks authoritative and means nothing, which
is why the percentage is dropped rather than annotated.

This follows `find_shared_multisig`: refusing beats truncating, because a
partial search cannot support the claim the caller is asking for.

Both walks were also missed by the null-cursor sweep in #101 — a null
`endCursor` with `hasNextPage: true` restarted them from page one and added the
same balances twice. Ten other walks carried the guard; these did not.

### Store writes must fail soft

The store is a cache and a notebook beside a read-only server, so a write that
fails must never fail the read that produced it. Every writer goes through
`tryWrite`, returns a falsy value on failure, and reports to **stderr** —
stdout is the MCP transport.

This is not hypothetical. An older server process writing into a database a
newer build had migrated failed with `NOT NULL constraint failed:
fanout.sponsored_address_count`, and that took down `get_address_fanout`
entirely rather than returning the fan-out it had just measured. Process and
schema drift apart whenever the server is left running across a rebuild, which
is the normal case during development.

`saveTransaction` had the guard from the start for exactly this reason; the
other eight writers did not. When adding a writer, add the guard.

Do NOT "fix" this by giving the sponsorship columns a DEFAULT. A cached row
reporting 0 there would be claiming "not a sponsor" from data it never read,
which is the failure the column comment already warns about.

### Watching an investigation, without drowning the agent

`watch_addresses` / `poll_watch`, pure logic in `src/utils/watch.ts`, network in
`watch-probe.ts`. The constraint is arithmetic, and it decides the architecture:

Mainnet runs 4.25 checkpoints and ~74 transactions a second. Subscribing to the
checkpoint stream is **1.1 GB/hour, about 323 million tokens an hour** — a 200k
context fills in 2.2 seconds. Streaming chain data to a model is not expensive,
it is impossible. The same measurement gives the way out: only **160 distinct
addresses** were touched in those 30 seconds, so against a watch set of twenty
the signal is roughly one part in a million.

- **Poll, do not stream.** `afterCheckpoint` on the `transactions` filter is
  EXCLUSIVE — verified on a wallet dead since January: after its last
  checkpoint returns nothing, after the one before returns exactly one. So the
  high-water checkpoint per address gives a delta with no gaps or duplicates,
  at ~60 requests an hour against 1.1 GB. The latency traded away is latency
  nobody consumes. Streaming wins past roughly fifty watched addresses, where
  polling's per-address cost overtakes the stream's flat one.
- **Native gRPC `subscribeCheckpoints` works on the public fullnode** if that
  day comes. The gRPC-Web transport this server uses CANNOT do it (the call
  fails at `fetch`), and the archive answers UNIMPLEMENTED.
- **Two phases, forced by the service.** Measured: 20 aliases of digest +
  checkpoint is 3,917 bytes and accepted; 30 is 5,877 and rejected on the
  5,000-byte cap; 20 aliases WITH balance changes breaks the separate
  300-node limit. So the delta query carries a minimal selection and detail is
  a second fetch made only for digests that moved. That is also why a quiet
  poll costs 13 tokens and one request.
- **A new watch starts at the current checkpoint**, never zero. Seeding at zero
  replays the wallet's whole history into the context on the first poll, which
  is the cost the tool exists to avoid.
- **The cursor advances even when a trigger suppressed every hit.** A filtered
  transaction has still been seen; leaving the cursor behind re-reads it on
  every poll forever.
- **A full page means more happened than was reported.** Measured on a mainnet
  address doing a transaction every two seconds: it fills the cap on every
  poll. `more_pending` says so — a permanently lagging watch that reads as
  complete is the same failure class as everything else in this file.
- **`min_amount` filters VALUE only.** A labelled sink, a capability handover
  or any object move has no amount to measure, so a floor must never suppress
  one.
- **Detail reads object changes, not just balances.** A capability changes
  hands WITHOUT a balance change, which is the transfer most worth waking
  someone for. `affectedAddress` does return those transactions — verified on a
  real UpgradeCap handover, which appears in both parties' histories — so the
  watch already fired on them and only needed to say WHAT moved. Batch is 5
  digests, not 20: object changes are many nodes each and the 300-node limit
  binds long before the byte cap (8 digests = 4,767 bytes, rejected).
- **`flagLookalikes` costs no request.** The watch set and this poll's
  counterparties are already in hand. It fires only when a NEW counterparty
  resembles a WATCHED address — two watched addresses resembling each other is
  a fact about the set, not an event.
- **Every `HitReason` must actually be emitted.** The first version declared
  `capability_moved` and `lookalike_appeared` in the type and produced neither,
  which advertises detection that does not happen.

**Nothing triggers a watch except `poll_watch`.** There is no timer, no push and
no background process; the tool is cheap enough to call on a loop, which is not
the same as monitoring. Say so rather than implying otherwise.

### Address poisoning

`address-lookalike.ts` reports two addresses close enough to be mistaken for
one another. Four rules:

- **Normalize before looking activity up.** The ledger is keyed by the strings
  the chain returned; the subject is whatever the caller typed, and the
  GraphQL API accepts uppercase and unpadded short forms. Keying on the raw
  string lost the subject's own footprint, so it scored zero and the VICTIM was
  named the impostor. Reported addresses are emitted canonical so they match
  themselves in `save_finding` and `export_case`.
- **Direction needs a real margin** (`DIRECTION_MIN_MARGIN`). Dust repeating
  inside one page is the normal shape of this attack, so a 3-vs-1 count is not
  evidence — on the pinned mainnet case the live margin is 4-vs-1, and five
  dust sends invert it. Below the margin the pair is reported unordered.
- **`received` is only ever compared against ZERO.** Raw units are not
  comparable across coin types — 1 unit of an 18-decimal token outranks 5 SUI —
  which `funding.ts` already learned. What carries signal is "received
  nothing".
- **Do not claim the addresses render identically.** At the 8+8 width this
  module itself renders, a 3+4 pair visibly differs. The true claim is that
  they match at both ends, which defeats a glance and a short truncation.

The rule is a floor of `MIN_PER_END` at each end, and the candidate bucketing
uses the same width. Making the rule asymmetric without changing the bucketing
would put a genuine pair in two buckets and report nothing.

### Object flow: what moves that is not a coin

A balance change is derived from `Coin<T>`, so **anything that is not a coin
moves without producing one.** `trace_funds` reads `objectChanges` for that
reason; do not remove it on the grounds that balance changes already cover
value.

Measured on mainnet, sampling the transaction that last touched each object:
`package::UpgradeCap` 30 of 30 and `package::Publisher` 30 of 30 produced no
non-gas balance change; `coin::TreasuryCap` 14 of 30.

Seven rules, every one of them a bug that shipped to `main` first:

- **The archive DOES report object changes.** Its gRPC `changedObjects`
  carries `objectType`, `inputOwner` and `outputOwner`, and the read mask
  already requests it. Verified against a digest the fullnode has pruned. Do
  not reintroduce a caveat saying otherwise.
- **Framework types are matched in FULL, never by suffix.** A package may name
  its module `package` and its struct `UpgradeCap`; suffix matching hands an
  airdropped fake the loudest output the tool has. The mirror is worse — naming
  a module `coin` and a struct `Coin` would get an object EXCLUDED as "already
  a balance change" while producing none, invisible in both channels.
  `baseType` pads the defining address so `0x2::` and the padded form meet.
- **Custody is not only address-to-address.** A kiosk-held NFT is owned by the
  Kiosk object, so the ordinary NFT trade reads `object -> object`. Measured
  against four real wallets, filtering to address-to-address missed 10 of 28
  genuine transfers, and `ObjectOwner -> ObjectOwner` was 538 of ~1,240 object
  changes in a recent sample. `custodyChanges` is the filter; there is no
  address-only variant.
- **A capability sent somewhere unspendable is RENOUNCED, not handed over.**
  `upgrade-cap.ts` measured 27 of 30 UpgradeCap departures going to `0x0`/`0x2`.
  Reporting those as handovers made the loudest output wrong ~90% of the time
  for the type that motivated the feature. `renounced_capabilities` is a
  separate field and carries the opposite reading.
- **Old effects do not record the input owner.** Before roughly March 2024
  mainnet returns `inputState: null` for EVERY change — 117 of 117 non-created
  changes at checkpoint 20,000,000. Reading that as "unwrapped" and dropping it
  loses every object transfer over the chain's first year, the era a backward
  trace reaches. It is reported as `appeared` with the ambiguity stated.
- **`appeared` is custody ONLY when it lands on a party** — an address, an
  object or a consensus owner. Admitting every `appeared` turned ordinary
  shared-object traffic into custody changes: a live Pyth price update reported
  three oracle objects as having changed hands, and 58 of 59 movements at
  checkpoint 10,000,000 were storage or shared-object churn. With no recorded
  source, a destination that is merely an ownership state carries no claim.
  After this, those checkpoints report 1 movement each, both genuine.
  `dynamic_field::Field` is excluded outright, like `Coin<T>` — it was 49 of
  those 59.
- **A capability can be given up three ways, not one.** Transfer to an
  unspendable address, `public_freeze_object` (→ Immutable) and
  `public_share_object` (→ Shared) all end exclusive control. All three set
  `renounced`; `capabilities.ts` already distinguished these owners.
- **Classify a capability BEFORE a position name.** `POSITION_NAME` is
  unanchored and matches `Account`, `Obligation`, `Receipt`, `Vault` — testing
  it first turned `custodian_v2::AccountCap` and
  `lending_market::ObligationOwnerCap` into positions. The object that controls
  a position is not the position. `0x2` and `0x3` are curated, so every
  framework type reads as protocol-vouched; keep generic words like `Ticket`
  out of `POSITION_NAME` for that reason.
- **`objectChanges` is paginated, not truncated.** About 1 transaction in 400
  exceeds 50, and a real three-hop trace hit one with 101. The connection is
  ordered by object id, not importance, so keeping the first 50 drops a
  capability transfer on a coin flip. `readAllObjectChanges` walks up to
  `OBJECT_CHANGE_PAGES`, tracks `more` and `cursor` SEPARATELY (a connection
  can claim another page and return a null cursor), and states the cap when it
  hits one.
- **Object counterparties go through identity, labels and the poisoning check.**
  Whoever receives a capability is as much a party as whoever receives a coin.
  `address` AND `consensus` owners count — the query fetches the consensus
  address, so dropping it wastes what was already paid for. Unspendable
  addresses are excluded: a burn address is nobody.
- **The transaction cache is stamped with `TX_METHOD_VERSION`.** Chain data in
  a finalized transaction cannot go stale, but the fields DERIVED at fetch time
  can — object movements are classified on the way in. A row written by an
  earlier build carries that build's classification, so reading it back is not
  a cache hit. Bump the stamp whenever anything derived in `fetchTx` changes
  shape or meaning. Same reasoning as `FUNDING_METHOD_VERSION`.

Two exclusions: `Coin<T>` (already a balance change; reporting both
double-counts the case that always worked) and mutations (an object written to
has not changed hands; shared-object traffic is 92% of transactions).

**A DeFi position is not an asset, and the registry is what says so.** A type
named `Position` proves nothing; a type named `Position` DEFINED BY a package
`lookupProtocol` already vouches for is a financial position. Name-matching
alone would be the guessing this project refuses, so `categorize` promotes to
`defi-position` only behind a resolver.

`high_consequence` is only the five framework types whose powers are stateable
(`UpgradeCap`, `TreasuryCap`, `DenyCap`, `DenyCapV2`, `Publisher`). A protocol's
own `AdminCap` is a capability with no claim about what it grants.

Base rate is low and the sampling lesson is the bridge one again: 0 object
transfers between addresses in 700 consecutive mainnet transactions, because
recent traffic is DeFi mutating shared objects. Sample where caps and NFTs
live, not by volume.

### Detecting a bridge exit vs. resolving one

Keep these apart — conflating them is what makes "support every bridge" sound
impossible.

**Detection** (did value leave, through what?) generalizes cheaply and lives in
`src/utils/bridge/detect.ts`. Two tiers:

1. Curated `callMarkers` / `eventMarkers` per protocol, matched by
   `module::function` *suffix and prefix* so they survive package upgrades and
   name variants (mainnet CCTP calls
   `deposit_for_burn_with_caller_with_package_auth`, not the bare name).
2. Any package `lookupProtocol` types as `bridge`. This is free and automatic:
   adding a bridge to `protocols.json` gives detection immediately, and via
   lineage roots it keeps working after that bridge upgrades.

**Resolution** (where did it land?) does *not* generalize — each protocol has
its own identity scheme and its own index — so each resolver is bespoke.
`BridgeProtocol.resolution` records which a protocol has: `identifier` means
followable, `detect-only` means we can name it and no more. Never point a
caller at a resolver that cannot help them; `resolvableHit()` is the guard.

Markers must be **distinctive**, not merely present. A generic name like
`init_order` collides with DEX order books, which emit some of the
highest-frequency events on mainnet — the Mayan markers carry `mctp` instead.
Sample before adding — `node scripts/find-unknown-packages.mjs` ranks by call
count, but note that bridge traffic is low-frequency relative to DEX and oracle
activity, so volume sampling will *not* surface bridges. Probe candidate event
types by name instead.

There is deliberately **no heuristic tier**. Guessing that an unknown package
looks bridge-shaped would manufacture exactly the unverifiable attribution this
project refuses to ship.

Detect from **Move calls, not sink labels.** A bridge burns or locks the coin
and emits a message; it does not transfer value to a labelable recipient
wallet, so `isSink` never fires on a real bridge exit and only one address
label ships at all. `trace_funds` runs `detectBridges` over each hop's calls —
data it already has, no extra query — and emits `bridge_exits`.

## Key Patterns

- `@protobuf-ts` oneof uses `oneofKind` (not `case`)
- SDK `Event` has `eventType` (not `type`), `module`, no `parsedJson`. GraphQL's
  `Event` has neither `type` nor `json` at the top level — both live under
  `contents` (`contents.type.repr`, `contents.json`). Three shapes for one
  concept, which is why `get_transaction` fetches event fields over GraphQL
  (`src/utils/event-json.ts`) even though it reads the transaction over gRPC.
- **Protocols come from events as well as Move calls.** A transaction calling an
  obfuscated wrapper into DeepBook reported `protocols: []` while the registry,
  asked directly, resolved the event's own package by lineage. Event types are
  also harder to fake: a package picks its own name, but the event it emits
  carries the type of whoever defined it. `protocols_from_events_only` marks the
  gap, since a transaction whose calls are unreadable and whose events name a
  known protocol is what a router or wrapper looks like.
- SDK `BalanceChange` has `address` (not `owner`)
- `GrpcTypes` must be imported as value (not `import type`) when using enum values
- GraphQL max page size: 50
- **Guard the cursor on every paginated walk.** A connection can claim
  `hasNextPage: true` and hand back a null `endCursor`; assigning it sends the
  walk back to page one. `for(;;)` loops then never return, and loops bounded by
  a page counter or a collection target return duplicates that skew whatever
  they feed — signer-set frequencies, event rankings, denied-address lists. The
  idiom is `if (!cursor) break;` immediately after the assignment.
- Build copies `src/data/` to `dist/data/` — JSON files must exist in dist at runtime
- Chain-qualify anything persisted or reported; bare addresses are Sui-only and
  ambiguous the moment a second chain enters a case
