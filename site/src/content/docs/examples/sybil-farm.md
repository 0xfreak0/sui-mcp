---
title: "Sybil farm: WAL claims"
description: WAL claim transfers, shared first funding and a same-window control sample.
sidebar:
  order: 4
---

The case file identifies 24 WAL claimants that sent their allocations to
one collector in March 2025. The following calls compare their first
funders with those of other claimants.

## Sources

- Walrus, [WAL mainnet NFT airdrop](https://walrus.xyz/blog/wal-mainnet-nft-airdrop/)
- Bybit, [proof-of-reserves audit](https://www.bybit.com/common-static/cht-static/por/Bybit_PoR_Audit_2026_Apr_22.pdf),
  which lists the reserve wallet the collected WAL reached
- Case file: [`walrus-wal-claim-farm-2025-03.json`](https://github.com/0xfreak0/sui-mcp/blob/main/cases/incidents/walrus-wal-claim-farm-2025-03.json),
  which lists all 24 wallets

The case file documents the claim and transfer transactions for these wallets.
Common control is the inference being tested.

| Subject | Value |
|---|---|
| Collector | `0xfbf58484139c8ace65aef5a52d3615ce0331bd4c80f4641a286d22b3fc9abd05` |
| One farm wallet | `0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83` |
| Shared funder | `0xb43139646d70b02e44dd5c16af587197e693b3197ebbcb60a750d03d82abfaa5` |
| WAL claim event | `0x98af8b8fde88f3c4bdf0fcedcf9afee7d10f66d480b74fb5a3a2e23dc7f5a564::events::NFTWithdrawal` |

`query_events` can inspect the claim records before sampling:

```json wrap
{ "event_type": "0x98af8b8fde88f3c4bdf0fcedcf9afee7d10f66d480b74fb5a3a2e23dc7f5a564::events::NFTWithdrawal",
  "after_checkpoint": "2025-03-27T10:00:00Z",
  "before_checkpoint": "2025-03-27T10:30:00Z" }
```

The response lists decoded `events` with `sender`, `emitting_module` and
`tx_digest`. `event_type` filters by the defining struct; the separate
`module` argument filters the emitting call, which can be in another module.
Pass `next_cursor` as `cursor` with the same filters and `order` while
`has_next_page` is true. A short or empty service read does not by itself
mean the event list has ended.

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

The collector received 19,968 WAL from 24 addresses and sent 19,968 WAL
to a wallet listed in Bybit's proof of reserves.

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

`CNnW3M8H…` credited this wallet 590 WAL without a sending address.
The wallet sent 590 WAL to the collector about 80 seconds later.

### 3. Look for a shared funder

[`find_funding_sources`](/reference/tools/incident-investigation/#find_funding_sources)
over all 24 wallets:

```json wrap
{ "addresses": [
  "0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83",
  "0x08826bca504e92b87180ef89907aed340e8e384ca59681b46c5e441ffc68442f",
  "0x0dad38bae3c047c5a70388ce2ba30fcebdb6b669507ff91ed940f61828c24904",
  "0x102d9805c71455dcb877cd29c1934c57db0b5afc742295ca98b454e5608ec876",
  "0x33831a12d1915ab7cf3ef001be1a692f641bcb520fc62301a8c085144af5bed6",
  "0x3b559aff5ae1a792c820b7f12f13e51755ccb3005b6fc39e871692ff81938677",
  "0x3c825ab8920017b173ee8660ee98654a12e0503fe809114532e2b61351bd6f35",
  "0x5323d8ca69bd5fb79aa0e66e855ade83722e743443a79f973d6c2fbbeb869ec9",
  "0x5b7ad2ac464f27a21fe9b73e4724fff6b2a6935acc7057fc4427b28b46ee21b9",
  "0x7349e5ca20f93941d36233ba9c6389701dc27aed9eeda149b9d15cbeac3e9ce7",
  "0x76a04ca24439656ccb423046bba4f0cdd67ba21f628057434508e302055a2750",
  "0x78747d586099be058af2af741db21a29c6d7ae3dc74f33894cf80d30916443c6",
  "0x86427087eece4817cce92c6e9ea0bba2755208169457ba68b1bf70ba6dd315d5",
  "0x8f87ab650920b33e23809ffbf0024b2be803e217ae9aa01333465fda665ee4c9",
  "0x9ac89a22dc6ef608d4da1f81dbfd8273cbe06892a27e85b489539f19aefb9db3",
  "0x9ed495338be7b0717277f799c3e9f636197b9deeba2d8eb318665199ed87f4ae",
  "0xa01824e21ba8681436bab9b7cccd392d374015f5633de77fa9bb478bc44a7af2",
  "0xbdd7063aa728563167d446ba15b7d4382b38c30691faab45da6f0eba20d87352",
  "0xbe2ab94a20c863d016ff27a8b514309e97e15c2e49ea1b49ba8929816c7564e9",
  "0xc2cda716e17a04ec5b5ef1876c72648eb0e9edbf1b96c147de09810527d4bcfa",
  "0xc2de996a383294877f1dbad59cb0b995058eb85b364d1eb2b879135e3d322865",
  "0xc34033c294b4666c1d29d96d1309debd2f3774ad1878eee8f274042b36a6f674",
  "0xc85073696bbe994a6feae3e3ce20e26ffb2225178db8ffbd8158a2579bf22d8c",
  "0xf266f8569e056435346dd6d2fa7abfa6dfa36725e97a6f6d24961e7f2a358813"
], "depth": "first_hop" }
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

The first SUI payment to each of the 24 wallets came from the same funder
between 08:23 and 08:35 UTC on 19 May 2024, in the bursts `funding_bursts`
lists. `popular: true` means that address also funded many others, so common
funding through it does not establish common control on its own.

### 4. Draw a control group

[`sample_control_addresses`](/reference/tools/incident-investigation/#sample_control_addresses)
from the same claim event in the same half hour, excluding the 24:

```json wrap
{ "event_type": "0x98af8b8fde88f3c4bdf0fcedcf9afee7d10f66d480b74fb5a3a2e23dc7f5a564::events::NFTWithdrawal",
  "size": 24,
  "exclude": [
    "0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83",
    "0x08826bca504e92b87180ef89907aed340e8e384ca59681b46c5e441ffc68442f",
    "0x0dad38bae3c047c5a70388ce2ba30fcebdb6b669507ff91ed940f61828c24904",
    "0x102d9805c71455dcb877cd29c1934c57db0b5afc742295ca98b454e5608ec876",
    "0x33831a12d1915ab7cf3ef001be1a692f641bcb520fc62301a8c085144af5bed6",
    "0x3b559aff5ae1a792c820b7f12f13e51755ccb3005b6fc39e871692ff81938677",
    "0x3c825ab8920017b173ee8660ee98654a12e0503fe809114532e2b61351bd6f35",
    "0x5323d8ca69bd5fb79aa0e66e855ade83722e743443a79f973d6c2fbbeb869ec9",
    "0x5b7ad2ac464f27a21fe9b73e4724fff6b2a6935acc7057fc4427b28b46ee21b9",
    "0x7349e5ca20f93941d36233ba9c6389701dc27aed9eeda149b9d15cbeac3e9ce7",
    "0x76a04ca24439656ccb423046bba4f0cdd67ba21f628057434508e302055a2750",
    "0x78747d586099be058af2af741db21a29c6d7ae3dc74f33894cf80d30916443c6",
    "0x86427087eece4817cce92c6e9ea0bba2755208169457ba68b1bf70ba6dd315d5",
    "0x8f87ab650920b33e23809ffbf0024b2be803e217ae9aa01333465fda665ee4c9",
    "0x9ac89a22dc6ef608d4da1f81dbfd8273cbe06892a27e85b489539f19aefb9db3",
    "0x9ed495338be7b0717277f799c3e9f636197b9deeba2d8eb318665199ed87f4ae",
    "0xa01824e21ba8681436bab9b7cccd392d374015f5633de77fa9bb478bc44a7af2",
    "0xbdd7063aa728563167d446ba15b7d4382b38c30691faab45da6f0eba20d87352",
    "0xbe2ab94a20c863d016ff27a8b514309e97e15c2e49ea1b49ba8929816c7564e9",
    "0xc2cda716e17a04ec5b5ef1876c72648eb0e9edbf1b96c147de09810527d4bcfa",
    "0xc2de996a383294877f1dbad59cb0b995058eb85b364d1eb2b879135e3d322865",
    "0xc34033c294b4666c1d29d96d1309debd2f3774ad1878eee8f274042b36a6f674",
    "0xc85073696bbe994a6feae3e3ce20e26ffb2225178db8ffbd8158a2579bf22d8c",
    "0xf266f8569e056435346dd6d2fa7abfa6dfa36725e97a6f6d24961e7f2a358813"
  ],
  "from": "2025-03-27T10:00:00Z", "to": "2025-03-27T10:30:00Z", "seed": 20250327 }
```

```text wrap
"addresses": [ … ],
"events_scanned": 5000,
"population_truncated": true,
"population_size": 4990,
"requested": 24,
"seed": 20250327,
"undersampled": false,
…
```

The seeded sample selects other event senders in the specified window
among the 5,000 events scanned. The population scan was truncated, so
this draw cannot establish coverage of every claimant in the window.
Record and pass its `addresses` to the next call; the seed makes the draw
reproducible from that scanned population.

### 5. Run the same funding test on the control

[`find_funding_sources`](/reference/tools/incident-investigation/#find_funding_sources)
over the 24 addresses returned by step 4, with `depth: "first_hop"`.
Use the complete returned `addresses` array as the `addresses` argument.

```text wrap
"shared_funders": [
  { "funder_popularity": { "popular": true, … }, … },
  { "funder": "0x60dd01bc037e2c1ea2aaf02187701f9f4453ba323338d2f2f521957065b0984d", … }
],
…
```

The case check found no `funding_bursts` or `co_funded_in_one_transaction`
in this sample. Neither shared funder is classified as narrow. One is a
Bybit reserve wallet; the other is a high-fanout distributor. A different
seed produces a different control sample.

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

The classifier reports `likely` and `tier: "heuristic"` after reading
the collector's full-balance transfer to the labelled Bybit reserve
wallet. The chain does not identify the account holder at Bybit.

The classifier reads every balance-change page before checking destinations or
reconstructing balances. If a continuation cannot be read, it returns
`verdict: "unknown"`, lists the digests in `incomplete_transactions`, and leaves
every check null with an explanation in `checks_not_run`. Sweep and deposit
counts are null, and `window_complete` is false. The deposit check in
`get_address_fanout` carries the same unknown verdict and incomplete-read reason.

The inferred-label sync reads complete balance-change connections for
candidate addresses and exchange wallets. An incomplete read prevents
`npm run sync:labels` from replacing its label file.

## Evidence and limits

- The claims, transfers and first-funding transactions are chain facts.
  Shared operation is an inference: one address first funded all 24 cohort
  wallets within 12 minutes, while the recorded control sample has no funding
  burst and its shared funders are an exchange reserve wallet and a
  distributor.
- The control draw comes from a truncated event scan, so some claimants may
  fall outside its population. A different seed gives a different sample
  from that scan; run more than one before relying on the rate.
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
