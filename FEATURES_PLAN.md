# Sui MCP Server — Feature Roadmap

Planned new features organized by priority tier. Each feature includes a summary, proposed tool interface, and implementation notes.

---

## Tier 1 — High Impact, Low Effort

### 1. `compare_wallets`
Compare two or more wallets side-by-side: token balances, NFT collections, DeFi positions, and staking.

**Tool interface:**
```
compare_wallets({ addresses: string[] })
```

**Output:** Per-address breakdown of holdings, shared/unique tokens, total portfolio value delta.

**Implementation:**
- Call `get_portfolio_value` and `list_nft_collections` in parallel for each address.
- Diff token lists to highlight shared vs. unique holdings.
- ~100 lines, reuses existing helpers.

---

### 2. `get_token_info_extended`
Enrich `get_coin_info` with price, top holders summary, and 24h volume when available.

**Tool interface:**
```
get_token_info_extended({ coin_type: string })
```

**Output:** Metadata (name, symbol, decimals, supply) + current price + top 5 holders + 24h change.

**Implementation:**
- Compose `get_coin_info` + `get_token_prices` + `get_token_top_holders(limit=5)`.
- Single tool that answers "tell me about this token" completely.
- ~80 lines.

---

### 3. `trace_funds`
Trace token flow across a chain of transactions, starting from a given transaction digest. Follow the money forward or backward through N hops.

**Tool interface:**
```
trace_funds({ digest: string, direction: "forward" | "backward", hops?: number, coin_type?: string })
```

**Output:** Array of hops: `[{ digest, from, to, amount, coin }]`.

**Implementation:**
- Start from `get_transaction` → extract balance changes.
- For "forward": query next transactions involving the recipient address + coin type.
- For "backward": query prior transactions involving the sender.
- Cap at `hops` (default 3, max 10) to avoid runaway queries.
- ~200 lines. Uses `query_transactions` with `affected_address` filter.

---

## Tier 2 — Medium Impact, Medium Effort

### 4. `get_pool_stats`
Fetch real-time stats for a DEX liquidity pool: TVL, volume, fee tier, token reserves.

**Tool interface:**
```
get_pool_stats({ pool_id: string, protocol?: string })
```

**Output:** `{ protocol, token_a, token_b, reserve_a, reserve_b, fee_bps, tvl_usd, volume_24h_usd }`.

**Implementation:**
- Read pool object via `get_object`.
- Protocol-specific struct parsing (Cetus `Pool`, DeepBook `Pool`, Turbos `Pool`).
- Enrich reserves with USD prices from `get_token_prices`.
- ~250 lines. Needs protocol-specific object layouts.

---

### 5. `decode_ptb`
Decode a base64-encoded Programmable Transaction Block (PTB) into human-readable commands without executing it.

**Tool interface:**
```
decode_ptb({ transaction_bcs: string })
```

**Output:** List of commands with resolved package/module/function names, type arguments, and input mappings.

**Implementation:**
- Use `@mysten/sui` BCS deserialization to parse the transaction bytes.
- Map each command through the protocol registry + decoder.
- Similar to `explain_transaction` but works on unsigned/unsubmitted transactions.
- ~150 lines.

---

### 6. `get_package_dependency_graph`
Map the dependency tree of a Move package: which packages it depends on, and which packages depend on it.

**Tool interface:**
```
get_package_dependency_graph({ package_id: string, depth?: number })
```

**Output:** Tree of `{ package_id, modules, depends_on: [...], depended_by: [...] }`.

**Implementation:**
- Use `get_package` to fetch module signatures.
- Parse type arguments and function signatures for cross-package references.
- Recursively resolve up to `depth` (default 2, max 5).
- ~200 lines.

---

### 7. Streaming / Subscription Support
Add real-time event streaming via MCP's subscription mechanism for address activity and object changes.

**Tool interface:**
```
subscribe_address({ address: string, event_types?: string[] })
subscribe_object({ object_id: string })
```

**Output:** Push notifications on new transactions, balance changes, or object mutations.

**Implementation:**
- Use polling with `check_address_activity` / `check_object_changes` on an interval.
- Wrap in MCP subscription protocol when SDK supports it.
- State management for last-seen checkpoint per subscription.
- ~300 lines. Depends on MCP SDK subscription support maturity.

---

## Tier 3 — High Impact, High Effort

### 8. `search_events`
Full-text search across on-chain events by type, module, sender, and content fields.

**Tool interface:**
```
search_events({ event_type?: string, module?: string, sender?: string, content_contains?: string, after_checkpoint?: string, limit?: number })
```

**Output:** Matching events with parsed JSON content.

**Implementation:**
- Extends existing `query_events` GraphQL tool.
- Add content filtering post-query (GraphQL doesn't support content search).
- Optional: index events locally for faster content search.
- ~150 lines for basic version.

---

### 9. `get_gas_estimate`
Estimate gas cost for a transaction before execution, with breakdown by computation and storage.

**Tool interface:**
```
get_gas_estimate({ transaction_bcs: string })
```

**Output:** `{ total_gas_mist, total_gas_sui, computation_cost, storage_cost, storage_rebate }`.

**Implementation:**
- Use `simulate_transaction` under the hood.
- Extract gas summary from simulation effects.
- Format into a clear cost breakdown.
- ~50 lines, mostly a thin wrapper over `simulate_transaction`.

---

### 10. MCP Resources
Expose read-only data as MCP Resources (not tools), enabling LLMs to subscribe to live state.

**Proposed resources:**
- `sui://wallet/{address}/balances` — live token balances
- `sui://wallet/{address}/nfts` — NFT inventory
- `sui://object/{id}` — object state
- `sui://chain/info` — network status

**Implementation:**
- Register resources via `server.resource()`.
- Each resource handler calls existing tool logic.
- Add `listChanged` notifications when polling detects updates.
- ~300 lines. Requires MCP SDK resource API.

---

### 11. `explain_package`
Generate a human-readable summary of a Move package: what it does, its public API, key types, and common usage patterns.

**Tool interface:**
```
explain_package({ package_id: string })
```

**Output:** Markdown summary with module descriptions, public function signatures, key struct types, and example usage.

**Implementation:**
- Use `get_package` to fetch all module signatures.
- Optionally use `decompile_package` for source-level analysis.
- Heuristic-based summarization (entry functions = user-facing API, friend functions = internal).
- ~200 lines.

---

## Implementation Priority

When ready to implement, suggested order:

1. `get_gas_estimate` — quick win, thin wrapper
2. `compare_wallets` — high user value, reuses existing tools
3. `get_token_info_extended` — single-call token research
4. `decode_ptb` — complements existing PTB builder tools
5. `trace_funds` — unique capability, high value for investigations
6. `get_pool_stats` — requires protocol-specific knowledge
7. `explain_package` — leverages decompiler
8. `search_events` — extends existing event queries
9. `get_package_dependency_graph` — niche but useful
10. MCP Resources — depends on SDK maturity
11. Streaming / Subscriptions — depends on SDK maturity
