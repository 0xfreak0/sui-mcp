#!/usr/bin/env node
/**
 * Turn a data-sync run into a release candidate: bump the patch version in
 * every file that has to agree (scripts/set-version.mjs) and open a CHANGELOG
 * section for it. Used by .github/workflows/data-sync.yml.
 *
 * A release publishes main, so anything merged since the last release ships
 * with the data. When main has an `## Unreleased` section it becomes this
 * version's section, keeping those entries under the version that actually
 * carries them; publish.yml takes the GitHub release notes from it.
 *
 *   node scripts/data-release-prep.mjs <note.md>   # note from data-sync-summary.mjs --changelog
 *
 * Prints the new version.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Next patch of an exact x.y.z version; a prerelease is refused rather than guessed at. */
export function nextPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`cannot bump "${version}": not a plain x.y.z release`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** Open `## <version> (<date>)` with a `### Data` subsection holding `note`. */
export function addChangelogSection(changelog, version, date, note) {
  const header = `## ${version} (${date})`;
  const data = `### Data\n${note.trim()}\n`;
  if (/^## Unreleased[ \t]*$/m.test(changelog)) {
    return changelog.replace(/^## Unreleased[ \t]*\n+/m, `${header}\n\n${data}\n`);
  }
  const first = changelog.search(/^## /m);
  if (first < 0) throw new Error("CHANGELOG.md has no version sections to insert before");
  return `${changelog.slice(0, first)}${header}\n\n${data}\n${changelog.slice(first)}`;
}

function main([notePath]) {
  if (!notePath) throw new Error("usage: data-release-prep.mjs <note.md>");
  const version = nextPatch(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  execFileSync(process.execPath, [join(root, "scripts/set-version.mjs"), version], { stdio: "inherit" });
  const path = join(root, "CHANGELOG.md");
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(path, addChangelogSection(readFileSync(path, "utf8"), version, date, readFileSync(notePath, "utf8")));
  console.log(version);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
