# Security Incident Investigation — capability roadmap

Goal: make sui-mcp a first-class tool for investigating on-chain security
incidents (exploits, drains, rugs, phishing) on Sui. The server already has
strong primitives — `trace_funds`, `analyze_package`/`disassemble`/`decompile`,
`decode_ptb`, `get_historical_prices`, `identify_address`, `get_top_holders`.
What's missing is the connective tissue that turns primitives into an
investigation: **attribution, cross-asset fund trails, exploit root-cause, and a
handoff-ready report.**

## Slices (prioritized)

### Slice 1 — Address labeling + sink-aware tracing  ← in progress
Turn raw hops into attribution.
- **Labeled-address registry** (`cex`, `bridge`, `mixer`, `malicious`,
  `protocol`, `validator`, `defi`, `burn`, `other`). Source model: a curated
  static JSON shipped in-repo **plus local overrides** — an investigator points
  `SUI_LABELS_FILE` at a case/org-maintained JSON that wins over the static set,
  and can tag addresses for the current session via a tool.
- **`manage_labels` tool** — `list` / `lookup` / `add` / `remove`.
- **Wire labels into `trace_funds`**: surface labels in the summary and
  **terminate a hop chain at a known sink** ("funds reached Binance deposit
  0x… — stopping") instead of running out of depth blind.

> Honesty note: we do **not** ship fabricated attribution. The static seed
> contains only entries we can state with confidence (e.g. the zero address);
> real CEX/bridge/attacker tagging lives in the override file and community
> feeds. `confidence` is a first-class field.

### Slice 2 — Swap-aware, USD-valued tracing  ← done
- Follow value across an asset swap (A→B on a DEX) instead of losing the trail:
  on a swap hop, keep following the *same actor* and switch the tracked coin to
  what they received, rather than diving into the pool. Pool/protocol addresses
  are treated as pass-through recipients and skipped when a real recipient
  exists. (`src/utils/trace-hop.ts`, `chooseNextHop`.)
- Value each hop in **USD at the block timestamp** via Pyth historical oracle
  (`src/utils/valuation.ts`). Per-hop `usd_value` on each balance change and a
  `usd_total`; summary reports origin + largest-hop (never a cross-hop sum,
  which would overstate — same funds moving).
- Follow-up: `Coin<T>` split/merge fork handling (trace currently follows one
  path; multi-path fan-out is a later enhancement).

### Slice 3 — Exploit vs. rug root-cause  ← in progress
- `diff_package_upgrade(pkg, from_version?, to_version?)` — **done**. On Sui each
  upgrade publishes a new package address; this resolves the two versions,
  disassembles both, and diffs modules (added/removed/changed + per-module line
  diff). Defaults to previous → latest.
  - **Gotcha (load-bearing):** `package(address: <versionAddr>) { module }`
    linkage-resolves to the LATEST version regardless of the historical address —
    so fetching a version's bytecode that way makes every version look identical
    (silent false-negative on backdoors). Version-specific bytecode MUST be read
    through the `packageAt(version: N) { module }` node. See
    `fetchAllModuleDisassemblyAtVersion` in `src/utils/move-package.ts`.
- `audit_capabilities(pkg|coin)` — **not yet**. Who holds `UpgradeCap` /
  `TreasuryCap` / `AdminCap`; shared/frozen/owned; is mint authority renounced.
  Needs the publish-tx → created-cap → `getObject` reverse-lookup path; the
  object-change GraphQL shape still needs pinning down.

### Slice 4 — Timeline + attribution primitives
- `build_timeline(addresses[], from, to)` — merge multi-address activity into one
  checkpoint-ordered, protocol-decoded stream (markdown/CSV).
- `find_funding_source(address)` — walk back to the wallet's first funding tx and
  who sent it; gas-payer / sponsor clustering.

### Slice 5 — Triage + reporting
- PTB anomaly heuristics on `decode_ptb` (flashloan wrap, calls into unverified
  packages, admin-cap usage, transfers to fresh addresses).
- `trace_object_history(object_id)` — full mutation/owner history of the exploited
  object.
- `generate_incident_report(...)` — IOCs + timeline + fund-flow (mermaid) + USD
  impact as one markdown artifact.

## Label data model

```jsonc
// src/data/labeled-addresses.json  (static, curated)
// and the file pointed to by SUI_LABELS_FILE (local overrides — same shape)
{
  "labels": {
    "0x<32-byte hex>": {
      "label": "Binance 14 (deposit)",   // human name
      "category": "cex",                  // drives sink termination
      "source": "curated",                // curated | override | session | <free>
      "confidence": "high",               // high | medium | low
      "notes": "optional context"
    }
  }
}
```

Resolution precedence: **session (runtime `manage_labels add`) > override file >
static**. Sink categories (terminate tracing): `cex`, `bridge`, `mixer`,
`malicious`, `burn`. Labels are network-agnostic (an address is one identity).
```
