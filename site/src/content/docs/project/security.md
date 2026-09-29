---
title: Security policy
description: How to report a vulnerability in sui-mcp, and what is in scope.
sidebar:
  order: 2
---

The policy is
[SECURITY.md](https://github.com/0xfreak0/sui-mcp/blob/main/SECURITY.md) in
the repository.

## Reporting a vulnerability

Report a vulnerability privately through
[GitHub Security Advisories](https://github.com/0xfreak0/sui-mcp/security/advisories/new),
not in a public issue. Include a description, steps to reproduce and the
potential impact. The policy states a response within 72 hours.

## Scope

sui-mcp is a read-only MCP server that queries public Sui endpoints. It does
not handle private keys, sign transactions or manage funds. Security-relevant
areas include input validation of tool parameters, error handling that leaks
no internal state, and the dependency supply chain.

What the process reads, writes and runs is listed in
[Security model](/concepts/security/).
