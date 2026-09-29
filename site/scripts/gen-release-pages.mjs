#!/usr/bin/env node
/**
 * Regenerate the changelog page and the current-release partial under
 * src/content/docs/project/ from the repo's CHANGELOG.md and package.json.
 *
 * `npm run gen:tools` runs it after gen-tools.mjs. The output is committed;
 * test/site-tool-reference.test.ts fails when it is stale.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReleasePages } from "./release-pages.mjs";

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(siteDir, "..");
const docsDir = join(siteDir, "src/content/docs");

let pages;
try {
  pages = renderReleasePages({
    changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  });
} catch (err) {
  console.error(`gen-release-pages: ${err.message}`);
  process.exit(1);
}

for (const [path, content] of pages) {
  const file = join(docsDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
console.log(`gen-release-pages: ${[...pages.keys()].join(", ")} written to ${docsDir}/`);
