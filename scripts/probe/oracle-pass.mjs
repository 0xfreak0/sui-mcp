#!/usr/bin/env node
/**
 * Oracle pass: tool answers on subjects drawn at random from mainnet, each
 * against the same fact read from the chain by another path. The case checks
 * replay incidents somebody picked and the invariant pass checks rules that
 * hold for any input; this checks facts on subjects nobody picked, in states
 * the curated incidents never reach: effects version 1, wrapped objects,
 * capabilities stored inside other objects.
 *
 *   node scripts/probe/oracle-pass.mjs [--seed N] [--tip CHECKPOINT] [--scan N] [--txs N]
 *     [--ends N] [--router N] [--coins N] [--jobs N] [--subjects JSON|FILE] [--dist PATH]
 *
 * Truth never goes through the code under test: it is raw GraphQL, and for
 * effects version 1 the effects' own BCS, read in the same run.
 *
 * a. Swap labels. get_transaction's `Swap X → Y` actions on transactions
 *    calling Aftermath's router. Each event naming a pool and a direction is a
 *    hop, its coins the pool object's first two type arguments in the order
 *    the event states (an event listing one type in and one out names them
 *    itself). The hops must appear in order among the decoded swaps, and no
 *    label may name a type that is not a coin. A label carries symbols, so it
 *    is read back into the types it can name with the tested build's own
 *    `displayCoin` over every type the transaction carries, and the comparison
 *    is by coin type.
 * b. Object end. trace_object_history, and get_upgrade_history for an
 *    UpgradeCap, against the object's live state, or against `idDeleted` in
 *    the objectChanges of the newest transaction that touched it.
 * c. Object changes. get_transaction's `object_changes` against GraphQL
 *    objectChanges: `idCreated`, `idDeleted`, and whether an input and an
 *    output state exist. GraphQL gives no input state under effects version 1,
 *    so there the effects' BCS lists separate unwrapped from mutated and
 *    cross-check the rest.
 * d. Mint authority. analyze_package on a registry coin's package must list
 *    its TreasuryCap<T> or name T in `coins_without_located_mint_authority`.
 *    A cap the registry's `treasury_cap_id` or a TreasuryCap<T> type query
 *    finds must be listed, and every listed cap must have the owner the chain
 *    gives: one deleted, or consumed by a registry supply of Fixed or
 *    BurnOnly, reads `burned`, one another object owns names that object
 *    (the owner of its `dynamic_field::Field` for a dynamic object field),
 *    and `unknown` never matches.
 * e. Flows. get_transaction's `token_flow` summed per coin against the
 *    sender's GraphQL balanceChanges, and `balance_changes` summed per owner
 *    and coin against all of them.
 * f. Cap owners. The other capabilities analyze_package lists, and
 *    get_upgrade_history's current holder, against each object's live owner.
 *
 * Sampling. `--seed` (default random) and `--tip` (default the latest
 * checkpoint) are printed first; `--seed S --tip T` redraws the same
 * subjects. Transactions come from three eras: effects version 1 (every
 * checkpoint before 23,897,141), later, and the newest million checkpoints.
 * `--scan` random checkpoints per era (default 8) are read, and from them
 * `--txs` transactions per era (default 4) go to c and e, one that wraps an
 * object and one that unwraps one first when the era has them, and `--ends`
 * removed objects (default 6, wrapped ones first) go to b. A wrap under
 * effects version 1 is rare in a random checkpoint, so when an era-1 scan
 * finds none, an object it saw unwrapped leads back to the transaction that
 * wrapped it, and failing that a call of Wormhole's `complete_registration`
 * before the era ends is drawn. `--router` router transactions (default 6)
 * go to a, c and e, and `--coins` registry coins (default 6, alternately
 * registered through `finalize_registration` and migrated through
 * `migrate_legacy_metadata`) to d and f, with their package's UpgradeCap to
 * b. `--jobs` subjects run at once through one server (default 2).
 * `VERBOSE=1` prints both sides of every agreement too.
 *
 * `--subjects` pins the subjects instead, as JSON or a file holding it:
 * `{"a":[digest],"b":[object or package id],"c":[digest],"d":[coin type],
 * "e":[digest],"f":[package id]}`. Only the oracles it names run; a package
 * given to b stands for its UpgradeCap. `--dist` runs another build's
 * `dist/index.js`.
 *
 * With `SUI_REPLAY_DIR` set, the server and the fixed raw reads (a
 * transaction by digest, a checkpoint, an object at a version, a closed
 * checkpoint range) replay from it. Live state is always read live.
 *
 * The report gives, per oracle, the samples checked, the agreements, each
 * disagreement with its subject, our answer, the truth and how the truth was
 * read, and each skip with its reason. A skip is never a pass. A tool error
 * on a valid subject is a disagreement; a state the tool itself says it could
 * not read, or a rate limit it reports, is a skip. A disagreement not in
 * KNOWN_DEFECTS fails the run, and so does a drawn oracle that checked
 * nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bcs } from "@mysten/sui/bcs";
import { startServer, gql as gqlOnce, ROOT } from "./lib/mcp-client.mjs";

/**
 * Disagreements already tracked. An entry names its oracles, a note saying
 * where it is tracked, and either one `subject` or a `problem` test that
 * every problem of a disagreement must pass. A matching disagreement is
 * reported as known and does not fail the run; a listed subject that agrees
 * fails it until its entry is removed. Never add an entry to quiet a new
 * finding.
 */
const KNOWN_DEFECTS = [];

const ORACLES = {
  a: {
    title: "swap labels",
    how: "each swap event's pool id and direction (GraphQL events), the pool object's type arguments from the transaction's objectChanges; labels read back into coin types with the build's displayCoin",
  },
  b: {
    title: "object end",
    how: "GraphQL object(address:) for a live object; otherwise idDeleted and outputState of the object in objectChanges of the newest transaction with it as affectedObject (effects version 1: cross-checked with the effects BCS lists)",
  },
  c: {
    title: "object changes",
    how: "GraphQL objectChanges: idCreated, idDeleted, inputState and outputState presence; effects version 1: the effects BCS created, mutated, unwrapped, deleted, unwrapped_then_deleted and wrapped lists",
  },
  d: {
    title: "mint authority",
    how: "the registry's Currency<T> (GraphQL objects of that exact type): treasury_cap_id and supply; GraphQL objects of type TreasuryCap<T>; each cap's live owner, or idDeleted in its newest transaction",
  },
  e: { title: "flows", how: "GraphQL balanceChanges of the transaction, every page" },
  f: {
    title: "cap owners",
    how: "GraphQL object(address:) owner of each capability; for one no longer live, idDeleted in its newest transaction",
  },
};
for (const o of Object.values(ORACLES)) o.rows = [];

// ---- arguments -------------------------------------------------------------
const FLAGS = ["seed", "tip", "scan", "txs", "ends", "router", "coins", "jobs", "subjects", "dist"];
function usage(message) {
  console.error(
    `${message}\nusage: node scripts/probe/oracle-pass.mjs [--seed N] [--tip CHECKPOINT] [--scan N] [--txs N] [--ends N] [--router N] [--coins N] [--jobs N] [--subjects JSON|FILE] [--dist PATH]`,
  );
  process.exit(2);
}
const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i += 2) {
  const name = argv[i].replace(/^--/, "");
  if (!argv[i].startsWith("--") || !FLAGS.includes(name)) usage(`unknown argument ${argv[i]}`);
  if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) usage(`${argv[i]} needs a value`);
  opts[name] = argv[i + 1];
}
function whole(name, fallback, min = 0) {
  if (opts[name] === undefined) return fallback;
  const n = Number(opts[name]);
  if (!Number.isSafeInteger(n) || n < min) usage(`--${name} needs a whole number, ${min} or more`);
  return n;
}
const SEED = opts.seed !== undefined ? whole("seed", 0) >>> 0 : Math.floor(Math.random() * 2 ** 32);
const SCAN = whole("scan", 8, 1);
const TXS = whole("txs", 4);
const ENDS = whole("ends", 6);
const ROUTER_N = whole("router", 6);
const COINS = whole("coins", 6);
const JOBS = whole("jobs", 2, 1);
const DIST = resolve(opts.dist ?? join(ROOT, "dist", "index.js"));

function readSubjects(value) {
  let parsed;
  try {
    parsed = JSON.parse(value.trim().startsWith("{") ? value : readFileSync(value, "utf8"));
  } catch (err) {
    usage(`--subjects: ${err.message}`);
  }
  for (const [key, list] of Object.entries(parsed)) {
    if (!ORACLES[key]) usage(`--subjects: there is no oracle "${key}" (a to f)`);
    if (!Array.isArray(list) || !list.every((s) => typeof s === "string" && s.trim())) usage(`--subjects: "${key}" needs a list of strings`);
  }
  return parsed;
}
const PINNED = opts.subjects === undefined ? null : readSubjects(opts.subjects);

/** mulberry32, as in invariant-pass: small, fast and the same on every platform. */
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
/** The draw. Only planning uses it, before any subject runs, so `--jobs` cannot reorder it. */
const rand = rng(SEED);
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
const pick = (xs) => (xs.length ? xs[Math.floor(rand() * xs.length)] : undefined);
const shuffled = (xs, next = rand) => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// ---- chain constants -------------------------------------------------------
/**
 * The last checkpoint of effects version 1: version 2 starts at checkpoint
 * 23,897,141 (2024-01-18). Each drawn transaction's version is read from its
 * effects BCS and checked against its era, so the report says if this moves.
 */
const V1_LAST = 23_897_140;
/** The newest this many checkpoints are the `recent` era. */
const RECENT = 1_000_000;
/** A sampling range ends this far below the tip, so the replay cache may record it. */
const SETTLE = 2_000;
const ROUTER = "0x7de5de8d75a8f4e42cdd3c018f788bc9b9ebf2d3d61dcfe9d2136f17f077afd5::router";
const REGISTRY_FUNCTIONS = [
  ["registered", "0x2::coin_registry::finalize_registration"],
  ["migrated", "0x2::coin_registry::migrate_legacy_metadata"],
];

// ---- normal forms ----------------------------------------------------------
const normAddr = (a) => `0x${String(a).replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
/** Every address in a type padded to 64 hex digits, with 0x added where a TypeName leaves it off. */
const normType = (t) =>
  String(t ?? "")
    .trim()
    .replace(/(^|[<,\s])(?:0x)?([0-9a-fA-F]{1,64})(?=::)/g, (_, pre, h) => `${pre}0x${h.toLowerCase().padStart(64, "0")}`)
    .replace(/,\s*/g, ", ");
const ADDR2 = normAddr("0x2");
const ZERO = normAddr("0x0");
const UPGRADE_CAP = `${ADDR2}::package::UpgradeCap`;
const OWNER_KIND = { AddressOwner: "address", ConsensusAddressOwner: "consensus", ObjectOwner: "object", Shared: "shared", Immutable: "immutable" };

/** The top-level type arguments of a type. */
function typeArgsOf(type) {
  const open = type.indexOf("<");
  if (open < 0 || !type.endsWith(">")) return [];
  const inner = type.slice(open + 1, -1);
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "<") depth++;
    else if (inner[i] === ">") depth--;
    else if (inner[i] === "," && depth === 0) {
      out.push(normType(inner.slice(start, i)));
      start = i + 1;
    }
  }
  out.push(normType(inner.slice(start)));
  return out;
}

const text = (v, n = 4000) => {
  const s = typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

// ---- raw GraphQL -----------------------------------------------------------
/** Raw GraphQL, retried on a transient failure. `fixed` reads go through the replay cache. */
async function gql(query, variables, fixed = false) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await gqlOnce(query, variables, { replay: fixed });
    } catch (err) {
      if (attempt >= 6 || !/429|Unexpected token|fetch failed|JSON|timeout|ECONNRESET|50[234]/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

const OBJECT_CHANGES = `pageInfo{ hasNextPage endCursor } nodes{ address idCreated idDeleted
  inputState{ version asMoveObject{ contents{ type{ repr } } } }
  outputState{ version owner{ __typename } asMoveObject{ contents{ type{ repr } } } asMovePackage{ address } } }`;
const BALANCE_CHANGES = "pageInfo{ hasNextPage endCursor } nodes{ owner{ address } coinType{ repr } amount }";
const EVENTS = "pageInfo{ hasNextPage endCursor } nodes{ contents{ type{ repr } json } }";
const TX_QUERY = `query($d:String!){ transaction(digest:$d){ digest sender{ address } kind{ __typename } transactionJson
  effects{ status checkpoint{ sequenceNumber } effectsBcs objectChanges(first:1024){ ${OBJECT_CHANGES} }
    balanceChanges(first:50){ ${BALANCE_CHANGES} } events(first:50){ ${EVENTS} } } } }`;
const nextPage = (field, first, selection) =>
  `query($d:String!,$a:String){ transaction(digest:$d){ effects{ ${field}(first:${first}, after:$a){ ${selection} } } } }`;

/** Object ids named by each list of an effects-version-1 BCS, and the version each input was read at. */
function v1Lists(v) {
  const ids = (xs) => new Set(xs.map((x) => normAddr((Array.isArray(x) ? x[0] : x).objectId)));
  return {
    created: ids(v.created),
    mutated: new Set([...ids(v.mutated), ...ids([v.gasObject])]),
    unwrapped: ids(v.unwrapped),
    deleted: new Set([...ids(v.deleted), ...ids(v.unwrappedThenDeleted)]),
    wrapped: ids(v.wrapped),
    versions: new Map(v.modifiedAtVersions.map(([id, version]) => [normAddr(id), String(version)])),
  };
}
/** What an effects-version-1 BCS says happened to an object, or null when no list names it. */
function v1Kind(v1, id) {
  for (const kind of ["created", "deleted", "wrapped", "unwrapped", "mutated"]) if (v1[kind].has(id)) return kind;
  return null;
}

/** Every string in a `typeArguments` list anywhere under a transaction's JSON. */
function collectTypeArgs(json, out = new Set()) {
  if (Array.isArray(json)) for (const x of json) collectTypeArgs(x, out);
  else if (json && typeof json === "object")
    for (const [k, v] of Object.entries(json)) {
      if (k === "typeArguments" && Array.isArray(v)) for (const t of v) typeof t === "string" && out.add(normType(t));
      else collectTypeArgs(v, out);
    }
  return out;
}

/** The `package::module::function` of every Move call under a transaction's JSON. */
function collectCalls(json, out = new Set()) {
  if (Array.isArray(json)) for (const x of json) collectCalls(x, out);
  else if (json && typeof json === "object") {
    const c = json.moveCall;
    if (c?.package) out.add(`${normAddr(c.package)}::${c.module}::${c.function}`);
    for (const v of Object.values(json)) collectCalls(v, out);
  }
  return out;
}

const txCache = new Map();
/** One transaction as GraphQL reports it, every page read. */
function rawTx(digest) {
  if (!txCache.has(digest)) txCache.set(digest, readTx(digest).catch((err) => (txCache.delete(digest), Promise.reject(err))));
  return txCache.get(digest);
}
async function readTx(digest) {
  const t = (await gql(TX_QUERY, { d: digest }, true)).transaction;
  if (!t) throw new Error(`GraphQL has no transaction ${digest}`);
  const e = t.effects;
  const pages = async (field, first, selection) => {
    const nodes = [...e[field].nodes];
    for (let p = e[field].pageInfo; p.hasNextPage; ) {
      const c = (await gql(nextPage(field, first, selection), { d: digest, a: p.endCursor }, true)).transaction.effects[field];
      nodes.push(...c.nodes);
      p = c.pageInfo;
    }
    return nodes;
  };
  const [changes, balances, events] = await Promise.all([
    pages("objectChanges", 1024, OBJECT_CHANGES),
    pages("balanceChanges", 50, BALANCE_CHANGES),
    pages("events", 50, EVENTS),
  ]);
  const effects = bcs.TransactionEffects.parse(Buffer.from(e.effectsBcs, "base64"));
  const typeOf = (state) => (state.asMovePackage ? "package" : normType(state.asMoveObject?.contents?.type?.repr) || null);
  return {
    digest,
    sender: t.sender?.address ? normAddr(t.sender.address) : null,
    kind: t.kind?.__typename ?? null,
    status: e.status,
    checkpoint: Number(e.checkpoint?.sequenceNumber),
    effectsVersion: effects.V1 ? 1 : 2,
    v1: effects.V1 ? v1Lists(effects.V1) : null,
    changes: new Map(
      changes.map((n) => [
        normAddr(n.address),
        {
          id: normAddr(n.address),
          created: n.idCreated === true,
          deleted: n.idDeleted === true,
          input: n.inputState ? { version: String(n.inputState.version), type: typeOf(n.inputState) } : null,
          output: n.outputState ? { version: String(n.outputState.version), type: typeOf(n.outputState), owner: n.outputState.owner?.__typename ?? null } : null,
        },
      ]),
    ),
    balances: balances.map((n) => ({ owner: n.owner?.address ? normAddr(n.owner.address) : null, coin: normType(n.coinType?.repr), amount: BigInt(n.amount) })),
    events: events.map((n) => ({ type: n.contents?.type?.repr ?? "", json: n.contents?.json ?? {} })),
    typeArgs: collectTypeArgs(t.transactionJson),
    calls: collectCalls(t.transactionJson),
  };
}

/**
 * What happened to each changed object, from GraphQL objectChanges, and under
 * effects version 1 from the effects BCS lists as well. `conflicts` names
 * each object the two readings disagree on, or one neither can place.
 */
function truthKinds(tx) {
  const kinds = new Map();
  const conflicts = [];
  for (const c of tx.changes.values()) {
    let reading;
    if (c.created) reading = "created";
    else if (c.deleted) reading = "deleted";
    else if (!c.output) reading = c.input || tx.v1 ? "wrapped" : null;
    else if (c.input) reading = "mutated";
    else reading = tx.v1 ? "mutated or unwrapped" : "unwrapped";
    if (tx.v1) {
      const listed = v1Kind(tx.v1, c.id);
      if (listed && (listed === reading || (reading === "mutated or unwrapped" && (listed === "mutated" || listed === "unwrapped")))) kinds.set(c.id, listed);
      else conflicts.push({ object: c.id, graphql: reading ?? "no reading", effects_bcs: listed ?? "in no list" });
    } else if (reading) kinds.set(c.id, reading);
    else conflicts.push({ object: c.id, graphql: "no input or output state, and not deleted" });
  }
  if (tx.v1)
    for (const kind of ["created", "deleted", "wrapped", "unwrapped", "mutated"])
      for (const id of tx.v1[kind]) if (id !== ZERO && !tx.changes.has(id)) conflicts.push({ object: id, graphql: "absent", effects_bcs: kind });
  return { kinds, conflicts };
}

const objectCache = new Map();
/**
 * An object's state now: live with its owner, or gone with how it ended
 * (`deleted` or `wrapped`) and the transaction that ended it. `unreadable`
 * says why neither could be read.
 */
function objectTruth(id) {
  const key = normAddr(id);
  if (!objectCache.has(key)) objectCache.set(key, readObjectTruth(key).catch((err) => (objectCache.delete(key), Promise.reject(err))));
  return objectCache.get(key);
}
async function readObjectTruth(id) {
  const d = await gql(
    `query($a:SuiAddress!){ object(address:$a){ version owner{ __typename ... on ObjectOwner{ address{ address } } } asMoveObject{ contents{ type{ repr } json } } asMovePackage{ address } }
      last: transactions(filter:{ affectedObject:$a }, last:1){ nodes{ digest } } }`,
    { a: id },
  );
  if (d.object?.asMovePackage) return { exists: true, package: true };
  if (d.object) {
    const typename = d.object.owner?.__typename;
    // The object that holds an object-owned one. A dynamic object field is
    // owned by its dynamic_field::Field, which the object holding the field owns.
    let holder = null;
    if (typename === "ObjectOwner") {
      holder = normAddr(d.object.owner.address.address);
      const direct = (
        await gql(`query($a:SuiAddress!){ object(address:$a){ owner{ __typename ... on ObjectOwner{ address{ address } } } asMoveObject{ contents{ type{ repr } } } } }`, { a: holder })
      ).object;
      if (normType(direct?.asMoveObject?.contents?.type?.repr).startsWith(`${ADDR2}::dynamic_field::Field<`) && direct.owner?.__typename === "ObjectOwner")
        holder = normAddr(direct.owner.address.address);
    }
    return {
      exists: true,
      owner: OWNER_KIND[typename] ?? `unread (${typename})`,
      ...(holder ? { holder } : {}),
      type: normType(d.object.asMoveObject?.contents?.type?.repr),
      json: d.object.asMoveObject?.contents?.json ?? null,
    };
  }
  const last = d.last.nodes[0]?.digest;
  if (!last) return { unreadable: "GraphQL has neither the object nor a transaction touching it" };
  const tx = await rawTx(last);
  const c = tx.changes.get(id);
  if (!c) return { unreadable: `its newest transaction ${last} does not list it in objectChanges` };
  if (c.output) return { unreadable: `it is not live, yet its newest transaction ${last} left it at top level` };
  const kind = c.deleted ? "deleted" : "wrapped";
  if (tx.v1 && v1Kind(tx.v1, id) !== kind)
    return { unreadable: `in ${last} GraphQL reads it ${kind} and the effects BCS ${v1Kind(tx.v1, id) ?? "in no list"}` };
  const version = c.input?.version ?? tx.v1?.versions.get(id) ?? null;
  let type = c.input?.type ?? null;
  let json = null;
  if (version) {
    const at = await gql(`query($a:SuiAddress!,$v:UInt53){ object(address:$a, version:$v){ asMoveObject{ contents{ type{ repr } json } } } }`, { a: id, v: Number(version) }, true);
    type ??= normType(at.object?.asMoveObject?.contents?.type?.repr) || null;
    json = at.object?.asMoveObject?.contents?.json ?? null;
  }
  return { exists: false, kind, tx: last, type, json };
}
/** The owner kind a capability audit names for an object's state. */
const capOwner = (t) => (t.exists ? t.owner : t.kind === "deleted" ? "burned" : "wrapped");

const upgradeCapCache = new Map();
/**
 * The UpgradeCap a package's publish transaction created for it (`id`), or
 * `destroyedAtPublish` naming that transaction when it created none and
 * called `0x2::package::make_immutable`: a cap created and destroyed in one
 * transaction is in no object change, while one created and wrapped is, with
 * no output state, so the call can only have destroyed this package's cap.
 */
function upgradeCapOf(pkg) {
  const key = normAddr(pkg);
  if (!upgradeCapCache.has(key)) upgradeCapCache.set(key, readUpgradeCap(key));
  return upgradeCapCache.get(key);
}
async function readUpgradeCap(pkg) {
  const d = await gql(`query($a:SuiAddress!){ object(address:$a){ asMovePackage{ address } previousTransaction{ digest } } }`, { a: pkg });
  if (!d.object?.asMovePackage) return { unreadable: `${pkg} is not a package` };
  const publish = d.object.previousTransaction?.digest;
  if (!publish) return { unreadable: "GraphQL names no publish transaction" };
  const tx = await rawTx(publish);
  const caps = [...tx.changes.values()].filter((c) => c.created && c.output?.type === UPGRADE_CAP);
  for (const c of caps) {
    const at = await gql(`query($a:SuiAddress!,$v:UInt53){ object(address:$a, version:$v){ asMoveObject{ contents{ json } } } }`, { a: c.id, v: Number(c.output.version) }, true);
    if (normAddr(at.object?.asMoveObject?.contents?.json?.package ?? ZERO) === pkg) return { id: c.id, publish };
  }
  if (tx.calls.has(`${ADDR2}::package::make_immutable`) && ![...tx.changes.values()].some((c) => c.created && !c.output))
    return { destroyedAtPublish: publish };
  return { unreadable: `its publish transaction ${publish} lists no UpgradeCap for it` };
}

/** Which of `types` have a CoinMetadata GraphQL can read. */
async function coinsOnChain(types) {
  const out = new Map();
  for (let i = 0; i < types.length; i += 20) {
    const batch = types.slice(i, i + 20);
    const d = await gql(
      `query(${batch.map((_, j) => `$t${j}:String!`).join(",")}){ ${batch.map((_, j) => `c${j}: coinMetadata(coinType:$t${j}){ address }`).join(" ")} }`,
      Object.fromEntries(batch.map((t, j) => [`t${j}`, t])),
    );
    batch.forEach((t, j) => out.set(t, !!d[`c${j}`]));
  }
  return out;
}

// ---- the server and its answers ---------------------------------------------
const server = await startServer({ name: "oracle-pass", replay: true, entry: DIST });
const toolCache = new Map();
let toolCalls = 0;
/** One tool answer, called once per tool and arguments: `{ json }`, `{ error }` or `{ limited }`. */
function callTool(tool, args) {
  const key = JSON.stringify([tool, args]);
  if (!toolCache.has(key)) toolCache.set(key, invoke(tool, args));
  return toolCache.get(key);
}
async function invoke(tool, args) {
  toolCalls++;
  const msg = await server.callRaw(tool, args, 240_000);
  const texts = (msg.result?.content ?? []).map((c) => c.text ?? "");
  const joined = texts.join("\n");
  if (msg.timedOut) return { error: `${tool}: no answer in 240s` };
  if (msg.error) return { error: `${tool}: JSON-RPC error ${msg.error.message}` };
  // The public endpoints are shared. A tool that says it was rate-limited, or
  // that the node told it to back off (gRPC RESOURCE_EXHAUSTED, an HTTP/2
  // GOAWAY), gave no answer to compare, so the sample is skipped.
  const refused = /Rate-limited by .*HTTP 429|resource has been exhausted|RESOURCE_EXHAUSTED|ENHANCE_YOUR_CALM/i;
  if (msg.result?.isError) return refused.test(joined) ? { limited: `${tool}: ${joined.slice(0, 200)}` } : { error: `${tool}: ${joined.slice(0, 600)}` };
  const json = texts.find((t) => t.trim().startsWith("{"));
  try {
    return json ? { json: JSON.parse(json) } : { error: `${tool}: no JSON in the answer: ${joined.slice(0, 200)}` };
  } catch {
    return { error: `${tool}: the answer is not valid JSON` };
  }
}

let displayCoin;
/** The tested build's own rendering of a coin type in an action label. */
async function labelSymbol() {
  displayCoin ??= import(pathToFileURL(join(dirname(DIST), "utils", "valuation.js")).href).then((m) => m.displayCoin);
  const render = await displayCoin;
  return (type) => render(type).symbol;
}

// ---- the recorder ----------------------------------------------------------
/** One sample's outcome. `status` is agree, disagree or skip; a disagreement listed in KNOWN_DEFECTS becomes known. */
function record(oracle, key, subject, status, detail = {}) {
  const known = KNOWN_DEFECTS.find(
    (k) => k.oracles.includes(oracle) && (k.subject ? k.subject === subject : status === "disagree" && detail.problems?.length > 0 && detail.problems.every(k.problem)),
  );
  const row = { key, subject, status, ...detail };
  if (known && status === "disagree") (row.status = "known"), (row.known = known.note);
  if (known && status === "agree") (row.status = "stale"), (row.known = known.note);
  ORACLES[oracle].rows.push(row);
}
const skip = (oracle, key, subject, reason) => record(oracle, key, subject, "skip", { reason });
/** A tool answer's JSON, or null after recording why there is none. A tool error on a valid subject is a disagreement. */
function answerOf(oracle, key, subject, res) {
  if (res.limited) return skip(oracle, key, subject, `the endpoint refused the tool's reads: ${res.limited}`), null;
  if (res.error) return record(oracle, key, subject, "disagree", { ours: `error: ${res.error}`, truth: "a valid subject" }), null;
  return res.json;
}
/** Truth read by `read`, or null after recording a skip naming why it could not be read. */
async function truthOf(oracle, key, subject, read) {
  try {
    const t = await read();
    if (t?.unreadable) return skip(oracle, key, subject, `truth unreadable: ${t.unreadable}`), null;
    return t;
  } catch (err) {
    return skip(oracle, key, subject, `truth unreadable: ${String(err?.message ?? err).slice(0, 300)}`), null;
  }
}

// ---- a. swap labels ---------------------------------------------------------
const DIRECTION = ["atob", "a_to_b", "a2b", "x_for_y"];
const SWAP_LABEL = /^Swap (.+?) → (.+?)(?: on (.+))?$/;

/** The swap hops a transaction's events state, in emission order. */
function swapHops(tx) {
  const hops = [];
  const unresolved = [];
  tx.events.forEach((e, index) => {
    const j = e.json ?? {};
    if (Array.isArray(j.types_in) && Array.isArray(j.types_out)) {
      if (j.types_in.length === 1 && j.types_out.length === 1)
        hops.push({ event: index, pool: j.pool_id ?? null, coin_in: normType(j.types_in[0]), coin_out: normType(j.types_out[0]) });
      return;
    }
    const raw = j.pool ?? j.pool_id;
    const pool = typeof raw === "string" ? raw : raw?.id;
    const dir = DIRECTION.find((f) => typeof j[f] === "boolean");
    if (!pool || !dir) return;
    const c = tx.changes.get(normAddr(pool));
    const args = typeArgsOf(c?.input?.type ?? c?.output?.type ?? "");
    if (args.length < 2) return void unresolved.push({ event: index, pool });
    const [a, b] = args;
    hops.push({ event: index, pool: normAddr(pool), [dir]: j[dir], coin_in: j[dir] ? a : b, coin_out: j[dir] ? b : a });
  });
  return { hops, unresolved };
}

async function checkSwapLabels(key, digest) {
  const tx = await truthOf("a", key, digest, () => rawTx(digest));
  if (!tx) return;
  if (tx.status !== "SUCCESS") return skip("a", key, digest, "the transaction failed, so no swap ran");
  const { hops, unresolved } = swapHops(tx);
  if (!hops.length)
    return skip("a", key, digest, `no event names a pool and a direction${unresolved.length ? ` whose pool type could be read (${unresolved.length} could not)` : ""}`);
  const ans = answerOf("a", key, digest, await callTool("get_transaction", { digest }));
  if (!ans) return;
  const labels = (ans.actions ?? []).filter((a) => a.startsWith("Swap "));
  const symbol = await labelSymbol();
  const evidence = new Set([...tx.balances.map((b) => b.coin), ...hops.flatMap((h) => [h.coin_in, h.coin_out])]);
  const bySymbol = new Map();
  for (const t of new Set([...evidence, ...tx.typeArgs])) {
    const s = symbol(t);
    if (!bySymbol.has(s)) bySymbol.set(s, []);
    bySymbol.get(s).push(t);
  }
  const decoded = labels.map((label) => {
    const m = SWAP_LABEL.exec(label);
    return m ? { label, from: bySymbol.get(m[1]) ?? [], to: bySymbol.get(m[2]) ?? [] } : { label, unparsed: true, from: [], to: [] };
  });
  const coin = new Map([...evidence].map((t) => [t, true]));
  for (const [t, is] of await coinsOnChain([...new Set(decoded.flatMap((d) => [...d.from, ...d.to]))].filter((t) => !coin.has(t)))) coin.set(t, is);
  const problems = [];
  for (const d of decoded) {
    if (d.unparsed) {
      problems.push(`"${d.label}" does not read as "Swap X → Y"`);
      continue;
    }
    for (const [side, types] of [["input", d.from], ["output", d.to]]) {
      if (!types.length) problems.push(`"${d.label}": its ${side} names no type the transaction carries`);
      else if (!types.some((t) => coin.get(t))) problems.push(`"${d.label}": its ${side} names ${types.join(" or ")}, which is not a coin`);
    }
  }
  let at = 0;
  for (const [i, h] of hops.entries()) {
    while (at < decoded.length && !(decoded[at].from.includes(h.coin_in) && decoded[at].to.includes(h.coin_out))) at++;
    if (at === decoded.length) {
      problems.push(`event ${h.event} (pool ${h.pool}: ${h.coin_in} → ${h.coin_out})${hops.length - i > 1 ? ` and the ${hops.length - i - 1} hop(s) after it` : ""} not among the decoded swaps in order`);
      break;
    }
    at++;
  }
  const ambiguous = [...new Set(decoded.flatMap((d) => [d.from, d.to]).filter((ts) => ts.length > 1).map((ts) => `${symbol(ts[0])}: ${ts.join(", ")}`))];
  record("a", key, digest, problems.length ? "disagree" : "agree", {
    ours: labels,
    truth: hops.map((h) => `${h.coin_in} → ${h.coin_out} (event ${h.event}, pool ${h.pool})`),
    ...(problems.length ? { problems } : {}),
    ...(ambiguous.length ? { symbols_naming_several_types: ambiguous } : {}),
    ...(unresolved.length ? { hops_without_a_pool_type: unresolved } : {}),
  });
}

// ---- b and f. object end, and an UpgradeCap's holder -------------------------
async function checkObjectEnd(key, subject) {
  let id = subject.id ? normAddr(subject.id) : null;
  let pkg = subject.pkg ? normAddr(subject.pkg) : null;
  const label = subject.label ?? id ?? pkg;
  if (id) {
    const t = await truthOf("b", key, label, () => objectTruth(id));
    if (!t) return;
    if (t.package) (pkg = id), (id = null);
  }
  if (!id) {
    const cap = await truthOf("b", key, label, () => upgradeCapOf(pkg));
    if (!cap) return;
    if (cap.destroyedAtPublish) return checkDestroyedAtPublish(key, pkg, cap.destroyedAtPublish);
    id = cap.id;
  }
  const t = await truthOf("b", key, label, () => objectTruth(id));
  if (!t) return;
  const truth = t.exists ? { live: true, owner: t.owner } : { live: false, end: t.kind, tx: t.tx };

  const trace = answerOf("b", key, `trace_object_history ${id}`, await callTool("trace_object_history", { object_id: id }));
  if (trace) {
    const ours = { current: trace.current ? { owner: trace.current.owner?.kind ?? null } : null, end: trace.end ? { kind: trace.end.kind, tx: trace.end.tx } : null };
    const ok = t.exists
      ? !!trace.current && !trace.end && trace.current.owner?.kind === t.owner
      : !trace.current && trace.end?.kind === t.kind && trace.end?.tx === t.tx;
    record("b", key, `trace_object_history ${id}${subject.why ? ` (${subject.why})` : ""}`, ok ? "agree" : "disagree", { ours, truth });
  }

  if (t.type !== UPGRADE_CAP) return;
  pkg ??= t.json?.package ? normAddr(t.json.package) : null;
  const histSubject = `get_upgrade_history ${pkg} (UpgradeCap ${id})`;
  if (!pkg) return skip("b", key, `get_upgrade_history for UpgradeCap ${id}`, "the cap's package could not be read");
  const hist = answerOf("b", key, histSubject, await callTool("get_upgrade_history", { package: pkg }));
  if (!hist) return;
  const cap = hist.upgrade_cap ?? {};
  const ours = { upgrade_cap: { object_id: cap.object_id ?? null, state: cap.state ?? null }, cap_end: hist.cap_end ? { kind: hist.cap_end.kind, tx: hist.cap_end.tx } : null };
  const sameCap = cap.object_id && normAddr(cap.object_id) === id;
  // The tool says it could not read the cap's state, so there is no answer to compare.
  if (sameCap && cap.state === "unknown") return skip("b", key, histSubject, `the tool reports the cap's state as unknown: ${hist.upgrade_cap_note ?? "no note"}`);
  const ok = sameCap && (t.exists ? cap.state === "exists" && !hist.cap_end : cap.state === t.kind && hist.cap_end?.kind === t.kind && hist.cap_end?.tx === t.tx);
  record("b", key, histSubject, ok ? "agree" : "disagree", { ours, truth: { cap: id, ...truth } });
  if (t.exists && sameCap) {
    const holder = cap.current_holder?.kind ?? null;
    record("f", key, `get_upgrade_history ${pkg} holder of UpgradeCap ${id}`, holder === t.owner ? "agree" : "disagree", {
      ours: { current_holder: holder },
      truth: { owner: t.owner },
      ...(holder === t.owner ? {} : { problems: [{ cap: id, audit: holder, chain: t.owner }] }),
    });
  }
}

/** get_upgrade_history on a package whose publish transaction destroyed its UpgradeCap. */
async function checkDestroyedAtPublish(key, pkg, publish) {
  const subject = `get_upgrade_history ${pkg} (UpgradeCap destroyed in its publish ${publish})`;
  const hist = answerOf("b", key, subject, await callTool("get_upgrade_history", { package: pkg }));
  if (!hist) return;
  const cap = hist.upgrade_cap;
  const ours = { upgrade_cap: cap ? { object_id: cap.object_id ?? null, state: cap.state ?? null } : null, cap_end: hist.cap_end ? { kind: hist.cap_end.kind, tx: hist.cap_end.tx } : null };
  const ok = cap?.object_id == null && cap?.state === "deleted" && hist.cap_end?.kind === "deleted" && hist.cap_end?.tx === publish;
  record("b", key, subject, ok ? "agree" : "disagree", { ours, truth: { live: false, end: "deleted", tx: publish, how: "no UpgradeCap in the publish's objectChanges, and a make_immutable call in its PTB" } });
}

// ---- c. object changes -------------------------------------------------------
async function checkObjectChanges(key, digest, why) {
  const subject = why ? `${digest} (${why})` : digest;
  const tx = await truthOf("c", key, subject, () => rawTx(digest));
  if (!tx) return;
  const { kinds, conflicts } = truthKinds(tx);
  if (conflicts.length) return skip("c", key, subject, `GraphQL objectChanges and the effects BCS disagree: ${text(conflicts, 600)}`);
  const ans = answerOf("c", key, subject, await callTool("get_transaction", { digest, detail: "full" }));
  if (!ans) return;
  const oc = ans.object_changes ?? { changed: 0, created: 0, deleted: 0 };
  const ours = new Map();
  for (const [kind, rows] of Object.entries(oc.by_kind ?? {})) for (const r of rows) for (const id of r.object_ids ?? [r.object_id]) ours.set(normAddr(id), kind);
  const problems = [];
  for (const [id, kind] of kinds) {
    if (ours.get(id) !== kind) {
      const c = tx.changes.get(id);
      let type = c.input?.type ?? c.output?.type ?? null;
      // Effects version 1 gives GraphQL no input state: read the type at the version the effects name.
      const version = tx.v1?.versions.get(id);
      if (!type && version) {
        const at = await gql(`query($a:SuiAddress!,$v:UInt53){ object(address:$a, version:$v){ asMoveObject{ contents{ type{ repr } } } } }`, { a: id, v: Number(version) }, true);
        type = normType(at.object?.asMoveObject?.contents?.type?.repr) || null;
      }
      problems.push({ object: id, type, ours: ours.get(id) ?? "absent", truth: kind });
    }
  }
  for (const [id, kind] of ours) if (!kinds.has(id)) problems.push({ object: id, ours: kind, truth: "not in objectChanges" });
  const count = (k) => [...kinds.values()].filter((x) => x === k).length;
  const truthCounts = { changed: kinds.size, created: count("created"), deleted: count("deleted") };
  const ourCounts = { changed: oc.changed, created: oc.created, deleted: oc.deleted };
  if (ourCounts.changed !== truthCounts.changed || ourCounts.created !== truthCounts.created || ourCounts.deleted !== truthCounts.deleted)
    problems.push({ counts: { ours: ourCounts, truth: truthCounts } });
  const tally = (m) => Object.fromEntries(["created", "mutated", "unwrapped", "wrapped", "deleted"].map((k) => [k, [...m.values()].filter((x) => x === k).length]).filter(([, n]) => n));
  record("c", key, subject, problems.length ? "disagree" : "agree", {
    ours: tally(ours),
    truth: { effects_version: tx.effectsVersion, ...tally(kinds) },
    ...(problems.length ? { problems } : {}),
  });
}

// ---- e. flows ----------------------------------------------------------------
function sums(rows, keyOf, amountOf) {
  const m = new Map();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0n) + amountOf(r));
  for (const [k, v] of m) if (v === 0n) m.delete(k);
  return m;
}
function differences(ours, truth) {
  const out = [];
  for (const k of new Set([...ours.keys(), ...truth.keys()])) if ((ours.get(k) ?? 0n) !== (truth.get(k) ?? 0n)) out.push({ key: k, ours: String(ours.get(k) ?? 0n), truth: String(truth.get(k) ?? 0n) });
  return out;
}

async function checkFlows(key, digest, why) {
  const subject = why ? `${digest} (${why})` : digest;
  const tx = await truthOf("e", key, subject, () => rawTx(digest));
  if (!tx) return;
  if (!tx.balances.length) return skip("e", key, subject, "the transaction moved no coin");
  const ans = answerOf("e", key, subject, await callTool("get_transaction", { digest, detail: "full" }));
  if (!ans) return;
  const problems = [];
  if (tx.sender) {
    const truth = sums(tx.balances.filter((b) => b.owner === tx.sender), (b) => b.coin, (b) => b.amount);
    const ours = sums(ans.token_flow ?? [], (r) => normType(r.raw_type), (r) => BigInt(r.amount));
    for (const d of differences(ours, truth)) problems.push({ token_flow: d });
  }
  const truthAll = sums(tx.balances, (b) => `${b.owner}|${b.coin}`, (b) => b.amount);
  const oursAll = sums(ans.balance_changes ?? [], (r) => `${normAddr(r.address)}|${normType(r.coin_type)}`, (r) => BigInt(r.amount));
  for (const d of differences(oursAll, truthAll)) problems.push({ balance_changes: d });
  if ((ans.balance_change_count ?? (ans.balance_changes ?? []).length) !== tx.balances.length)
    problems.push({ balance_change_count: { ours: ans.balance_change_count ?? null, truth: tx.balances.length } });
  record("e", key, subject, problems.length ? "disagree" : "agree", {
    ours: { token_flow_coins: (ans.token_flow ?? []).length, balance_changes: (ans.balance_changes ?? []).length },
    truth: { sender_coins: tx.sender ? new Set(tx.balances.filter((b) => b.owner === tx.sender).map((b) => b.coin)).size : null, balance_changes: tx.balances.length },
    ...(problems.length ? { problems } : {}),
  });
}

// ---- d and f. mint authority and cap owners ------------------------------------
/** Every capability an audit lists, a folded entry expanded to its holders. */
function auditCaps(audit) {
  return (audit?.capabilities ?? []).flatMap((c) =>
    (c.holders ?? [{ object_id: c.object_id }]).map((h) => ({
      id: h.object_id ? normAddr(h.object_id) : null,
      destroyed_in_tx: c.destroyed_in_tx ?? null,
      kind: c.kind,
      type: normType(c.type),
      owner: c.owner,
      holder: c.owner === "object" ? normAddr(h.owner_address ?? c.owner_address ?? ZERO) : null,
    })),
  );
}
/** An owner as compared: its kind, and for an object-owned cap the object that holds it. */
const ownerLabel = (owner, holder) => (owner === "object" ? `object ${holder}` : owner);

async function mintTruth(coinType) {
  const d = await gql(
    `query($c:String!,$t:String!){ currency: objects(filter:{ type:$c }, first:2){ nodes{ address asMoveObject{ contents{ json } } } }
      caps: objects(filter:{ type:$t }, first:50){ nodes{ address owner{ __typename } } } }`,
    { c: `${ADDR2}::coin_registry::Currency<${coinType}>`, t: `${ADDR2}::coin::TreasuryCap<${coinType}>` },
  );
  const json = d.currency.nodes[0]?.asMoveObject?.contents?.json;
  const registry = json
    ? { currency: normAddr(d.currency.nodes[0].address), treasury_cap_id: json.treasury_cap_id ? normAddr(json.treasury_cap_id) : null, supply: json.supply?.["@variant"] ?? null }
    : null;
  const caps = new Map();
  for (const n of d.caps.nodes) {
    const id = normAddr(n.address);
    const owner = OWNER_KIND[n.owner?.__typename] ?? n.owner?.__typename;
    const holder = owner === "object" ? (await objectTruth(id)).holder : undefined;
    caps.set(id, { owner, ...(holder ? { holder } : {}), found_by: "TreasuryCap<T> type query" });
  }
  if (registry?.treasury_cap_id && !caps.has(registry.treasury_cap_id)) {
    const t = await objectTruth(registry.treasury_cap_id);
    // make_supply_fixed and make_supply_burn_only take the cap by value and
    // turn it into the registry's Supply (coin_registry.move), deleting it:
    // one consumed during the publish never appears in an object change.
    const consumed = registry.supply === "Fixed" || registry.supply === "BurnOnly";
    let state;
    if (consumed && (t.unreadable || (!t.exists && t.kind === "deleted")))
      state = { owner: "burned", found_by: `registry treasury_cap_id, supply ${registry.supply}`, ...(t.tx ? { ended_in: t.tx } : {}) };
    else if (consumed) state = { unreadable: `the registry records supply ${registry.supply}, yet the cap is ${t.exists ? "live" : t.kind}` };
    else state = t.unreadable ? { unreadable: t.unreadable } : { owner: capOwner(t), ...(t.holder ? { holder: t.holder } : {}), found_by: "registry treasury_cap_id", ...(t.exists ? {} : { ended_in: t.tx }) };
    caps.set(registry.treasury_cap_id, state);
  }
  return { registry, caps };
}

async function checkMintAuthority(key, coinType) {
  const T = normType(coinType);
  const pkg = T.split("::")[0];
  const truth = await truthOf("d", key, T, () => mintTruth(T));
  if (!truth) return;
  const ans = answerOf("d", key, T, await callTool("analyze_package", { package_id: pkg }));
  if (!ans) return;
  const audit = ans.capabilities;
  if (!audit?.checked) return skip("d", key, T, `the capability audit did not run: ${text(audit?.note ?? audit, 300)}`);
  const listed = auditCaps(audit).filter((c) => c.kind === "treasury" && typeArgsOf(c.type)[0] === T);
  const unlocated = (audit.coins_without_located_mint_authority ?? []).filter((u) => normType(u.coin_type) === T);
  // Each problem is `{ cap, audit, chain }` or `{ coin, audit }`. An owner the
  // audit calls unknown is one: the chain states it.
  const problems = [];
  const unread = [];
  if (!listed.length && !unlocated.length) problems.push({ coin: T, audit: "neither lists a TreasuryCap nor names the coin in coins_without_located_mint_authority" });
  if (listed.length && unlocated.length) problems.push({ coin: T, audit: "lists a TreasuryCap and names the coin in coins_without_located_mint_authority" });
  for (const [id, c] of truth.caps) {
    if (c.unreadable) {
      unread.push(`the state of ${id} could not be read: ${c.unreadable}`);
      continue;
    }
    const l = listed.find((x) => x.id === id);
    const chain = ownerLabel(c.owner, c.holder);
    if (!l) problems.push({ cap: id, audit: "not listed", chain, found_by: c.found_by });
    else if (ownerLabel(l.owner, l.holder) !== chain) problems.push({ cap: id, audit: ownerLabel(l.owner, l.holder), chain });
  }
  const extra = [];
  for (const l of listed.filter((x) => !truth.caps.has(x.id))) {
    const t = await objectTruth(l.id);
    const chain = t.unreadable ? null : ownerLabel(capOwner(t), t.holder);
    extra.push({ id: l.id, audit: ownerLabel(l.owner, l.holder), chain: chain ?? `unreadable: ${t.unreadable}` });
    if (!chain) unread.push(`the state of listed cap ${l.id} could not be read: ${t.unreadable}`);
    else if (ownerLabel(l.owner, l.holder) !== chain) problems.push({ cap: l.id, audit: ownerLabel(l.owner, l.holder), chain });
  }
  const detail = {
    ours: { treasury_caps: listed.map((l) => ({ id: l.id, owner: ownerLabel(l.owner, l.holder) })), unlocated: unlocated.map((u) => ({ risk: u.risk, reason: text(u.reason, 200) })) },
    truth: { registry: truth.registry, caps: Object.fromEntries(truth.caps), ...(extra.length ? { listed_by_the_audit_only: extra } : {}) },
  };
  if (problems.length) return record("d", key, T, "disagree", { ...detail, problems });
  if (unread.length) return skip("d", key, T, unread.join("; "));
  record("d", key, T, "agree", detail);
}

/** At most this many capabilities per package are read for f, UpgradeCaps and DenyCaps first. */
const CAPS_PER_PACKAGE = 5;

async function checkCapOwners(key, pkgId) {
  const pkg = normAddr(pkgId);
  const ans = answerOf("f", key, pkg, await callTool("analyze_package", { package_id: pkg }));
  if (!ans) return;
  if (!ans.capabilities?.checked) return skip("f", key, pkg, `the capability audit did not run: ${text(ans.capabilities?.note ?? ans.capabilities, 300)}`);
  const all = auditCaps(ans.capabilities).filter((c) => c.kind !== "treasury");
  // A publish that destroyed its own UpgradeCap: the audit must list it as
  // burned in that transaction, with no object id.
  const upgrade = await upgradeCapOf(pkg).catch(() => null);
  if (upgrade?.destroyedAtPublish) {
    const entry = all.find((c) => c.kind === "upgrade");
    const ours = entry ? { object_id: entry.id, owner: entry.owner, destroyed_in_tx: entry.destroyed_in_tx } : null;
    const ok = !!entry && entry.id === null && entry.owner === "burned" && entry.destroyed_in_tx === upgrade.destroyedAtPublish;
    record("f", key, `analyze_package ${pkg} UpgradeCap destroyed in its publish ${upgrade.destroyedAtPublish}`, ok ? "agree" : "disagree", {
      ours: { upgrade_cap: ours },
      truth: { owner: "burned", destroyed_in_tx: upgrade.destroyedAtPublish },
      ...(ok ? {} : { problems: [{ cap: null, audit: ours ? ownerLabel(ours.owner) : "not listed", chain: "burned in the publish" }] }),
    });
  }
  const caps = all.filter((c) => c.id !== null);
  if (!caps.length) return skip("f", key, pkg, "the audit lists no capability object besides TreasuryCaps");
  // A generator of its own per subject: subjects run concurrently, and the draw must not depend on their order.
  const own = rng((SEED ^ Math.imul(key + 1, 0x9e3779b1)) >>> 0);
  const chosen = [...caps.filter((c) => c.kind === "upgrade" || c.kind === "deny"), ...shuffled(caps.filter((c) => c.kind === "admin"), own)].slice(0, CAPS_PER_PACKAGE);
  for (const c of chosen) {
    const subject = `analyze_package ${pkg} ${c.type.split("<")[0].split("::").slice(-2).join("::")} ${c.id}`;
    const t = await truthOf("f", key, subject, () => objectTruth(c.id));
    if (!t) continue;
    const owner = ownerLabel(capOwner(t), t.holder);
    const ours = ownerLabel(c.owner, c.holder);
    record("f", key, subject, ours === owner ? "agree" : "disagree", {
      ours: { owner: ours },
      truth: { owner, ...(t.exists ? {} : { ended_in: t.tx }) },
      ...(ours === owner ? {} : { problems: [{ cap: c.id, audit: ours, chain: owner }] }),
    });
  }
}

// ---- sampling ----------------------------------------------------------------
const latest = async () => Number((await gql(`{ checkpoint { sequenceNumber } }`)).checkpoint.sequenceNumber);
const TIP = opts.tip !== undefined ? whole("tip", 0, 1) : PINNED ? null : await latest();

const SCAN_V1 = `query($s:UInt53){ checkpoint(sequenceNumber:$s){ transactions(first:50){ nodes{ digest kind{ __typename } effects{ effectsBcs } } } } }`;
const SCAN_V2 = `query($s:UInt53){ checkpoint(sequenceNumber:$s){ transactions(first:50){ nodes{ digest kind{ __typename }
  effects{ objectChanges(first:100){ nodes{ address idCreated idDeleted inputState{ version } outputState{ version } } } } } } } }`;

/**
 * Read `SCAN` random checkpoints of an era: its PTBs, and the objects they
 * wrapped, unwrapped and removed. Only an object read as an input counts as
 * removed: one created, or unwrapped, in the transaction that wrapped or
 * deleted it may never have existed at top level.
 */
async function scanEra(era) {
  const found = { ptbs: [], wraps: [], unwraps: [], removed: [] };
  for (let i = 0; i < SCAN; i++) {
    const s = randInt(era.lo, era.hi);
    const d = await gql(era.v1 ? SCAN_V1 : SCAN_V2, { s }, true);
    for (const n of d.checkpoint?.transactions?.nodes ?? []) {
      if (n.kind?.__typename === "ProgrammableTransaction") found.ptbs.push(n.digest);
      const at = { tx: n.digest, checkpoint: s };
      if (era.v1) {
        const v = bcs.TransactionEffects.parse(Buffer.from(n.effects.effectsBcs, "base64")).V1;
        if (!v) continue;
        const l = v1Lists(v);
        const thenDeleted = new Set(v.unwrappedThenDeleted.map((r) => normAddr(r.objectId)));
        for (const id of l.wrapped) found.wraps.push({ id, ...at }), found.removed.push({ id, ...at, deleted: false });
        for (const id of l.deleted) if (!thenDeleted.has(id)) found.removed.push({ id, ...at, deleted: true });
        for (const id of l.unwrapped) found.unwraps.push({ id, ...at, deleted: false });
        for (const id of thenDeleted) found.unwraps.push({ id, ...at, deleted: true });
      } else {
        for (const c of n.effects?.objectChanges?.nodes ?? []) {
          if (c.idCreated) continue;
          const id = normAddr(c.address);
          if (!c.outputState && c.inputState) found.removed.push({ id, ...at, deleted: c.idDeleted === true });
          if (!c.outputState && !c.idDeleted && c.inputState) found.wraps.push({ id, ...at });
          if (!c.inputState && (c.outputState || c.idDeleted)) found.unwraps.push({ id, ...at, deleted: !c.outputState });
        }
      }
    }
  }
  return found;
}

/**
 * The transaction that wrapped an object an effects-version-1 transaction
 * unwrapped: the one touching it just before, when that one wrapped it.
 */
async function wrapBefore({ id, tx, checkpoint }) {
  const d = await gql(`query($a:SuiAddress!,$b:UInt53){ transactions(filter:{ affectedObject:$a, beforeCheckpoint:$b }, last:3){ nodes{ digest } } }`, { a: id, b: checkpoint + 1 });
  const digests = d.transactions.nodes.map((n) => n.digest);
  const at = digests.indexOf(tx);
  const before = at > 0 ? digests[at - 1] : null;
  if (!before) return null;
  const w = await rawTx(before);
  return w.v1?.wrapped.has(id) ? before : null;
}

const firstCalls = new Map();
/** The checkpoint of a function's first call. */
function firstCall(fn) {
  if (!firstCalls.has(fn))
    firstCalls.set(
      fn,
      gql(`query($f:String!){ transactions(first:1, filter:{ function:$f }){ nodes{ effects{ checkpoint{ sequenceNumber } } } } }`, { f: fn }).then((d) => {
        const cp = d.transactions.nodes[0]?.effects?.checkpoint?.sequenceNumber;
        return cp === undefined ? null : Number(cp);
      }),
    );
  return firstCalls.get(fn);
}

/**
 * The newest 20 calls of `fn` in a random closed window of checkpoints
 * between its first call and `hi`. The window starts `width` wide and grows
 * fourfold while it holds no call, up to the whole range.
 */
async function callsInWindow(fn, width, selection, hi = TIP - SETTLE) {
  const first = await firstCall(fn);
  if (first === null || first > hi) return [];
  for (let w = width; ; w *= 4) {
    const span = Math.min(w, hi - first + 1);
    const lo = randInt(first, hi - span + 1);
    const d = await gql(
      `query($f:String!,$a:UInt53,$b:UInt53){ transactions(last:20, filter:{ function:$f, afterCheckpoint:$a, beforeCheckpoint:$b }){ nodes{ digest ${selection} } } }`,
      { f: fn, a: lo - 1, b: lo + span },
      true,
    );
    if (d.transactions.nodes.length || span === hi - first + 1) return d.transactions.nodes;
  }
}

/**
 * Wormhole's token bridge `complete_registration` wraps the registered
 * coin's UpgradeCap. Its calls up to V1_LAST are effects-version-1 wraps,
 * drawn when a random era-1 checkpoint holds none.
 */
const V1_WRAPPER = "0x26efee2b51c911237888e5dc6702868abca3c7ac12c53f76ef8eba0697695e3d::create_wrapped::complete_registration";
async function drawV1Wrap() {
  const t = pick(await callsInWindow(V1_WRAPPER, 2_000_000, "", V1_LAST));
  if (!t) return null;
  return { tx: t.digest, ids: [...((await rawTx(t.digest)).v1?.wrapped ?? [])] };
}

async function drawRouter() {
  const out = [];
  for (let i = 0; i < ROUTER_N; i++) {
    const nodes = (await callsInWindow(ROUTER, 20_000, "effects{ status }")).filter((n) => n.effects.status === "SUCCESS" && !out.includes(n.digest));
    const t = pick(nodes);
    if (t) out.push(t.digest);
  }
  return out;
}

async function drawCoins() {
  const out = [];
  for (let i = 0; i < COINS; i++) {
    const [how, fn] = REGISTRY_FUNCTIONS[i % REGISTRY_FUNCTIONS.length];
    const nodes = await callsInWindow(fn, 200_000, "effects{ objectChanges(first:50){ nodes{ outputState{ asMoveObject{ contents{ type{ repr } } } } } } }");
    const types = nodes.flatMap((n) =>
      n.effects.objectChanges.nodes
        .map((c) => normType(c.outputState?.asMoveObject?.contents?.type?.repr))
        .filter((t) => t.startsWith(`${ADDR2}::coin_registry::Currency<`))
        .map((t) => typeArgsOf(t)[0]),
    );
    const t = pick([...new Set(types)].filter((x) => !out.some((o) => o.type === x)));
    if (t) out.push({ type: t, how });
  }
  return out;
}

// ---- plan and run --------------------------------------------------------------
const t0 = Date.now();
const problems = [];
const tasks = [];
const task = (run) => tasks.push({ key: tasks.length, run });

console.log(`oracle-pass  build ${DIST}`);
if (PINNED) {
  console.log(`pinned subjects: ${JSON.stringify(PINNED)}`);
  for (const d of PINNED.a ?? []) task((k) => checkSwapLabels(k, d));
  for (const s of PINNED.b ?? []) task((k) => checkObjectEnd(k, { id: s }));
  for (const d of PINNED.c ?? []) task((k) => checkObjectChanges(k, d));
  for (const t of PINNED.d ?? []) task((k) => checkMintAuthority(k, t));
  for (const d of PINNED.e ?? []) task((k) => checkFlows(k, d));
  for (const p of PINNED.f ?? []) task((k) => checkCapOwners(k, p));
} else {
  console.log(`seed ${SEED}  tip ${TIP}`);
  console.log(
    `replay this draw: node scripts/probe/oracle-pass.mjs --seed ${SEED} --tip ${TIP} --scan ${SCAN} --txs ${TXS} --ends ${ENDS} --router ${ROUTER_N} --coins ${COINS}`,
  );
  const eras = [
    { name: "v1", lo: 1, hi: V1_LAST, v1: true },
    { name: "v2", lo: V1_LAST + 1, hi: TIP - RECENT, v1: false },
    { name: "recent", lo: TIP - RECENT + 1, hi: TIP - SETTLE, v1: false },
  ];
  const txs = [];
  const removed = [];
  for (const era of eras) {
    const found = await scanEra(era);
    const chosen = [];
    const add = (digest, why) => {
      if (digest && chosen.length < TXS && !chosen.some((c) => c.digest === digest)) chosen.push({ digest, why: `${era.name}, ${why}`, era });
    };
    let wrap = pick(found.wraps)?.tx;
    let how = "wraps an object";
    if (!wrap && era.v1) for (const u of shuffled(found.unwraps.filter((u) => !u.deleted)).slice(0, 3)) if ((wrap = await wrapBefore(u))) break;
    if (!wrap && era.v1) {
      const w = await drawV1Wrap();
      if (w) {
        wrap = w.tx;
        how = "wraps an object, a complete_registration call";
        for (const id of w.ids) found.removed.push({ id, tx: w.tx, deleted: false });
      }
    }
    add(wrap, how);
    add(pick(found.unwraps.filter((u) => !u.deleted))?.tx ?? pick(found.unwraps)?.tx, "unwraps an object");
    for (const d of shuffled(found.ptbs)) add(d, "random");
    txs.push(...chosen);
    removed.push(...found.removed.map((r) => ({ ...r, era: era.name })));
    console.log(
      `  ${era.name.padEnd(6)} ${SCAN} checkpoints: ${found.ptbs.length} PTBs, ${found.wraps.length} wrapped, ${found.unwraps.length} unwrapped, ${found.removed.length} removed objects; drew ${chosen.map((c) => `${c.digest} (${c.why.slice(era.name.length + 2)})`).join(", ") || "nothing"}`,
    );
  }
  // Removed objects for b: wrapped ones first, each group spread over the eras.
  const ends = [];
  for (const deleted of [false, true]) {
    const byEra = eras.map((e) => shuffled(removed.filter((r) => r.era === e.name && r.deleted === deleted)));
    while (ends.length < ENDS && byEra.some((l) => l.length))
      for (const list of byEra) {
        const r = list.shift();
        if (r && ends.length < ENDS && !ends.some((x) => x.id === r.id)) ends.push(r);
      }
  }
  const router = await drawRouter();
  const coins = await drawCoins();
  console.log(`  router: ${router.join(", ") || "none drawn"}`);
  console.log(`  coins:  ${coins.map((c) => `${c.type} (${c.how})`).join(", ") || "none drawn"}`);
  console.log(`  ends:   ${ends.map((r) => `${r.id} (${r.deleted ? "deleted" : "wrapped"} in ${r.tx}, ${r.era})`).join(", ") || "none drawn"}`);

  for (const t of txs) {
    task(async (k) => {
      await checkObjectChanges(k, t.digest, t.why);
      await checkFlows(k, t.digest, t.why);
      const tx = await rawTx(t.digest).catch(() => null);
      if (tx && tx.effectsVersion !== (t.era.v1 ? 1 : 2))
        problems.push(`${t.digest} was drawn from era ${t.era.name} but carries effects version ${tx.effectsVersion}: V1_LAST is wrong`);
    });
  }
  for (const d of router) {
    task(async (k) => {
      await checkSwapLabels(k, d);
      await checkObjectChanges(k, d, "router");
      await checkFlows(k, d, "router");
    });
  }
  for (const r of ends) task((k) => checkObjectEnd(k, { id: r.id, why: `${r.deleted ? "deleted" : "wrapped"} in ${r.tx}, ${r.era}` }));
  for (const c of coins) {
    task(async (k) => {
      await checkMintAuthority(k, c.type);
      await checkCapOwners(k, c.type.split("::")[0]);
      await checkObjectEnd(k, { pkg: c.type.split("::")[0], label: `UpgradeCap of ${c.type.split("::")[0]}`, why: `package of ${c.how} coin` });
    });
  }
}

let next = 0;
async function worker() {
  while (next < tasks.length) {
    const t = tasks[next++];
    try {
      await t.run(t.key);
    } catch (err) {
      problems.push(`the probe stopped on subject ${t.key}: ${err?.stack ?? err}`);
    }
  }
}
try {
  await Promise.all(Array.from({ length: Math.min(JOBS, tasks.length) }, worker));
} finally {
  server.stop();
}

// ---- report ------------------------------------------------------------------------
const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n${"=".repeat(78)}\noracle-pass  ${PINNED ? "pinned subjects" : `seed=${SEED} tip=${TIP}`}  ${secs}s  ${toolCalls} tool calls`);
let failures = 0;
const summary = [];
for (const [id, o] of Object.entries(ORACLES)) {
  const rows = [...o.rows].sort((a, b) => a.key - b.key);
  const n = (s) => rows.filter((r) => r.status === s).length;
  // A drawn oracle whose bounds allow subjects must check something.
  const drawn = { a: ROUTER_N, b: ENDS + COINS, c: TXS + ROUTER_N, d: COINS, e: TXS + ROUTER_N, f: COINS };
  const requested = PINNED ? !!PINNED[id]?.length : drawn[id] > 0;
  if (!rows.length && !requested) continue;
  const checked = n("agree") + n("disagree") + n("known");
  summary.push([id, o.title, checked, n("agree"), n("disagree"), n("known"), n("skip")]);
  console.log(`\n${id}. ${o.title}: checked ${checked}, agree ${n("agree")}, disagree ${n("disagree")}, known ${n("known")}, skipped ${n("skip")}`);
  console.log(`   truth: ${o.how}`);
  for (const r of rows) {
    if (r.status === "skip") {
      console.log(`   skip  ${r.subject}: ${r.reason}`);
      continue;
    }
    const mark = { agree: "ok", disagree: "!!", known: "known", stale: "stale" }[r.status];
    console.log(`   ${mark.padEnd(5)} ${r.subject}${r.known ? `  [${r.known}]` : ""}`);
    if (r.status === "agree" && !process.env.VERBOSE) continue;
    console.log(`         ours:  ${text(r.ours)}`);
    console.log(`         truth: ${text(r.truth)}`);
    if (r.problems) for (const p of r.problems) console.log(`         - ${text(p)}`);
    for (const k of ["symbols_naming_several_types", "hops_without_a_pool_type"]) if (r[k]) console.log(`         ${k}: ${text(r[k])}`);
  }
  failures += n("disagree");
  if (n("stale")) problems.push(`${id}: ${n("stale")} KNOWN_DEFECTS entr(ies) now agree; remove them`);
  if (requested && !checked) problems.push(`${id}. ${o.title}: nothing was checked`);
}

console.log(`\n${"checked".padStart(8)} ${"agree".padStart(6)} ${"disagree".padStart(9)} ${"known".padStart(6)} ${"skip".padStart(5)}  oracle`);
for (const [id, title, checked, agree, disagree, known, skipped] of summary)
  console.log(`${String(checked).padStart(8)} ${String(agree).padStart(6)} ${String(disagree).padStart(9)} ${String(known).padStart(6)} ${String(skipped).padStart(5)}  ${id}. ${title}`);
for (const p of problems) console.log(`!! ${p}`);
if (failures || problems.length) {
  console.log(`\n${failures} disagreement(s), ${problems.length} other problem(s)${PINNED ? "" : `; replay with --seed ${SEED} --tip ${TIP}`}`);
  process.exitCode = 1;
} else console.log("\nevery checked answer agreed with the chain");
process.exit();
