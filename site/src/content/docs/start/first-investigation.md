---
title: How an investigation runs
description: A question, the tool calls that answer it, and the marks each answer carries, shown on the first two steps of the Cetus exploit.
sidebar:
  label: First investigation
  order: 3
---

An investigation starts from one question. The assistant calls the tools that
answer it, reads each answer, and uses what it finds to choose the next call.
Every answer also states what it covers and how sure it is, and a conclusion
rests on those statements.

## The first two steps on a real incident

Question: what did the wallet behind the 22 May 2025 Cetus CLMM exploit take?
Every value below can be checked on chain.

[`get_transaction_history`](/reference/tools/starting-points/#get_transaction_history)
on the attacker wallet, oldest transactions first:

```json
{ "address": "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06", "order": "oldest", "limit": 5 }
```

```text
{ "digest": "EKHNUkpyzuzBg85rFXxpvXiR4kYU9quRXDCZNUmqYnuh", "status": "success",
  "subject_flow": [ { "formatted": "9.98065224 SUI", … } ], … },
{ "digest": "BTMCNZd2kt6b1ALvntNC99GGo1nancJtJHAbxi5SnCpR", "status": "failure", … },
{ "digest": "DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x", "timestamp": "2025-05-22T10:30:50.476Z",
  "status": "success", … },
…
```

The wallet was funded once, failed one transaction, and first succeeded at
10:30:50 UTC. Cetus's incident report dates the exploit from that time.

[`analyze_attack_tx`](/reference/tools/incident-investigation/#analyze_attack_tx)
on that transaction:

```json
{ "digest": "DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x" }
```

```text
"profit": { "gains": [ { "symbol": "haSUI", "amount": "10024321275017081", … },
                       { "symbol": "SUI", "amount": "5765124463062928", … } ], … },
"swaps": [ { "pool": "0x871d8a227114f375170f149f7e9d45be822dd003eba225e83c05ac80828596bc",
             "price_change_pct": -99.999906, … } ],
"anomalies": [ { "code": "outsized-mint", "severity": "high", … }, … ]
```

The transaction moved the haSUI/SUI pool's price by -99.9999% and left the
attacker 10,024,321.28 haSUI and 5,765,124.46 SUI. `outsized-mint` flags a
position credited more liquidity than its amounts can buy, which points at the
pool's liquidity math.

The [Cetus exploit example](/examples/protocol-exploit/) continues from here:
it totals the whole run, finds where the proceeds left Sui, and checks who
funded the wallet.

## Reading the marks on an answer

- `truncated` and `omitted`: a list left rows out. `next_call` is the call
  that returns them. See [Truncated lists](/concepts/truncation/).
- `complete: true`: every transaction in the window was read, so a transfer
  absent from the answer did not happen in that window.
- `lower_bound: true`: a USD total leaves out coins that had no price at the
  time, so the real figure is higher. `unpriced_remainder` lists those coins
  with their amounts.
- `coin_verified` and `verified`: whether a coin is the one its symbol
  suggests or an imitator. See [Coin identity and scale](/concepts/coins/).
- Leads and facts: amounts, digests, signers and timestamps are read from the
  chain. Anomaly flags, clusters and deposit-address verdicts are leads that
  say where to look next. A check that did not match clears nothing. A saved
  finding records which kind it is in `evidence_tier`: `chain-derived`,
  `indexer-attested` or `heuristic`.

[How to read results](/concepts/) covers the marks specific to coins,
transactions, fund flows, funders and packages.

## More examples

- [Cetus CLMM exploit](/examples/protocol-exploit/): what an exploit took and
  where it left Sui.
- [KONG SUI rug pull](/examples/token-rug/): whether the deployer could still
  mint or upgrade, and where the sale proceeds went.
- [claim::swapS drainer kit](/examples/wallet-drainer/): how a drainer package
  took staked SUI, and who collected it.
- [WAL claim farm](/examples/sybil-farm/): whether wallets that swept an
  airdrop to one address share a funder.
- [Typus oracle authority check](/examples/package-authority/): who could call
  a price update, and what the fix changed.
