#!/usr/bin/env node
/**
 * Run every live check against mainnet, in order, and fail loudly.
 *
 *   npm run build && npm run verify:live
 *
 * The unit tests are offline by design — they pin real mainnet signatures and
 * shapes as fixtures so they stay fast and deterministic. That is exactly why
 * this exists: a fixture cannot notice that the chain, the SDK or the GraphQL
 * schema moved underneath it. It will keep passing against a stale copy of a
 * world that has changed.
 *
 * There are three moments when that matters, and they are the only times this
 * needs running:
 *
 * 1. **After an `@mysten/sui` bump.** Signature parsing, protobuf field shapes
 *    and BCS key encoding all live in the SDK, and all fail silently — a
 *    changed key encoding returns null, which is indistinguishable from "not
 *    found".
 * 2. **After Mysten changes the GraphQL schema.** A renamed field makes a query
 *    return `null` rather than an error, so a tool quietly starts reporting
 *    less than it did.
 * 3. **Before cutting a release.**
 *
 * Deliberately NOT in CI. It needs the network and mainnet's current state, so
 * it would be flaky on a schedule nobody chose, and a flaky required check
 * teaches people to ignore failures.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(root, "dist/index.js"))) {
  console.error("dist/ is missing — run `npm run build` first. These checks drive the built tools.");
  process.exit(1);
}

/**
 * Order matters. `dump-fixtures` first because it rewrites
 * `test/fixtures/signatures.json`: if the SDK's parse has drifted, the offline
 * tests fail immediately afterwards and say so, which is the loudest available
 * signal. The behavioural sweeps follow.
 */
const CHECKS = [
  ["probe/dump-fixtures", "regenerate signature fixtures from live mainnet"],
  ["probe/adversarial", "hostile and malformed input across every tool"],
  ["probe/investigation", "chained end-to-end investigation"],
  ["probe/full-case", "cross-tool consistency: two tools must not disagree about one fact"],
  ["probe/gap-pass", "paths the other sweeps do not reach"],
  ["probe/consistency-pass2", "each 1.13.0+ feature against an independent source of the same fact"],
  ["probe/incident-pass", "the incident tools on the Cetus and Nemo exploits, against raw chain reads"],
  ["probe/attribution-pass", "funding, clustering, multisig, event, history and holder tools, each against a raw chain read"],
  ["probe/surface-pass", "stateful, prompt, core, market and developer tools against raw chain reads, plus malformed input"],
];

const run = (script) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [join(root, "scripts", `${script}.mjs`)], {
      cwd: root,
      stdio: "inherit",
    });
    p.on("close", (code) => resolve(code ?? 1));
  });

let failed = 0;
for (const [script, what] of CHECKS) {
  console.log(`\n${"=".repeat(70)}\n${script} — ${what}\n${"=".repeat(70)}`);
  const code = await run(script);
  if (code !== 0) {
    failed++;
    console.error(`\n!! ${script} exited ${code}`);
  }
}

console.log(`\n${"=".repeat(70)}`);
if (failed) {
  console.error(`${failed} of ${CHECKS.length} live checks failed.`);
  console.error("Run `npm test` next: a drifted fixture shows up there as a parse mismatch.");
  process.exit(1);
}
console.log(`All ${CHECKS.length} live checks passed.`);
console.log("Now run `npm test` — the regenerated fixtures must still derive to their own addresses.");
