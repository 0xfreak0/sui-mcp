#!/usr/bin/env node
/**
 * Vendor the Sui framework Move sources that `test/sui-framework.test.ts`
 * checks the server's framework claims against, at one upstream ref.
 *
 *   npm run sync:framework -- <ref>    # a tag, branch or commit of MystenLabs/sui
 *   npm run sync:framework             # re-fetch the commit the README records
 *   npm run sync:framework -- <ref> --checkout <dir>
 *                                      # read a local MystenLabs/sui checkout of <ref>
 *                                      # instead of the GitHub API (a sparse clone of
 *                                      # the sources directory and LICENSE is enough)
 *
 * Vendored: every non-test source of the framework package, so the test's
 * completeness checks see every module that could take a capability or what
 * a function taking one returns. Files are written byte for byte as upstream serves them, with their
 * license headers; the repository's LICENSE is copied beside them. A file
 * without an Apache-2.0 SPDX header is refused. `README.md` is generated and
 * records the commit, its date and why each file is there.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CITED_FILES, REPO, SOURCES_DIR } from "./lib/sui-framework-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "test/fixtures/sui-framework");
const README = join(OUT, "README.md");
const TIMEOUT_MS = 120_000;
const FETCH_CONCURRENCY = 8;
const LICENSE_HEADER = /^\/\/ SPDX-License-Identifier: Apache-2\.0$/m;

async function get(url, as) {
  const res = await fetch(url, {
    headers: { "user-agent": "sui-analytics-mcp sync-framework" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return as === "json" ? res.json() : Buffer.from(await res.arrayBuffer());
}

/** The ref and commit the README records, or nulls before the first sync. */
function recorded() {
  let text = "";
  try {
    text = readFileSync(README, "utf8");
  } catch {}
  return {
    ref: /^- Ref: `([^`]+)`$/m.exec(text)?.[1] ?? null,
    commit: /^- Commit: `([0-9a-f]{40})`$/m.exec(text)?.[1] ?? null,
  };
}

const args = process.argv.slice(2);
let checkout = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--checkout" || a.startsWith("--checkout=")) {
    const value = a === "--checkout" ? args[++i] : a.slice("--checkout=".length);
    if (!value || value.startsWith("--")) throw new Error("--checkout needs a directory");
    checkout = value;
  } else if (a.startsWith("--")) {
    throw new Error(`unknown option ${a}`);
  } else {
    rest.push(a);
  }
}
const arg = rest[0];
const pinned = recorded();
const ref = arg ?? pinned.ref;
const lookup = arg ?? pinned.commit;
if (!ref || !lookup) throw new Error("usage: npm run sync:framework -- <ref> (no commit is recorded yet)");
const prefix = `${SOURCES_DIR}/`;

let commit;
let date;
let sources;
let readSource;
let readLicense;
if (checkout) {
  // Read the ref's commit from git's object store, never the working tree,
  // so local edits, untracked files or line-ending conversion cannot be
  // vendored as upstream bytes. The checkout's HEAD must also be that commit.
  const git = (...a) => execFileSync("git", ["-C", checkout, ...a], { encoding: "utf8" }).trim();
  const show = (path) => execFileSync("git", ["-C", checkout, "show", `${commit}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  commit = git("rev-parse", `${lookup}^{commit}`);
  const head = git("rev-parse", "HEAD");
  if (head !== commit) throw new Error(`${checkout} is at ${head}, not ${lookup} (${commit})`);
  // UTC, the form the GitHub API gives, so both modes record the same date.
  date = new Date(git("log", "-1", "--format=%cI", commit)).toISOString().replace(/\.000Z$/, "Z");
  sources = git("ls-tree", "-r", "--name-only", commit, "--", prefix)
    .split("\n")
    .filter((p) => p.endsWith(".move"))
    .map((p) => p.slice(prefix.length))
    .filter((p) => !p.startsWith("test/"));
  readSource = async (p) => show(`${prefix}${p}`);
  readLicense = async () => show("LICENSE");
} else {
  const commitInfo = await get(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(lookup)}`, "json");
  commit = commitInfo?.sha;
  if (typeof commit !== "string") throw new Error(`could not resolve ${lookup} to a commit`);
  date = commitInfo.commit?.committer?.date ?? "unknown";
  const tree = await get(`https://api.github.com/repos/${REPO}/git/trees/${commit}?recursive=1`, "json");
  if (tree.truncated) throw new Error("the tree listing came back truncated, so some sources might be missed");
  sources = tree.tree
    .filter((t) => t.type === "blob" && t.path.startsWith(prefix) && t.path.endsWith(".move"))
    .map((t) => t.path.slice(prefix.length))
    .filter((p) => !p.startsWith("test/"));
  const raw = (path) => `https://raw.githubusercontent.com/${REPO}/${commit}/${path}`;
  readSource = (p) => get(raw(`${prefix}${p}`));
  readLicense = () => get(raw("LICENSE"));
}
const missing = CITED_FILES.filter((f) => !sources.includes(f));
if (missing.length) throw new Error(`cited files absent at ${commit}: ${missing.join(", ")}`);

const bytes = new Map();
for (let i = 0; i < sources.length; i += FETCH_CONCURRENCY) {
  const batch = sources.slice(i, i + FETCH_CONCURRENCY);
  const got = await Promise.all(batch.map((p) => readSource(p)));
  batch.forEach((p, k) => bytes.set(p, got[k]));
}

const reason = new Map(sources.map((p) => [p, CITED_FILES.includes(p) ? "cited by a claim" : "completeness checks"]));
const chosen = [...reason.keys()].sort();
const unlicensed = chosen.filter((p) => !LICENSE_HEADER.test(bytes.get(p).toString("utf8")));
if (unlicensed.length) throw new Error(`no Apache-2.0 SPDX header, not vendoring: ${unlicensed.join(", ")}`);

const license = await readLicense();
rmSync(join(OUT, "sources"), { recursive: true, force: true });
for (const p of chosen) {
  const dest = join(OUT, "sources", p);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes.get(p));
}
writeFileSync(join(OUT, "LICENSE"), license);

const readme = `# Sui framework sources (vendored)

GENERATED by \`npm run sync:framework\`; do not edit by hand.

\`test/sui-framework.test.ts\` checks every framework claim the server's rules
make against these files: function visibility and how each takes its
parameters, struct abilities and fields, and that every callable function
taking a capability, or what a function taking one returns, is one the rules
account for. Every non-test source is here so those checks see every module.

- Upstream: https://github.com/${REPO}/tree/${commit}/${SOURCES_DIR}
- Ref: \`${ref}\`
- Commit: \`${commit}\`
- Commit date: ${date}

The files are copied byte for byte and keep their Mysten Labs copyright and
Apache-2.0 SPDX headers. \`LICENSE\` is the upstream repository's license.

To move to another ref: \`npm run sync:framework -- <ref>\`, then run the test.
A failure names the claim or the function that no longer holds.

| File | Why |
|---|---|
${chosen.map((p) => `| \`${p}\` | ${reason.get(p)} |`).join("\n")}
`;
writeFileSync(README, readme);
console.log(`${commit} (${date}): ${chosen.length} files`);
