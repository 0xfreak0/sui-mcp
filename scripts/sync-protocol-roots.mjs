#!/usr/bin/env node
/**
 * Regenerate `src/data/protocol-roots.json` from `src/data/protocols.json`.
 *
 * protocols.json is a list of package *versions* someone typed in by hand, so
 * it identifies a protocol only until that protocol's next upgrade mints an ID
 * nobody has seen. This script walks each curated ID back to the root of its
 * upgrade lineage (the version-1 package) and writes the root → protocol map
 * that `src/protocols/registry.ts` uses as its second lookup tier. A lineage
 * root is stable for every version a protocol will ever publish, so the
 * generated file keeps identifying a protocol across upgrades that nobody has
 * curated yet.
 *
 *   npm run sync:protocol-roots [-- --network mainnet]
 *
 * Re-run it after adding entries to protocols.json. It refuses to write when two
 * curated entries in one lineage disagree about the protocol's name or category,
 * since silently picking one would mislabel every future version of it.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const protocols = require("../src/data/protocols.json").protocols;

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const NETWORK = argValue("--network", "mainnet");
const GRAPHQL = `https://graphql.${NETWORK}.sui.io/graphql`;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../src/data/protocol-roots.json");

// The service rejects a request carrying more than 21 queries that need
// dedicated backing-store access, and caps the payload at 5000 bytes. Keep this
// in step with ROOT_BATCH_SIZE in src/protocols/package-roots.ts.
const BATCH = 20;

const normalize = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0").toLowerCase();

async function rootsFor(ids) {
  const decls = ids.map((_, i) => `$a${i}: SuiAddress!`).join(", ");
  const fields = ids
    .map((_, i) => `p${i}: packageVersions(address: $a${i}, first: 1) { nodes { address } }`)
    .join(" ");
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query (${decls}) { ${fields} }`,
      variables: Object.fromEntries(ids.map((id, i) => [`a${i}`, id])),
    }),
  });
  const body = await res.json();
  if (body.errors) {
    throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return ids.map((id, i) => [id, body.data[`p${i}`]?.nodes?.[0]?.address ?? null]);
}

const ids = Object.keys(protocols);
const roots = new Map(); // root -> { name, type }
const conflicts = [];
const unresolved = [];

for (let i = 0; i < ids.length; i += BATCH) {
  const chunk = ids.slice(i, i + BATCH);
  process.stderr.write(`resolving ${i + 1}-${i + chunk.length} of ${ids.length}\r`);
  for (const [id, root] of await rootsFor(chunk)) {
    if (!root) {
      unresolved.push(id);
      continue;
    }
    const info = { name: protocols[id].name, type: protocols[id].type };
    const key = normalize(root);
    const seen = roots.get(key);
    if (seen && (seen.name !== info.name || seen.type !== info.type)) {
      conflicts.push(`${key}: ${seen.name}/${seen.type} vs ${info.name}/${info.type} (from ${id})`);
      continue;
    }
    roots.set(key, info);
  }
}
process.stderr.write("\n");

if (unresolved.length > 0) {
  console.warn(
    `\n${unresolved.length} entr${unresolved.length === 1 ? "y has" : "ies have"} no lineage on ${NETWORK} ` +
      "(not a package, or wrong network):",
  );
  for (const id of unresolved) console.warn(`  ${id}  ${protocols[id].name}`);
}

if (conflicts.length > 0) {
  console.error("\nRefusing to write — one lineage, two protocols:");
  for (const c of conflicts) console.error(`  ${c}`);
  console.error(
    "\nOne of the curated entries is mislabelled, or two teams share an upgrade lineage. " +
      "Fix protocols.json and re-run.",
  );
  process.exit(1);
}

// Sorted by protocol then root so a re-run produces a reviewable diff rather
// than a reshuffle.
const sorted = [...roots.entries()].sort(
  ([ra, a], [rb, b]) => a.name.localeCompare(b.name) || ra.localeCompare(rb),
);

writeFileSync(
  OUT,
  JSON.stringify(
    {
      _generated: "npm run sync:protocol-roots — do not hand-edit; add entries to protocols.json",
      network: NETWORK,
      roots: Object.fromEntries(sorted),
    },
    null,
    2,
  ) + "\n",
);

console.log(`\nWrote ${sorted.length} lineages from ${ids.length} curated ids → ${OUT}`);
