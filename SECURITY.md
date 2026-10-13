# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/0xfreak0/sui-mcp/security/advisories/new).
Do not open a public issue containing vulnerability details.

Include the affected version, a description, reproduction steps and potential
impact. You should receive a response within 72 hours.

## Scope

The server reads public Sui blockchain data, queries public third-party
services such as price providers and bridge indexers, and can build unsigned
transaction bytes. It does not hold private keys, sign or execute
transactions, or manage funds. When the optional local store is configured,
it caches chain reads, and some tools write case findings, labels or watch
cursors there.

Security-relevant areas include:

- Tool input validation
- Error responses and exposure of local data
- Dependency supply chain
