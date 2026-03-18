# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/0xfreak0/sui-mcp/security/advisories/new) rather than opening a public issue.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

You should receive a response within 72 hours.

## Scope

This project is a read-only MCP server that queries public Sui blockchain endpoints. It does not handle private keys, sign transactions, or manage funds. Transaction building tools return unsigned bytes for the user to sign externally.

Security-relevant areas include:
- Input validation (tool parameters)
- Error handling (no leaking of internal state)
- Dependency supply chain
