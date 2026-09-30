---
title: Contributing
description: Where the development, testing and release workflow for sui-mcp is documented.
sidebar:
  order: 1
---

The contributor guide is
[CONTRIBUTING.md](https://github.com/0xfreak0/sui-mcp/blob/main/CONTRIBUTING.md)
in the repository. It covers:

- Getting started: clone, `npm install`, `npm run build`, `npm test`, and
  `npm run hooks:install` for the commit hooks.
- What must never be published: session URLs and a maintainer's own wallet
  addresses or SuiNS names, and the hooks that block them.
- Adding a new tool: argument helpers, profiles, the generated tool
  reference, store overrides, tests and a live check.
- Running a blind investigation and writing a case file.
- Changing an anomaly detector.
- Keeping the protocol registry and the coin symbol index current.
- Citing the Sui framework source for claims about it.
- Writing mocks that match what a service can return.
- Adding a bridge.
- Releasing, and what needs a new release.

To build and run the server from a clone, see
[Running from source](/start/install/#running-from-source).

For context-size comparisons, build the server and save a case-pass summary:

```bash
npm run build
npm run verify:live -- --keep-summary /tmp/case-pass.json
node scripts/probe/token-baseline.mjs --summary /tmp/case-pass.json --out /tmp/token-baseline
```

The report measures tool definitions by profile selection and answer sizes
from the saved run without repeating its tool calls. It reports characters
and estimated tokens. The script is a manual comparison tool, not a
`verify:live` check.
