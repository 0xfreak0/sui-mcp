# Changelog

## Unreleased

### Changed
- **USD values are labelled as estimates, and a docs page explains them.**
  A new page, "How USD values are calculated", says which provider and which
  moment each tool prices at. It also explains why a total can differ from
  an exact or reported figure (price moves, stale or missing quotes, thin
  coins, rounding, two tools pricing at different times) and which fields
  state it. The answer is: report raw token amounts as exact and USD as an
  estimate. USD-bearing answers say in one phrase that their USD comes from
  provider quotes, not execution prices.
- **The forensics skill matches 1.25.** It uses the renamed funds-loss prompt,
  distinguishes empty pages and read-budget stops from exhausted results,
  and explains unread transactions, same-network continuations, validator
  summaries and historical staking. Pricing guidance follows each transaction's
  time and marks unpriced totals partial rather than a lower bound. Stale
  counts and repeated guidance are removed.
- **The docs site matches 1.25.** The pricing, flow, transaction, capability
  and getting-started pages describe daily pricing and partial totals.
  Contributor docs describe the context-cost workflow. Output-size figures
  that change between releases are gone.
- **Shorter tool descriptions.** The longest tool and field descriptions are
  rewritten to say the same in fewer words. Each keeps when to pick the tool,
  what it does not cover, when output is partial, how to continue, and the
  "leads, not verdicts" caveats. Explanations of method and worked examples
  moved to the concept guides on the docs site. Every model request with all
  tools enabled carries about 16% fewer characters of tool definitions.
  Behaviour and input schemas are unchanged.
- **Higher default request pacing on mainnet.** The public mainnet endpoints
  now accept more requests per IP than testnet and devnet, so the default
  spacing for `*.mainnet.sui.io` hosts is raised; testnet and devnet keep
  theirs. `SUI_RATE_LIMIT` still overrides both.
- **Tool JSON answers omit indentation.** Graph and fund traces, flow paths,
  event queries and the other JSON tool responses keep every field, row,
  summary, caveat and continuation without pretty-printing overhead. Graph
  JSON exports and SuiNS name-resolution annotations use the same compact
  encoding. Resource bodies, stored results and non-JSON exports are unchanged.
- **`was_i_scammed` is now `what_happened_to_my_funds`, and it starts with
  stopping further loss.** Someone asking has usually lost funds already, so
  the prompt works in this order: whether anyone else can still move what is
  left (a leaked key, an address in `delegated_to` the user did not add), how
  the funds left (a leaked key, a drainer transaction the user signed or an
  approval on a website, a lookalike address pasted from the wallet's
  history), where they went up to the first exchange deposit address or
  bridge, and whom to report to with which digests and addresses. The plain
  answer follows the same order. A drop and the user's own order or position
  remain the two outcomes in which nothing was taken, and every check and
  rule of the old prompt is kept.
- Removed repeated instructions from `what_happened_to_my_funds` and
  shortened the shared profile-enabling instructions used by the four
  everyday prompts. The own-order branch explicitly checks who can still
  move funds before answering, including after a wrapper's drainer check.
  Wallet selection, ownership evidence, withdrawal-versus-fill limits and
  all safety and answer rules are kept.
- **The truncation guide distinguishes display limits from pagination.**
  It explains empty `query_events` pages with `has_next_page: true`, read-budget
  stops under `scan`, and continuation with `scan.next_call.repeat_with`.
- **The unused CoinMarketCap price source is gone.** No tool read a
  CoinMarketCap price, yet setting `CMC_API_KEY` added `coinmarketcap` to the
  `price_sources` list `get_token_prices` returns for a past moment.
  `fetchCoinMarketCap`, `CMC_API_KEY` and the `coinmarketcap` source are
  removed, and the configuration guide, capabilities page, security model and
  `.env.example` no longer offer the key. `price_sources` names only
  Aftermath, DefiLlama and, with `PYTH_API_KEY`, Pyth.
- **`get_token_prices` says when Pyth answers.** Current prices come from
  Aftermath, then DefiLlama, then Pyth for a verified coin only when
  `PYTH_API_KEY` is set; the description and the configuration guide now say
  so.
- Tool descriptions: `trace_funds` and `aggregate_events` are tagged
  "(Incident investigation)", the group they are listed under, instead of
  "(Advanced — multi-hop)" and "(Analytics)"; `get_top_holders` drops its
  "(Advanced — slow, paginated scan)" tag. Em-dash asides in tool and
  parameter descriptions are rewritten as plain clauses.
- **The docs site's changelog page is generated.** `npm run gen:tools` in
  `site/` also reads CHANGELOG.md and package.json and writes the changelog
  page (each release's summary, with links to its entry and GitHub release)
  and a "Current release" line on the front page and Start here.
  `test/site-tool-reference.test.ts` fails while either is stale, and the
  release steps in CONTRIBUTING.md regenerate them.
- Docs fixes from a review: the Cetus example reconciles its step 4 totals
  with step 3; the lookalike-address page states where a poisoning wallet
  appears and lists the conditions of the timing rule; the fund-flow page
  lists when a low-value sale's remainder is `retained` or `consumed`; clever
  errors are defined where the term first appears; each page has one name in
  its title and the sidebar.
- **The docs site has investigation examples and task-based navigation.**
  Five worked examples (a protocol exploit, a token rug, a drainer kit, a
  claim farm and a package authority check) show each tool call with its
  arguments and a trimmed excerpt of the answer. "Start here" lists common
  tasks and links each to an example or page, and the front page links to the
  examples. Pages no longer state counts or sizes that change with the
  product; the profile list and each tool group's summary table are generated
  with the tool reference.
- **The README is an overview; the documentation moved to a docs site.**
  The README keeps the install snippet, one investigation example and links.
  Every other section moved to pages under `site/src/content/docs/` (an
  Astro Starlight site in `site/`, outside the npm package), and the tool
  reference is generated from the server's own tool and prompt schemas;
  `test/site-tool-reference.test.ts` fails when the committed reference is
  stale. Tool counts are checked against the tool profiles page.
- The docs site is live at <https://sui-mcp.vercel.app/>. The README links
  there, `package.json`'s `homepage` points to it, and the site sets its
  address for canonical links and a sitemap.

### Fixed
- **The 24h change is current.** `get_token_prices` and `analyze_token` read
  DefiLlama's percentage endpoint, which is served from a cache and could be
  up to an hour old. The change is now computed from DefiLlama's current
  price and its price 24 hours earlier, read in one batched request.
- **USD over long windows is priced near each transaction's time.**
  `summarize_address_flows` priced a multi-month window at one median-time
  price, so its USD totals were unusable. Each coin movement is now priced
  before it is summed. The quote is taken at the median time of that coin's
  movements within each UTC hour, or within each UTC day when the window
  needs more quotes than the pricing budget allows. This applies to coin
  totals, counterparties and bridges; objects keep their transaction-time
  valuation. The same holds for:
  - `summarize_incident_losses` coin gains and pool losses (`price_at` still
    sets one fixed time);
  - `aggregate_events` participant P&L.

  One pricing block states the method, the source and the coverage. A quote
  more than an hour from its sample time, up to two hours, is accepted and
  listed as stale. Anything older, a missing price, unknown decimals or a
  pricing-budget stop leaves the amount unpriced and reported. There is no
  median or current-price fallback. A one-day window costs the same as
  before. In `summarize_address_flows` the bridge transaction list is capped
  like other lists: group totals and destinations stay complete, and the
  omitted rows are reachable through the continuation.
- **Continuations stay on the chain that produced them.** A `next_call`
  from a testnet or devnet call, or from a mainnet call on a server whose
  default is another network, omitted `network`, so following it read the
  default chain. Server-generated follow-up calls and stored results now
  carry `network` whenever it differs from the server default. Decoded event
  and object data is never altered. `repeat_with` is merged into the original
  arguments, which keep their network. Package-lineage and wrapped-object
  hints are now structured calls.
- **Tools that read a transaction's balance changes now read all of them.**
  Several tools used only the first page of a transaction's balance changes,
  so a large transaction (an airdrop, a batch payout, an exploit) could hide
  the row that mattered. Now read in full:
  - `screen_address` exposure paths;
  - `analyze_attack_tx` round trips;
  - `classify_deposit_address` and the inferred deposit labels (also through
    `get_address_fanout`);
  - `resolve_bridge_transfer` inbound fulfilment;
  - fan-out measurement;
  - first-funder lookups and `build_wallet_edges` signals.

  When a continuation read fails, the answer says which transactions were
  unread and draws no conclusion from the partial rows:
  - screening withholds those paths;
  - deposit verdicts become `unknown`;
  - round trips go to `round_trips_unread`;
  - the bridge names no beneficiary;
  - graph and path traces stop the branch as unread instead of reading it
    as a budget limit, in every output format.

  Label sync cannot turn partial rows into an inferred label or a rejection.
- **`query_transactions` fills pages across short and empty service reads.**
  With combined filters the service can return a short or empty page while
  more exist. Ordinary queries now read on to the requested limit, the end of
  the list, or a read budget. With `all_versions`, the version streams are
  merged in global order: the page holds only rows no unread stream can
  precede, and reading stops once it is full. A budget stop reports `scan`
  with the call that continues, including when nothing was found yet.
- **`aggregate_events` bounds its reads.** Empty reads no longer run without
  limit: `max_reads` caps the reads a call makes, `scan.stop_reason` says
  which budget stopped it, and the ranking stays `truncated`. An opaque
  cursor resumes over the next disjoint slice of events. Per-key counts and
  summed values from the slices add up when every group was kept in every
  slice; top-N rankings, distinct-key counts, distributions and group P&L do
  not add up.
- **`summarize_address_flows` lists the StakedSui an old withdrawal
  deleted.** gRPC renders effects version 1 (before about March 2024) with no
  owner on either side of an object they deleted or wrapped, and those
  changes were dropped as ownerless. A 2023 `request_withdraw_stake` counted
  its SUI as inflow while the StakedSui it ended was missing from `objects`
  and from `objects_out`. Such a change is now reported as `deleted` or
  `wrapped` with `source_unrecorded`, and its holder is read at the input
  version: the address that held it is debited. A holder identified as another
  object, shared or immutable is excluded from direct-address valuation; a
  missing holder or unrecognised owner kind is listed in `objects_unread`.
  `analyze_attack_tx` and `summarize_incident_losses` value these objects
  through the same path. `trace_funds` can value them through its archive
  path; its GraphQL path can still omit historical deleted objects when their
  type is absent. A tracked object deleted or wrapped under effects v1 ends
  the object trail. A wrap with no recorded holder names no party, so
  `get_transaction` still does not report it as a custody change.
- **`query_events` no longer returns an empty page while matches remain.**
  The GraphQL service reads a bounded range per request, so a filter combining
  `sender` with `event_type` could answer with no events and `has_next_page:
  true`, and the matches appeared only on a later page. `query_events` now
  keeps reading until `limit` events are found or the list ends, up to a read
  budget per call. When the budget runs out first, the response carries
  `scan` with the number of reads, how many of `limit` events were found and
  a `next_call` that continues from `next_cursor`. A module filter split at
  the `relocate_event_module` cutover reads on the same way inside each
  segment.
- **`get_validators` no longer silently cuts the active set.** The default
  summary ranks the whole set, shows compact rows within an output budget and
  keeps at-risk validators. Omitted rows and fields are stated, with a full
  call on the same network and without a limit. `detail: "full"` returns all
  fields and rows unless an explicit `limit` is set; address lookups are
  unchanged. `active_validator_count` and `total_stake` cover the whole set,
  while `validator_count` counts the rows in each displayed or stored result.
- **`identify_address` reports what an address received at genesis.**
  `first_seen` read one page of its transaction's balance changes. The
  mainnet genesis transaction credits every initial holder and runs past one
  page, so a holder whose row sorted later showed `received: []` and
  `first_inflow: null` while `get_balance` and `summarize_address_flows`
  showed the genesis balance. The balance changes are now read to the end:
  `received` lists the genesis amount, `first_inflow` is true (genesis has no
  sender), and `first_inflow` is null only when a continuation read fails.
  The tool description and site explain that genesis allocations are
  system-created: `sender` remains null and does not identify a funding wallet.

### Migration
- `was_i_scammed` stays registered for this release with the same
  arguments. It renders `what_happened_to_my_funds` after a first line
  naming the new name, and will be removed in a later release.

### Added
- **Staking positions at a past date.** `get_staking_summary` takes `as_of`
  (a date, or a checkpoint number as a string) and returns the StakedSui objects the address held
  directly at that checkpoint. Positions that were transferred, split or
  joined are included. Reward estimates come from the pools' exchange rates
  and are shown separately from principal. The answer is read directly when
  the checkpoint is recent. Otherwise it is rebuilt from the address's object
  changes, and it is exact only when complete. When a transaction or time
  budget stops the rebuild, the totals are null, never partial. Stakes held
  inside other objects, and liquid-staking tokens, are outside its scope.
- **A context-cost measurement script for contributors.**
  `scripts/probe/token-baseline.mjs` reports what the tool definitions cost
  per profile selection and what each tool's answers cost, in characters and
  estimated tokens, from a saved case-pass summary. It is a manual comparison
  tool, not a `verify:live` check. `verify:live --keep-summary <path>` keeps
  that run's case-pass summary for it.

## 1.24.0 (2026-09-29)

Everyday questions get guided answers, and answers are checked against the
chain itself. Four prompts walk a non-investigator through "was I scammed",
"who is this wallet" and who controls a token or a protocol, answering in
plain words with a How-sure line and never a safety verdict or financial
advice. Capability audits now read wrapped, shared, frozen and object-held
caps by who can still use them, and find mint authority the publish
transaction did not show. Two new gates back this: every framework fact the
capability rules rely on is checked against the vendored Sui framework
source, and `verify:live` compares answers on random subjects from every era
with the same facts read from the chain another way.

### Added
- **Oracle checks on random subjects in `verify:live`.**
  `scripts/probe/oracle-pass.mjs` draws its subjects at random each run,
  printing the seed and the tip checkpoint so `--seed S --tip T` redraws
  them: transactions from the effects version 1 era, later and the newest
  checkpoints, Aftermath router transactions, and coins from the on-chain
  coin registry. Each answer is compared with the same fact read from the
  chain by a path the tool does not use, and the report says where a read is
  a query the tool also runs: `get_transaction` swap labels against each
  pool's own swap event and the pool's type arguments, by coin type; the end
  of an object no longer at top level in `trace_object_history` and
  `get_upgrade_history` against `idDeleted` in its last transaction;
  `get_transaction` object changes against GraphQL `objectChanges`, and
  under effects version 1 against the effects' own BCS; `analyze_package`
  mint authority against the registry's `treasury_cap_id`, its supply state
  and a `TreasuryCap<T>` type query; `token_flow` and `balance_changes`
  against GraphQL `balanceChanges`; and capability owners, down to the
  object that holds an object-owned cap, against each object's live owner
  read over gRPC. A swap label no pool event matches is listed and counted
  rather than passed. The report lists per oracle the samples checked, the
  agreements, every disagreement with our answer, the truth and how it was
  read, and every skip with its reason. A disagreement fails the run unless
  the script's `KNOWN_DEFECTS` lists it. `--subjects` pins subjects and
  `--dist` runs another build. The full tier runs it, the affected tier runs
  it when a change reaches a tool it checks, and `SUI_REPLAY_DIR` replays
  its fixed reads.
- **Framework claims checked against the framework source.**
  `test/sui-framework.test.ts` parses the Sui framework Move sources vendored
  under `test/fixtures/sui-framework` (every non-test source at
  mainnet-v1.80.1) and checks every
  framework fact a rule relies on: how each function the capability rules
  cite takes the cap, that `balance::destroy_supply` is package-private, that
  `coin_registry::make_supply_fixed` and `make_supply_burn_only` consume the
  TreasuryCap, the `coin_registry`, deny list and address alias layouts the
  readers use, the DenyList and CoinRegistry ids and the UpgradeCap policy
  values, and the recipient argument of each framework payout the PTB
  anomaly check reads. For every high-consequence capability it fails on a
  callable function that takes the cap in any mode, or consumes what a
  function taking it by `&` returns, that the rules do not account for, on a
  parameter naming a capability that does not resolve to its defining
  module, and when the shared or frozen reading or note disagrees with what
  those functions allow. `npm run sync:framework -- <ref>` re-vendors the
  sources at another release.
- **Exchange deposit addresses inferred from their sweeps.** `npm run
  sync:labels` reads the senders into every exchange wallet the disclosed set
  names and keeps an address when `classify_deposit_address` would read it
  `likely` against that wallet, with at least two sweeps: every outflow in its
  latest 50 transactions emptied the swept coin into that one disclosed
  wallet. An address poisoner's lookalike and an exchange's own operational
  address sweep the same way, so an address is also left out when it renders
  like another counterparty of the wallet, when only its sweep sponsor, the
  exchange's own wallets or the wallet's own forwarding address ever paid
  it a coin it later swept, and when a sweep sponsor is not a relayer or the
  exchange itself. A
  disclosed wallet that is deposit-shaped itself is never a sweep target. The
  set ships in `src/data/deposit-labels.json` as a tier below every other
  label, so a disclosed, curated, override or session label always wins. A
  label names the exchange only (`<Exchange> deposit address (inferred)`,
  category `cex`, confidence medium, source `inferred`, evidence
  `sweep-pattern`) and carries `inferred_from`: the wallet swept into, the
  sweep count and the latest sweep digests. Every surface that shows a
  label's provenance shows it, `screen_address` reports the set's coverage
  per exchange, and a trace or flow graph that stops at one says the label
  was inferred, names its latest sweep and says how to trace past it.
  `manage_labels export` leaves inferred labels out. An address missing from
  the set is not cleared: only recent senders into the disclosed wallets
  were read.
- **Four everyday prompts for people who are not investigators.**
  `was_i_scammed` (a wallet, a digest or both) finds what left the wallet,
  where it went, whether a blocklisted drainer package or a lookalike address
  was involved, and whom to report to; after a key compromise it points to a
  new wallet on a clean device, and coins that went into the user's own
  protocol account get their current state read before any advice.
  `who_is_this_wallet` (an address or SuiNS name) reads what kind of account
  it is, its labels and their evidence, its funding, activity and exchange
  deposit behaviour. Two control checks report facts, never a safety
  verdict: `who_controls_this_token` (a coin type) reads who can mint,
  freeze or upgrade the coin, its holders, its pools and its deployer, and
  `who_controls_this_protocol` (a package ID, MVR name or protocol name)
  reads who holds the UpgradeCap and admin caps, how they sign and what
  changed recently. Neither calls anything safe or unsafe or recommends
  buying, selling, depositing or holding, and each answer ends by saying,
  as of the chain tip it read, that it is not an audit or financial advice.
  No prompt gives investment or legal advice. Each asks for a plain answer
  of at most four sentences in everyday words, then a `How sure:
  high|medium|low` line naming what was and was not checked, then the
  digests and addresses behind it. Flags are reported as leads, an empty
  result clears nothing, no private person is named, and each step names
  the one profile outside `core` it needs, so a profile is enabled only
  when a step runs. A test checks every tool call a prompt spells out
  against the registered tools, their argument names and enum values, the
  profile its step names, and the profiles the prompt enables.
- `prompts/get` without an `arguments` field renders a prompt whose
  arguments are all optional, as the protocol allows.
- **`get_transaction` explains a round trip inside a swap route.** When a
  router path swaps a coin away and back (USDC → USDT → USDC, then USDC →
  ZUK), the result carries `route_loops`: the `actions` indices of the loop,
  its coins, what went in and what came back, and the difference as `cost`,
  read from the pools' own swap events and matched to each hop by command,
  coins and direction. The Cetus, Full Sail, Bluefin, Momentum and FlowX CLMM
  swap events are read; otherwise the cost is null and `cost_unknown` says
  why (no events, fields not read, a hop unmatched, amounts that do not
  chain), since the sender's balance changes net the whole transaction. A
  negative cost means more came back than went in. When the route itself
  starts and ends in the loop's coin and the loop is its whole path, the loop
  is marked `whole_trade` and reported as that path's share of the trade,
  with gas and any fee the router charged outside the pools not counted.
  Failed transactions and transactions without a loop are unchanged.

### Fixed
- **`invariant-pass` no longer fails a history page that new transactions
  moved.** On a busy address the newest page moves between reads.
  `get_transaction_history` and `query_transactions` pages are now compared
  with the raw page read up to the checkpoint of the tool's newest row, row
  for row, in the order of the `transactions` connection both tools page, and
  the tool's newest row must be no older than the raw page read before the
  call. A wrong order, a missing or extra digest or a stale page still fails.
  The default view is compared with the full view only when the raw pages
  read before the full view and after the default view are equal, and
  `build_timeline` takes its window from the raw page of the full view's own
  read.
- **`invariant-pass` compares `summarize_address_flows` totals with its full
  view.** The check read the default view, which lists the coins that fit
  its budget and counts the rest in `omitted`, and took an omitted coin as
  zero. It now compares the raw totals with `detail: "full"` and checks that
  the default view is the full view's coins in order (when both views priced
  them alike), with the same raw totals and exactly `omitted` coins left
  out.
- **`classify_deposit_address` counts a deposit that arrives during a sweep
  as the next sweep's.** An exchange sweeps credited deposits, so a deposit
  that lands while a sweep is pending stays behind until the next one. A
  sweep that leaves a balance equal to the latest deposits of that coin now
  counts as full when the next outflow of the coin empties it into the same
  destination, or has not happened yet in the window; the sweep carries
  `left_for_next_sweep` with the deposits and the sweep that took them. A Bybit
  customer deposit address read `no` before and reads `likely` now. The
  deposit-labels rule uses the same reading, so the next `sync:labels` may
  add addresses it rejected as `partial-sweep`.
- **`analyze_package` says when a cap holder has never signed.** Such a
  holder's `signing_scheme` says so rather than being absent, and a cap type
  held by several addresses names how many in its note, so no holder reads
  as unresolved.
- **`get_transaction` says an order's fills cover that transaction only.**
  `order_events_note` appears when an event places an order on the book
  (not for a swap whose order filled at once): a resting order fills later
  in other traders' transactions, and `query_transactions`
  on the account object lists the owner's later cancels and withdrawals.
- `get_transaction` named the wrong coins for a router swap that follows a
  routed call the decoder does not label as a swap. After Meta Stable's
  `withdraw_w1` turned superSUI into afSUI, the next hop read "Swap superSUI
  → SUI" while the pool swapped afSUI for SUI; after `sell_w1` sold the
  path's SUI for USDC, the next Bluefin hop read "Swap SUI → USDC" while the
  pool swapped USDC for SUI. A routed call with two coins of its own that is
  no decoded swap now passes the coin the path holds on to its other coin,
  and one with a single coin of its own (an LST integration's `mint_w1`
  staking the path's SUI) passes that coin on, so the next hop no longer
  reads "Swap SUI → sSUI" where the pool swapped sSUI for SUI. A step whose
  only coin is the one the path holds (an LST `redeem_w1`) consumes it
  without naming its output, so the next hop is read from its own coins
  instead of taking the route's start coin as its input.
- `get_transaction` named Turbos's fee tier as a router swap's output ("Swap
  SUI → FEE10000BPS") when nothing in the transaction showed the coin the
  pool gave out to be a coin, and then started the next hop from the wrong
  coin. A hop's output is now what the route uses next: the type the path's
  next routed call names, or for a path's last hop the coin the route gives
  out. A fee tier two consecutive Turbos hops both pass is never taken for
  an output.
- `analyze_package` read a capability held by another object (a dynamic
  object field, a child object) as owner `unknown`. Launchpad coins keep
  their TreasuryCap that way, as a field of the bonding curve. It now reads
  owner `object`, names the holding object in `owner_address` (the object
  that owns the field, for a dynamic object field) and its type in
  `owner_type`, and rates the cap as it rates a wrapped one: that object's
  module decides who can use it.
- A package made immutable in its own publish transaction, which passes the
  new UpgradeCap to `0x2::package::make_immutable` so that no cap object
  ever exists, read as "cap custody is unknown" in `get_upgrade_history` and
  as nothing in `analyze_package`. Both now say the package is immutable and
  name that transaction: `get_upgrade_history` reports the cap `deleted` at
  the publish, and the capability audit lists the UpgradeCap burned there,
  with no object id. A transaction that publishes several packages counts
  when it destroys every UpgradeCap its Publish commands returned.
- A shared `Publisher` and a shared `DenyCapV2` now say everything they let
  any transaction do. `display_registry::new_with_publisher` and
  `claim_with_publisher` take a Publisher by `&mut`, so a shared one lets
  anyone create a registry Display, or claim an unclaimed DisplayCap, for the
  package's types; `coin::deny_list_v2_enable_global_pause` takes a DenyCapV2
  by `&mut`, so a shared one lets anyone pause the coin where the cap allows
  it. A shared `DenyCap` says `coin::migrate_regulated_currency_to_v2` can
  take it by value, so anyone can swap it for a DenyCapV2 of their own that
  pauses the coin. A frozen `Publisher` no longer reads as closing the Display
  registry: its `display::new` Display reaches
  `display_registry::migrate_v1_to_v2` and `claim`. A frozen or shared
  TreasuryCap's note names the registry setters its MetadataCap reaches, and
  that a token policy anyone can create lets any holder confirm its own token
  transfers and conversions to coins outside the coin's token rules
  (`token::confirm_with_policy_cap`). A frozen or shared Publisher's note says
  a TransferPolicy anyone can create clears a kiosk purchase of the package's
  types without the creator's royalty or lock rules
  (`transfer_policy::confirm_request`). The
  `trace_funds` object-flow note and the `analyze_package` capability note
  name them.
- `analyze_package` no longer leaves out a coin whose TreasuryCap the
  publish transaction did not show at top level. The capability audit listed
  only caps among the objects version 1's publish created, so a cap stored
  inside another object during `init` (wUSDC's Wormhole `WrappedAssetSetup`,
  SRT's `TreasuryAccess`, CLOWNPEPE's `Storage`, which keeps the Supply the
  cap became) or created by a later transaction was absent, and the audit
  read the same as a coin nobody can mint. The audit now takes the package's
  coins from the `CoinMetadata`, `TreasuryCap`, `Coin` and registry
  `Currency` its publish created for its own types, and from the registry
  entry each of its non-generic `key` structs and one-time-witness structs
  would have, read in one request. That finds a coin created after publish
  through `coin_registry::new_currency` and one whose `init` wrapped both
  its TreasuryCap and its CoinMetadata, such as HOPELESS inside a
  `connector::Connector`. A one-time witness the registry does not know is
  asked of the node. A generic `key` struct in a module whose functions take
  the CoinRegistry is named in `incomplete_scans`, under the id of the
  version that defined it, since its coins cannot be looked up. Each missing
  cap is looked up through the registry's `treasury_cap_id` and then by
  type. A cap found this way is listed with `found_by` (`coin_registry` or
  `type_scan`) and read like any other; a registry supply recorded as fixed
  or burn-only reads as a destroyed cap. A coin whose cap is still not found
  is named in `coins_without_located_mint_authority` with what was checked,
  and its `risk` says what that means: medium, who can mint is unknown;
  info, nothing can mint (a registry supply recorded as fixed or burn-only,
  or SUI, whose Supply `sui::new` destroyed at genesis). The audit note
  names these coins, and `incomplete_scans` lists each type once, with every
  reason a scan gave. `who_controls_this_token` reads each entry by its risk.
- `classify_deposit_address` no longer counts an inferred deposit label on
  the destination as an exchange wallet, so a wallet that pays into an
  exchange deposit address is not read as a deposit address itself.
- **A wrapped capability is no longer reported as destroyed.**
  `analyze_package` and the capability audit read a cap that no longer exists
  at top level from the last transaction that touched it: deleted is
  `burned`, stored inside another object is `wrapped` with `wrapped_in_tx`,
  including wraps recorded by older transactions (effects version 1), which
  gRPC lists as deletions. A TreasuryCap a launchpad keeps inside its own
  shared object reads medium risk, with supply fixed only as far as the
  wrapper's module and its UpgradeCap holder allow. A cap whose end cannot be
  read is `unknown`. `get_upgrade_history` and `trace_object_history` use the
  same reading, so Wormhole's wrapped UpgradeCaps no longer read destroyed,
  and `get_transaction` lists an object an older transaction wrapped under
  `wrapped`, not `deleted`. When how a cap ended cannot be read,
  `get_upgrade_history` reports its state as `unknown` and names no current
  holder.
- **A destroyed TreasuryCap no longer means fixed supply on its own.**
  Destroying the cap leaves its Supply, which can still mint wherever it is
  kept. `analyze_package` reports fixed or burn-only supply when Sui's
  on-chain coin registry records it, and medium risk otherwise.
- **A shared or frozen capability can still be open to everyone.** Any
  transaction can pass a shared object by `&mut`, and `coin::mint`,
  `coin::deny_list_v2_add` and `package::authorize_upgrade` are public, so a
  shared TreasuryCap, DenyCap or UpgradeCap now reads high risk (anyone can
  mint, freeze or upgrade). A frozen object still passes by `&`: a frozen
  UpgradeCap or DenyCap is renounced, but a frozen TreasuryCap leaves its
  metadata setters and token policy open to anyone (medium), and a frozen
  Publisher or custom cap stays usable through functions that take it by
  `&`. Object traces list these under `opened_capabilities`,
  `get_transaction` marks them `opened: true` in `object_transfers`, and
  `poll_watch` reports `capability_moved` for a framework cap and
  `object_moved` for a custom one, including a cap shared or frozen in the
  transaction that created it, which none of them showed before.
- `get_transaction` and the other decoded views named a router's own
  bookkeeping type as a coin in swaps routed through Aftermath's router
  (`Swap RouterDataV1 → USDC`). Each hop now shows the coins it traded, in
  route order: a path starts from the coin the route names and each hop takes
  in what the previous hop gave out. Swap function names spelled `a_to_b` and
  `b_to_a` now also count as a direction.

### Changed
- The capability notes in `analyze_package`, `trace_funds` and
  `get_upgrade_history` name the framework functions from one table
  (`CAPABILITY_USES`), the same one that decides whether sharing or freezing
  a cap opens or renounces it. A frozen or shared TreasuryCap, UpgradeCap or
  deny cap reads the same in every tool, and a frozen cap's note says which
  functions freezing closes and which stay open.

## 1.23.0 (2026-09-27)

What a wallet holds beyond plain coins now has a value. Staked SUI,
liquid-staking coins, CLMM and AMM liquidity, lending positions and
receipts carry a USD figure with its method and evidence tier, and NFTs carry
an estimate. The wallet, flow, loss and attack tools count those values, so a
drain of staked SUI or liquidity positions reads as the collector's gain, not
the victim's. Each reader was checked against the protocol's own figures:
reward amounts, issuer rates, position views and on-chain removals matched
exactly.

### Added
- **Position values.** `get_defi_positions` values every position it finds:
  staked SUI (principal plus the rewards a withdrawal would pay), every
  liquid-staking coin at its issuer's rate, CLMM positions on Cetus, Bluefin,
  Momentum, FlowX, Magma and Turbos, AMM LP shares on Aftermath, FlowX v2 and
  Kriya v2, and lending and margin positions on Suilend, NAVI, Scallop,
  AlphaLend, Bucket and Bluefin Pro, with supply and borrow legs and the
  health figures the protocol stores. An object no specific reader knows is
  valued at the coin balances it holds.
- **Wallet totals that state their coverage.** `get_wallet_overview` with
  `include_prices` pages every coin balance, ranks holdings by value, adds
  `positions_value_usd` to `total_value_usd`, reports NFTs apart as
  `nft_estimate_usd`, and lists in `coverage` what was read, what could not
  be, and which owned object types no reader recognises. `leads` names shared
  vaults the address operates and positions near their borrow limit.
- **NFT estimates.** `list_nfts` and `list_nft_collections` estimate a value
  per item and collection from the lower of the lowest current listing and
  the last sale in 30 days, after a wash-trade guard, tier heuristic and
  labelled as an estimate. `get_nft_sales` reads TradePort bid matches, and
  OriginByte kiosks are found.
- **Moved objects in investigations.** `analyze_attack_tx`,
  `summarize_incident_losses`, `summarize_address_flows` and `trace_funds`
  value the positions a transaction moved at that transaction's checkpoint.
  `trace_funds` follows a valued object to its recipient's next use of it.
- **Detectors.** `analyze_attack_tx` flags `price-off-market` (a price a
  transaction states far from the provider price), `signing-key-replaced` (a
  public key changed in a shared object), `share-round-trip` (shares or a
  position redeemed within a day for more than they cost) and
  `switched-before-execution` (a shared object another address rewrote
  seconds before the transaction read it, changing where value goes). Each
  was scored on 251 ordinary transactions with no false positives at medium
  or above.
- **Cheaper live verification.** `npm run verify:live -- --tier affected`
  runs only the checks a change can reach, `--tier smoke` one per tool plus
  critical checks, and `case-pass --jobs <n>` runs cases in parallel. With
  `SUI_REPLAY_DIR` set, case-pass and detector-pass record chain reads that
  cannot change and replay them. The full pass stays the default.
- A new case, `claim-swaps-staked-drainer-2024-11`: a drainer that switched
  its routing object seconds before each victim-signed transaction.

### Changed
- A lending leg is valued at the protocol's oracle only when a price provider
  confirms it within 2%; otherwise it takes the provider price, tier
  price-provider, and both prices are shown. A reserve that reuses another
  asset's feed is not valued at that feed.
- `classify_deposit_address` counts sweeps that keep gas dust or are paid by
  a relayer, and runs every check.
- `list_owned_objects`, `manage_labels`, `get_nft_sales` and
  `get_defi_positions` keep within their size with `omitted` and `next_call`.

### Fixed
- `summarize_incident_losses` and `trace_funds` time out less on large
  incidents: object reads are batched and the hub check is skipped while
  following objects.
- The GraphQL service's transient "Failed to list events" is retried like
  "Failed to list transactions".

## 1.22.1 (2026-09-27)

### Fixed
- **`analyze_attack_tx` failed on a programmable system transaction.** The
  SDK's BCS schema lists four transaction kinds, and a programmable system
  transaction, which mainnet runs against the accumulator root `0xacc`, is
  kind 10, so reading one failed with "Unknown value 10 for enum
  TransactionKind". The kind is now read from the bytes before they are
  parsed: `analyze_attack_tx` answers with its other checks and says in
  `checks_note` why the PTB checks did not run, and `decode_ptb` and
  `get_transaction` with `detail: "full"` give the same reason. The other
  kinds past the SDK's four are system transactions with no commands, and are
  read as having no PTB.

### Changed
- The live probes check 1.22.0's behaviour instead of the behaviour it
  replaced. `invariant-pass` and `incident-pass` compare a capped list's
  full view (`detail: "full"`) with the chain and check that the default
  view is that list with exactly `omitted` rows left out; they unfold
  events `get_transaction` folds, apply `trace_funds`' next-hop rule (the
  spend that drew most of what arrived), accept `disassemble_module`'s line
  notes, and count `diff_package_upgrade`'s renumbered lines. `adversarial`
  tests a list of command indices with a word, and `surface-pass` no longer
  reads a documented parameter or result field in a prompt as a tool name.

## 1.22.0 (2026-09-27)

Investigations now ask how an exploit worked, not only where its funds went.
Across Typus, Nemo, Cetus, Scallop, Aftermath Perpetuals, BlueMove, Haedal,
Full Sail and AlphaFi, the tools found the flaw in the Move code with the
decompiler switched off, including two incidents no public source gave an
address for. An audit checked every detection rule against incidents it was
not written from and against ordinary mainnet traffic. Rules keyed to one
incident's names or thresholds were replaced with rules on data flow, state
and value, and a scoring harness keeps detectors honest on transactions
their authors never saw. The case library grows from 8 to 19 incidents.

### Added
- **An executed transaction's inputs and argument wiring.** `get_transaction`
  takes `detail: "full"` to add the PTB's `inputs`, every command with its
  arguments resolved (an object's id, version and type; a pure value decoded
  as the parameter type the called function declares; the command a result
  came from), and `object_changes.by_kind` with the id, type and version of
  each created, mutated, wrapped, unwrapped and deleted object. `decode_ptb`
  takes `digest` as an alternative to bytes and decodes an executed PTB the
  same way. Both page commands with `command_offset` and list exactly the
  ones named in `commands: [i, j]`.
- **Reading one function's bytecode.** `disassemble_module` takes
  `function_name`. Its output notes what the text leaves raw: a clever abort
  code's error name, message and source line, a large integer's hex form, and
  on each dependency's `use` line the version the package's linkage table
  runs. `get_package` and `get_upgrade_history` list the dependency versions a
  package runs.
- **Upgrade diffs by declaration.** `diff_package_upgrade` matches functions,
  structs and constants by name, lists `changed_functions`, and counts lines
  that only renumber offsets, locals or indices apart from real changes. A
  test mutates real disassemblies one instruction at a time and checks that
  no semantic change reads as renumbering.
- **Code checks that use no names.** `analyze_package` traces data flow
  through each function and reports graded leads: `discarded-check` (a
  check's result that never reaches a branch or abort), `sibling-guard-gap`
  (a public function that mutates an object without a check its siblings
  make on that type) and `unchecked-state-write` (a caller's value written
  into shared state with no comparison against stored state). They find the
  Typus, Scallop and Nemo flaws and raise a strong lead on 1 of 138 clean
  package versions. `bytecode_scan` names the checks run and says a function
  with no lead is not cleared.
- **State and value invariants in `analyze_attack_tx`.** It reads each
  changed shared object at the transaction's input and output versions
  (`state_deltas`) and flags `shared-state-jump`: a stored value that moved
  100x or more, a holding drained to zero, or a value copied from an object
  other than the one referenced. `caller-value-used` follows a caller's pure
  value into shared state and a later read, including a set, use and restore.
  `value_reconciliation` compares what reached addresses with what decoded
  events and read balances paid out. With `get_upgrade_history`'s
  `find_redeploys`, other lineages carrying the same module code are found.
- **Output caps that keep every fact reachable.** `summarize_address_flows`,
  `find_funding_sources`, `list_nfts`, `get_transaction`, `decode_ptb` and
  `analyze_attack_tx` list what fits about 20k characters. Totals, counts and
  verdicts cover every row, flagged rows are always listed, `omitted` states
  what was left out, and `next_call` names the call that returns it. With
  `SUI_STORE_PATH` set, the full result is stored and paged through the MCP
  resource `sui://results/{id}`. `get_transaction` folds events that differ
  only in amounts once they pass the budget. The largest result in the case
  replays fell from 273k to 35k characters.
- **Detector scoring.** `cases/detectors.json` labels exploit transactions
  from seven incidents and 251 ordinary mainnet transactions in a tuning set
  and a held-out set. `scripts/probe/detector-pass.mjs`, run by
  `verify:live`, reports each anomaly's detections and false-positive rate
  per split, and which incidents a rule catches beyond the one it came from.
  The held-out set gates on rates, so a rule change is judged on transactions
  its author never saw.
- **Eleven new cases.** Protocol exploits: `cetus-2025-05`,
  `scallop-2026-04`, `aftermath-2026-04`, `bluemove-2026-07`, `haedal-2026-06`,
  `fullsail-2026-08` and `alphafi-2026-09`. Drainers:
  `scallop-pass-drainer-2024-05` and `giftsui-drainer-2024-08`, pinned on the
  drainer side only. LP-pull rugs found on chain: `gobble-rug-2024-10` and
  `dope-rug-2024-11`. Typus and Nemo gain mechanism checks. Each pins the
  exploited function, the flaw as the bytecode shows it and the fixing
  version where there is one, and no case check calls `decompile_module`.
- **Cross-version checks.** `analyze_package` raises `ungated-older-version`
  when an older version of a lineage mutates a shared type without the check
  the newest version makes, since old versions stay callable against the same
  objects. `get_upgrade_history` with `find_redeploys` dates each function on
  its own (`function_origins`).
- **Reading more code in fewer calls.** `decompile_module` takes
  `function_name`, `disassemble_module` notes that `Shl` and `Shr` drop
  shifted-out bits without aborting, `diff_package_upgrade` shows every changed
  function before a second hunk of any, and `trace_object_history` pages
  newest first.
- **Signed values.** A u64, u128 or u256 with its top bit set carries its
  two's-complement reading (`signed_value`, `signed_readings`).
- **Pre-sign context.** `decode_ptb` on unsigned bytes states each sent coin's
  share of the sender's balance and each recipient's first transaction.
- The investigation brief asks for the mechanism, and a case check can carry
  the tier `code-derived`.
- `case-pass` reports characters and estimated tokens per call and per case,
  and fails a call over its tool's size budget.

### Changed
- **Guidance for finding a flaw.** The `trace_incident` prompt, the server
  instructions and the forensics skill read the calls and their arguments,
  then the called functions in the version live at the exploit and its linked
  dependencies, and only then diff the fix and the introduction. They lead
  with tools that need no decompiler; `decompile_module` is an optional aid.
- **Anomalies are leads, and silence clears nothing.** `analyze_attack_tx`
  and `decode_ptb` return `checks_run`, state that a check that matched
  nothing clears nothing, and `analyze_attack_tx` prints every anomaly.
  `analyze_attack_tx` now runs the payout and blocklist checks, and reads
  payouts through any function from the transaction's effects.
- **Trust apart from naming.** `unverified-package-call` is decided by the
  curated registry and a curated protocol's own publishing keys, never by a
  Move Registry name or an UpgradeCap's holder, which anyone can send a cap
  to. On an executed transaction it reads medium only when value through the
  package went one way or another lead fires. New
  `stale-package-version` and `unregistered-package-lineage` anomalies.
- **Rules replaced for generality.** `oracle-set-then-used` became
  `caller-value-used`, and `outsized-mint` bounds liquidity by the event's own
  tick range with no protocol-specific ratio. Events are attributed to the
  changed object whose id they carry, whatever the field is called.
- `trace_flow_graph` and `find_flow_path` expand the branch carrying the most
  value first, so the node limit goes to the heaviest branches.
  `resolve_bridge_transfer` recognises inbound fulfils and names a package
  that deposits into a bridge for a user as its carrier. `trace_funds` no
  longer stops at a theft address it calls a distributor, or switches to a
  dust coin.
- `summarize_incident_losses`, `aggregate_events`, `get_transactions`,
  `build_timeline` and `get_transaction_history` keep their answers within
  budget with `omitted` and `next_call`, and window-mode loss totals no longer
  net laundering transfers into the loss.
- `address_poisoning` is always present in history, flow and trace results,
  with `addresses_compared` and an empty `pairs` when nothing matched.
- A funder's popularity counts only recipients paid above dust, so dusting
  addresses cannot end a funding walk. `build_wallet_edges` links a sponsor to
  the seeds' first funder when the roles are split across two addresses and
  the funder is narrow. An unpriced grant counts by the shape of its send.
- `trace_flow_graph` carries a below-market sale's lost value as `retained`
  or `consumed` and reads swaps from values as well as names.
  `cross_chain_leads` lists events that look like a bridge exit through a
  package no bridge reader covers.
- `query_transactions` counts `matched_calls` at the filter's granularity.
- Output of the capped tools is compact JSON, and they no longer repeat it as
  structured content.

### Fixed
- A Sui Bridge token with no DefiLlama price under its Sui type is priced as
  its Ethereum asset (`priced_as`); the Cetus incident total rises from
  $193.7M to $213.1M.
- `get_transaction` no longer lists Cetus's pay-amount getters as liquidity
  adds of their own.
- `analyze_attack_tx` decodes swaps whose events name their coins.
- `decompile_module` treats an empty `SUI_DECOMPILER_PATH` as no decompiler
  and names the tools that read bytecode without one.
- The Sui Bridge package `0xb` and DeepBook v1 count as system packages.

## 1.21.0 (2026-09-26)

Seven blind investigations of real Sui incidents ran through the server using
only its tools: an address-poisoning loss, a wallet drainer campaign and its NFT
thefts, a token rug, an airdrop claim farm, a vault key compromise and an
exploit cash-out. Their answers were graded against the published reports and
the chain, and each incident is now a case file replayed on every
`npm run verify:live`. The fixes below come from those investigations and from
two code reviews of the fixes.

### Added
- **Incident case files.** `cases/incidents/*.json` pin the facts of eight
  incidents, each check tied to a source or to the chain.
  `scripts/probe/case-pass.mjs` replays them through the built server, and
  `cases/README.md` documents the format. A check the server gets wrong is
  marked `known_defect` and reported as known; a known defect that starts
  passing fails the run until the marker is removed.
- **A live-coverage gate.** `test/live-coverage.test.ts` fails when a
  registered tool is called by no live check and named by no case, so a new
  tool cannot ship without one.
- **A random-sample invariant pass.** `scripts/probe/invariant-pass.mjs` draws a
  seeded sample of mainnet transactions and addresses and checks rules that
  hold for any input against raw reads: balance changes, history against a raw
  query, flow totals against their parts, identify against the object lookup.
- **Running a blind investigation**, a CONTRIBUTING section, and
  `scripts/probe/blind-investigation.md`, a brief anyone can be handed to run
  one.
- **A symbol index of every mainnet coin.** `analyze_token` and `search_token`
  answer a symbol from `src/data/coin-symbols.json`
  (`npm run sync:coin-symbols`) before scanning. A symbol several coins use
  returns every candidate as `ambiguous_symbol`, verified first; `KONG` now
  lists its 30 coins where it answered "not found". Coins published after the
  index's sync date fall back to the live scan, and every answer names the
  sync date. The npm tarball grows from 1.7 MB to 8.0 MB.
- **Request pacing.** Each GraphQL and fullnode attempt, retries included,
  takes a slot in a per-host window: at most 180 per 10 seconds for `*.sui.io`
  hosts by default. `SUI_RATE_LIMIT` sets the number for every host; `0` turns
  it off.
- `get_object` and `identify_address` name a kiosk's controller
  (`kiosk_cap_holder`), following a KioskOwnerCap through a PersonalKioskCap or
  any other wrapper, including one wrapped in the kiosk's creation
  transaction.
- `get_transaction` reports `mutated_capabilities` (a capability used without
  changing owner) and `coins_delivered_to`.
- `identify_address` and `get_transaction_history` find transactions an
  address signed as an address alias for another wallet (`signed_as_alias`).
- `analyze_package` finds authority capabilities minted after publish (for
  example an OperatorCap held by one hot key), with each holder's signing
  scheme. Per-user capability types are reported as counts in
  `user_held_types`, and failed scans in `incomplete_scans`.
- `analyze_multisig` marks a committee key written by hand as `unsignable` and
  states the `effective_committee`.
- `decode_ptb` resolves 32-byte pure inputs to addresses and flags a payout to
  an address other than the sender and a call into a package on the Sui wallet
  blocklist.
- `get_address_fanout` classes a sponsor that also paid most of the addresses
  it sponsors as `operator`, with `sponsored_and_paid_count`.
- `trace_funds` hops report `residual` when the holder moved much less than
  it received, and `object_flow.capability_transfers` lists every capability
  handover, not only the framework types.
- `summarize_address_flows` and `screen_address` report bridge fee and relayer
  legs as `retained_on_sui`, apart from the bridged amount.
- `summarize_address_flows` and `trace_flow_graph` warn about lookalike
  address pairs (`address_poisoning`), and the flow graph never prunes a
  branch to one.

### Fixed
- **Coin amounts used an assumed scale.** A coin outside the curated list was
  formatted at 9 decimals in several tools, and at its real scale in others
  once a previous call had loaded its metadata. KONG (1 decimal) read 10^8
  too small. Every tool that formats or values an amount now reads the coin's
  CoinMetadata first.
- **`trace_flow_graph` counted value twice or called it a cycle.** From an
  address it counted burns reached through a swap twice, over-reporting the
  Typus attacker's 3,430,717 USDC CCTP exit, and later called a third of the
  same graph a cycle. From an address it now traces every coin a transaction
  moved. A swap made at the start address counts once: through the later leg
  that spends its proceeds, or as unspent (source backward) at the address
  while they are held. A payment funded partly by a swap and partly by coin
  already held is traced once, an edge's amount is what moved on chain, and a
  bridge exit counts each transaction's beneficiaries once. A swap between a
  priced coin and one with no price keeps the swap's value on both sides. The
  Typus graph ends 99.99% at the CCTP exit. First-in-first-out allocation no
  longer skips an earlier transfer for a later one, and held funds are
  reported as unspent rather than as a cycle.
- A deposit into a contract that returns a little change or dust is traced
  as consumed, and a withdrawal that paid a small fee in another coin is
  traced back to a source, instead of handing the whole value to the dust or
  fee coin.
- `trace_flow_graph` and `find_flow_path` mark the graph truncated, and say
  why in `coverage.partial`, when the search of the start address stops at
  its move or page limit before reading every move in the window.
- **Failed transactions counted as bridge exits**, and `resolve_bridge_transfer`
  said funds had left for an aborted transaction.
- **A bridge exit counted under every bridge it touched.** It now counts once,
  under the protocol that carried it, with its settlement legs in `route`.
  Unrelated bridges in one transaction stay separate exits, and every
  beneficiary is screened.
- **`build_wallet_edges` linked unrelated wallets.** Intermediaries the query
  budget never measured, or whose read failed, were treated as narrow and
  linked seeds; a public gas station became an operator. Edges are
  deterministic between runs, and an unpriced dust transfer no longer counts
  as a first funding.
- **Funding walks passed hubs they could not measure.** A failed popularity
  read, on any page, now stops the walk and says so. A price outage no longer
  changes who funded a wallet. An unpriced coin inflow counts as funding when
  it is at least 1% of the coin's supply, or 0.1% from its publisher.
- **The attacker defaulted to a gas-only sender.** `analyze_attack_tx` and
  `summarize_incident_losses` name the largest gainer when the sender only paid
  gas, and attribute losses to the vault or pool whose own events record
  them.
- **Module event filters on upgraded packages.** `query_events`,
  `aggregate_events` and `sample_control_addresses` query each version's id
  in the era where events carry it, per network, and name the lineage's other
  ids.
- **`trace_object_history`** resolves kiosk-held owners, handles deleted and
  wrapped objects, reaches distant ownership changes by checkpoint search, and
  says when that search cannot prove the history complete.
- **`analyze_package`** no longer rates a capability sent to an unspendable
  address as a live risk, and judges a destroyed UpgradeCap consistently.
- **`screen_address`** missed an active address's main exit at its default
  window; the default is now 300 transactions.
- **`list_nfts`** truncated a wallet when a kiosk boundary fell on the page
  limit.
- **`analyze_token`** resolved a symbol query to a coin whose name merely
  contained it.
- Swap direction in decoded actions no longer flips when another leg of the
  transaction moves the same coins.
- `get_transactions` names failures the same way `get_transaction` does.
- `get_top_holders` stops a holder scan at a time budget and says how far it
  read, and whether a retry or a smaller `max_scan` would help.
- `get_address_fanout` reads each counterparty's direction per coin.
- `get_transaction_history` names up to 25 counterparties per row, with
  `counterparty_count` for the rest.
- Transient read failures in `check_coin_restrictions` and `analyze_package`
  name their cause.
- `find_flow_path` defaults to 5 hops.
- `get_token_prices` and `analyze_token` ask DefiLlama for SUI's 24h change
  under its short address. The 64-digit key answered a stale change.

### Changed
- Fan-out, funding and holder cache versions were raised; cached rows from
  earlier releases are measured again.
- `get_top_holders` and the kiosk owner caveats state their rules without
  sampled endpoint figures.

## 1.20.0 (2026-09-25)

Every tool now has a live check against real mainnet data. Before this release
24 of the 76 tools had one. `verify:live` replays the Cetus and Nemo exploits
and checks each answer against a raw chain read taken in the same run, and a
generated pass sends malformed input to every argument of every tool. The
checks found the defects below, and each fix has a regression test.

### Added
- Three live checks in `npm run verify:live`: `attribution-pass` (funding,
  clustering, multisig, events, history, holders), `surface-pass` (labels,
  findings, watches, prompts, the case resource, and the core, market and
  developer tools) and a deeper `incident-pass` (all eighteen incident and
  package tools). Each fails any call over 60s or over its declared result
  size.
- `adversarial.mjs` is generated from `tools/list`: about 3,200 malformed and
  hostile inputs across every field of every tool, with a per-tool pass/fail
  table.

### Changed
- **Unknown argument names are refused.** The error names the closest valid
  argument and lists the rest. A misspelt argument used to be dropped without
  a word, so `disassemble_module {module: "pool"}` listed the modules instead
  of disassembling one.
- Blank strings are refused for every argument. `epoch: " "` returned epoch 0,
  `sequence_number: " "` returned checkpoint 0, and `search_token {query: ""}`
  returned every token.
- History and timeline rows list each distinct action once with a count;
  `query_transactions` does the same for Move calls. `get_transaction` still
  lists every action in order.
- `summarize_incident_losses` reports its window as `from`, `to`,
  `after_checkpoint` and `before_checkpoint`, like the other windowed tools.
- `is_sink` is false for `malicious` labels, matching traces, which follow
  them. `watch_addresses` still raises `sink_reached` on a labelled attacker.

### Fixed
- **gRPC reads failed as "Unknown error" under load.** The fullnode answers a
  busy client with `RESOURCE_EXHAUSTED` and no message. Requests are now
  queued at 8 in flight and retried, and an empty error is reported by its
  code.
- **`trace_funds` valued a bridge exit at its fee.** A hop that burned 100,000
  USDC was valued at the $10 its relayer received. A hop is now valued by the
  largest amount any address sent or received.
- **`get_top_holders` and `analyze_token` reported partial balances.** A holder
  whose coins were only partly scanned showed the part seen. Each sampled
  holder's balance is now read directly, with the scanned part kept as
  `balance_in_sample`.
- **`get_staking_summary` summed only the first 50 positions**, and
  `get_defi_positions` read one page. Both read every page, and the total is
  null when not every position could be read.
- **`analyze_multisig` read a wallet's oldest transactions** to decide which
  keys are live. It reads the newest.
- **`compare_oracle_price` read Pyth at the candle's open** while the market
  price is its close. Without `PYTH_API_KEY` it now says nothing was compared
  instead of reporting zero flagged candles.
- **The 24h price change was 0 for every coin.** Aftermath's field is always
  0; `get_token_prices` and `analyze_token` take the change from DefiLlama.
- **`find_pools` showed at most 10 pools per type**, never matched Turbos,
  missed DeepBook v3, reported every pool in the query's token order, and read
  a failed search as no pools.
- **`search_token` could miss the real coin** behind impostors with the same
  symbol. Verified coins come first and each result says whether it is
  verified.
- **`query_transactions` with `all_versions`** failed on lineages of more than
  10 versions with "Query has over 300 nodes".
- **`sample_control_addresses` and `summarize_incident_losses`** resolved a
  time window to the nearest checkpoint instead of the checkpoints stamped
  inside it, as the other windowed tools do.
- **Signatures dropped `&` and `&mut`** in `get_package` and
  `analyze_package`, and `get_move_function` named every type parameter
  `typeParameter`.
- **`get_package_dependency_graph` missed dependencies used only inside
  function bodies.** It reads each package's linkage table.
- **`check_coin_restrictions` reported `globally_paused: null`** for a coin
  that never set a pause. It is false; null means the deny list was not read
  to the end.
- **`list_nfts` ignored `limit`**: `limit: 1` returned 50 NFTs.
- **`get_chain_info` left out the reference gas price** its description names.
- **`resolve_name`** now tells an unregistered or expired name (null, with a
  note) apart from a malformed name or a failed lookup (errors).
- Inputs that tools answered as if they were valid are refused: a malformed
  coin type, a time of `"-5"` (read as a date in 6 BC), `"1e309"`, a u64 over
  2^64-1, trailing bytes in `decode_ptb`, both `address` and `object_id` in
  `check_activity`, a non-pool object in `get_pool_stats`, a non-package in
  `resolve_protocol_packages`, an absent `value_field` in `aggregate_events`,
  and `""` in `classify_deposit_address`, which classified the zero address.
- `analyze_token` refuses a coin type that does not exist, and
  `decompile_module` without a decompiler binary no longer suggests another
  network.
- Argument errors are one line of at most 600 characters and carry no control
  characters from the input.

## 1.19.1 (2026-09-25)

### Fixed
- **`disassemble_module` showed the latest version's bytecode for every
  version.** GraphQL's `package(address:)` resolves any version's address to
  the newest version in its lineage, so disassembling Nemo v1 showed
  `redeem_pt`, which v5 added. Module lists and disassembly now read the
  package stored at exactly the address given, and so does `analyze_package`
  with `include_disassembly`. `get_move_function`, `get_package` and
  `analyze_package`'s summary read over gRPC and were already exact.
- **`export_case`'s diagram left out value taken from protocols.** A transfer
  was drawn only when an address paid it, and the Nemo markets that paid the
  attacker are shared objects, so the exploit had no arrow at all. Value a
  case address received that no address paid is now drawn from a node for the
  protocols the transaction called, and value it paid that no address
  received is drawn into one, so a swap shows both legs.

### Changed
- The `investigate_address` and `trace_incident` prompts, the server
  instructions and the forensics skill route through the tools added in
  1.19.0: `summarize_address_flows`, `trace_flow_graph`, `find_flow_path`,
  `classify_deposit_address` and `get_upgrade_history`. The skill no longer
  says the shipped label set is nearly empty.

## 1.19.0 (2026-09-25)

Two public incidents were replayed end to end through the server: the Cetus
exploit of 22 May 2025 and the Nemo exploit of 7 September 2025. Both runs,
together with an audit of address balances and of the tool surface, found reads
that were cut short without saying so, lists that started at the wrong end, and
traces that stopped or went the wrong way. Every such defect below was
reproduced on mainnet before it was fixed and checked again after.

### Added
- **`analyze_attack_tx`.** Breaks down one exploit transaction: each address's
  net per coin and in USD at block time, flash-loan and flash-swap legs paired
  from borrow to repay, every swap's pool price before and after, what each
  pool lost according to its own events, oracle calls and Pyth updates inside
  the PTB, anomaly flags, and the attacker's profit. It reads the whole
  transaction over gRPC with archive fallback, so the Nemo exploit's 214
  commands and 103 events are all read.
- **`summarize_incident_losses`.** Totals an attacker's take across a digest
  list, or across a sender's transactions in a window, grouped by the pool each
  transaction drained and priced at the time of the attack. Over the 265 Cetus
  exploit transactions it reports $193.7M across 103 priced coins and lists the
  92 it could not price, so the total is marked as a lower bound.
- **`summarize_address_flows`.** One address over a window: per coin in, out
  and net with USD; every address that paid it; the top recipients with
  identity and labels; gas sponsorship in both directions; and every bridge
  exit grouped by bridge and destination, with the far-side beneficiary. Both
  replays needed this and had to page hundreds of transactions to get it.
- **`trace_flow_graph` and `find_flow_path`.** The graph follows every branch
  of the funds from a transaction, or from an address after a time, and
  allocates the traced value across recipients in proportion to what each
  received. It returns nodes, edges with USD and digests, and `terminals`
  grouped by why each branch ended (bridge exit with beneficiary, sink, hub,
  unspent, deposit) with the share that ended there. `find_flow_path` searches
  for a value path between two addresses, including to an EVM or Solana
  account a bridge exit paid, and says what it explored when it finds none.
- **Graph export.** `format: mermaid | graph_json | csv` on `trace_flow_graph`,
  `find_flow_path`, `trace_funds` and `build_wallet_edges`. `export_case` with
  `format: mermaid` appends a fund-flow diagram of the findings' transactions.
- **`get_upgrade_history`.** For every version of a package: the publish
  transaction, sender, the sender's signing scheme (single key, zkLogin,
  passkey, or multisig with the members that signed), who held the UpgradeCap
  at that moment, and dependency relinks. It flags a cap round trip, an upgrade
  signed by a single key while a multisig usually holds the cap, policy
  changes, and a cap that was destroyed, wrapped, frozen or shared. `as_of`
  says who held upgrade authority at a given time. On Nemo it finds the
  eleven-minute loan of the cap to a single key during which the vulnerable
  version shipped, and that the single key held the cap again at the time of
  the exploit.
- **`screen_address`.** Direct and indirect exposure (default 2 hops) to
  labelled malicious, exchange, bridge and mixer accounts, and to sanctioned
  accounts on the far side of bridge exits, with path digests, amounts and each
  label's source.
- **`classify_deposit_address`.** Decides whether an address is an exchange
  deposit address from full-balance sweeps to one hot wallet, relayer-paid
  sweep gas and a labelled or hub-shaped destination. Tier: heuristic.
- **Shipped first-party labels.** Binance, OKX, Bybit and KuCoin
  proof-of-reserves wallets; Wormhole, Circle CCTP, Sui Bridge and Mayan
  objects from their deployment docs; and the Cetus and Nemo attacker addresses
  named in those protocols' own incident reports. Each entry records entity,
  evidence kind, source URL and retrieval date, and every tool that shows a
  label shows where it came from. `npm run sync:disclosed-labels` regenerates
  the set from the source documents.
- **Sanctions and blocklist data.** The OFAC SDN digital currency list
  (`npm run sync:sanctions`) contains no Sui addresses, and `screen_address`
  says so; hits can only come from bridge beneficiaries. The Sui wallet
  blocklist (`npm run sync:guardians`) appears as `flagged_by`, tier
  third-party, in `analyze_token`, `analyze_package` and `identify_address`. It
  is never a label or a sink.
- **Historical USD without a key.** DefiLlama answers `get_token_prices` with
  `at`, the per-hop USD in `trace_funds` and the new tools, and fills current
  prices Aftermath does not list. SUI at the Cetus exploit prices at $4.16.
- **Historical balances.** `get_balance` takes `at` (ISO) as well as
  `at_checkpoint`, and reconstructs a balance older than GraphQL's consistent
  range (about an hour) from the owner's balance changes since then. `method`,
  `transactions_scanned` and `complete` say how it was derived; when the scan
  budget runs out the balance is null rather than a partial sum.
- **Bridge coverage.** `resolve_bridge_transfer` and `trace_funds` now handle
  LayerZero V2 (destination endpoint, GUID and the OFT recipient), Axelar ITS,
  Allbridge Core, Celer cBridge and Mayan Swift, with recipients read from the
  Sui events. Meson is detected, and says its destination cannot be read from
  chain data. Wormhole transfers arriving on Sui are reported under
  `wormhole_inbound`.
- **`aggregate_events` `group_pnl`.** Ranks the senders of the matched
  transactions by their own balance changes and USD, and marks PTBs that also
  called packages outside the filtered protocol.
- **Address balances are reported.** `get_balance` and
  `get_wallet_overview` split each total into `coin_balance` and
  `address_balance`. `identify_address` and `get_object` list funds an object
  holds in its own address balance (a bridge bank holds ~118k USDC this way).
  `get_transaction` reports `address_balance_ops`, `funds_withdrawals` and
  `gas_source`, and `decode_ptb` shows a `FundsWithdrawal`'s amount, coin and
  source.
- **`subject_flow` on history and timeline rows**, the queried address's own
  signed change per coin. `token_flow` is the sender's, so a transfer the
  address received used to read as the sender's outflow.
- **`subject_paid_subject` in `find_funding_sources`**: every payment one
  subject made to another, with digests and amounts, not only first fundings.
- **Ordering and windows.** `order: newest | oldest` on
  `get_transaction_history`, `query_transactions` and `query_events`; ISO times
  in their checkpoint bounds; `get_checkpoint {timestamp}`;
  `query_transactions` `all_versions` to read calls across a package lineage
  as one list; `check_activity` `cursor`.
- **Arguments.** Address arguments accept SuiNS names (echoed as
  `resolved_from`), any case, and short hex. `get_balance` and
  `list_owned_objects` accept `address` for `owner`, and a single string is
  accepted where a list is expected.
- **`save_finding` takes `evidence_tier`** (`chain-derived`,
  `indexer-attested`, `heuristic`) and `digests`; `export_case` groups findings
  by tier.
- **`diff_package_upgrade`** lists added and removed functions, visibility
  changes, and `linkage_changes`. The Cetus fix was a dependency relink
  (integer-mate v3 to v5), which the diff now names together with the call
  that diffs the dependency.
- **`analyze_package`** reports `root_publisher`, `version_publisher` and an
  `upgrade_cap` summary.
- **MCP surface.** Every tool has a title and annotations, with the store
  writers marked non-read-only. The main investigation tools return
  `structuredContent` and declare `anthropic/maxResultSizeChars`. Prompts
  `investigate_address`, `trace_incident` and `attribute_cluster` carry the
  forensics skill for clients without skills. `sui://case/{name}` renders a
  recorded case, and server `instructions` name the profiles and the main
  tools.
- Nemo is in the protocol registry.

### Fixed
- **Transaction reads stopped at 20 balance changes and 20 commands.** GraphQL
  pages nested connections at 20, and reads across the server took the first
  page as the whole list. `FujboNeQt8Nbb…` has 202 balance changes and the sender's debit
  sorted past the 20th, so history showed no flow for it and a trace ranked
  the next hop from a partial set; on the Cetus attacker it produced the wrong
  funding origin. Every read now completes both lists, or says it could not.
- **"Recent" meant oldest.** `get_wallet_overview.recent_transactions`,
  `get_transaction_history`, `query_transactions` and `query_events` returned
  an address's first transactions, so a wallet active today showed rows from
  2024 and the history's address-poisoning check never saw recent activity.
  They are newest first now.
- **Time windows came back empty.** `build_timeline` and `check_activity`
  fetched the address's oldest transactions and then filtered them by time, so
  a one-day window on a busy wallet returned nothing and the Cetus
  12:36–12:39 window returned 3 of its 6 transactions. The window is now in the
  query, and a timeline says when its per-address budget cut the walk short.
- **`trace_funds` reported false bridge exits.** Every Pyth price update calls
  Wormhole's `vaa::parse_and_verify`, so a plain NAVI deposit read as "Value
  left Sui via Wormhole". Exits routed through a wrapper, such as Mayan's
  `bridge_with_fee`, were missed because no event types were checked.
- **`resolve_bridge_transfer` named the bridge contract as the destination.**
  54.4M of the Cetus attacker's 61.3M USDC went through Mayan, and the tool
  named Mayan's settlement contract instead of the attacker's Ethereum address
  `0x89012a55…`. The recipient is now decoded from the Sui transaction into
  `beneficiaries` for Wormhole Token Bridge, the Token Bridge Relayer, NTT,
  Mayan, CCTP and the native bridge, and the contract is
  `redeemed_via_contract`.
- **Backward traces followed the wrong money.** They took the oldest of the
  last five transactions, including the address's own outflows, and reported
  cycles that did not exist. They now follow whoever paid the coin in, list the
  other payers as `unfollowed_sources`, and stop at hubs.
- **Forward traces stopped silently or wandered.** An exploit transaction that
  credits only the attacker ended the trace at hop 1 with no reason, as did a
  protocol deposit and value sent to an object. A trace also followed the
  recipient's next transaction whatever it moved. Traces now follow the
  tracked coin, follow the actor through self-credits and swaps, follow value
  out of objects (`Receiving<T>`, object address balances), name the protocol
  a deposit went into, and always set `stop_reason`. `coin_type` accepts
  `0x2::sui::SUI`, and small USDC flows are no longer shown as gas.
- **A wallet labelled malicious ended a trace.** With the attackers now
  labelled, both exploit traces stopped at the attacker. A malicious label
  marks the wallet being followed; exchanges, bridges, mixers and burn
  addresses still end a trace.
- **A transaction the sender did not sign was attributed to the sender.** The
  Cetus recovery moved 24M SUI out of an attacker address under a 31-of-64
  multisig's signature. `get_transaction` now reports
  `signer_is_sender: false` and `authorized_by`, `identify_address` no longer
  says such an address never sent a transaction, `analyze_multisig` sees the
  multisig signatures, and a trace stops at the hop.
- **`analyze_multisig` never finished on an ordinary wallet.** It paged the
  whole history looking for multisig signatures. It now stops at the
  address's own single-key signature.
- **Funding walks went past exchanges.** `find_funding_source` walked through
  a funder that pays hundreds of addresses and called its 2023 ancestors a
  narrow, meaningful origin. It now stops at a funder over the
  50-recipient limit `build_wallet_edges` uses. `find_funding_sources` no
  longer counts a chain twice when it runs through another subject, and a dead
  end keeps its `dust_skipped` list and reports who sponsored the address's
  gas.
- **Holder rankings missed address balances.** On XAGM a ranking marked
  `complete_ranking: true` left out the #2 holder, whose 13.74% of supply sits
  in its address balance, and USAD, held entirely in one, reported no holders.
  Both walks now run, and a ranking is complete only when both finish.
- **Address-balance writes were counted as changed objects** in
  `get_transaction`, and objects minted to someone else were reported as
  nothing changing hands.
- **`build_transfer` failed for a coin held only in the address balance.**
- **A SuiNS name someone else sent was reported as the holder's alias.** A
  third party sent the Cetus attacker a taunting name after the freeze; it is
  now reported as received from that address.
- **Upper-case or short addresses changed conclusions.** They turned a funding
  trace into a dead end, a fan-out into zero counterparties and a validator
  into a wallet.
- **`null` meant zero.** `limit: null` returned an empty page with
  `has_next_page: false`, and `hops: null` traced nothing.
- **Failed reads looked like empty wallets.** `get_wallet_overview` and
  `identify_address` now report a failed read as unknown or as an error,
  never as zero.
- **One rate limit lost a whole investigation.** GraphQL requests retry 429,
  5xx and dropped connections with backoff, time out after 30s and run at most
  8 at a time per network. Errors are one line.
- **`diff_package_upgrade` showed no changes.** The sample was the top of each
  module; on Nemo v9 to v10 it held no changed line. It is now unified hunks
  with the changed lines first.
- **`analyze_package` judged the UpgradeCap against the wrong publisher**, and
  so said a cap that had left the deployer was still held by it.
- **Party objects were reported as shared**, dropping the one address that can
  use them.
- **`query_events` returned nothing for an event type written with an upgraded
  package ID.**
- **`get_transactions` labelled every failure `MOVE_ABORT`.**
- **Coins were named by their struct name**, so ten Wormhole assets all read
  `COIN`.
- **A gas sponsor's storage rebate counted as a payment** in fan-out
  measurements and co-funding counts.
- **`identify_address` called a wrapped or deleted object's id a wallet.**
- `save_finding` and `manage_labels` stored malformed addresses; hints named
  tools that do not exist; `enable_tools`' description was cut off past 2,048
  characters.

### Changed
- `trace_funds` reports `stop_reason` on every trace, replacing
  `stopped_at_sink`.
- The pagination argument of `get_transaction_history`, `query_transactions`
  and `query_events` is `cursor` (was `after`), and pages run newest first.
- `resolve_bridge_transfer` moves the redeeming contract from
  `destination.account` to `destination.redeemed_via_contract`.
- `analyze_package` and `get_package` return a per-module summary by default;
  `detail: 'full'` or `modules: [...]` returns struct shapes and signatures.
  `analyze_package` on `0x2` went from 272k to 34k characters.
- `find_funding_sources` returns the origin, first funder and first hop per
  result; `include_chains: true` returns every hop. `max_hops` defaults to 5,
  as in `find_funding_source`.
- `aggregate_events`' `window` is `{from, to, after_checkpoint,
  before_checkpoint}`.
- `build_transfer` no longer returns `coins_used`; the SDK picks the coins.
- Numeric limits are in the schemas, so an out-of-range value is rejected
  instead of clamped.
- Every price names its source, confidence and sample time, and marks a sample
  more than an hour from the requested time as `stale`. Pyth is asked only
  about verified coins, since its feeds match by symbol.
- The injected `network` argument has a one-line description, and
  `list_findings`, `export_case` and `delete_finding` no longer take it.
  `enable_tools` sends one `tools/list_changed` per call and accepts profile
  names in any case.
- `check_coin_restrictions` notes that a freeze by validators, such as the
  Cetus freeze, is node configuration and appears in no deny list.

### Migration
- Cached fan-out measurements are discarded on first use and measured again,
  because the recipient count no longer includes gas sponsors.
- Existing stores gain the `evidence_tier` and `digests` columns on open.
  Earlier findings keep an unstated tier.

## 1.18.0 (2026-09-21)

### Added
- **`get_transaction` reports what a transaction touched.** `object_changes`
  counts the objects changed, created and deleted, and `object_transfers` names
  anything that changed hands, with each party's owner kind so a kiosk is not
  reported as a wallet. A balance change is derived from `Coin<T>`, so an NFT, a
  capability or a DeFi position moves without producing one. The response
  already carried this data and the tool was not reading it.

- **`command_count` on `get_transaction`.** An empty `actions` array covered
  both a transaction that ran no commands and commands that would not decode.
  Found on a real mainnet transaction that ran zero commands, moved no coin and
  reported nothing at all: it was one of hundreds fired by a market-making bot
  to manage a pool of gas coins.

### Fixed
- **The guard on `decimals_source` tested a copy of itself.** The tier decision
  was re-implemented inside the test file, so reintroducing the defect it
  guards left the whole suite green while `analyze_token` went back to
  reporting an assumed scale as `curated`. The decision is now an exported
  function the test calls, and the mutation that used to pass now fails two
  cases. No behaviour change.

## 1.17.0 (2026-09-15)

### Added
- **`identify_address` reports address aliases.** `0x2::address_alias` lets a
  wallet authorize up to eight other addresses to act for it, so a committee
  being unable to rotate no longer means the committee is the only way to move
  the funds. The set replaces the signer rather than extending it, so
  `owner_can_authorize` says whether the wallet's own key can still sign for it:
  50 of the 63 mainnet sets are wallets that can no longer authorize for
  themselves. `delegated_to` is the set without the wallet itself, since
  enabling the feature seeds it with the wallet's own address and an empty
  `delegated_to` means nobody else was authorized. Reported as control rather than shared ownership, since a
  custodian holds authority for a client, and a failed lookup is reported as
  unknown rather than as an absence of delegation.

- **`analyze_token` reads the on-chain coin registry.** `0x2::coin_registry`
  (state at `0xc`) is Sui's canonical home for coin metadata, and it now
  supplies decimals when `CoinMetadata` has none. `decimals_source` names where
  the scale came from, across five tiers: `coin_metadata`, `coin_registry`,
  `curated`, `symbol_scan` and `assumed`. A coin nothing knows about says
  outright that 9 was assumed rather than reporting the guess silently, and a
  symbol reached by scanning on-chain metadata is not reported as curated. A wrong scale misstates
  every amount derived from it, and 47 of 289 sampled impostors declare a
  different scale from the coin they imitate.

  The registry also states whether a coin is regulated and names the cap that
  can freeze holders. Presence in it is **not** a vouch: anyone who can publish
  a coin can register it, so `verified` still means only that the curated list
  vouched for the coin.

### Fixed
- **Two documented invariants were false.** The forensics skill and CLAUDE.md
  said an address has exactly one authenticator forever and that a multisig
  committee cannot rotate. Both still hold for derivation, and neither holds
  for who can spend. A report resting on them was wrong rather than
  incomplete.

## 1.16.0 (2026-09-14)

### Added
- **`watch_addresses` and `poll_watch`.** Record a set of addresses during an
  investigation and collect only what is new since the last poll. An empty poll
  is 13 tokens and one request; a hit names the address, digest, checkpoint and
  why it fired, never the transaction itself. Watching starts at the current
  checkpoint, so adding an address does not replay its history. `min_amount`
  filters coin movements only — a labelled sink or a transfer that moves no
  coin is reported whatever its size — and an address that fills the per-poll
  cap is listed in `more_pending` rather than silently truncated. Requires
  `SUI_STORE_PATH`.

  Hits carry a reason: `value_in`, `value_out`, `capability_moved`,
  `object_moved`, `sink_reached`, `lookalike_appeared` or `appeared`. Detail
  reads object changes as well as balances, because a capability changes hands
  without producing a balance change — the transfer most worth waking someone
  for. The lookalike check costs no request.

- **NFT marketplaces in the protocol registry.** TradePort (six packages),
  BlueMove, Drip (two) and OriginByte now resolve by name, so a marketplace sale
  in a trace is attributed instead of showing as an unknown package. A Move type
  keeps the package that defined it, so older sales carry older ids and every
  generation is needed. The registry is 96 protocols, 11 of them `nft`.

### Fixed
- **A failed cache write no longer fails the read.** `get_address_fanout`
  aborted with `NOT NULL constraint failed: fanout.sponsored_address_count`
  when a server left running across a rebuild wrote into a migrated database.
  The fan-out had already been measured. Cache and cursor writes now return a
  falsy value and log to stderr instead of throwing. `save_finding` deliberately
  still throws, because there the write is the operation rather than a side
  effect of one.

- **One bad address no longer costs a whole poll.** Watched addresses are
  validated before they are stored and again when they are read back. A delta
  query batches twenty addresses into one document and the service answers a
  single unparseable address with no data at all, so one typo returned nothing
  for every other watched address. `watch_addresses` now reports what it
  rejected, and what it actually wrote — the count came from the input before,
  so a failed write still read as watched.

- **`get_top_holders` no longer reports a coin as an empty collection.** With no
  `mode` given, a type that is neither `Coin<T>` nor a known symbol was scanned
  as NFTs, and an ordinary memecoin type came back `unique_holders: 0`. The
  mode is now settled by asking whether a `Coin` of that type exists.

- **`get_top_holders` counts NFTs whose owner it cannot resolve.** They were
  dropped, so holder counts silently described less than the supply — 4 of 2,555
  on one mainnet collection. They are reported as `unresolved_owners`. The coin
  walk now counts them too.

- **A holder scan stopped by a null cursor is reported as a sample.** The guard
  that prevents the walk restarting from page one left the scan marked
  complete, so a known-incomplete result carried ranks and percentages of
  supply. `complete_ranking` now means the walk reached the end.

- **A holder scan that found nothing no longer claims a complete ranking of
  zero holders.** Zero objects reads the same as a mistyped type, a type from
  another network, or a coin scanned as a collection, and the result says so
  instead. `max_scan` and `limit` are clamped at both ends: `max_scan: 0`
  previously made no request at all and reported a complete ranking.

- **`poll_watch` no longer loses transactions at a page boundary.**
  `afterCheckpoint` is exclusive per checkpoint while the page cap cuts per
  transaction, so a full page usually ended part-way through a checkpoint and
  the rest of it was excluded from every later poll. Measured on one mainnet
  address: 30 transactions over 13 checkpoints, 8 holding more than one. The
  cursor now stops one checkpoint short of a full page, and an address whose
  full page sits inside a single checkpoint is reported as `stalled`.

- **`lookalike_appeared` only fires against a watched address.** Two
  counterparties resembling each other were reported as impersonating the
  address under investigation.

- **Watched addresses are normalized when read back, not only validated.** A
  row holding a short form such as `0x2` matched none of its own balance
  changes, so it appeared as its own counterparty and `min_amount` never
  applied. `min_amount` is also validated: `"0.5"` silently removed the floor.

- **Tools no longer report a write that failed as success.** `manage_labels`
  remove, add and import, `watch_addresses` remove, and `delete_finding` all
  derive their result from the write. A label whose store delete failed comes
  back at the next start, and for a `cex` label that silently keeps terminating
  traces. `delete_finding` reported success for an id matching nothing.

- **`get_nft_sales`.** Marketplace sales over a bounded recent window, with
  volume and per-marketplace totals. Reads TradePort, BlueMove and OriginByte.
  Measured on mainnet, a 24-hour window across every registered marketplace is
  13 requests for 237 sales and 5,982 SUI. `collection_type` narrows the result
  where a marketplace names the collection in its event, which most do not, so
  the sales it cannot judge are reported as `unattributable_sales`. `events` has no
  collection filter, so the window is bounded and says so rather than paging a
  marketplace to exhaustion.

  Its other output is the useful one: a sale names the buyer and the buyer's
  kiosk in the same record, so every sale is a chain-derived statement of who
  held a kiosk. Those are stored, and `get_top_holders` now resolves a
  kiosk-held NFT to that wallet instead of the kiosk's own declared owner.
  Verified end to end: nine mappings resolved eleven NFTs in one collection
  scan, which then ranked as `holder_kind: "kiosk_resolved"` — chain-derived,
  but a snapshot at the sale's checkpoint rather than a current read.

- **Kiosk-held NFTs are marked, not silently credited.** `get_top_holders`
  attributes them through the kiosk's own `owner` field, which is self-declared
  and is not updated when the `KioskOwnerCap` moves. Measured over 300 mainnet
  kiosks it disagreed with the real cap holder 40% of the time, and one address
  was declared by 82 kiosks, so an unmarked scan invented a top holder. Each
  holder now carries `holder_kind` and a `from_kiosk_owner_field` count, with a
  caveat naming the reliable resolution.

- **The NFT holder scan reads `ConsensusAddressOwner`**, which it would
  otherwise count as an unresolvable owner. No mainnet object sampled reports
  it today; the rest of the server already selects it.

- **`get_object` reads the Display standard.** An NFT's name and image live in
  `0x2::display::Display<T>`, which is registered per type and is not in the
  object's own fields, so the tool promised display metadata and returned none
  for the collections it was written for. The struct's fields are still
  preferred, and `display_source` says which answered.

- **`collection_name` is refused off mainnet.** The collection registry is
  keyed by package id, so resolving a name on another network scanned it with a
  mainnet type and reported the collection as empty.

- **A watch no longer stalls on a single new transaction.** Saturation was
  inferred from a full page, but at `max_per_address: 1` every non-empty page
  is full and sits in one checkpoint, so the cursor never advanced and the same
  transaction was reported as new on every poll. The delta query now asks for
  one more row than it reports, so "there is more" is proven rather than
  guessed.

- **A watch on a non-canonical stored address advances again.** Normalizing
  rows on read fixed balance-change matching and broke the cursor write, which
  is keyed on the stored spelling. `advanceWatch` now reports whether a row
  actually changed rather than whether the statement threw.

- **`analyze_token` no longer reports a complete ranking of zero holders**, the
  same guard `get_top_holders` received, and it surfaces `unresolved_owners`.

- **One bad address no longer disables multisig detection for a whole batch.**
  `identify_address` and the investigation flows batch twenty addresses into one
  aliased query whose error is swallowed as enrichment, so a single unparseable
  address removed authentication data for the other nineteen.

## 1.15.0 (2026-09-11)

### Added
- **Address-poisoning detection.** `get_transaction_history` and `trace_funds`
  report `address_poisoning` when two addresses in a result are close enough to
  be mistaken for one another — the attack where a lookalike address sends dust
  so that an address copied from history lands on it. A pair is reported when at
  least three characters match at each end. The comparison covers senders, since
  a poisoning address sends rather than receives, and includes the subject's own
  address. In a trace it spans all hops. Where activity does not clearly
  separate the two, the pair is reported with `direction_known: false`.

- **Object flow in `trace_funds`.** A balance change is derived from `Coin<T>`,
  so objects that are not coins — NFTs, kiosk items, DeFi positions, admin
  capabilities — change hands without producing one. `object_flow` and per-hop
  `object_transfers` report those. Transfers of `UpgradeCap`, `TreasuryCap`,
  `DenyCap`, `DenyCapV2` and `Publisher` are marked as carrying control; a
  capability that is burned, frozen or shared is reported as
  `renounced_capabilities` instead, which is the opposite finding. Object
  changes ride the same query the trace already makes, so a trace where no
  object moved is unchanged in size.

### Changed
- **`get_top_holders` and `analyze_token` return `sampled_holders` instead of
  `top_holders` when a scan does not complete**, with no rank and no percentage
  of supply, plus a caveat. A caller reading `top_holders` unconditionally will
  find it absent on a truncated scan. Check `complete_ranking`.

### Fixed
- **`get_top_holders` ranked a sample and presented it as the top holders.** The
  scan walks coin objects in object-id order, which is unrelated to balance, so
  a scan that stopped at its budget returned the largest holder it happened to
  see. Measured on SUI, the reported top holder by `max_scan`: 66 SUI at 200,
  522 at 400, 3,454 at 800, 25,000 at the default 5,000, with no overlap in the
  top five between 200 and 800.

- **Both holder walks could restart and double-count.** A null `endCursor`
  alongside `hasNextPage: true` sent the walk back to the first page, adding the
  same balances again.

### Internal
- Git hooks (`npm run hooks:install`) and a CI job that block a commit whose
  message or staged content matches a configured pattern.

## 1.14.1 (2026-09-10)

Four cases where a tool reported something it could not determine as something
it had. Found by sweeping for the pattern rather than by any single failure.

### Fixed
- **`trace_object_history` named a burn address as an object's creator.**
  Historical object versions fall outside the indexer's retention for anything
  that has sat still, so a long-lived object comes back with one version.
  Truncation was computed as "did the page come back full", which is false when
  the page came back EMPTY — the opposite of what an empty page means here.

  Verified on a real upgrade cap: published by one address, currently owned by
  `0x2`, so it provably changed hands. The tool reported
  `owner_change_count: 0`, `history_truncated: false`, and named the burn
  address as its creator. Three false claims from one missing page. `created`
  is now null, with `history_unavailable` saying the history is beyond
  retention rather than absent.

- **`find_pools` blamed the caller for its own failed query.** Each DEX is
  queried separately and a failure returned an empty list, so that protocol
  silently vanished and the hint said "check that the coin types are correct"
  when the search never ran. Now reports `search_complete: false` and which
  protocols went unqueried.

- **`get_wallet_overview` summed unpriced holdings as zero.** Measured on three
  mainnet wallets: 1 of 3, 46 of 50 and 5 of 15 holdings had no price. The
  middle one reported a total of $1.86 for a wallet holding fifty coins. The
  total now says how much of the wallet it covers, and what an absent price
  usually means — no market price and nothing vouching for the coin is the
  usual shape of a spam or impersonation token, though a newly listed asset
  looks the same. That tool was also still naming coins by their struct name,
  so a fake USDC displayed as `USDC`; holdings now carry `verified`.

- **A paginated walk could restart from page one, or never return.** A
  connection can claim `hasNextPage: true` and hand back a null `endCursor`.
  `move-package.ts` pages with `for(;;)`, so that was an infinite loop reached
  by `analyze_package`, `disassemble_module` and `package-audit`. Loops bounded
  by a target terminated but re-read page one, double-counting timeline
  entries, kiosk NFTs, signer-set frequencies, event rankings and denied
  addresses. Nine call sites guarded.

### Added
- **A weekly Drift workflow.** The offline tests pin real mainnet signatures as
  fixtures, which is what makes them fast and deterministic — and exactly why
  they cannot notice that the chain, the SDK or the Sui GraphQL schema moved
  underneath them. `npm run verify:live` is the only thing that catches it, and
  it ran when somebody remembered. It now runs weekly and opens one issue on
  failure, commenting on it thereafter rather than filing a duplicate. Not in
  CI: it needs the network, and a flaky required check teaches people to ignore
  failures.

## 1.14.0 (2026-09-10)

Investigations can now say who controls a wallet, who wrote the code, why a
transaction failed, and whether the asset they followed is the real one.

### Added
- **Multisig identity, chain-derived.** A Sui address is the hash of its
  authenticator, so a multisig's committee travels inside every transaction it
  sends. `identify_address` reports it and expands each member; `analyze_multisig`
  says which keys are live and which have never signed; `find_shared_multisig`
  searches backwards from known keys to a treasury; `get_transaction` names the
  keys that signed one transaction. `build_wallet_edges` gains a `co_signer`
  signal, and clusters built only from it are `chain-derived` rather than
  `heuristic`.

  Burned into the design: the committee cannot rotate, an address has one
  authenticator forever, and a wallet that has never SENT cannot be classified
  at all — which surfaces as an explicit unknown rather than "ordinary wallet".

- **Why a transaction failed.** `formatStatus` reduced every failure to
  `failure: command=1`. `get_transaction` and `get_transactions` now report the
  abort code with the package, module and function that raised it, from data
  already in `effects` — no extra requests. Notes are attached only where a
  kind's name misleads: a congestion cancellation means the transaction was
  never invalid, and `ADDRESS_DENIED_FOR_COIN` records an issuer's decision
  rather than a protocol rule.

- **Package publisher attribution.** `analyze_package` and `identify_address`
  report who deployed a package — the field that turns an unknown package back
  into an address a trace can follow. Attributed to the lineage ROOT, since an
  upgrade's creating transaction names the upgrader rather than the publisher,
  and resolved through the archive because publish transactions are usually
  pruned.

- **Upgrade-cap holder status.** Whoever holds an `UpgradeCap` can replace a
  package's code, and reporting only the current holder is not a finding.
  Compared against the publisher it becomes one. `burned` and `transferred` are
  kept distinct deliberately: 20% of mainnet caps are not with their publisher,
  but 27 of every 30 of those went somewhere unspendable, which is the
  responsible choice. A single "the cap moved" flag would have fired on a fifth
  of all packages.

- **`check_coin_restrictions`** reads the on-chain deny list — which addresses
  an issuer froze, or whether one address is frozen anywhere. Mainnet has ~1,250
  coin types with a deny config. A denial is epoch-scheduled, so an entry
  written this epoch is reported as pending rather than in force, and a lifted
  one is not reported at all.

- **Sponsorship breadth** on `get_address_fanout`. Paying gas moves none of the
  sponsor's own value, so a relayer looks narrow by balance changes and is
  anything but. Measured free on the scan that was already running.

### Changed
- **A coin's symbol no longer identifies it.** `resolveTokenBySymbol` scanned
  on-chain metadata and stopped at the first exact match, so "USDC" resolved to
  an imitator named "USDC v2 (complete bridge: usdv2.com)" rather than Circle's
  issue. 8,008 mainnet coins share a symbol with another; 585 claim `SUI`.
  Symbols now resolve against a curated registry, seeded from Aftermath's
  verified list by `npm run sync:verified-coins` and refreshed at runtime under
  rules that can only ever add.

  **Behaviour change:** `analyze_token` on an ambiguous symbol returns
  CANDIDATES rather than a coin. Seven symbols are ambiguous among legitimate
  verified coins — Circle's USDC, Wormhole's and Celer's all exist — and picking
  one silently would misreport which asset moved. Pass a full coin type to get a
  single answer.

- **Amounts are scaled by coin type, not by the name of the struct.** Decimals
  were keyed on the last segment of the type, so anything ending `::sui::SUI`
  was rendered with real SUI's 9 decimals. Of 289 unverified coins whose struct
  name matches a hardcoded symbol, 47 declare different decimals — a fake SUI
  with 0 would have reported every amount 10^9 out. Traces now carry
  `coin_verified` per balance change, and an amount scaled by a guess says so.

- **`evidence_tier` moved from the response root onto each cluster** in
  `build_wallet_edges`, since a cluster built only on co-signature is read from
  the address hash rather than inferred from behaviour.

- **A narrow sponsor reading is provisional when the scan was truncated.**
  Breadth only grows with the window; on one mainnet sponsor the count went 1 to
  86 between a 100- and an 800-transaction scan, crossing the threshold.
  `relayer` is proven by what was seen and is never marked provisional.

### Fixed
- **A malformed transaction digest** was passed straight to gRPC, which threw a
  transport error about Base58 length — indistinguishable, to a reader, from the
  transaction not existing. It is now rejected before the request, with a
  message saying so. The realistic input is an object ID.

- **Checking whether one address is frozen** looked only at the coins it holds.
  Freezing and holding are anti-correlated: an issuer freezes an address and it
  ends up holding none of that coin. Measured, that found 11 restrictions where
  a full scan finds 58.

### Internal
- Tool count 62 → 65. `npm run verify:live` runs six live checks against
  mainnet — regenerate signature fixtures, hostile input, a chained
  investigation, and cross-tool consistency. Not in CI; run it after an
  `@mysten/sui` bump, after a Sui GraphQL schema change, and before a release.
- The `scripts/probe/` directory went from 70 one-off scripts to six with a
  trigger.

## 1.13.0 (2026-09-10)

Multisig wallets are now legible: who is on the committee, which of them
actually sign, and who signed a given transaction.

### Added
- **Multisig identification, chain-derived.** A Sui address is the hash of its
  authenticator, so a multisig's threshold, member keys and weights are part of
  the address itself and travel inside every transaction the wallet sends.
  Membership is derived and checked against the address rather than inferred.

  Nothing could see this before: an address with no object at it classified as
  `wallet`, so a treasury multisig and a personal wallet gave the same answer.
  `identify_address` now returns `authentication`, and expands each committee
  member into its own identity — name, labels, SuiNS history. `trace_funds`,
  `find_funding_source`, `find_funding_sources` and `build_wallet_edges` carry
  the same enrichment.

  Three properties are the opposite of the EVM intuition and are documented at
  the point of use. The committee cannot rotate — changing a member changes the
  address, so a member key is permanent. An address has exactly one
  authenticator for its whole life. And a wallet that has never *sent* cannot be
  classified at all, which surfaces as an explicit "unknown" rather than as an
  ordinary wallet: a receive-only treasury multisig is indistinguishable from a
  fresh personal wallet until it spends.

  zkLogin and passkey wallets go through the same path. zkLogin reports its
  OAuth issuer, which is all the chain discloses about the account — the address
  seed is one-to-one with the address and cannot link a person's wallets.

- **`analyze_multisig`** — which committee keys are live, which have never
  signed, and how the signer set moved. The committee is fixed, so the signer
  bitmap is the only thing that varies between transactions, and one
  transaction cannot interpret it. Measured on a mainnet 4-of-7: eight
  transactions, three distinct signer sets, two of the seven keys with no
  signature at all. Every claim is reported against `transactions_examined`,
  because "never signed" over 8 transactions and over 200 are different claims.

- **`find_shared_multisig`** — given addresses a trace has already linked,
  derive every committee those keys could form and return the ones that exist
  on chain. A hit is proof rather than a resemblance. It finds treasuries that
  never appeared in the trace, since a multisig is only visible if it happened
  to transact with something already examined.

  Two limits are in the output, not just the docs. Member order is part of the
  address, so the search is factorial and refuses past five keys — a truncated
  search cannot support the negative it is asked for. And it covers equal-weight
  committees only, so a nil result means "no equal-weight multisig of these
  exact keys", never "these addresses share no multisig".

- **`authorization` on `get_transaction`** — which keys signed *this*
  transaction and which committee members did not, plus the gas sponsor when
  one paid. A member under `did_not_sign` is still authorised and may have
  signed others; the response says so.

- **`co_signer` clustering signal** on `build_wallet_edges`, weighted 1.5 for a
  key that can spend a wallet alone. It is the only signal here that is not
  behavioural — the others say two addresses did something co-controlled
  wallets tend to do, measured against a base rate, while this says the
  committee hashes to the address and the key is in it.

  Two guards, both load-bearing. A multi-party committee is evidence its members
  are *separate* parties — that is what a 4-of-7 treasury is for — so edges run
  member-to-multisig in a star, never member-to-member, and a member who cannot
  spend alone is weighted below the merge floor. And a co-signing key can be a
  service: a wallet provider's recovery key sits on one committee per customer,
  which without a popularity filter links every customer of that provider into
  one cluster. Measured on mainnet: one key on 31 committees produced a
  63-member cluster of unrelated people; with the filter, 31 two-member
  clusters. Excluded keys are reported in `excluded_co_signers` rather than
  dropped — that such a key can spend 31 wallets is itself chain-derived.

### Changed
- **`evidence_tier` moved from the response root onto each cluster.**
  `build_wallet_edges` previously tagged its whole output `heuristic`. A cluster
  built only from full-weight co-signature is read from the address hash, so it
  now carries `chain-derived` while behavioural clusters stay `heuristic`, and
  the root field reports which case applies. Weakest link: a cluster that needed
  one behavioural edge to hold together is heuristic however strong the rest is.

  A `chain-derived` cluster still shows **control, not ownership** — a custodian
  holds a key for a client.

- Tool count 62 → 64. The `forensics` profile gains `analyze_multisig` and
  `find_shared_multisig`.

## 1.12.1 (2026-09-04)

### Fixed
- **A rarely-used wallet was reported as automated.** Found by running
  `activity_hours` on a real mainnet wallet: 120 transactions over 292 days —
  0.4 a day — with a flat clock, reported as `automation_indicated: true`.

  It could not have looked otherwise. A hundred and twenty points scattered
  across a year never form a peak, so a 24/7 script and a person who uses a
  wallet twice a week produce the same resultant length. The check asked whether
  activity was flat and never whether the rate made flatness informative, which
  put a confident label on an address that is simply not used much.

  Flatness now requires 3+ transactions a day. Above that, a person keeping
  ordinary hours would have left a shape and its absence means something; below
  it, the reading says plainly that nothing follows either way.

- **A peak inside a single hour now names the scheduled-job alternative.** A
  person's day spreads over several hours, so one hour holding most of the
  activity fits a cron line equally well — and a scheduled job has no timezone
  at all. On the wallet that prompted this, 46% of activity sat in the single
  hour 19:00 UTC, and a reader given only "likely UTC-3" would not have thought
  of it.

Also corrects a test fixture that had been passing on a wrong premise: its
"automated" wallet ran at 1.3 transactions a day, which is an occasional person
rather than a script.

## 1.12.0 (2026-09-04)

Clustering found more of what it was looking for, and timing analysis turned out
to be a bot detector.

### Added
- **Reciprocal flow as a clustering signal.** Transfer volume was excluded
  outright, on the reasoning that everyone pays an exchange so "A sent to B"
  clusters the world together. That is true of one-directional payment and false
  of value coming *back*, and the code never made the distinction.

  Measured on mainnet: across 47 counterparty relationships of ordinary active
  wallets, 1 was reciprocal — a 2.1% base rate. Among four addresses known to
  share an owner, 4 of 6 pairs were. Roughly 32x enrichment, so it is weighted
  level with a shared narrow funder and guarded the same way: a counterparty
  popular enough to be a service is refused, because a deposit to an exchange
  followed by a withdrawal is reciprocal and means nothing.

  The return leg is asked of the counterparty rather than scanned for. A seed's
  bounded window usually shows one direction only, and `probeRecipients` already
  returns who a counterparty paid while measuring whether it is a service.

- **`activity_hours` on `build_timeline`**, which is mostly an automation
  detector. Hours are read as a circle: the count-weighted circular mean gives a
  peak, and the resultant length R gives concentration and doubles as the
  confidence.

  Of 20 sampled active senders, 17 did 400 transactions inside a single day, and
  the 3 spanning a week or more were all flat at R 0.03-0.06 over ~298 days.
  Every wallet that could produce an answer produced "automated", so automation
  is reported directly by two routes: a flat clock over a long span, and a rate
  above 200 transactions a day. The second matters because a burst has no rhythm
  to read and would otherwise be dismissed as insufficient data when it is the
  clearest signal available.

  Volume is not the constraint. Sub-sampling full histories, the verdict agreed
  with the full-sample answer 100% of the time at 30-100 transactions. Finding a
  wallet whose activity spans a week is the hard part.

  A region is not a city, and the same pattern comes from two people who merely
  share a timezone. The reading says both.

- **A `sui-forensics` skill**, shipped in the package. The server gives Claude
  chain access; it does not give it method. The skill carries the evidence tiers
  and what each licenses, the base-rate check that stops shared ancestry reading
  as collusion, which tool answers which question, and the conclusions to refuse.
  Copy it into `~/.claude/skills/`; see the README.

### Fixed
- **A narrow funder was excluded from the cluster it funded.** `funding_edge`
  fired only between two seeds, so a funder discovered on the walk was used as
  the `via` label on the edges between the addresses it funded and then
  discarded — the hub excluded from its own cluster. That made the answer depend
  on what the caller already knew: pass both addresses as seeds and the edge
  appears, pass one and it does not, on identical chain data.

  Seeding one wallet previously reached 4 addresses on a single invisible
  intermediary. It now reaches 7 on three independent ones, including two known
  co-owned wallets whose funding lineage differs and which no shared-funder
  signal could ever have found.

- **MVR names vanished past 50 packages.** The bulk endpoint answers 51+ with
  `400 Batch size limit exceeded`, and the only caller catches that — so the
  failure was silent and total: every name lost, not just the ones past the
  limit, and indistinguishable from a package not being registered. Batching
  transactions in 1.11.0 made it easy to reach, since a batch collects packages
  across every transaction in it. Now chunked, with the error handling per chunk
  so one bad page does not discard the pages already in hand.

## 1.11.0 (2026-09-04)

One new tool (61 → 62): reading many transactions in a single call.

### Added
- **`get_transactions`** — up to 50 digests in one request. An investigation
  rarely arrives at digests one at a time: `get_address_fanout` hands back a set
  of counterparties, `build_wallet_edges` attaches digests as evidence on every
  edge, and comparing branches means reading several at once. Each of those was
  one round trip per digest.

  Measured on ten digests: 0.80s sequentially against 0.10s batched. The latency
  is the smaller half — ten tool calls becoming one saves ten model turns, which
  is the actual reason it exists. Fifty digests return in 0.41s.

  One query carries sender, status, timing, balance changes, Move call targets
  and events with decoded fields, so protocols are identified from both the
  calls and the events without a second request.

  `trace_funds` is deliberately unaffected: a trace is sequential by nature,
  since each hop decides the next.

### Fixed
Cross-checking the new tool against `get_transaction` on 24 real mainnet digests
agreed on 9. Three causes, none visible to unit tests, because those answered
with shapes the real service does not send.

- **System transactions had no sender.** GraphQL reports one as `sender: null`
  while gRPC reports the null address, so the two tools described the same
  transaction differently on 15 of 24. Normalised, and system transactions are
  flagged rather than left looking like a transaction with an unknown sender.

- **`ProgrammableSystemTransaction` is a distinct GraphQL type** that still
  carries real Move calls — framework settlement, randomness. A fragment on
  `ProgrammableTransaction` alone never saw them, so the batch reported no
  protocols where `get_transaction` reported Sui Framework.

- **The batch had no archive fallback.** Mainnet prunes continuously — digests
  sampled 200k checkpoints back disappeared mid-test — so a pruned transaction
  arrived as a null entry indistinguishable from a wrong digest. Misses now
  retry through the same archive path, and a GraphQL failure sends every digest
  there, since `get_transaction` is gRPC-first and would still have answered.
  Only the misses are retried, and one archive miss does not sink the others.

  The archive cannot decode event fields, so recovered events arrive typed but
  unparsed and say so. `get_transaction` has the same limit on a pruned digest.

- **A hollow record is now treated as absence.** A pruned digest can come back
  carrying a digest and a timestamp and nothing else; rendering that as a
  transaction that moved nothing is the failure `trace_funds` already guards
  against.

Malformed digests are rejected before the request, because the server refuses an
entire batch over one bad key — and the Base58 alphabet alone does not catch it,
since 44 ones is valid Base58 that decodes to 44 bytes rather than 32.

## 1.10.1 (2026-09-04)

Package analysis was unreachable from an investigation, in two different ways.
Reported from a real run that fell back to hand-written GraphQL as a result.

### Fixed
- **Package tools were missing from the `forensics` profile.**
  `analyze_package`, `get_package`, `get_move_function` and `disassemble_module`
  sat in `developer` only, so a session running `core,forensics` had no way to
  inspect a package at all. Reading an unknown package is investigation work —
  naming an obfuscated wrapper, reading a protocol's event structs, checking
  what a suspicious package can do — so all four now appear in `forensics` too.
  `decompile_module` stays developer-only, since it needs an external binary.

  This required relaxing an invariant, deliberately: profiles had to be
  disjoint, on the reasoning that disabling one could silently keep a tool alive
  through another. Profiles are additive and nothing ever removes one, so that
  cannot happen. Overlap is now declared, and undeclared duplication still
  fails the test.

- **`enable_tools` rejected the plural form of its own name.** It takes
  `profile`, singular, and refused `profiles: ["developer"]` — which is what
  anyone guesses from a tool called `enable_tools`. The consequence was not a
  retry with the other spelling: the capability was treated as absent and
  GraphQL was written by hand for something a tool already did. Both keys and
  both shapes now work, several profiles can be enabled in one call, and calling
  it with no arguments names the options rather than failing on a schema.

- **The publish verifier raced npm's index.** 1.10.0 published to npm and to the
  MCP Registry successfully and then failed a second later on "No matching
  version found", which marked a good release as failed and skipped the GitHub
  release job behind it. The install now retries while npm reports the version
  as missing. Only propagation errors are retried; anything else still surfaces
  immediately.

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
