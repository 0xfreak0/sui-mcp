---
title: "Sybil farm: WAL claims"
description: Testing whether wallets that claimed an airdrop and swept it to one address share a funder, against a control group drawn from the same claim window.
sidebar:
  order: 4
---

Question: when WAL claims opened on 27 March 2025, 24 wallets sent their
whole allocation to one address. Were they funded together, and is that
pattern unusual among other claimants?

## Sources

- Walrus, [WAL mainnet NFT airdrop](https://walrus.xyz/blog/wal-mainnet-nft-airdrop/)
- Bybit, [proof-of-reserves audit](https://www.bybit.com/common-static/cht-static/por/Bybit_PoR_Audit_2026_Apr_22.pdf),
  which lists the reserve wallet the collected WAL reached
- Case file: [`walrus-wal-claim-farm-2025-03.json`](https://github.com/0xfreak0/sui-mcp/blob/main/cases/incidents/walrus-wal-claim-farm-2025-03.json),
  which lists all 24 wallets

No published sybil list names these wallets. Every step reads the chain, and
common control is the inference being tested.

| Subject | Value |
|---|---|
| Collector | `0xfbf58484139c8ace65aef5a52d3615ce0331bd4c80f4641a286d22b3fc9abd05` |
| One farm wallet | `0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83` |
| Shared funder | `0xb43139646d70b02e44dd5c16af587197e693b3197ebbcb60a750d03d82abfaa5` |
| WAL claim event | `0x98af8b8fde88f3c4bdf0fcedcf9afee7d10f66d480b74fb5a3a2e23dc7f5a564::events::NFTWithdrawal` |

## Steps

### 1. See who paid the collector

[`summarize_address_flows`](/reference/tools/incident-investigation/#summarize_address_flows)
on the collector for the three days after claims opened:

```json wrap
{ "address": "0xfbf58484139c8ace65aef5a52d3615ce0331bd4c80f4641a286d22b3fc9abd05",
  "from": "2025-03-27T00:00:00Z", "to": "2025-03-30T00:00:00Z" }
```

```text wrap
"coverage": { "scanned_transactions": 25, "complete": true, … },
"coins": [ { …, "symbol": "WAL", …, "in": 19968, "out": 19968, …, "transactions_in": 24, "transactions_out": 1, … } ],
"inflow_source_count": 24,
"top_recipients": [
  { "address": "0x60dd01bc037e2c1ea2aaf02187701f9f4453ba323338d2f2f521957065b0984d",
    "label": "Bybit reserve wallet",
    "coins": [ { "symbol": "WAL", "amount": 19968, … } ],
    "digests": [ "4vjL1u67iiGDtHN2vv1fXcV4N28GTXcL85zEfHT9rmmE" ], "first_at": "2025-03-29T10:27:10.387Z", … }
]
```

24 wallets sent the collector 19,968 WAL. Two days later it sent all of it,
in one transfer, to a wallet Bybit lists in its proof of reserves.

### 2. Confirm one wallet claimed and swept

[`summarize_address_flows`](/reference/tools/incident-investigation/#summarize_address_flows)
on one of the 24:

```json wrap
{ "address": "0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83",
  "from": "2025-03-27T00:00:00Z", "to": "2025-04-14T00:00:00Z" }
```

```text wrap
"coins": [ { …, "symbol": "WAL", …, "in": 590, "out": 590, … } ],
"unattributed_inflows": [
  { "symbol": "WAL", …, "amount": 590, …, "digests": [ "CNnW3M8H4vzBmCm1Piaavg8TEWkuzhHLFpXGJMPnxmGY" ] }
],
"top_recipients": [
  { "address": "0xfbf58484139c8ace65aef5a52d3615ce0331bd4c80f4641a286d22b3fc9abd05",
    "coins": [ { "symbol": "WAL", "amount": 590, … } ],
    "digests": [ "3doBwS5jmXZhtQynPaF1jy2XrcgM2HFyHC2CfNHoTzLk" ],
    "first_at": "2025-03-27T10:01:22.427Z", … }
]
```

The 590 WAL arrived with no sending address, as the claim does: `CNnW3M8H`
withdraws it from the airdrop. The wallet sent all 590 WAL to the collector 80
seconds after claiming.

### 3. Look for a shared funder

[`find_funding_sources`](/reference/tools/incident-investigation/#find_funding_sources)
over all 24 wallets:

```json wrap
{ "addresses": [ "0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83", …, "0xf266f8569e056435346dd6d2fa7abfa6dfa36725e97a6f6d24961e7f2a358813" ],
  "depth": "first_hop" }
```

```text wrap
"shared_funders": [
  { "funder": "0xb43139646d70b02e44dd5c16af587197e693b3197ebbcb60a750d03d82abfaa5",
    "funded_count": 24, "funded": [ "0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83", … ],
    "funder_popularity": { "popular": true, … }, "fanout": { … } }
],
"funding_bursts": [
  …
  { "started_at": "2024-05-19T08:23:30.373Z", "ended_at": "2024-05-19T08:26:13.641Z",
    "addresses": [ "0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83", … ],
    "funders": [ "0xb43139646d70b02e44dd5c16af587197e693b3197ebbcb60a750d03d82abfaa5" ], "single_funder": true, … },
  …
],
"results": [
  { "address": "0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83",
    "first_funder": "0xb43139646d70b02e44dd5c16af587197e693b3197ebbcb60a750d03d82abfaa5",
    "first_hop": { "funding_tx": "Hc5KdsNToXab2b7m925uripuU1N2yQrzkPtX6RHB5vux",
      "timestamp": "2024-05-19T08:23:30.373Z", "amount": "0.3 SUI", … }, … },
  …
]
```

One wallet made the first SUI payment to all 24, in bursts between 08:23 and
08:35 UTC on 19 May 2024, ten months before the claim. The funder also pays
many other addresses (`popular: true`), so shared funding through it is weak
on its own. The next two steps measure how often it happens by chance.

### 4. Draw a control group

[`sample_control_addresses`](/reference/tools/incident-investigation/#sample_control_addresses)
from the same claim event in the same half hour, excluding the 24:

```json wrap
{ "event_type": "0x98af8b8fde88f3c4bdf0fcedcf9afee7d10f66d480b74fb5a3a2e23dc7f5a564::events::NFTWithdrawal",
  "size": 24, "exclude": [ "0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83", … ],
  "from": "2025-03-27T10:00:00Z", "to": "2025-03-27T10:30:00Z", "seed": 20250327 }
```

```text wrap
"addresses": [ … ],
"requested": 24,
"seed": 20250327,
"undersampled": false,
…
```

The sample is 24 other wallets that claimed WAL in the same window. The same
seed returns the same sample, so the comparison can be repeated. The excerpt
omits the sampled addresses; they are ordinary claimants.

### 5. Run the same funding test on the control

[`find_funding_sources`](/reference/tools/incident-investigation/#find_funding_sources)
over the 24 control wallets, with the same arguments as step 3:

```text wrap
"shared_funders": [
  { "funder": "0xab73…cd56", "funded_count": 5, … },
  { "funder": "0x60dd01bc037e2c1ea2aaf02187701f9f4453ba323338d2f2f521957065b0984d", "funded_count": 4, … }
],
…
```

The control has no `funding_bursts` field: no two of its wallets were first
funded within 60 seconds of each other. Its largest shared funder, an unlabelled wallet shortened here,
paid 5 of 24, against 24 of 24 for the farm. The second is the Bybit reserve wallet from
step 1, paying out exchange withdrawals.

### 6. Classify the collector

[`classify_deposit_address`](/reference/tools/incident-investigation/#classify_deposit_address)
on the collector:

```json wrap
{ "address": "0xfbf58484139c8ace65aef5a52d3615ce0331bd4c80f4641a286d22b3fc9abd05" }
```

```text wrap
"verdict": "likely",
"tier": "heuristic",
"hot_wallet": "0x60dd01bc037e2c1ea2aaf02187701f9f4453ba323338d2f2f521957065b0984d",
"exchange": { "label": "Bybit reserve wallet", "entity": "Bybit", "evidence": "proof-of-reserves-listed", … },
"checks": { "single_destination": true, "full_balance_sweeps": true, …, "destination_is_exchange": true },
"sweeps": [ { "digest": "4vjL1u67iiGDtHN2vv1fXcV4N28GTXcL85zEfHT9rmmE", … } ]
```

The collector swept its full balance once, to a Bybit reserve wallet, so it
reads as a Bybit deposit address. Exchanges usually assign a deposit address
to one account.

The classifier reads every balance-change page before checking destinations or
reconstructing balances. If a continuation cannot be read, it returns
`verdict: "unknown"`, lists the digests in `incomplete_transactions`, and leaves
every check null with an explanation in `checks_not_run`. Sweep and deposit
counts are null, and `window_complete` is false. The deposit check in
`get_address_fanout` carries the same unknown verdict and incomplete-read reason.

The inferred-label pipeline uses the same completed reads for exchange wallets
and candidate addresses. An unread balance-change connection stops
`npm run sync:labels` from replacing the label file; it cannot establish or
reject a deposit label.

## What this shows and what it does not

- The claims, the sweeps, the funding payments and their timing are chain
  facts. That one operator controls the 24 wallets is an inference. It rests
  on the gap between the farm and the control: one funder for all 24 in
  bursts, against no bursts and at most 5 of 24 in the control.
- A single control sample is one draw. A different seed gives a different
  sample; run more than one before relying on the rate.
- The deposit-address verdict is a heuristic. It says who runs the
  destination wallet, not who the account holder is. Only the exchange can
  name the account.
- Wallets that share nothing with the cohort are not cleared. A farm that
  funds each wallet from a different exchange withdrawal would not show up in
  step 3.

## Related

- [Gas sponsors](/concepts/gas-sponsors/): the other shared-infrastructure
  signal, `sponsor_shape` from `get_address_fanout`.
- [Fund flows](/concepts/fund-flows/#paths-between-two-addresses):
  `find_flow_path` confirms the path from a farm wallet to the reserve wallet
  in two hops.
- [Forensics skill](/guides/forensics-skill/): the order to work in and
  the conclusions to refuse.
