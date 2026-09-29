---
title: Everyday prompts
description: Four MCP prompts that answer common questions about a wallet, a token or a protocol in plain words.
sidebar:
  order: 4
---

Four prompts answer the questions people without investigation experience ask.
Each gives a plain answer of at most four sentences in everyday words first,
then a `How sure: high|medium|low` line naming what was and was not checked,
then the digests and addresses behind it.

They treat every flag as a lead, never as a verdict, never name a private
person, keep to default detail levels, and call `enable_tools` only when a step
needs a tool outside `core`.

The two control prompts, `who_controls_this_token` and
`who_controls_this_protocol`, report facts only, each as of the checkpoint or
time read: they never call a coin or protocol safe or unsafe and never
recommend buying, selling, depositing or holding, and every answer ends by
saying it is not an audit or financial advice. The other two, `was_i_scammed`
and `who_is_this_wallet`, limit next steps to protecting the wallet, checking
the user's own orders or positions, keeping evidence and whom to report to.

| Prompt | Arguments | For |
|---|---|---|
| `was_i_scammed` | optional `address`, `digest`, `network` | What left the wallet, where it went, whether a blocklisted drainer package or a lookalike address was involved, and whom to report to |
| `who_controls_this_token` | `coin_type`, optional `network` | Who can mint, freeze or upgrade the coin, how concentrated its holders are, which pools trade it, and whether the Sui wallet blocklist lists it |
| `who_controls_this_protocol` | `protocol` (package ID, MVR name or protocol name), optional `network` | Who can upgrade the code or use the admin caps, how they sign, and what changed recently |
| `who_is_this_wallet` | `address` (or SuiNS name), optional `network` | What kind of account it is, its labels and their evidence, its funding, activity and exchange deposit behaviour |

The three investigation prompts are described in
[The forensics skill](/guides/forensics-skill/#investigation-prompts). The
[prompt reference](/reference/prompts/) lists every prompt with its arguments.
