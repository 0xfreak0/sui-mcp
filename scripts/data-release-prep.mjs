#!/usr/bin/env node
/**
 * Add the weekly data note under Unreleased when main already has pending
 * changes. Only a data-only release gets a patch version. Used by
 * .github/workflows/data-sync.yml.
 *
 *   node scripts/data-release-prep.mjs <note.md>
 *
 * Prints "release" or "unreleased" for the workflow.
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

/** Existing entries, not empty category headings, mean a normal release is pending. */
export function hasUnreleasedEntries(changelog) {
 const start = /^## Unreleased[ \t]*\n/m.exec(changelog);
 if (!start) return false;
 const following = changelog.slice(start.index + start[0].length);
 const end = following.search(/^## /m);
 const body = end < 0 ? following : following.slice(0, end);
 return body.replace(/^#{3,6}[ \t]+.*$/gm, "").trim().length > 0;
}

/** Keep the pending notes intact; repeated weekly refreshes share one Data heading. */
export function addUnreleasedData(changelog, note) {
 const start = /^## Unreleased[ \t]*\n/m.exec(changelog);
 if (!start) throw new Error("CHANGELOG.md has no Unreleased section");
 const from = start.index + start[0].length;
 const following = changelog.slice(from);
 const next = following.search(/^## /m);
 const to = next < 0 ? changelog.length : from + next;
 const body = changelog.slice(from, to);
 const data = `### Data\n${note.trim()}\n`;
 const amended = /^### Data[ \t]*$/m.test(body)
  ? body.replace(/^### Data[ \t]*\n/m, `${data}`)
  : `\n${data}\n${body.trimStart()}`;
 return changelog.slice(0, from) + amended + changelog.slice(to);
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
 const path = join(root, "CHANGELOG.md");
 const changelog = readFileSync(path, "utf8");
 const note = readFileSync(notePath, "utf8");
 if (hasUnreleasedEntries(changelog)) {
  writeFileSync(path, addUnreleasedData(changelog, note));
  console.log("unreleased");
  return;
 }
 const version = nextPatch(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
 execFileSync(process.execPath, [join(root, "scripts/set-version.mjs"), version], { stdio: "inherit" });
 writeFileSync(path, addChangelogSection(changelog, version, new Date().toISOString().slice(0, 10), note));
 console.log("release");
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
