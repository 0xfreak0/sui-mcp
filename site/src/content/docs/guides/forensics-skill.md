---
title: Forensics skill
description: Install the sui-forensics skill, or use the investigation prompts that carry its method in clients without skills.
sidebar:
  order: 3
---

The shipped skill gives Claude an investigation method: tool selection, control
groups and limits on conclusions.

## Install the skill

```bash
mkdir -p ~/.claude/skills
cp -r "$(npm root -g)/sui-analytics-mcp/.claude/skills/sui-forensics" ~/.claude/skills/
```

Or copy `.claude/skills/sui-forensics/` out of
[the repository](https://github.com/0xfreak0/sui-mcp/tree/main/.claude/skills/sui-forensics).
It loads automatically once present; there is nothing to configure.

## What it covers

It covers evidence tiers, investigation order, base-rate checks for shared
ancestry and limits on conclusions. A missing wallet edge does not establish
that two wallets are unrelated.

## Investigation prompts

Clients without skills get the same method as MCP prompts. Each one states the
task and the order of tool calls, followed by the skill sections that govern
it:

| Prompt | Arguments | For |
|---|---|---|
| `investigate_address` | `address`, optional `network`, `case_name` | What an address is, who funded it, where its money went |
| `trace_incident` | `subject` (attack digest or attacker address), optional `network`, `case_name` | What an exploit took, the flaw in the code it ran, and where the money went |
| `attribute_cluster` | `addresses` (comma-separated), optional `network`, `case_name` | Whether several addresses share an operator, with a control group |

The [everyday prompts](/guides/everyday-prompts/) answer the questions people
without investigation experience ask. The
[prompt reference](/reference/prompts/) lists every prompt with its arguments.
