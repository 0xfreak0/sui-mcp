---
title: Configuration
description: Environment variables, request handling, address arguments, price sources and the optional local store.
sidebar:
  order: 2
---

## Environment variables

All environment variables are optional. See
[`.env.example`](https://github.com/0xfreak0/sui-mcp/blob/main/.env.example)
for the full list; the common ones are `SUI_NETWORK` (default network),
`SUI_FULLNODE_URL` / `SUI_GRAPHQL_URL` (custom RPC endpoints), and
`SUI_LABELS_FILE` (address attribution labels for fund tracing).

Set them in the `env` block of your client config:

```json
{
  "mcpServers": {
    "sui": {
      "command": "npx",
      "args": ["-y", "sui-analytics-mcp"],
      "env": { "SUI_NETWORK": "testnet" }
    }
  }
}
```

`SUI_NETWORK` sets only the default. Every chain tool also takes a `network`
argument; see [Capabilities](/reference/capabilities/).

## Requests and retries

GraphQL and fullnode requests retry a rate limit (HTTP 429), a 5xx or a
dropped connection with backoff, time out, and run a bounded number at a time
per network. Requests to `*.sui.io` endpoints are also spaced per endpoint,
more widely on testnet and devnet than on mainnet.
`SUI_RATE_LIMIT` sets the number of requests per 10 seconds allowed to each
endpoint, including non-`sui.io` ones, and `0` turns the spacing off. If the
public endpoint still rate-limits a heavy investigation, set
`SUI_GRAPHQL_URL` to a private one.

## Address arguments

Address arguments accept any case, a short form (`0x2`), the hex without `0x`,
or a SuiNS name (`example.sui`). A name is resolved on the call's network and
echoed back as `resolved_from`.

## Price sources

Current USD prices in `get_token_prices` come from Aftermath, then DefiLlama
for anything Aftermath does not list, then Pyth for verified coins when
`PYTH_API_KEY` is set. The 24h change in `get_token_prices` and `analyze_token` is
DefiLlama's, and null for a coin it does not list. Prices at a past moment
(`get_token_prices` with `at`, per-hop USD in `trace_funds`,
`analyze_attack_tx`, `summarize_incident_losses`) use DefiLlama by default,
then CoinGecko's public API and GeckoTerminal when a quote is missing or a
request fails. These keyless fallbacks cover recent history only. Unsupported
dates are skipped; a historical request never falls back to a current price.
Pyth is preferred for verified coins when `PYTH_API_KEY` is set. A Sui Bridge
token (ETH, USDT, wBTC, wLBTC) that DefiLlama has no price for under its own Sui
type is priced as the Ethereum asset it is minted against, and the price says
so in `priced_as`. Only Pyth needs a key.

```
get_token_prices(["0x2::sui::SUI"], at: "2025-05-22T10:30:00Z")
  → price_usd 4.16, source "defillama", confidence 0.99,
    price_time 2025-05-22T10:30:01Z, price_offset_sec 1
```

Every historical price names its source and sample time, with
`price_offset_sec` showing its distance from the requested time. Confidence
is included only when the provider supplies it. A sample more than an hour
away is marked `stale`. Every coin that could not be priced is listed under
`unpriced` with the reason. Non-JSON replies and HTTP 429 responses are failed
requests, distinct from an answered request with no price.

CoinGecko resolves the full type as a contract on the `sui` platform and reads
its historical USD chart. GeckoTerminal uses the full type on `sui-network`,
selects the matching pool with the greatest reported USD reserve and reads
completed hourly USD candles for the correct side of that pool. The sample
time is the candle end, not its open. `market` names the pool and candle
boundaries, and states whether the pool scan reached the end. Both fallbacks
accept only quotes within an hour of the requested time.

For windows, `summarize_address_flows`, `summarize_incident_losses` and
`aggregate_events` participant P&L use each coin's median movement time within
each UTC hour, or within each UTC day when the window needs too many quotes.
Their pricing blocks report each sample's provider, time and offset, and raw
amount coverage names which provider priced which incoming and outgoing
amounts. Missing samples, unknown decimals and pricing-budget stops stay
unpriced. `price_at` on `summarize_incident_losses`
selects one fixed time instead. Objects keep their own transaction-time
valuation unless that override is set. See
[How USD values are calculated](/concepts/pricing/) for timing, partial totals
and how to report USD estimates.

DefiLlama, CoinGecko, GeckoTerminal and Aftermath identify coins by full type,
so an impostor coin that copies a real coin's symbol is priced as itself or not
at all. Pyth feeds are
matched by symbol, so Pyth is only ever asked about coins on the verified list.

Pyth is opt-in and engages only when its key is set, so nobody is billed by
accident and nothing degrades without it:

| Variable | Enables |
|---|---|
| `PYTH_API_KEY` | Pyth as the third current-price source in `get_token_prices` and the preferred historical source for verified coins, with keyless providers covering the rest, and the oracle-vs-market comparison in `compare_oracle_price`, which is Pyth-only. Without it, `compare_oracle_price` returns the DeepBook candles with `oracle_unavailable` and compares nothing. Pyth's Hermes endpoint requires authentication for price values; feed discovery is still open. |

A missing price and a price of zero mean different things, and no tool reports
one as the other.

`analyze_token`, `get_pool_info` and the coin balances in
`get_wallet_overview` use Aftermath's current prices. Position and NFT
valuations use the same historical providers, with Pyth preferred for verified
coins when its key is set; each position's method names the source and time.

## Optional local store

Set `SUI_STORE_PATH` to keep address labels and fan-out measurements across
sessions. It uses Node's built-in `node:sqlite`, so it adds no dependency and
no native build. It is unset by default, and nothing is written to disk unless
you set it. An investigation store is a record of which addresses you looked
at, so that default is deliberate.

```json
"env": { "SUI_STORE_PATH": "/Users/you/.local/share/sui-mcp/store.db" }
```

Fund traces are not cached. A trace depends on your label set, so a stored
result would disagree with a fresh run as soon as a label changed.

Each recorded case is also a resource, `sui://case/{name}`, holding the
Markdown report `export_case` renders. `resources/list` lists every case in
the store.

A capped tool response (see [Truncated lists](/concepts/truncation/)) names
its full result as `sui://results/{id}` when the store is on. Reading that URI
lists the result's lists and their lengths. Each list's `page` URI,
`?path=inflow_sources&omitted=1`, pages only the rows the response left out;
`offset`, `limit` and `match=0xab` page any list, and each page is capped in
size.

The finding tools (`save_finding`, `list_findings`, `export_case`,
`delete_finding`) and the watch tools (`watch_addresses`, `poll_watch`) need
the store. `get_nft_sales` needs it to keep the kiosk owners it learns.

## Address labels

`manage_labels` records exchanges, bridges, mixers, malicious wallets,
protocols and other attributed addresses so traces can name them and stop at
known sinks. `list` reads the registry, `lookup` reads one address, `add` and
`remove` change a local label, `import` takes a batch, and `export` returns a
batch in the import format for moving labels between machines.

Added and imported labels persist when `SUI_STORE_PATH` is set and otherwise
last only for the session. Removing one deletes its stored copy. The override
file (`SUI_LABELS_FILE`) and shipped labels are read-only through this tool.
Precedence is local additions, override file, shipped disclosed labels, then
shipped inferred exchange deposit addresses (`source: "inferred"`).
Export excludes the inferred deposits.

Lookup reports `deposit_address` alongside the effective label. Shipped
inferred deposit roles come from that same registry lookup, so an override
does not leave a second, conflicting role active. The role includes its sweep
provenance, not an assertion that the exchange disclosed the address.

`classify_deposit_address` also keeps its verdict in a process-local cache,
keyed by network, address and resolved window. Lookup, `identify_address` and
`summarize_address_flows` select one observation without running a classifier
or adding chain reads. Each cached verdict retains the period actually read,
limits and checks not run. A flow summary matches resolved checkpoint bounds,
not the spelling of a timestamp or checkpoint. `other_session_observations`
counts other windows; `session_observations_call` points to
`manage_labels(action: "lookup", detail: "full")`, which returns the full
`deposit_observations` list, including checks, reasons and read limits.
With neither an inferred role nor an applicable session verdict, the field
says `not classified` and supplies a classification call.

Cached verdicts are not registry labels and do not change precedence, exports,
persistence or trace stops. An effective inferred `cex` label **does** stop a
trace, even if a later cached verdict is `no` or `unknown` for a different
window. Read both sets of evidence. To follow onward, add an `other` label
through `manage_labels`. Removing that override reveals the inferred label
again. A cached `likely` verdict on an unlabelled address does not by itself
make a trace sink.

Labels are chain-qualified. A bare address uses the call's network; a CAIP-10
account such as `eip155:1:0x…` records a destination on another chain after a
bridge hop. A label recorded on one chain does not apply on another.

`add` requires address, label and category; confidence defaults to medium and
notes are optional. The sink categories `cex`, `bridge`, `mixer` and `burn`
terminate tracing. A `malicious` label alerts without stopping the trace
because the investigator is following that wallet. Imports skip and report
malformed entries without failing the whole batch.

List counts every label by category and source. Its summary shows local
additions first, then other labels within a display budget;
`omitted` reports the rest. `detail: "full"` lists every label.
