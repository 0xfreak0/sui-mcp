---
title: Move decompiler (optional)
description: Build Revela's move-decompiler and point SUI_DECOMPILER_PATH at it to enable decompile_module.
sidebar:
  label: Move decompiler
  order: 7
---

`decompile_module` is the only tool that needs an external binary, and every
code question can be answered without it:

- `disassemble_module` returns Move bytecode assembly via the GraphQL endpoint;
  its `function_name` argument returns one function.
- `get_move_function` returns a function's signature and visibility.
- `diff_package_upgrade` diffs two versions of a package, function by function.
- `analyze_package` summarizes a package's API and runs a heuristic risk scan.

Use the decompiler when you want higher-level, source-like Move output instead
of bytecode.

## Build the binary

The binary is Revela's `move-decompiler`, built from Rust. It is not bundled in
the npm package because a published tarball could only carry one platform's
build, so you compile it once yourself and point the server at it with
`SUI_DECOMPILER_PATH`. This works the same whether you installed via npx or
from source. You need a Rust toolchain ([rustup.rs](https://rustup.rs/)); the
build takes a few minutes.

```bash
git clone --depth 1 https://github.com/verichains/revela_sui.git
cd revela_sui/external-crates/move
cargo build --release --bin move-decompiler
# binary lands at target/release/move-decompiler
```

If you already cloned this repo, `npm run build:decompiler` does the same
clone and build and copies the result to `bin/move-decompiler`.

## Point the server at it

Add its absolute path to your client config:

```json
{
  "mcpServers": {
    "sui": {
      "command": "npx",
      "args": ["-y", "sui-analytics-mcp"],
      "env": {
        "SUI_DECOMPILER_PATH": "/absolute/path/to/revela_sui/external-crates/move/target/release/move-decompiler"
      }
    }
  }
}
```

Without `SUI_DECOMPILER_PATH` the server falls back to looking for
`move-decompiler` on `PATH`. Prefer the absolute path: desktop clients often
launch servers with a minimal environment that doesn't include your shell's
`PATH`, so a binary you can run in a terminal may still be invisible to the
server.

## When the binary is missing

If it's found in neither place, or `SUI_DECOMPILER_PATH` is set to an empty
string, `decompile_module` returns an error naming the tools that read bytecode
without it, its module listing reports `decompiler_available: false`, and
every other tool is unaffected.
