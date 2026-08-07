#!/usr/bin/env node
/**
 * Set the release version in every place that has to agree.
 *
 * Three fields must match or publishing fails: package.json `version`, and
 * server.json's top-level `version` and `packages[0].version` (the MCP Registry
 * rejects a server.json whose version doesn't resolve to a published npm
 * version). test/packaging.test.ts asserts they agree; this script is what
 * makes them agree.
 *
 * This is a plain script rather than an `npm version` lifecycle hook on purpose.
 * npm skips all lifecycle scripts when `ignore-scripts=true` is set in .npmrc,
 * which some of us set globally as a supply-chain precaution — a hook would
 * silently not run and the versions would drift apart.
 *
 *   node scripts/set-version.mjs 1.1.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version) {
  console.error("usage: node scripts/set-version.mjs <version>");
  process.exit(1);
}

// Semver, optionally with a prerelease tag. The registry rejects ranges
// ("^1.2.3", "1.x") outright, so refuse anything that isn't exact.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`error: "${version}" is not an exact semver version (e.g. 1.1.0, 2.0.0-rc.1)`);
  process.exit(1);
}

/** Rewrite one JSON file in place, preserving 2-space formatting + trailing newline. */
function edit(file, mutate) {
  const path = join(root, file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  mutate(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  return path;
}

edit("package.json", (pkg) => {
  pkg.version = version;
});

edit("server.json", (server) => {
  server.version = version;
  for (const p of server.packages) p.version = version;
});

// package-lock.json carries the version twice; leaving it stale makes `npm ci`
// complain that the lockfile is out of sync with package.json.
edit("package-lock.json", (lock) => {
  lock.version = version;
  lock.packages[""].version = version;
});

console.log(`Set version to ${version} in package.json, server.json, package-lock.json`);
console.log("\nNext:");
console.log("  npm run build && npm test");
console.log(`  git commit -am "Release ${version}" && git tag -a v${version} -m "v${version}"`);
console.log("  git push && git push --tags        # CI publishes to npm + the MCP Registry");
