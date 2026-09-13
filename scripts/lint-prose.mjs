#!/usr/bin/env node
/**
 * Grep the docs for prose patterns that read as machine-written.
 *
 * Advisory, not a gate. Every pattern here was found in this repo's own README
 * and removed; the point is to make "sound natural" into something checkable
 * rather than something to remember. Some hits will be legitimate — read them
 * and decide, do not rewrite on the count.
 */
import { readFileSync } from "node:fs";

const FILES = ["README.md", "CONTRIBUTING.md", ".claude/skills/sui-forensics/SKILL.md"];

const RULES = [
  [/\b(That|This) (is|was) the (point|whole point|reason|difference)\b/i, "summarising closer"],
  [/\bwhich is (what|why|exactly)\b/i, "trailing 'which is what/why' clause"],
  [/\bis not (a|an|the)?\s*[^.,;]{2,40}, (it|that)('s| is)\b/i, "'X is not Y, it is Z'"],
  [/\bthe (thing|one) (you're|you are) looking for\b/i, "aphoristic closer"],
  [/\bworth (knowing|noting)\b/i, "editorialising"],
  [/\bis (worse|better) than\b/i, "aphorism"],
  [/\bthe difference between\b/i, "aphorism"],
  [/(?<![|\-]\s)\S — \S/u, "em-dash in prose (fine in a table cell or bullet label)"],
];

let hits = 0;
for (const file of FILES) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    if (fenced) return;
    // Table rows and bullet labels use an em-dash as a separator by convention.
    const isTable = line.trimStart().startsWith("|");
    // `- **Label** — description` and `- `cmd` — description` are both the
    // label convention, not prose.
    const isBulletLabel = /^\s*[-*]\s+(\*\*|`)/.test(line);
    for (const [re, what] of RULES) {
      if ((isTable || isBulletLabel) && what.startsWith("em-dash")) continue;
      if (re.test(line)) {
        console.log(`${file}:${i + 1}  ${what}`);
        console.log(`    ${line.trim().slice(0, 100)}`);
        hits++;
      }
    }
  });
}

console.log(hits ? `\n${hits} to look at. Advisory — some will be fine.` : "\nNothing flagged.");
