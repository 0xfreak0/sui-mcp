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
dropped connection up to four times with backoff, time out after 30 seconds,
and run at most eight at a time per network. Requests to `*.sui.io` endpoints
are also spaced per endpoint. `SUI_RATE_LIMIT` sets the number of requests per
10 seconds allowed to each endpoint, including non-`sui.io` ones, and `0` turns
the spacing off. If the public endpoint still rate-limits a heavy
investigation, set `SUI_GRAPHQL_URL` to a private one.

## Address arguments

Address arguments accept any case, a short form (`0x2`), the hex without `0x`,
or a SuiNS name (`example.sui`). A name is resolved on the call's network and
echoed back as `resolved_from`.

## Price sources

Current USD prices come from Aftermath, then DefiLlama for anything Aftermath
does not list. The 24h change in `get_token_prices` and `analyze_token` is
DefiLlama's, and null for a coin it does not list. Prices at a past moment
(`get_token_prices` with `at`, per-hop USD in `trace_funds`,
`analyze_attack_tx`, `summarize_incident_losses`) come from DefiLlama, or from
Pyth for verified coins when `PYTH_API_KEY` is set. A Sui Bridge token (ETH,
USDT, wBTC, wLBTC) that DefiLlama has no price for under its own Sui type is
priced as the Ethereum asset it is minted against, and the price says so in
`priced_as`. Neither Aftermath nor DefiLlama needs a key.

```
get_token_prices(["0x2::sui::SUI"], at: "2025-05-22T10:30:00Z")
  → price_usd 4.16, source "defillama", confidence 0.99,
    price_time 2025-05-22T10:30:01Z, price_offset_sec 1
```

Every price names its source, the provider's confidence, and the time of the
sample it came from; one more than an hour from the moment asked for is marked
`stale`. Every coin that could not be priced is listed under `unpriced` with
the reason, and a failed request is reported differently from a coin the
provider does not list.

DefiLlama and Aftermath key on the full coin type, so an impostor coin that
copies a real coin's symbol is priced as itself or not at all. Pyth feeds are
matched by symbol, so Pyth is only ever asked about coins on the verified list.

Two paid sources are opt-in and engage only when their key is set, so nobody
is billed by accident and nothing degrades if you set neither:

| Variable | Enables |
|---|---|
| `PYTH_API_KEY` | Pyth as the preferred historical source for verified coins, with DefiLlama covering the rest, and the oracle-vs-market comparison in `compare_oracle_price`, which is Pyth-only. Without it, `compare_oracle_price` returns the DeepBook candles with `oracle_unavailable` and compares nothing. Pyth's Hermes endpoint requires authentication for price values; feed discovery is still open. |
| `CMC_API_KEY` | CoinMarketCap as an additional current-price source. Note it keys on ticker symbols, which are not unique on-chain, so it is only consulted for symbols already mapped to a coin type. |

A missing price and a price of zero mean different things, and no tool reports
one as the other.

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
`offset`, `limit` and `match=0xab` page any list, 20k characters at most per
page.

The finding tools (`save_finding`, `list_findings`, `export_case`,
`delete_finding`) and the watch tools (`watch_addresses`, `poll_watch`) need
the store. `get_nft_sales` needs it to keep the kiosk owners it learns.
