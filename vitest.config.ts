import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run this project's tests. The move-decompiler source is cloned into
    // a git-ignored `revela_sui/` dir by scripts/build-decompiler.sh and ships
    // its own (unrelated) test suite; without this scope, `vitest run` globs
    // into it and reports failures that have nothing to do with this repo.
    include: ["test/**/*.test.ts"],
  },
});
