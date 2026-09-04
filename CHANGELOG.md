# Changelog

## 1.10.0 (2026-09-04)

A minor rather than a patch release: alongside the fixes there is new
capability — historical SuiNS name recovery, address classification in every
investigation flow — and shipping that under a patch bump would leave it
unread.

The fixes came from running 1.9.0 against real transactions rather than reading
its output. Three things looked right and were not.

### Fixed
- **`get_transaction` returned event types with no values.** The gRPC `Event`
  carries `eventType`, `module` and BCS but no decoded JSON, so the tool could
  report that an `order_info::OrderPlaced` fired and not what was ordered.
  Decoded fields now come from GraphQL — the same exception the bridge resolvers
  already rely on — joined by position and guarded on length, because attaching
  fields from a mismatched list would file one event's values under another's
  type.

  Worth knowing if you ever query this by hand: the GraphQL `Event` has neither
  `type` nor `json` at its top level. Both sit under `contents`. That is three
  different shapes for one concept across gRPC, GraphQL and this server's
  output.

- **Protocols ignored the events entirely.** A transaction calling an obfuscated
  wrapper (`h86261::h8b64d`) and emitting twelve DeepBook events reported
  `protocols: []`, while the registry — asked directly about the event's own
  package — resolves it to DeepBook by upgrade lineage. Nobody asked it.

  That ran the wrong way round for investigation work: hashed module names are
  what a bot or a laundering route looks like, so the transactions most worth
  naming were the ones going unnamed. An event type is also harder to fake, since
  a wrapper picks its own name but carries the type of whoever defined the event.
  Protocols are now the union of both sources, and `protocols_from_events_only`
  reports the discrepancy rather than merging it away quietly.

- **Historical SuiNS names were lost.** Reverse lookup answers a narrower
  question than it appears to — what is the *current default* name — and returns
  nothing once a name lapses, so a wallet's former aliases vanished from an
  investigation. The `SuinsRegistration` object outlives expiry, so held
  registrations are now read directly and expired ones flagged. On one wallet
  reverse lookup gave a single name while the registrations gave ten, six of
  them expired. An expired name is still attribution: the address was known by
  it at the time of the activity being investigated.

- **Quoted numbers failed the whole call.** A model composing JSON will sometimes
  send `max_hops: "8"`, and strict validation rejected it for something whose
  intent was never ambiguous. Every numeric and boolean argument now accepts its
  string form. The advertised JSON schema is byte-identical, so no client sees a
  looser contract, and `"abc"` is still rejected. Booleans deliberately do not
  use `z.coerce.boolean()`, which applies JavaScript truthiness and would turn
  `"false"` into `true`.

### Added
- **What an address is**, in every investigation flow. A hop that is a package or
  a shared object is not "someone the funds went to", and nothing in a trace said
  so. `trace_funds`, both funding tools and `build_wallet_edges` now report the
  kind, the protocol where a package is known, and the names an address holds.
  Two batched calls for a whole result set. `identify_address` remains the
  thorough single-address tool at roughly five requests each.

- **`max_event_field_bytes`** on `get_transaction`, unset by default. Every event
  comes back with its fields; bounding the payload is the caller's decision, and
  when they make it the response says plainly that it is not the complete event
  data.

### Changed
- Tool descriptions now say what they replace. Two of the fixes above exist
  because GraphQL was hand-written for something a tool already did, so
  `query_events` and `analyze_package` now name the shapes that trip people up,
  and `get_balance` says what it does not count — staked SUI and DeFi positions
  are invisible to it.

## 1.9.0 (2026-09-04)

One new tool (60 → 61) and a round of correctness work on fund tracing.

Most of this release came from asking a narrower question than "does it work":
*where does this produce a confident answer that is wrong?* Several of the fixes
below are cases where a trace or an attribution completed successfully and named
the wrong party, which is worse than an error — an error gets investigated.

### Added
- **`build_wallet_edges`** — find addresses that may share an operator with the
  ones you give it, built live with no analytics warehouse behind it.

  The usual objection to on-demand clustering is that deciding whether a funder
  is an exchange means enumerating its tens of thousands of recipients. It does
  not: the count is never needed, only the bound. The probe fetches
  `limit + 1` distinct counterparties and stops, and the same probe returns who
  that funder paid, so it doubles as candidate generation. Popular means discard
  and spend nothing more; narrow means at most `limit` candidates.

  Four signals — a shared first funder, one address first-funding another, a
  shared gas payer, and a third party moving both balances in one transaction.
  Plain transfer volume is deliberately not among them: everyone pays an
  exchange, so "A sent to B" clusters the world together.

  Edges are reported as facts with the digests to check them; clusters are an
  inference, tagged `heuristic` — the only heuristic-tier output in the server.
  Nothing calls it automatically, because a heuristic must not change where a
  chain-derived trace stops.

- **Transaction cache** (`SUI_STORE_PATH`). Only the transaction reads are
  cached, never a trace's conclusion. A finalized transaction is immutable, so
  there is no TTL to get wrong; a conclusion depends on the label set and on how
  far the chain has grown, both of which move. Measured: little on recent hops,
  but an archive hop goes 0.56s to 0.14s — and those are the hops least likely
  to ever get cheaper. `hops_from_cache` and `hops_served_by_archive` are
  reported so a fast trace reads as reuse rather than as a different chain read.

- **First-funder cache.** A wallet's first funding cannot change once it
  happens, so no TTL. Only positives are stored, since "no funder yet" goes
  stale the moment the address is funded.

- **CoinMarketCap** as an optional price source (`CMC_API_KEY`).

### Fixed
- **`trace_funds` followed the wrong party.** The forward hop asked for the next
  transaction *affecting* an address, which includes anyone paying it — so a
  third party's transaction could be attributed to the subject. It now filters
  on `sentAddress`. Two more bugs lived in the same query: `afterCheckpoint` is
  exclusive, so passing the hop's own checkpoint skipped every same-checkpoint
  spend (what a script does — the adversarial case, not an edge case), and
  asking for a single candidate let the current transaction crowd out the
  answer.

- **The archive fallback was dropped** on the belief that archives omit balance
  changes. They do not, verified on mainnet, so historical hops were failing for
  no reason. Also: GraphQL answers a pruned digest with a *hollow* record rather
  than null — digest and timestamp present, no sender, no balance changes — so a
  trace ended early looking complete. That shape is now treated as absent.

- **Dust and scam tokens counted as funding.** A 1-MIST spam send could become
  "first funded by", and the walk then followed the spammer's ancestry. Inflows
  now need to clear 0.01 SUI, or $0.10 for a priced non-SUI coin. The stronger
  rule is not a threshold: an inflow in a coin nobody prices is spam at any
  size. Skipped inflows are reported as `dust_skipped`, never dropped silently.

- **The gas sponsor was named as the funder.** Gas folds into the payer's net
  SUI rather than being itemised, so the most-negative change across all coins
  picked the sponsor: -0.036 SUI outranks a real sender's -11 USDC on raw
  magnitude, because SUI has three more decimals. The funder is now sought in
  the coin that actually arrived. The same decimals bug was fixed in two other
  places.

- **Co-funding reported the weakest evidence and dropped the strongest.** Groups
  were truncated to the first ten while sorted widest-payout-first, so a
  bespoke payment to exactly the two addresses under investigation sorted last
  and was cut.

- **A failed object lookup was reported as a wallet.** "Could not look" and
  "nothing there" are opposite conclusions.

- **Validator lookups never worked** — mainnet has more than one page of
  validators and the query took the first page only.

- **The top-holders cache ignored result size and network**, so a request for
  100 holders could be served a cached 10, and mainnet could answer a testnet
  query.

- **Resolving one coin symbol crawled the whole registry.**

### Changed
- **Pyth is now opt-in** (`PYTH_API_KEY`) rather than the default path. Its
  Hermes endpoint began requiring authentication for price *values*, and every
  call site handled that softly — prices simply became null, which reads as "no
  value" rather than "no access". Aftermath is the free default and covers
  current prices; historical pricing needs a paid key and now says so rather
  than returning a null a caller might read as zero.

- **Test doubles now refuse to answer shapes the real services never send.**
  Three shipped bugs had survived because a mock returned a page larger than
  GraphQL's 50-item cap, or an empty response where gRPC throws `NOT_FOUND`.

## 1.8.0 (2026-09-03)

Inbound bridge transfers now resolve to their origin.

1.7.0 detected an inbound claim and correctly refused to read it as an exit —
that guard matters, since following an entry forward sends an investigator to
the wrong chain. But it stopped at a count, and everything needed to resolve the
origin was already in the event it had read.

### Added
- **Inbound bridge resolution.** A native-bridge claim now reports the origin
  chain, its CAIP-2 id and the transfer id — `10/32597` from Ethereum — marked
  `chain-derived`, since all of it comes from the claim event. This is the
  mirror of the outbound `transfer_id`, so a trace running backwards can pick
  the transfer up on the origin chain instead of dead-ending.

  `NativeBridgeClaim` is deliberately a separate type from
  `NativeBridgeTransfer`: the two carry the same shape of identity pointing in
  opposite directions, and one type would make rendering an entry as an exit a
  plausible mistake.

  Off mainnet the CAIP-2 origin is withheld, the same rule the outbound side
  follows — the bridge reuses its chain numbers across environments. The
  bridge's own chain number is still reported, so the origin is never lost.

## 1.7.0 (2026-09-03)

One new tool (59 → 60) and the identity change that makes cross-chain work
possible at all.

A fund trace used to stop at a bridge — which is exactly where attribution
becomes possible, and exactly why attackers bridge. Following value past that
point needs two things this release adds: a way to say *which chain* an address
is on, and a way to recognise a bridge exit and read the transfer's identity off
the chain.

### Added
- **`resolve_bridge_transfer`** — follow funds across a bridge. Returns the
  transfer identity read from chain data and, where it can be established, the
  destination chain and account. Results are tiered by evidence and the tiers
  are the point: `chain-derived` trusts nobody, `indexer-attested` is a lead to
  confirm on the destination chain, and `heuristic` is defined but never
  produced, so amount-matching can never quietly become a finding.

  Three protocols resolve today. **Sui's native bridge** and **Circle CCTP**
  both carry the destination in their events, so their far side is
  chain-derived with no third party involved. **Wormhole** cannot — a VAA names
  an emitter and a sequence, never a recipient — so its destination comes from
  Wormholescan and is labelled as such. **Mayan MCTP** is detected and named but
  routes over the others, which are what you follow.

- **Chain-qualified account identity** (CAIP-2 / CAIP-10). Anything stored or
  reported now carries the chain it belongs to: `sui:mainnet:0x…`,
  `eip155:1:0x…`. Normalization is per-chain because the Sui rule is wrong
  elsewhere — padding a 20-byte EVM address to 32 invents an address belonging
  to nobody, and lowercasing a Solana address destroys base58. An unknown chain
  is rejected rather than passed through.

- **Bridge-exit detection in `trace_funds`.** A trace that reaches a bridge now
  says so and names the digest to hand to `resolve_bridge_transfer`, instead of
  ending silently — which read as "the money stopped here" when it had left the
  chain. Detection generalizes: any package typed `bridge` in `protocols.json`
  is recognised with no per-protocol work.

- **Protocol identification by upgrade lineage.** A package upgrade mints a new
  ID, so the curated exact-ID registry went stale on every upgrade — silently,
  with no error. `protocol-roots.json` keys protocols on their lineage root,
  which is stable across every version they will ever publish. Generated by
  `npm run sync:protocol-roots`, which refuses to write when two curated entries
  in one lineage disagree.

### Changed
- **`manage_labels action='export'` emits CAIP-10 accounts, not bare
  addresses.** Scripts parsing that output will see a different shape. This was
  a correctness fix, not cosmetics: exporting bare and re-importing resolved the
  address against whichever network the import ran on, so an Ethereum label
  round-tripped into a zero-padded Sui account. Because `bridge` and `cex` are
  sink categories, that phantom would silently terminate later Sui traces at an
  address belonging to nobody.
- **Labels are chain-scoped.** A session label added while querying one chain no
  longer applies on another. Curated entries keyed by a bare address still apply
  across every Sui network, since they describe entities rather than networks.
- Registry keys are normalized on load, so curated entries written short (`0x2`,
  `0x3`, `0xdee9`) match the padded form the chain reports. The exact-match tier
  was missing the system packages entirely.

### Fixed
- Mainnet and testnet fan-out measurements of the same address no longer share a
  cache row. They are different accounts with genuinely different counterparty
  counts.

### Migration
Automatic and one-way, on first open of an existing `SUI_STORE_PATH`:

- **Labels are migrated, never dropped** — they are hand-built attribution and
  they decide where traces stop. Pre-1.7.0 rows backfill to `sui:mainnet`, an
  assumption stated outright since nothing in a legacy row can settle it. The
  migration runs in a transaction and rolls back to the legacy shape on failure,
  so a store that cannot migrate switches off with a reason rather than losing
  rows.
- **Findings** have their addresses qualified in place.
- **The fan-out cache is discarded**, being derived data. The cost is one
  re-measurement.

## 1.6.0 (2026-08-09)

Four new tools and richer output from `find_funding_sources` (53 → 59 tools).

The theme is the gap between the methodology the documentation describes and
what the tools actually helped you carry out. The README has always said to
compare a cohort against a control before believing a shared-funding rate, and
there was no way to build one; it cited "funded in three bursts of under a
minute" as decisive evidence that had to be computed by hand. Those steps exist
now.

Two of these came out of running the documented investigation and getting it
wrong, which is recorded in the tests rather than smoothed over.

### Added
- **`sample_control_addresses`** — draw a control group from the same protocol
  and window as the cohort under test. Random rather than top-N, because
  sampling the largest actors compares a cohort against whales, which transact
  more and therefore collide more; de-duplicated, so an active address is not
  likelier to be drawn than a quiet one; and seedable, because a control nobody
  can redraw cannot be checked by whoever reads the report.
- **`resolve_protocol_packages`** — find which of a protocol's package versions
  are actually emitting. `protocols.json` is a decode map, full of historical
  IDs on purpose so that a 2023 transaction still resolves to a name; used as a
  query target it returns nothing, which reads as a dead protocol rather than a
  wrong ID. Three major protocols were written off that way while building
  this. The answer is usually plural — an event carries the ID of the version
  that *defined* it, so a protocol upgraded piecemeal emits from several at
  once. Cetus measured ten live versions, Suilend two. Resolving to a single
  "current package" would drop most of a protocol's activity while looking
  complete.
- **Co-funding detection** in `find_funding_sources`: addresses paid by one
  transaction, reported separately from shared funders because they support
  different conclusions. Each group is weighed against how many addresses that
  transaction paid in total — two of two is bespoke, two of nineteen is a batch
  distribution an unrelated address can land in by chance. That case is real
  and is in the tests: a randomly drawn control address appeared in the same
  payout as two cohort wallets.
- **Subject-to-subject links** — one address under investigation funding
  another. Stronger than shared ancestry and needing no control to interpret,
  since there is no base rate for money moving directly between two subjects.
  Invisible by eye once a batch runs past a handful of addresses.
- **Funding bursts** — fundings clustered by time, splitting on a 60s gap,
  tightest first. Timing is what survives when co-funding does not: a wide
  payout proves little, but wallets funded seconds apart did not get there
  independently. Bursts built from a single transaction carry
  `same_transaction`, because that is the co-funding entry restated and
  counting both would tally one fact as two independent signals.

### Changed
- `find_funding_sources` returns the whole fan-out measurement for each shared
  funder, including `flow_shape` and `out_in_ratio`. It previously surfaced the
  count alone — in the one tool whose job is deciding whether shared funding
  means anything, which a count cannot decide.

## 1.5.1 (2026-08-09)

All fixes, no new tools. Every item is 1.5.0 changing how fan-out is measured
without the surface around it following: the description, the comments, the
cache schema and the embedded summary were all still answering the 1.4.x
question.

Upgrading discards cached fan-out rows once, on first open. They were written
by the paths fixed below, so re-measuring is the point.

### Fixed
- **The cache discarded the feature the release was built on.** Only
  `recipient_count` was persisted, so any cache hit returned `-1` for
  `sender_count` and `coin_type_count`, `null` for `out_in_ratio` and
  `"unknown"` for `flow_shape`. It also wrote `counterparty_count` into the
  `recipient_count` column, so a cached read disagreed with a fresh one about
  the same address. Worst on the documented path: `find_funding_sources` warms
  the cache, so the follow-up `get_address_fanout` on a shared funder was
  always a hit — the example in the README could not produce a flow shape.
- **Cached scans could be shallower than the one requested.**
  `find_funding_sources` measures funders at 300 transactions and the cache is
  keyed on address alone, so a later call asking for 1,500 got the
  300-transaction reading back for a week, more truncated than asked for and
  silent about it. A cached row is now used only when it scanned at least as
  deep, or when it was untruncated and had already reached the end of the
  address's history.
- **`find_funding_sources` surfaced a quarter of what it measured**, dropping
  `counterparty_count`, `sender_count`, `out_in_ratio` and `flow_shape`. That
  is the tool deciding whether shared funding means anything, and a count alone
  cannot decide it — an exchange and a sybil funder can carry near-identical
  counterparty counts and opposite flow.
- **Two migration bugs**, both invisible to tests that each used a fresh
  database and so never exercised an upgrade. `CREATE TABLE IF NOT EXISTS`
  leaves an existing table's columns alone, so adding columns kept the old
  shape and every write failed; and a migration that bumped the version stamp
  then failed left a store claiming to be current while holding old columns,
  which a stamp-only check could never repair. The schema version and the
  actual column list are now both checked, so such a store heals on next open.
- **`get_address_fanout`'s description still documented the 1.4.x contract** —
  "sent value to", "Outbound transactions to scan" — teaching the very
  misconception 1.5.0 fixed, in the text a model reads to decide how to call
  it. Two module comments had the same problem, one of them arguing that
  counting both directions would be wrong.
- `classifyFanout` accepted a `coinTypes` argument it never read, with callers
  passing it as though it changed the result.

### Changed
- The container image no longer builds the Move decompiler by default. It is a
  Rust build over the Move crates taking tens of minutes, long enough to risk a
  directory's sandbox build timeout — and a timeout yields no image and no
  introspection, losing all 57 tools to keep one. Opt in with
  `docker build --build-arg WITH_DECOMPILER=1`. The image also now loads every
  tool by default, since an unset `SUI_TOOLS` published the 18-tool `core`
  profile as the server's public capability record.
- The shipped `Dockerfile` was `node:20-slim`, which cannot run this server at
  all: `node:sqlite` does not exist there, it is below the declared
  `>=22.13.0` floor, and Node 20 is EOL. Rebuilt as a three-stage image that
  drops to a non-root user and ships only `dist/` and production dependencies.

## 1.5.0 (2026-08-08)

Minor rather than patch: fan-out numbers change meaningfully, so a figure from
1.4.x and one from 1.5.0 are not comparable.

### Fixed
- **`get_address_fanout` was measuring the wrong end of history.** Sui's GraphQL
  `first` returns the OLDEST transactions, so every fan-out figure described an
  address's genesis rather than what it does now — a 2023-era address was
  sampled entirely from its first weeks, and an address that only became an
  exchange recently would have read as narrow. It now walks backwards from the
  most recent transaction. Numbers change: one funder reported at 1,623
  recipients measures 792 counterparties over its recent history.
- **Fan-out counted outbound counterparties only**, which cannot see a
  custodial cold wallet — it receives from thousands and sends to almost
  nobody, so it classified as "narrow". Both directions are now counted, and
  the response carries `sender_count`, `counterparty_count` and
  `coin_type_count` alongside the recipients.
- **The fan-out cache kept serving the old measurements after the upgrade.** It
  is keyed on address alone, so a row carries no record of *how* it was taken
  and the 7-day TTL would have handed back 1.4.x numbers for a week. Cached
  fan-out is now stamped with a method version (`PRAGMA user_version`) and
  discarded when the method changes — once, on first open, and only the cache:
  labels and findings are user data and are never touched.

### Added
- **`out_in_ratio` and `flow_shape`** on fan-out results. Shape separates cases
  size cannot: measured the same day, a known exchange and a sybil funder had
  399 and 431 counterparties respectively — indistinguishable by count — but
  ratios of 0.73 (balanced custodian) and 9.78 (disperser).
- Thresholds recalibrated against measured wallets: exchanges land at 205–440
  counterparties per 600 recent transactions, ordinary wallets at 6–12. The
  20x gap is what makes a coarse cut defensible; the boundaries themselves are
  not precise and the code says so.
- `labeled-addresses.example.json` now distinguishes **behavioural** claims you
  can derive and stand behind from **named** claims that must cite a source,
  since no measurement distinguishes Binance from Bybit.
- **Findings capture.** `save_finding`, `list_findings`, `export_case` and
  `delete_finding`. An investigation used to end as a chat transcript — the
  conclusions were real but lived somewhere nobody would read again, and
  re-deriving them cost as much as the original work. Findings are recorded
  against a named case and `export_case` renders the whole thing as Markdown,
  highest-confidence first, with a full-address appendix. Needs
  `SUI_STORE_PATH`.
- **`sort_order` and distribution on `aggregate_events`.** Value sorted
  descending only and `top` caps at 200, so a dust swarm was invisible: 919
  wallets each borrowing ~$0.20 never appeared behind twenty large depositors.
  `sort_order: "asc"` reaches the small end, and every response now carries
  min/p25/median/p75/p95/max computed over *all* groups rather than the
  returned page.
- **Labels persist** when a store is configured. `manage_labels` previously
  told you to hand-edit a JSON file; session labels now survive restarts, and
  `action: "import"` / `"export"` round-trip a labels file so a team can share
  attribution.
- **`get_address_fanout` suggests a label** when fan-out is at hub scale — as a
  suggestion the human confirms, never applied automatically. Labels decide
  where fund traces stop, so an auto-applied one would let a measurement
  silently redirect an investigation.

### Notes
- No seeded labels. DefiLlama was proposed as a source for exchange addresses;
  checking it, their Sui CEX address book is literally empty (`sui: []`), so
  shipping any would have been fabricated attribution. The mechanism is here;
  the data is yours to supply.

## 1.4.1 (2026-08-07)

### Fixed
- Setting `SUI_STORE_PATH` to a path whose parent directory did not exist
  disabled persistence with only a line on stderr — the store looked configured
  but silently kept nothing. Naming a store path means "keep a store there", so
  the parent directory is now created. Only the parent, never the file, and a
  path that genuinely cannot be opened still degrades to disabled rather than
  taking the server down.

## 1.4.0 (2026-08-07)

### Changed
- **Minimum Node is now 22.13.** `node:sqlite` (which backs the optional store)
  landed in 22.5 and stopped needing a flag in 22.13, and Node 20 reached EOL on
  2026-04-30. CI's matrix moves from 20/22 to 22/24.

### Added
- **`aggregate_events`** — rank wallets or event types by activity or value over
  a time window, in one call instead of paginating thousands of events by hand.
  Validated against a manual investigation that took 19 minutes: two calls
  reproduced its top wallets in the same order with matching magnitudes
  (`0x8c90d1c1…` $343,983 vs its $344k, `0x808fb10d…` $193,547 vs $194k).
  - Bounds accept **ISO timestamps or checkpoints**, so "today" no longer means
    hand-probing for the checkpoint at midnight.
  - Called without `value_field`, it returns each event type with its count and
    numeric fields. That is the discovery step which otherwise requires
    reverse-engineering a protocol's payload — and it makes visible that user
    actions are usually far rarer than bookkeeping events (AlphaLend: 642
    reward-refresh events to 61 deposits). Deliberately not a per-protocol
    schema registry: one hand-maintained registry already drifts.
  - Reports `truncated` loudly. A ranking from a partial scan looks exactly
    like a complete one, which is how a wrong answer gets believed.
- **Optional local store** via `SUI_STORE_PATH`, using Node's built-in
  `node:sqlite` — no dependency, no native build, nothing new for a
  supply-chain scanner to flag. Persists address labels (previously in-memory
  only, with the tool telling you to hand-edit JSON) and fan-out measurements
  (the expensive measurement here, and a stable one). Off by default: an
  investigation store records which addresses you looked at, and that should
  not land on disk because someone ran `npx`. Fund traces are deliberately not
  cached — a trace is a function of labels, so a stored one would silently
  disagree with a fresh run.

### Notes
- Two traps found while building this, both encoded in the tool: `event_type`
  filters on the struct's **defining** package, which for many protocols is not
  the package you call (AlphaLend calls `0xe48b33ef…` but defines its events at
  `0xd631cd66…`), so `module` is usually the filter you want; and a zero-result
  response now says so rather than looking like "nothing happened".
- Added a static test that fails on a bare `require()` in `src/`. The build
  output is ESM where `require` is undefined, but vitest's transform provides
  one — so that bug passes every unit test and only surfaces when the built
  server runs. It did exactly that here.

## 1.3.0 (2026-08-07)

Everything here came out of a real investigation — ranking AlphaLend wallets by
flow and attributing their funding — where the walls hit were specific enough
to fix.

### Fixed
- **`query_events` reported the wrong event type.** It used
  `transactionModule.fullyQualifiedName`, the module whose function was
  *called*, not the event's own struct. Through an aggregator those are
  different packages: a DeepBook `OrderCanceled` came back labelled with the
  router's module, and `DepositEvent` was indistinguishable from `BorrowEvent`
  in the same page. Now reports the real struct type, with the old value kept
  as `emitting_module`.
- **`enable_tools` described profiles in prose, not tool names.** "DeepBook
  order book and fills" never matched a search for `deepbook_trades`, so an
  agent reimplemented a gated tool by hand instead of enabling it. The gate now
  lists every tool name — a disabled tool is only reachable if its name is
  visible.

### Added
- `get_address_fanout` — how many distinct addresses a funder has paid.
  Shared ancestry is the classic false positive in attribution: several wallets
  tracing to one funder looks decisive until the funder turns out to have
  ~29,000 recipients and be an exchange. Returns a classification
  (`hub` / `distributor` / `narrow`) so the reading comes with the number.
- `find_funding_sources` — batch attribution for up to 100 addresses, sharing
  a memo across the batch. Funding chains converge hard, so per-address calls
  re-derive the same ancestors repeatedly. Reports funders shared across the
  batch and measures their fan-out, which a per-address call cannot see.
  `depth: "first_hop"` skips the tail, which reliably dead-ends in 2023-era
  distribution wallets.
- `query_transactions` now returns `gas_sponsor` and `gas_sponsored`. Sponsored
  gas is one of the strongest coordination signals on Sui and was invisible in
  every tool.
- `query_transactions` gains `include_functions`, returning every Move call in
  a transaction plus `matched_calls` / `total_calls`.
- `deepbook_trades` reports `truncated` when it returns a full page. The
  indexer has no cursor, so a full page was previously indistinguishable from
  "that was all of them".

### Changed
- `query_transactions`' description now carries an attribution warning: the
  `function` filter matches PTBs where the package is one leg among several,
  and transaction balance changes cover the whole PTB. Summing them per
  protocol over-attributes — in the investigation above, a Bluefin LP open was
  counted as AlphaLend volume. A live check on a Cetus-filtered transaction
  shows `matched_calls: 3 / 12`, so the over-attribution is now measurable
  rather than assumed.

## 1.2.0 (2026-08-07)

Minor, and it changes default behaviour: the server now starts with 17 tools
instead of all 50. Nothing is removed — `enable_tools` turns the rest on
mid-session, and `SUI_TOOLS=all` restores the previous startup surface.

### Added
- **Tool profiles.** The full tool manifest is ~14k tokens and MCP sends it on
  every request; a large flat tool list also degrades tool selection. The
  server now starts with a `core` profile (17 tools, ~4.6k tokens) and exposes
  `enable_tools` to turn on `forensics`, `developer`, `market` or `all`
  mid-session — the client picks up the new tools via
  `notifications/tools/list_changed`, no restart. `SUI_TOOLS` sets the startup
  surface for clients that cache the tool list. Same approach GitHub's MCP
  server takes with `GITHUB_TOOLSETS`.
- **DeepBook v3 tools**, backed by the [DeepBook indexer](https://docs.sui.io/standards/deepbookv3-indexer)
  (mainnet and testnet; devnet runs none):
  - `deepbook_orderbook` — live bid/ask depth, spread, mid, and resting-liquidity
    imbalance. Omit `pool_name` to list pools.
  - `deepbook_trades` — recent fills with maker/taker balance manager IDs, so
    trading can be attributed to an account during an incident window.
  - `compare_oracle_price` — Pyth oracle price against the price DeepBook
    actually traded at, over a window. Lending protocols liquidate on oracle
    prices, so divergence is the signature of a stale feed, a manipulation
    window, or liquidations priced where the market never printed.

### Fixed
- `get_pool_stats` reported DeepBook vault balances under `reserves`. DeepBook
  is a central limit order book with no reserves — the vaults are custody for
  resting orders and say nothing about tradable depth. It now reports
  `protocol_type: "clob"`, a null `reserves`, and points at `deepbook_orderbook`.

### Notes
- The DeepBook indexer has two undocumented quirks, both encoded in the client:
  the OHLCV path is `/ohclv` (transposed upstream, `/ohlcv` returns empty), and
  it takes milliseconds while `/trades` takes seconds. Its `depth` parameter
  counts levels across both sides, so callers pass per-side and the client
  doubles it.
- Margin and `/portfolio` endpoints are deliberately not wired up: the
  `@backfill_collateral` pipelines were ~197 days behind when this was written.

## 1.1.1 (2026-08-07)

Patch: both changes harden `decompile_module` against hostile input. No tool
signatures or output shapes change, except that a truncated `all_modules` run
now says so explicitly.

### Security
- `decompile_module` built a temp-file path from the on-chain module name
  without validating it (`join(dir, \`${mod.name}.mv\`)`). Module names come
  from whoever published the package, relayed by whatever RPC the user
  configured, so a name like `../../../evil` was an arbitrary file write with
  attacker-controlled contents. Move's verifier should prevent it, but a
  hostile `SUI_FULLNODE_URL` removes that guarantee. Names are now checked
  against the Move identifier grammar before touching the filesystem.
- Bounded `all_modules`, which previously ran one subprocess per module with no
  ceiling on either count or total output — a package with a few hundred
  modules turned one call into tens of minutes and hundreds of megabytes
  buffered in memory. Now capped at 32 modules, a 120s whole-call budget and
  8MB of combined output, with `complete: false` and a `notes` array in the
  response so a truncated result is never mistaken for a full one.

### Documentation
- README documents every capability a supply-chain scanner reports — network,
  filesystem, subprocess, environment — with the reason for each, plus how to
  verify a release's provenance with `npm audit signatures`.

## 1.1.0 (2026-08-07)

Minor rather than patch: `protocol_type` can now return categories that did not
exist in 1.0.0 (`oracle`, `bridge`, `yield`, `farm`, and `unknown` for
runtime-resolved packages), and decoded output changes for packages the registry
previously missed — a DeepBook call that rendered as a truncated address in
1.0.0 now renders as a named action.

### Fixed
- **Testnet never used its archive.** `archive.testnet.sui.io` exists, but the
  config had testnet as archive-less, so every testnet call silently fell back
  to the fullnode and returned `NOT_FOUND` for anything pruned. Testnet reads of
  historical epochs, checkpoints, objects and transactions now work.
- MVR requests had no timeout, unlike every other external call. An
  unresponsive registry hung the tool call for ~300s instead of 10.
- SpringSui was categorized as `lending`; it is a liquid staking protocol.

### Added
- Move Registry fallback for unknown packages. Decoded output now shows an MVR
  name (`@deepbook/core`) instead of a truncated address. Display only —
  `lookupProtocol`, which fund tracing uses to decide pass-through addresses,
  stays curated-only so a registered name can't change where a trace stops.
- `npm run find-unknown-packages` samples recent checkpoints and ranks packages
  missing from the registry by call count. Catches protocol upgrades, which
  otherwise degrade decoding silently.
- 27 protocol package IDs, each resolved via Move Registry or verified against
  its on-chain module list: AlphaFi, Volo, Momentum, Mole, Kai Finance, Ember,
  WaterX, Pyth, Wormhole, plus current package IDs for DeepBook, Cetus,
  Bluefin, FlowX, Bucket, SpringSui and Haedal that had drifted past the
  registry. New categories: `oracle`, `bridge`, `yield`, `farm`, `rwa`.
- `EXTERNAL_HTTP_TIMEOUT_MS` — one timeout policy for all non-Sui HTTP calls.
- `test/protocols-data.test.ts` validates the registry JSON against the
  `ProtocolType` union, which tsc cannot check.

### Changed
- The four hand-inlined fullnode→archive fallbacks are now one tested helper,
  `withArchiveFallback`. This is a consolidation, not a bug fix: all four call
  sites already handled the case that actually occurs. Probing mainnet shows
  pruned and nonexistent data throw gRPC `NOT_FOUND` rather than resolving with
  an empty payload, so the pre-existing empty-result retries in `get_object`,
  `get_checkpoint` and `get_chain_info` appear to be unreachable, and
  `get_transaction` lacking one was not a defect. The helper keeps that
  defensive path and skips both retries on devnet, where `archive` is the same
  client as the fullnode and the second call was a duplicate request.
- `CLAUDE.md` documents which transport to use for which read shape. The
  gRPC/GraphQL split was consistent in practice but written down nowhere.

## 1.0.0 (2026-08-07)

First release published to npm and the [MCP Registry](https://registry.modelcontextprotocol.io).

### Distribution
- Published to npm as **`sui-analytics-mcp`**. The unscoped name `sui-mcp` was
  already taken on npm by an unrelated package, so `npx -y sui-analytics-mcp` is
  the install path; the registry name remains `io.github.0xfreak0/sui-mcp`.
- Added `server.json` for the official MCP Registry and `mcpName` to
  `package.json` for npm package-ownership verification.
- Added a `files` allowlist. `dist/` is git-ignored, and npm falls back to
  `.gitignore` when there's no `.npmignore`, so without the allowlist the
  tarball would have shipped no build output.
- Build now sets the executable bit on `dist/index.js`; `npx` execs the bin
  directly and `tsc` does not preserve the mode.
- Server version is read from `package.json` instead of a second hardcoded copy,
  which the registry requires to match the published npm version.

### Fixed
- `decompile_module`'s missing-binary error pointed at `scripts/build-decompiler.sh`,
  a path that doesn't exist for anyone installing from npm. It now names the repo
  and suggests `disassemble_module` as the no-binary alternative.

### Security
- Updated `@modelcontextprotocol/sdk` to `^1.30.0` and refreshed the lockfile,
  clearing all production-dependency advisories (previously 1 critical, 7 high).

## 0.1.0 (2026-02-14)

Initial public release.

### Tools (38)
- **Wallet**: `identify_address`, `get_wallet_overview`, `get_transaction_history`
- **Chain**: `get_chain_info`, `get_checkpoint`
- **Objects**: `get_object`, `list_owned_objects`, `list_dynamic_fields`
- **Coins**: `get_balance`, `get_coin_info`, `search_token`, `get_token_prices`, `get_historical_prices`, `analyze_token`
- **Transactions**: `get_transaction`, `query_transactions`, `query_events`
- **DeFi**: `get_defi_positions`, `find_pools`, `get_pool_stats`
- **NFTs**: `list_nfts`, `list_nft_collections`, `get_top_holders`
- **Staking**: `get_validators`, `get_validator_detail`, `get_staking_summary`
- **Names**: `resolve_name`
- **Packages**: `get_package`, `get_move_function`, `get_package_dependency_graph`, `decompile_module`
- **Transaction building**: `build_transfer_sui`, `build_transfer_coin`, `build_stake_sui`, `build_unstake_sui`, `simulate_transaction`
- **Advanced**: `decode_ptb`, `trace_funds`, `check_activity`

### Highlights
- gRPC + GraphQL dual client architecture with archive fallback
- Protocol-aware transaction decoding (Cetus, DeepBook, Suilend, NAVI, Scallop, Bluefin, and more)
- Kiosk-aware NFT resolution
- SuiNS name enrichment across wallet, history, and holder tools
- Token price aggregation via Aftermath Finance, Pyth, and CoinGecko
- Move bytecode decompilation via Revela
