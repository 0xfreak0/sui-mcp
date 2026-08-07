#!/usr/bin/env node
/**
 * Find packages the protocol registry doesn't know, ranked by real usage.
 *
 * `src/data/protocols.json` is hand-maintained, so it drifts in two ways:
 *
 *   - **New protocols** launch and never get added.
 *   - **Existing protocols upgrade.** A package upgrade produces a brand-new
 *     package ID, so a protocol we already "support" silently stops decoding
 *     with no error and no signal. This is the one you cannot catch by reading
 *     a TVL leaderboard, and it is the reason this script sorts by call count
 *     rather than by anything external.
 *
 * MVR would be the obvious fix, but its coverage is thin — roughly half of even
 * our own curated list is unregistered, and some large protocols (AlphaFi) have
 * no MVR presence at all. So this samples the chain directly and only asks MVR
 * afterwards, as an optional name hint.
 *
 *   node scripts/find-unknown-packages.mjs [--checkpoints N] [--network mainnet]
 *
 * Output is a table plus ready-to-paste protocols.json stubs. It never writes to
 * the registry: which protocol a package belongs to, and its category, are
 * judgement calls that belong to a human.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const registry = require("../src/data/protocols.json").protocols;

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const NETWORK = argValue("--network", "mainnet");
const CHECKPOINTS = Number(argValue("--checkpoints", "40"));
const GRAPHQL = `https://graphql.${NETWORK}.sui.io/graphql`;
const MVR = NETWORK === "devnet" ? null : `https://${NETWORK}.mvr.mystenlabs.com/v1`;

// GraphQL caps a page at 50. Transactions carry their move calls inline, so one
// query per checkpoint window gets both the package IDs and their call counts.
const QUERY = `
  query($afterCp: Int, $beforeCp: Int, $first: Int, $after: String) {
    transactions(filter: { afterCheckpoint: $afterCp, beforeCheckpoint: $beforeCp }, first: $first, after: $after) {
      nodes {
        kind {
          ... on ProgrammableTransaction {
            commands { nodes { ... on MoveCallCommand {
              function { name module { name package { address } } }
            } } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function gql(query, variables) {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function latestCheckpoint() {
  const d = await gql(`query { checkpoints(last: 1) { nodes { sequenceNumber } } }`, {});
  return d.checkpoints.nodes[0].sequenceNumber;
}

/** Reverse-resolve MVR names in bulk. Best-effort: a failure just means no hints. */
async function mvrNames(ids) {
  if (!MVR || ids.length === 0) return new Map();
  try {
    const res = await fetch(`${MVR}/reverse-resolution/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package_ids: ids }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return new Map();
    const { resolution = {} } = await res.json();
    return new Map(ids.map((id) => [id, resolution[id]?.name ?? null]));
  } catch {
    return new Map();
  }
}

const tip = await latestCheckpoint();
const from = tip - CHECKPOINTS;
console.error(`Sampling checkpoints ${from}..${tip} on ${NETWORK} ...`);

// packageId -> { calls, modules:Set, functions:Set }
const seen = new Map();
let txCount = 0;
let cursor;
let pages = 0;

do {
  const data = await gql(QUERY, { afterCp: from, beforeCp: tip, first: 50, after: cursor });
  const { nodes, pageInfo } = data.transactions;
  txCount += nodes.length;

  for (const node of nodes) {
    for (const cmd of node.kind?.commands?.nodes ?? []) {
      const pkg = cmd.function?.module?.package?.address;
      if (!pkg) continue;
      let entry = seen.get(pkg);
      if (!entry) {
        entry = { calls: 0, modules: new Set(), functions: new Set() };
        seen.set(pkg, entry);
      }
      entry.calls++;
      if (cmd.function.module.name) entry.modules.add(cmd.function.module.name);
      if (cmd.function.name) entry.functions.add(`${cmd.function.module.name}::${cmd.function.name}`);
    }
  }

  cursor = pageInfo.hasNextPage ? pageInfo.endCursor : undefined;
  pages++;
  // Bound the work: this is a sampler, not an indexer.
  if (pages >= 40) {
    console.error(`Stopped at ${pages} pages (sample bound), not end of range.`);
    break;
  }
} while (cursor);

const unknown = [...seen.entries()]
  .filter(([id]) => !(id in registry))
  .sort((a, b) => b[1].calls - a[1].calls);

const known = seen.size - unknown.length;
console.error(
  `\n${txCount} txs, ${seen.size} distinct packages — ${known} known, ${unknown.length} unknown.\n`,
);

if (unknown.length === 0) {
  console.log("No unknown packages in this sample.");
  process.exit(0);
}

const top = unknown.slice(0, 25);
const names = await mvrNames(top.map(([id]) => id));

console.log("calls  package                                     mvr name / top functions");
console.log("-----  ------------------------------------------  ------------------------");
for (const [id, info] of top) {
  const hint = names.get(id) ?? [...info.functions].slice(0, 2).join(", ");
  console.log(`${String(info.calls).padStart(5)}  ${id.slice(0, 42)}  ${hint}`);
}

// Stubs are emitted with a deliberately wrong-looking name so nobody pastes
// them in unedited: identifying the protocol behind an address is manual work.
console.log(`\n--- protocols.json stubs (fill in name/type before using) ---`);
for (const [id, info] of top.slice(0, 10)) {
  const hint = names.get(id);
  const comment = hint ? ` // MVR: ${hint}` : ` // modules: ${[...info.modules].slice(0, 3).join(",")}`;
  console.log(`"${id}": { "name": "TODO", "type": "TODO" },${comment}`);
}
