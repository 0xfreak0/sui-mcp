---
title: "Token rug pull: KONG SUI"
description: KONG SUI mint and upgrade authority, deployer sale and subsequent SUI transfers.
sidebar:
  order: 2
---

The following calls inspect KONG SUI's mint and upgrade authority, a
deployer swap and transfers after the October 2024 sale.

## Sources

- BitPinas, [KONG SUI rug pull](https://bitpinas.com/cryptocurrency/kong-sui-rugpull/)
- BitPinas, [feature on the traders involved](https://bitpinas.com/feature/rugpull-millions-pinoy-trader-sog-sui/)
- Coinpaprika, [KONG listing](https://coinpaprika.com/coin/kong-kong-sui/)
- Case file: [`kong-sui-rug-2024-10.json`](https://github.com/0xfreak0/sui-mcp/blob/main/cases/incidents/kong-sui-rug-2024-10.json)

| Subject | Value |
|---|---|
| Coin package | `0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb` |
| Deployer | `0x70f1042521565aa5c3fb887f939ef05e8dee264cc11ee07735132691801d360d` |
| Consolidation wallet | `0xfbbab0fdf16bd65d7ff7d17b86e0086892573337b6e7f466794506bc8aa6c0f3` |

## Steps

### 1. Check who could mint or upgrade

[`analyze_package`](/reference/tools/packages/#analyze_package) on the coin
package. The capability audit runs by default:

```json wrap
{ "package_id": "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb" }
```

```text wrap
"root_publisher": {
  "publisher": "0x70f1042521565aa5c3fb887f939ef05e8dee264cc11ee07735132691801d360d",
  "publish_tx": "99s8gEPTAvdks4xwUVNvtrWDg1npNH3NJKatjqLyKJ7q",
  "published_at": "2024-09-26T05:54:55.924Z", …
},
"capabilities": { "checked": true, "capabilities": [
  { "kind": "upgrade", "owner": "burned", "risk": "info", … },
  { "kind": "treasury", "owner": "address",
    "owner_address": "0x0000000000000000000000000000000000000000000000000000000000000000", "risk": "info", … }
] }
```

The UpgradeCap is destroyed, and the TreasuryCap's recorded owner is the
unspendable `0x0` address. The audited capabilities cannot authorize
further upgrades or minting.

### 2. Confirm the deployer sold

[`get_transaction`](/reference/tools/transactions-and-events/#get_transaction)
on the deployer's swap on the day of the collapse:

```json wrap
{ "digest": "rC4ijs7mTe3KXnY1ChDVWXmxyHAXLBrJpyiU4jovPA1" }
```

```text wrap
"sender": "0x70f1042521565aa5c3fb887f939ef05e8dee264cc11ee07735132691801d360d",
"timestamp": "2024-10-14T08:54:39.222Z",
"token_flow": [
  { "coin": "SUI", "amount": "431391181040", "formatted": "431.39118104 SUI", … },
  { "coin": "KONG", "amount": "-4499000000", "formatted": "-449900000 KONG (unverified)", … }
],
"events": [
  { …, "event_type": "0x91bfbc38…::pool::SwapEvent",
    "parsed": { "pool": "0x48ff70ae056c64407ebf08dc532964434ef2108b2b232e7a01d78d17f51123b7", … } },
  …
]
```

The deployer's transaction exchanged 449,900,000 KONG for about
431.39 SUI in the Turbos KONG/SUI pool at 08:54 UTC on 14 October.

`token_flow` is the sender's net across the whole transaction, while
`get_transaction` can read an individual swap's direction from its pool
event when that event identifies the coins and can be assigned to one
call. For a route with several swaps, check each action and its event
before interpreting the net as one swap. History, timeline and fund
trace action labels have no pool-event evidence and may use the call's
type arguments instead.

`find_pools` takes the full type for an unverified coin:

```json wrap
{ "token_a": "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG",
  "token_b": "SUI" }
```

The result lists `pools`, `total` and each venue's search status under
`venues`. It searches Cetus, DeepBook v2/v3, Turbos, BlueMove v1,
Bluefin, Momentum, FlowX CLMM/v2, Magma, Aftermath AMM and Kriya v2.
Use `omitted.next_call` to page a long pool list. A failed or bounded venue
search cannot establish that the pair has no other pools.

### 3. Find where the sellers' SUI converged

[`summarize_address_flows`](/reference/tools/incident-investigation/#summarize_address_flows)
on the consolidation wallet over two hours on 24 October:

```json wrap
{ "address": "0xfbbab0fdf16bd65d7ff7d17b86e0086892573337b6e7f466794506bc8aa6c0f3",
  "from": "2024-10-24T06:00:00Z", "to": "2024-10-24T08:00:00Z", "top": 30 }
```

```text wrap
"coverage": { "scanned_transactions": 36, "complete": true, … },
"coins": [ { …, "symbol": "SUI", …, "in": 7650.187157164, "out": 0, …, "transactions_in": 36, … } ],
"inflow_source_count": 35,
"inflow_sources": [
  { "address": "0x6730b5661d2a741d810ab425112507979326d09906874b265a80e0dd1a172f32",
    "coins": [ { "symbol": "SUI", "amount": 4910.77, … } ], … },
  …
  { "address": "0x70f1042521565aa5c3fb887f939ef05e8dee264cc11ee07735132691801d360d",
    "coins": [ { "symbol": "SUI", "amount": 440.33, … } ], … },
  …
]
```

The scan found 35 inflow sources sending 7,650.19 SUI between 06:39
and 07:01 UTC. The deployer is among them. The case file traces a
4,910.75 SUI payment into the largest sender, `0x6730b566…`, from
an address that received 1,000,000,000 KONG from the deployer.

### 4. Follow the consolidated SUI

[`trace_flow_graph`](/reference/tools/incident-investigation/#trace_flow_graph)
forward from the consolidation wallet, SUI only:

```json wrap
{ "address": "0xfbbab0fdf16bd65d7ff7d17b86e0086892573337b6e7f466794506bc8aa6c0f3", "direction": "forward",
  "from": "2024-10-24T06:48:00Z", "coin_type": "0x2::sui::SUI", "max_depth": 5, "max_nodes": 60 }
```

```text wrap
"edges": [
  { "from": "0xfbbab0fdf16bd65d7ff7d17b86e0086892573337b6e7f466794506bc8aa6c0f3|…::sui::SUI",
    "to": "0x97ab09d16d5c8ffb611abac70ccbe3898a2b11802589df4e6206fbc09afb4e97|…::sui::SUI",
    "amount_formatted": "7649 SUI", "first_time": "2024-10-29T16:07:34.678Z",
    "digests": [ "6sdKKWtJiWtUmvs4B58HBqKh8cWWmCJSRhmvttEMTSV6" ], … }
]
```

The graph shows 7,649 SUI sent to `0x97ab09d1…` on 29 October. It stops at
that address because it pools SUI from many senders, so its later transfers
are not traced as a continuation of these funds and need a separate read.

### 5. See where that address forwarded it

[`get_transaction`](/reference/tools/transactions-and-events/#get_transaction)
on the next transfer out of `0x97ab09d1`:

```json wrap
{ "digest": "E3rCEX7ex5uBuPpZ9scXeChkMGaZha5gVRk4Qxiheg53" }
```

```text wrap
"sender": "0x97ab09d16d5c8ffb611abac70ccbe3898a2b11802589df4e6206fbc09afb4e97",
"timestamp": "2024-10-29T16:15:15.287Z",
"balance_changes": [
  { "address": "0x97ab09d16d5c8ffb611abac70ccbe3898a2b11802589df4e6206fbc09afb4e97", "amount": "-7649000000000", … },
  { "address": "0xf8b7b95d01ae79756fc3d1bc58675e59a17f07cdafe3d31ea57425adbec2d43f", "amount": "7648999230240", … }
]
```

Eight minutes later, `0x97ab09d1…` sent nearly 7,649 SUI to
`0xf8b7b95d…`. This transfer alone does not identify the recipient
as an exchange wallet.

### 6. Check who funded the deployer

[`find_funding_source`](/reference/tools/incident-investigation/#find_funding_source):

```json wrap
{ "address": "0x70f1042521565aa5c3fb887f939ef05e8dee264cc11ee07735132691801d360d" }
```

```text wrap
"origin": {
  "address": "0xf8b7b95d01ae79756fc3d1bc58675e59a17f07cdafe3d31ea57425adbec2d43f",
  "label": "MEXC reserve wallet", "category": "cex",
  "label_provenance": { "entity": "MEXC", "evidence": "proof-of-reserves-listed",
    "source_url": "https://por.mocortech.com/MEXC_PoR_Audit_20260910.pdf", … }
},
"chain": [
  { …, "funded_by": "0xf8b7b95d01ae79756fc3d1bc58675e59a17f07cdafe3d31ea57425adbec2d43f",
    "funding_tx": "DGbdmrFNNmMT29KzUmzug3wr2sXBSbh7SRywMvVawcma",
    "timestamp": "2024-09-26T01:45:04.246Z", "amount": "710 SUI", … }
],
```

The first funding transaction sent the deployer 710 SUI from
`0xf8b7b95d…` about four hours before publication. The same address
received the later transfer in step 5. A MEXC proof-of-reserves listing
identifies it as a reserve wallet.

## Evidence and limits

- Mint and upgrade authority describe the capabilities the audit located;
  they do not establish that a token is safe to trade. KONG's audited caps
  could not mint or upgrade it at the time read, and the deployer sold into
  the pool.
- The sale, the 35 inflow sources and the exit are chain facts.
  That the 35 wallets are one operator is an inference from the convergence
  and from the funding links in the case file.
- The proof-of-reserves listing attributes `0xf8b7b95d…` to MEXC, but
  this transfer does not identify whose exchange account received it.
  `classify_deposit_address` on `0x97ab09d1…` reads its recent sweeps,
  not the October 2024 ones, so its verdict can differ from the
  shape seen here.
- A funder's other recipients cannot be attributed to the deployer merely
  because the funder paid them.

## Related

- [Packages and upgrade authority](/concepts/packages/#capability-audit): what
  the capability audit reports.
- [Fund flows](/concepts/fund-flows/#how-traced-value-is-allocated): how
  `trace_flow_graph` allocates value and where it stops.
- [Coin identity and scale](/concepts/coins/): why KONG is marked
  `(unverified)`.
