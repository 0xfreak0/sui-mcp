---
title: Everyday prompts
description: MCP prompts that answer common questions about a wallet, a token or a protocol in plain words.
sidebar:
  order: 4
---

The everyday prompts answer the questions people without investigation
experience ask. Each gives a short answer in everyday words first, then a
`How sure: high|medium|low` line naming what was and was not checked, then
the digests and addresses behind it.

They treat every flag as a lead, never as a verdict, never name a private
person, keep to default detail levels, and call `enable_tools` only when a step
needs a tool outside `core`.

The control prompts, `who_controls_this_token` and
`who_controls_this_protocol`, report facts only, each as of the checkpoint or
time read: they never call a coin or protocol safe or unsafe and never
recommend buying, selling, depositing or holding, and every answer ends by
saying it is not an audit or financial advice. `what_happened_to_my_funds` and
`who_is_this_wallet` limit next steps to protecting the wallet, checking the
user's own orders or positions, keeping evidence and whom to report to.

| Prompt | Arguments | For |
|---|---|---|
| `what_happened_to_my_funds` | optional `address`, `digest`, `network` | Whether anyone else can still move what is left (a leaked key, an address the wallet authorized to act for it), how the funds left (a drainer transaction, a lookalike address, an approval on a website), where they went up to the first exchange deposit address or bridge, and whom to report to with which digests and addresses. When nothing was taken, such as an unwanted coin sent to the wallet or coins sitting in the user's own order, it says so |
| `who_controls_this_token` | `coin_type`, optional `network` | Who can mint, freeze or upgrade the coin, how concentrated its holders are, which pools trade it, and whether the Sui wallet blocklist lists it |
| `who_controls_this_protocol` | `protocol` (package ID, MVR name or protocol name), optional `network` | Who can upgrade the code or use the admin caps, how they sign, and what changed recently |
| `who_is_this_wallet` | `address` (or SuiNS name), optional `network` | What kind of account it is, its labels and their evidence, its funding, activity and exchange deposit behaviour |

`was_i_scammed` is the former name of `what_happened_to_my_funds`. It still
renders the same prompt, with a first line giving the new name, and will be
removed in a later release.

The investigation prompts are described in the
[Forensics skill](/guides/forensics-skill/#investigation-prompts) guide. The
[prompt reference](/reference/prompts/) lists every prompt with its arguments.
