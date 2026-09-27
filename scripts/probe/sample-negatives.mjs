#!/usr/bin/env node
/**
 * Draw ordinary mainnet transactions for the held-out negative split of
 * cases/detectors.json.
 *
 *   node scripts/probe/sample-negatives.mjs [--n 100] [--seed S] [--tip T] [--window W] > random.json
 *   node scripts/probe/sample-negatives.mjs --per 2 --function "LST mint=0x…::liquid_staking::mint" … > shaped.json
 *
 * Without `--function` the sample is random and not by shape: checkpoints are
 * drawn uniformly from the W checkpoints below T (default: the latest, and
 * 30,000,000, about three months), and from each one successful programmable
 * transaction is taken at random. With `--function "<shape>=<pkg::module::fn>"`
 * (repeatable) each function gets `--per` transactions (default 2), each the
 * random pick among the last 20 calls before a random checkpoint in the same
 * window.
 *
 * Either way a sender already sampled, or already labelled in
 * cases/detectors.json, is skipped, so one busy bot cannot fill the split and
 * no transaction a rule was tuned on comes back. The seed and tip are printed
 * on stderr; the same arguments with `--seed S --tip T` redraw the same sample.
 *
 * Prints a JSON array of negatives with `split: "holdout"`, each with its
 * sender, time, Move calls and the protocol its packages resolve to in the
 * curated registry (by package id, then by upgrade lineage root).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gql as gqlOnce, ROOT } from "./lib/mcp-client.mjs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const functions = argv.flatMap((a, i) => (a === "--function" ? [argv[i + 1]] : [])).map((f) => {
  const eq = f?.indexOf("=") ?? -1;
  if (eq < 1 || f.split("::").length !== 3) {
    console.error(`--function takes "<shape>=<package>::<module>::<function>", got ${f}`);
    process.exit(2);
  }
  return { shape: f.slice(0, eq), fn: f.slice(eq + 1) };
});
const SEED = arg("seed") !== undefined ? Number(arg("seed")) >>> 0 : Math.floor(Math.random() * 2 ** 32);
const N = Math.max(1, Number(arg("n") ?? 100));
const PER = Math.max(1, Number(arg("per") ?? 2));
const WINDOW = Math.max(1, Number(arg("window") ?? 30_000_000));

/** mulberry32, the generator invariant-pass uses. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);

/** The public endpoint answers bursts with an HTML 429; retry those. */
async function gql(query, variables) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await gqlOnce(query, variables);
    } catch (err) {
      if (attempt >= 7 || !/429|Unexpected token|fetch failed|JSON|timeout|ECONNRESET|503|502/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

const TIP = arg("tip") !== undefined ? Number(arg("tip")) : Number((await gql("{ checkpoint { sequenceNumber } }")).checkpoint.sequenceNumber);
console.error(`seed ${SEED} tip ${TIP} window ${WINDOW} ${functions.length ? `${functions.length} functions, ${PER} each` : `n ${N}`}`);

const labelled = JSON.parse(readFileSync(join(ROOT, "cases", "detectors.json"), "utf8"));
const usedDigests = new Set([...labelled.positives, ...labelled.negatives].map((e) => e.digest));
const usedSenders = new Set([...labelled.positives, ...labelled.negatives].map((e) => e.sender));

const curated = JSON.parse(readFileSync(join(ROOT, "src", "data", "protocols.json"), "utf8")).protocols;
const roots = JSON.parse(readFileSync(join(ROOT, "src", "data", "protocol-roots.json"), "utf8")).roots;
const FRAMEWORK = /^0x0{63}[1-9a-f]$/;
const nameCache = new Map();
async function protocolOf(pkg) {
  if (curated[pkg]) return curated[pkg].name;
  if (!nameCache.has(pkg)) {
    const d = await gql("query($a:SuiAddress!){ packageVersions(address:$a, first:1){ nodes{ address } } }", { a: pkg });
    const root = d.packageVersions?.nodes?.[0]?.address ?? pkg;
    nameCache.set(pkg, curated[root]?.name ?? roots[root]?.name ?? null);
  }
  return nameCache.get(pkg);
}

const TX_FIELDS = `digest sender{ address } effects{ status timestamp }
  kind{ __typename ... on ProgrammableTransaction{ commands(first:50){ nodes{ __typename ... on MoveCallCommand{ function{ name module{ name package{ address } } } } } } } }`;
const CP_QUERY = `query($s:UInt53){ checkpoint(sequenceNumber:$s){ transactions(first:50){ nodes{ ${TX_FIELDS} } } } }`;
const FN_QUERY = `query($f:String!,$b:UInt53){ transactions(last:20, filter:{ function:$f, beforeCheckpoint:$b }){ nodes{ ${TX_FIELDS} } } }`;

const shortCall = (c) => {
  const [p, ...rest] = c.split("::");
  return `${FRAMEWORK.test(p) ? `0x${p.slice(-1)}` : p.slice(0, 10)}::${rest.join("::")}`;
};

/** Take one eligible transaction at random from `nodes`, or null. */
async function take(nodes, shape, how) {
  const eligible = nodes.filter(
    (t) =>
      t.kind?.__typename === "ProgrammableTransaction" &&
      t.effects?.status === "SUCCESS" &&
      t.sender?.address &&
      !usedDigests.has(t.digest) &&
      !usedSenders.has(t.sender.address),
  );
  // Draw even when nothing is eligible, so the sequence does not depend on the labelled set's size.
  const pick = eligible[Math.floor(rand() * eligible.length)];
  if (!pick) return null;
  usedSenders.add(pick.sender.address);
  usedDigests.add(pick.digest);
  const cmds = pick.kind.commands?.nodes ?? [];
  const calls = [
    ...new Set(cmds.filter((c) => c.function).map((c) => `${c.function.module.package.address}::${c.function.module.name}::${c.function.name}`)),
  ];
  const own = calls.filter((c) => !FRAMEWORK.test(c.split("::")[0]));
  const names = [...new Set((await Promise.all([...new Set(own.map((c) => c.split("::")[0]))].map(protocolOf))).filter(Boolean))];
  const shown = (own.length ? own : calls).map(shortCall);
  return {
    digest: pick.digest,
    split: "holdout",
    protocol: names.length ? names.join(" / ") : own.length ? `unlabelled ${own[0].slice(0, 10)}` : "Sui framework",
    shape,
    sender: pick.sender.address,
    timestamp: pick.effects.timestamp,
    calls: shown.length ? shown.slice(0, 8) : [...new Set(cmds.map((c) => c.__typename.replace("Command", "")))],
    source: `sample-negatives.mjs --seed ${SEED} --tip ${TIP} --window ${WINDOW}: ${how}; senders not already labelled`,
  };
}

const randomCheckpoint = () => TIP - 1 - Math.floor(rand() * WINDOW);
const out = [];
if (!functions.length) {
  for (let draws = 1; out.length < N; draws++) {
    if (draws > N * 20) {
      console.error(`stopped after ${draws - 1} checkpoint draws with ${out.length} transactions`);
      break;
    }
    const nodes = (await gql(CP_QUERY, { s: randomCheckpoint() })).checkpoint?.transactions?.nodes ?? [];
    const e = await take(nodes, "random checkpoint sample", "one random successful programmable transaction from a random checkpoint");
    if (!e) continue;
    out.push(e);
    console.error(`${String(out.length).padStart(3)}/${N} ${e.digest} ${e.protocol}`);
  }
} else {
  for (const { shape, fn } of functions) {
    let got = 0;
    for (let tries = 0; got < PER && tries < PER * 6; tries++) {
      const nodes = (await gql(FN_QUERY, { f: fn, b: randomCheckpoint() })).transactions?.nodes ?? [];
      const e = await take(nodes, shape, `a random pick among the last 20 calls of ${shortCall(fn)} before a random checkpoint`);
      if (!e) continue;
      out.push(e);
      got++;
      console.error(`${shape}: ${e.digest} ${e.protocol}`);
    }
    if (got < PER) console.error(`${shape}: only ${got} of ${PER} found`);
  }
}
console.log(JSON.stringify(out, null, 2));
