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

### Slice 2 — Swap-aware, USD-valued tracing
- Follow value across an asset swap (A→B on a DEX) instead of losing the trail.
- Handle `Coin<T>` split/merge forks.
- Value each hop in **USD at the block timestamp** via `get_historical_prices`,
  so impact is quantified correctly ("$4.2M", not today's price).

### Slice 3 — Exploit vs. rug root-cause
- `diff_package_upgrade(pkg, vN, vN+1)` — disassemble both versions and diff to
  surface an injected backdoor / changed auth check (malicious upgrade vector).
- `audit_capabilities(pkg|coin)` — who holds `UpgradeCap` / `TreasuryCap` /
  `AdminCap`; shared/frozen/owned; is mint authority renounced.

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
