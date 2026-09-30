---
title: Watching addresses
description: Record a set of addresses with watch_addresses and read only what is new with poll_watch.
sidebar:
  order: 6
---

`watch_addresses` records a set of addresses and where it last looked;
`poll_watch` returns only what is new:

```
{ "watched": 20, "active": 0, "hits": [], "requests": 1 }
```

Nothing triggers a poll on its own; the caller drives it. A hit names the
address, digest, checkpoint and why it fired. It does not include the
transaction, which you read separately with `get_transaction`:

| Reason | Meaning |
|---|---|
| `value_in` / `value_out` | coin moved, with per-coin nets |
| `capability_moved` | mint, upgrade, freeze or publish rights changed hands |
| `object_moved` | an NFT, kiosk item or DeFi position changed hands |
| `sink_reached` | a counterparty carries a sink label (exchange, bridge, mixer, burn) or a `malicious` one |
| `lookalike_appeared` | a new counterparty renders like a watched address |
| `appeared` | something happened that moved no coin and no named object |

Watching starts from the current checkpoint, so adding an address does not
replay its history. `min_amount` filters coin movements only: a labelled sink
or a transfer that moves no coin is reported whatever its size. An address
busy enough to fill the per-poll cap is listed in `more_pending` rather than
being silently truncated.

Both tools require `SUI_STORE_PATH`; see
[Optional local store](/guides/configuration/#optional-local-store). Both are
in the `forensics` profile.
