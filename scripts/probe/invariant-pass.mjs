#!/usr/bin/env node
/**
 * Invariant pass: a seeded random sample of mainnet, run through the tools,
 * checking rules that must hold for any input. The other probes check facts
 * somebody picked; this one checks data nobody picked.
 *
 *   node scripts/probe/invariant-pass.mjs [--seed N] [--n N] [--tip CHECKPOINT]
 *
 * `--seed` defaults to a random seed, printed first. `--tip` pins the newest
 * checkpoint the sample is drawn below; it defaults to the chain's latest and
 * is printed too, so `--seed S --tip T` redraws the same sample. `--n` is the
 * number of sampled transactions (default 12); the address checks run on up to
 * `n` addresses taken from them. The rare kinds are drawn first, so an `n`
 * under 9 drops some of them.
 *
 * The sample spreads checkpoints evenly over the chain's whole history, so old
 * checkpoints (the archive-only era for gRPC) come up as often as recent ones,
 * and then adds the kinds random checkpoints rarely hold: a system transaction,
 * a failed one, a sponsored one, multisig and zkLogin senders, address-balance
 * transactions, a PTB with 100+ commands or balance changes, a package, shared
 * and owned objects, a kiosk, an object holding an address balance, and a bridge
 * exit. Every tool answer is compared with a raw GraphQL read taken in the same
 * run. A value that moves while it is read is read before and after the tool
 * call: a balance must equal one of the two reads, and an object's version must
 * lie between them. An address's page is compared with the raw page read up to
 * the checkpoint of the tool's newest row.
 *
 * Prints pass/fail counts per invariant and, for every failure, the seed, the
 * tool call and the raw value. Exits 1 on any failure.
 */
import { startServer, gql as gqlOnce, SUI } from "./lib/mcp-client.mjs";
import { SuiGrpcClient } from "@mysten/sui/grpc";

// ---- arguments and the seeded generator ------------------------------------
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SEED = arg("seed") !== undefined ? Number(arg("seed")) >>> 0 : Math.floor(Math.random() * 2 ** 32);
const N = Math.max(1, Number(arg("n") ?? 12));
const CALL_LIMIT_MS = 60_000;

/** mulberry32: small, fast and the same on every platform. */
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
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
const pick = (xs) => (xs.length ? xs[Math.floor(rand() * xs.length)] : undefined);

// ---- raw GraphQL, retried --------------------------------------------------
/** The public endpoint is shared; it answers bursts with an HTML 429. */
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

/** Pad every address in a type to 64 hex digits, so short and long forms compare equal. */
const normType = (t) =>
  String(t ?? "").replace(/0x([0-9a-fA-F]{1,64})(?=::)/g, (_, h) => `0x${h.toLowerCase().padStart(64, "0")}`);
const normAddr = (a) => (a ? `0x${String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0")}` : a);
const SUI_T = normType(SUI);
const isSui = (t) => normType(t) === SUI_T;
const short = (v, n = 400) => {
  const s = typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

// ---- the recorder ----------------------------------------------------------
const INVARIANTS = new Map();
function inv(name) {
  if (!INVARIANTS.has(name)) INVARIANTS.set(name, { pass: 0, fail: 0, skip: 0, failures: [], skips: [] });
  return INVARIANTS.get(name);
}
/** One check. `detail` names the tool call, what it said and what the chain says. */
function check(name, ok, detail = {}) {
  const r = inv(name);
  if (ok) {
    r.pass++;
    return true;
  }
  r.fail++;
  r.failures.push(detail);
  console.log(`   !! ${name}: ${short(detail, 600)}`);
  return false;
}
function skip(name, reason) {
  const r = inv(name);
  r.skip++;
  if (!r.skips.includes(reason)) r.skips.push(reason);
}

const I = {
  health: "every call answers inside 60s and inside its declared size, with no crash, stack trace or unexplained empty answer",
  txBc: "get_transaction balance changes equal the raw effects",
  txFields: "get_transaction sender, status, checkpoint, timestamp, event count and gas equal the raw transaction",
  abOps: "get_transaction address_balance_ops equal the raw accumulator writes",
  conservation: "per coin the balance changes sum to zero, and SUI to minus the net gas (no Move call, or failed)",
  batch: "get_transactions agrees with get_transaction for the same digest",
  balance: "get_balance equals coin objects plus address balance (raw)",
  balanceAt: "get_balance at the latest checkpoint equals the current balance and the raw read at that checkpoint",
  balancePast: "get_balance at a past checkpoint equals the sum of every raw balance change up to it",
  historyList: "get_transaction_history and query_transactions list the raw query's digests in the same order",
  subjectFlow: "subject_flow on a history row equals the raw balance change of that address",
  timeline: "build_timeline lists the same digests as get_transaction_history and the raw query in a shared window",
  flows: "summarize_address_flows totals equal the raw balance changes over the transactions it scanned",
  identify: "identify_address type agrees with the raw object/package lookup",
  fanout: "get_address_fanout counts equal a raw recount under the documented rule",
  trace: "trace_funds hop 1 amounts equal the raw balance changes of the start transaction",
  attack: "analyze_attack_tx per-address nets equal the raw balance changes",
  bridge: "resolve_bridge_transfer names a beneficiary that appears in the raw event payload",
  events: "query_events lists the raw events query's transactions for the same type and window",
  holders: "get_top_holders ranks in descending balance order and each balance equals a raw read",
  checkpoint: "get_checkpoint timestamp, epoch and transaction count equal the raw checkpoint",
  object: "get_object type and version equal the raw object",
};

// ---- the server and the call wrapper ---------------------------------------
const server = await startServer({ name: "invariant-pass" });
// A result over the size a tool declares is cut or spilled to a file by the client.
const declaredSize = new Map(
  ((await server.rpc("tools/list", {})).result?.tools ?? []).map((t) => [t.name, t._meta?.["anthropic/maxResultSizeChars"] ?? 100_000]),
);
const STACK = /\n\s+at (async )?[\w$.<>\[\] ]+ \(?[^)\n]*:\d+:\d+\)?/;
const timings = [];

/**
 * Call a tool with valid input. Records the health invariant for every call and
 * returns the first JSON block of the result, or null when there is none.
 */
async function call(tool, args) {
  const msg = await server.callRaw(tool, args, 180_000);
  const texts = (msg.result?.content ?? []).map((c) => c.text ?? "");
  const text = texts.join("\n");
  timings.push({ tool, ms: msg.ms });
  const problems = [];
  if (msg.timedOut) problems.push("no answer in 180s");
  else if (msg.ms > CALL_LIMIT_MS) problems.push(`took ${(msg.ms / 1000).toFixed(1)}s`);
  if (msg.error) problems.push(`JSON-RPC error: ${msg.error.message}`);
  // The public endpoint is shared. A tool that retried and then said so has
  // explained itself; the answer is missing, not wrong.
  const rateLimited = msg.result?.isError && /Rate-limited by .*HTTP 429/.test(text);
  if (rateLimited) {
    skip(I.health, "the shared GraphQL endpoint rate-limited a call past its retries");
    return null;
  }
  if (msg.result?.isError) problems.push(`isError on valid input: ${text.slice(0, 300)}`);
  if (STACK.test(text)) problems.push("stack trace in the answer");
  if (!msg.error && !text.trim()) problems.push("empty answer");
  if (text.length > (declaredSize.get(tool) ?? 100_000)) problems.push(`${text.length} characters, over the ${declaredSize.get(tool) ?? 100_000} the tool declares`);
  check(I.health, problems.length === 0, { seed: SEED, tool, args, got: problems.join("; ") });
  if (msg.error || msg.result?.isError) return null;
  const json = texts.find((t) => t.trim().startsWith("{"));
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    check(I.health, false, { seed: SEED, tool, args, got: "answer is not valid JSON" });
    return null;
  }
}

// ---- raw reads -------------------------------------------------------------
const BC_NODES = "pageInfo { hasNextPage endCursor } nodes { owner { address } coinType { repr } amount }";
const TX_QUERY = `query($d:String!){ transaction(digest:$d){
  digest sender { address } gasInput { gasSponsor { address } } kind { __typename } signatures { scheme { __typename } }
  effects {
    status timestamp checkpoint { sequenceNumber } epoch { epochId }
    gasEffects { gasSummary { computationCost storageCost storageRebate nonRefundableStorageFee } }
    balanceChanges(first: 50) { ${BC_NODES} }
    events(first: 50) { pageInfo { hasNextPage endCursor } nodes { contents { type { repr } json } } }
    effectsJson
  }
  transactionJson } }`;
const MORE_BC = `query($d:String!,$a:String){ transaction(digest:$d){ effects { balanceChanges(first:50, after:$a){ ${BC_NODES} } } } }`;
const MORE_EV = `query($d:String!,$a:String){ transaction(digest:$d){ effects { events(first:50, after:$a){ pageInfo { hasNextPage endCursor } nodes { contents { type { repr } json } } } } } }`;

const txCache = new Map();
/** One transaction as the chain reports it, every page of balance changes and events read. */
async function rawTx(digest) {
  if (txCache.has(digest)) return txCache.get(digest);
  const d = await gql(TX_QUERY, { d: digest });
  const t = d.transaction;
  if (!t) return null;
  const bcs = [...t.effects.balanceChanges.nodes];
  for (let p = t.effects.balanceChanges.pageInfo; p.hasNextPage; ) {
    const c = (await gql(MORE_BC, { d: digest, a: p.endCursor })).transaction.effects.balanceChanges;
    bcs.push(...c.nodes);
    p = c.pageInfo;
  }
  const events = [...t.effects.events.nodes];
  for (let p = t.effects.events.pageInfo; p.hasNextPage; ) {
    const c = (await gql(MORE_EV, { d: digest, a: p.endCursor })).transaction.effects.events;
    events.push(...c.nodes);
    p = c.pageInfo;
  }
  const g = t.effects.gasEffects?.gasSummary;
  const ptb = t.transactionJson?.kind?.programmableTransaction ?? null;
  const out = {
    digest,
    sender: t.sender?.address ?? null,
    sponsor: t.gasInput?.gasSponsor?.address ?? null,
    kind: t.kind?.__typename,
    schemes: (t.signatures ?? []).map((s) => s.scheme?.__typename),
    status: t.effects.status,
    timestamp: t.effects.timestamp,
    checkpoint: Number(t.effects.checkpoint?.sequenceNumber),
    epoch: t.effects.epoch?.epochId,
    gas: g
      ? {
          computation: BigInt(g.computationCost),
          storage: BigInt(g.storageCost),
          rebate: BigInt(g.storageRebate),
          nonRefundable: BigInt(g.nonRefundableStorageFee),
          net: BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate),
        }
      : null,
    changes: bcs.map((n) => ({ owner: n.owner?.address ?? null, coin: normType(n.coinType?.repr), amount: BigInt(n.amount) })),
    events,
    commands: ptb?.commands ?? [],
    inputs: ptb?.inputs ?? [],
    accumulatorWrites: (t.effects.effectsJson?.changedObjects ?? [])
      .filter((c) => c.accumulatorWrite)
      .map((c) => c.accumulatorWrite),
  };
  txCache.set(digest, out);
  return out;
}

/** Signed net per `owner|coin`, zeros dropped. */
function netMap(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${normAddr(r.owner)}|${normType(r.coin)}`;
    m.set(k, (m.get(k) ?? 0n) + BigInt(r.amount));
  }
  for (const [k, v] of m) if (v === 0n) m.delete(k);
  return m;
}
/** Keys where two net maps differ, with both values. */
function mapDiff(tool, raw) {
  const out = [];
  for (const k of new Set([...tool.keys(), ...raw.keys()])) {
    const a = tool.get(k) ?? 0n;
    const b = raw.get(k) ?? 0n;
    if (a !== b) out.push({ key: k, tool: a.toString(), raw: b.toString() });
  }
  return out;
}
/** The rows a tool printed as balance changes, in the recorder's terms. */
const toolRows = (rows) => (rows ?? []).map((r) => ({ owner: r.address ?? r.owner, coin: r.coin_type ?? r.coinType, amount: r.amount }));

/** Transactions touching `address`, one page, in the order asked, inside the exclusive checkpoint bounds. */
async function rawAddressPage(address, { order = "newest", limit = 20, after = null, before = null } = {}) {
  const newest = order === "newest";
  const d = await gql(
    `query($a:SuiAddress!,$n:Int,$af:UInt53,$bf:UInt53){ transactions(${newest ? "last" : "first"}:$n, filter:{affectedAddress:$a, afterCheckpoint:$af, beforeCheckpoint:$bf}){ pageInfo{hasNextPage hasPreviousPage} nodes{ digest effects{ checkpoint{sequenceNumber} } } } }`,
    { a: address, n: limit, af: after, bf: before },
  );
  const nodes = d.transactions.nodes.map((n) => ({ digest: n.digest, checkpoint: Number(n.effects.checkpoint.sequenceNumber) }));
  return {
    rows: newest ? nodes.reverse() : nodes,
    more: newest ? d.transactions.pageInfo.hasPreviousPage : d.transactions.pageInfo.hasNextPage,
  };
}
/** Every transaction touching `address` in (after, before), oldest first, up to `limit`. */
async function rawAddressWindow(address, after, before, limit = 400) {
  const out = [];
  for (let cursor = null; ; ) {
    const d = await gql(
      `query($a:SuiAddress!,$c:String,$af:UInt53,$bf:UInt53){ transactions(first:50, after:$c, filter:{affectedAddress:$a, afterCheckpoint:$af, beforeCheckpoint:$bf}){ pageInfo{hasNextPage endCursor} nodes{ digest effects{ checkpoint{sequenceNumber} } } } }`,
      { a: address, c: cursor, af: after, bf: before },
    );
    out.push(...d.transactions.nodes.map((n) => ({ digest: n.digest, checkpoint: Number(n.effects.checkpoint.sequenceNumber) })));
    if (!d.transactions.pageInfo.hasNextPage || out.length >= limit) return { rows: out, complete: !d.transactions.pageInfo.hasNextPage };
    cursor = d.transactions.pageInfo.endCursor;
  }
}
async function rawBalance(owner, coinType, atCheckpoint = null) {
  const d = await gql(
    `query($a:SuiAddress!,$t:String!,$c:UInt53){ address(address:$a, atCheckpoint:$c){ balance(coinType:$t){ totalBalance coinBalance addressBalance } } }`,
    { a: owner, t: coinType, c: atCheckpoint },
  );
  const b = d.address?.balance;
  return b ? { total: BigInt(b.totalBalance ?? 0), coin: BigInt(b.coinBalance ?? 0), address: BigInt(b.addressBalance ?? 0) } : { total: 0n, coin: 0n, address: 0n };
}
/** The sum of `owner`'s Coin<T> objects, or null past `maxPages` pages. */
async function rawCoinObjectSum(owner, coinType, maxPages = 10) {
  let sum = 0n;
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const d = await gql(
      `query($a:SuiAddress!,$t:String!,$c:String){ address(address:$a){ objects(first:50, after:$c, filter:{type:$t}){ pageInfo{hasNextPage endCursor} nodes{ contents{ json } } } } }`,
      { a: owner, t: `0x2::coin::Coin<${coinType}>`, c: cursor },
    );
    const conn = d.address?.objects;
    for (const n of conn?.nodes ?? []) sum += BigInt(n.contents?.json?.balance ?? 0);
    if (!conn?.pageInfo?.hasNextPage) return sum;
    cursor = conn.pageInfo.endCursor;
  }
  return null;
}
const strs = (r) => ({ total: r.total.toString(), coin: r.coin.toString(), address: r.address.toString() });
const grpc = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io" });
/** The fullnode's current balance, read over gRPC, retried on a transient failure. */
async function grpcBalance(owner, coinType) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { balance } = await grpc.getBalance({ owner, coinType });
      return { total: BigInt(balance.balance), coin: BigInt(balance.coinBalance ?? 0), address: BigInt(balance.addressBalance ?? 0) };
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}
const latestCheckpoint = async () => Number((await gql(`{ checkpoint { sequenceNumber } }`)).checkpoint.sequenceNumber);
async function rawObject(id) {
  const d = await gql(
    `query($a:SuiAddress!){ object(address:$a){ address version asMovePackage{ address } owner{ __typename ... on AddressOwner{ address{ address } } ... on ObjectOwner{ address{ address } } ... on ConsensusAddressOwner{ address{ address } } } asMoveObject{ contents{ type{ repr } } } } }`,
    { a: id },
  );
  return d.object;
}

// ---- sampling --------------------------------------------------------------
const CP_QUERY = `query($s:UInt53){ checkpoint(sequenceNumber:$s){ sequenceNumber timestamp transactions(first:50){ nodes{
  digest kind{ __typename } sender{ address } gasInput{ gasSponsor{ address } } signatures{ scheme{ __typename } }
  effects{ status balanceChanges(first:50){ pageInfo{ hasNextPage } } effectsJson }
  transactionJson } } } }`;

function tagsOf(n) {
  const tags = new Set();
  const ptb = n.transactionJson?.kind?.programmableTransaction;
  if (n.kind?.__typename !== "ProgrammableTransaction") tags.add("system");
  if (n.effects?.status && n.effects.status !== "SUCCESS") tags.add("failed");
  const sponsor = n.gasInput?.gasSponsor?.address;
  if (sponsor && sponsor !== n.sender?.address) tags.add("sponsored");
  for (const s of n.signatures ?? []) {
    if (/multisig/i.test(s.scheme?.__typename)) tags.add("multisig");
    if (/zklogin/i.test(s.scheme?.__typename)) tags.add("zklogin");
  }
  if ((n.effects?.effectsJson?.changedObjects ?? []).some((c) => c.accumulatorWrite)) tags.add("address-balance");
  if ((ptb?.commands?.length ?? 0) >= 100) tags.add("large-ptb");
  if (!ptb?.commands?.some((c) => c.moveCall || c.publish || c.upgrade) && ptb) tags.add("no-move-call");
  return tags;
}

/** Transactions calling `fn` just before a random checkpoint in [lo, hi]; empty if none. */
async function byFunction(fn, lo, hi, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const before = randInt(lo, hi);
    const d = await gql(
      `query($f:String!,$b:UInt53){ transactions(last:50, filter:{function:$f, beforeCheckpoint:$b}){ nodes{ digest effects{ balanceChanges(first:50){ pageInfo{ hasNextPage } } } kind{ ... on ProgrammableTransaction { commands(first:50){ pageInfo{ hasNextPage } } } } } } }`,
      { f: fn, b: before },
    );
    if (d.transactions.nodes.length) return d.transactions.nodes;
  }
  return [];
}

async function sample(tip) {
  console.log(`\nsampling below checkpoint ${tip}`);
  const picked = new Map(); // digest -> reason
  const pool = [];
  // Stratified: one checkpoint from each of C equal slices of the chain, so
  // every era is drawn, plus two from the newest million.
  const C = Math.max(4, Math.ceil(N * 1.5));
  const cps = [];
  for (let i = 0; i < C; i++) cps.push(randInt(Math.floor((i * tip) / C) + 1, Math.floor(((i + 1) * tip) / C)));
  cps.push(randInt(tip - 1_000_000, tip), randInt(tip - 1_000_000, tip));
  for (const s of cps) {
    const d = await gql(CP_QUERY, { s });
    for (const n of d.checkpoint?.transactions?.nodes ?? []) pool.push({ digest: n.digest, checkpoint: s, tags: tagsOf(n), sender: n.sender?.address });
  }
  const ptbs = pool.filter((p) => !p.tags.has("system"));
  // One of each kind found in the random checkpoints.
  for (const kind of ["system", "failed", "sponsored", "zklogin", "multisig", "address-balance", "large-ptb", "no-move-call"]) {
    const c = pick(pool.filter((p) => p.tags.has(kind) && !picked.has(p.digest)));
    if (c) picked.set(c.digest, `${kind} (checkpoint ${c.checkpoint})`);
  }
  // The rare kinds, searched for directly when the checkpoints held none.
  const have = (kind) => [...picked.values()].some((r) => r.startsWith(kind));
  if (!have("zklogin")) {
    for (let i = 0; i < 30 && !have("zklogin"); i++) {
      const s = randInt(tip - 50_000_000, tip);
      const d = await gql(CP_QUERY, { s });
      const z = pick((d.checkpoint?.transactions?.nodes ?? []).filter((n) => tagsOf(n).has("zklogin")));
      if (z) picked.set(z.digest, `zklogin (checkpoint ${s})`);
    }
  }
  if (!have("multisig")) {
    // Multisig senders sign few transactions; draw one from a known multisig
    // address, at a random point of its history.
    const corpus = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./multisig-corpus.json", import.meta.url), "utf8"));
    for (let i = 0; i < 4 && !have("multisig"); i++) {
      const ms = pick(corpus).address;
      const d = await gql(`query($a:SuiAddress!){ transactions(last:50, filter:{sentAddress:$a}){ nodes{ digest } } }`, { a: ms });
      const t = pick(d.transactions.nodes);
      if (t) picked.set(t.digest, `multisig (sender ${ms.slice(0, 10)}…)`);
    }
  }
  if (!have("address-balance")) {
    const fn = pick(["0x2::balance::send_funds", "0x2::balance::redeem_funds", "0x2::coin::send_funds", "0x2::coin::redeem_funds"]);
    const t = pick(await byFunction(fn, tip - 30_000_000, tip));
    if (t) picked.set(t.digest, `address-balance (${fn})`);
  }
  if (!have("large-ptb")) {
    for (let i = 0; i < 6 && !have("large-ptb"); i++) {
      const cands = (await byFunction("0x2::coin::split", 1, tip, 2)).filter(
        (n) => n.kind?.commands?.pageInfo?.hasNextPage || n.effects?.balanceChanges?.pageInfo?.hasNextPage,
      );
      for (const c of cands) {
        const t = await rawTx(c.digest);
        if (t && (t.commands.length >= 100 || t.changes.length >= 100)) {
          picked.set(c.digest, `large-ptb (${t.commands.length} commands, ${t.changes.length} balance changes)`);
          break;
        }
      }
    }
  }
  // The rest at random, programmable transactions first.
  const rest = ptbs.filter((p) => !picked.has(p.digest));
  while (picked.size < N && rest.length) {
    const [c] = rest.splice(Math.floor(rand() * rest.length), 1);
    picked.set(c.digest, `random (checkpoint ${c.checkpoint})`);
  }
  // The special kinds come first, so a small n keeps the rare ones.
  return { txs: [...picked.entries()].slice(0, N).map(([digest, why]) => ({ digest, why })), checkpoints: cps };
}

// ---- transaction invariants ------------------------------------------------
async function checkTransaction(digest, why) {
  const raw = await rawTx(digest);
  if (!raw) {
    check(I.txFields, false, { seed: SEED, tool: "raw", args: { digest }, got: "raw read found no transaction for a sampled digest" });
    return null;
  }
  const args = { digest };
  const tx = await call("get_transaction", args);
  if (!tx) return raw;
  const rawNet = netMap(raw.changes);
  const toolNet = netMap(toolRows(tx.balance_changes));
  const diff = mapDiff(toolNet, rawNet);
  check(I.txBc, diff.length === 0 && (tx.balance_changes ?? []).length === raw.changes.length, {
    seed: SEED, tool: "get_transaction", args, why,
    got: diff.length ? diff.slice(0, 5) : `${(tx.balance_changes ?? []).length} rows`,
    raw: diff.length ? undefined : `${raw.changes.length} rows`,
  });

  const fieldDiffs = [];
  const eq = (name, a, b) => {
    if (String(a) !== String(b)) fieldDiffs.push({ field: name, tool: a, raw: b });
  };
  // A system transaction's sender is 0x0 in its data; GraphQL reports none.
  eq("sender", normAddr(tx.sender), normAddr(raw.sender ?? (raw.kind === "ProgrammableTransaction" ? null : "0x0")));
  eq("status", String(tx.status).toLowerCase(), raw.status === "SUCCESS" ? "success" : "failure");
  eq("checkpoint", tx.checkpoint, raw.checkpoint);
  eq("timestamp", tx.timestamp, raw.timestamp);
  eq("event_count", tx.event_count ?? (tx.events ?? []).length, raw.events.length);
  if (raw.gas && raw.kind === "ProgrammableTransaction") {
    eq("gas.computation_cost", tx.gas?.computation_cost, raw.gas.computation);
    eq("gas.storage_cost", tx.gas?.storage_cost, raw.gas.storage);
    eq("gas.storage_rebate", tx.gas?.storage_rebate, raw.gas.rebate);
  }
  check(I.txFields, fieldDiffs.length === 0, { seed: SEED, tool: "get_transaction", args, why, got: fieldDiffs });

  // Address-balance writes: owner, coin, direction and amount, one per write.
  const opKey = (owner, coin, op, amount) => `${normAddr(owner)}|${normType(coin)}|${op}|${amount}`;
  const rawOps = raw.accumulatorWrites.map((w) => {
    const m = /::balance::Balance<(.+)>$/.exec(w.accumulatorType ?? "");
    const op = w.operation === "MERGE" ? "deposit" : w.operation === "SPLIT" ? "withdraw" : "unknown";
    return opKey(w.address, m ? m[1] : w.accumulatorType, op, w.integerValue ?? w.value ?? "0");
  }).sort();
  const toolOps = (tx.address_balance_ops ?? []).map((o) => opKey(o.owner, o.coin_type ?? o.accumulator_type, o.op, o.amount)).sort();
  if (rawOps.length || toolOps.length)
    check(I.abOps, rawOps.join() === toolOps.join(), { seed: SEED, tool: "get_transaction", args, why, got: toolOps, raw: rawOps });

  // Conservation holds where no Move code can put a coin into an object or take
  // one out: a PTB of transfers, splits and merges only, or any failed
  // transaction, whose effects are reverted down to gas.
  const failed = raw.status !== "SUCCESS";
  const plain = raw.kind === "ProgrammableTransaction" && raw.commands.length > 0 && !raw.commands.some((c) => c.moveCall || c.publish || c.upgrade);
  if (raw.gas && raw.kind === "ProgrammableTransaction" && (failed || plain) && raw.accumulatorWrites.length === 0) {
    const sums = new Map();
    for (const r of toolRows(tx.balance_changes)) sums.set(normType(r.coin), (sums.get(normType(r.coin)) ?? 0n) + BigInt(r.amount));
    const bad = [];
    for (const [coin, s] of sums) if (coin !== SUI_T && s !== 0n) bad.push({ coin, sum: s.toString() });
    const suiSum = sums.get(SUI_T) ?? 0n;
    if (suiSum !== -raw.gas.net) bad.push({ coin: "SUI", sum: suiSum.toString(), expected: (-raw.gas.net).toString() });
    check(I.conservation, bad.length === 0, { seed: SEED, tool: "get_transaction", args, why, got: bad, raw: { net_gas: raw.gas.net.toString() } });
  } else skip(I.conservation, "Move calls can move value into or out of objects");
  return { raw, tool: tx };
}

async function checkBatch(sampled) {
  const digests = sampled.map((s) => s.digest).slice(0, 50);
  const args = { digests };
  // The default view keeps each transaction's lists within a share of its
  // budget and names what it left out in `omitted.lists`; `detail: "full"`
  // lists every row. The full view is compared with the single reads, and the
  // default view must be a subset of it with `omitted` counting the rest.
  const batch = await call("get_transactions", args);
  const full = await call("get_transactions", { ...args, detail: "full" });
  if (!batch || !full) return;
  const byDigest = new Map((full.transactions ?? []).map((t) => [t.digest, t]));
  const summaryAt = new Map((batch.transactions ?? []).map((t, i) => [t.digest, { t, i }]));
  for (const s of sampled.slice(0, 50)) {
    const one = s.tool;
    const many = byDigest.get(s.digest);
    if (!one) continue;
    if (!many) {
      check(I.batch, false, { seed: SEED, tool: "get_transactions", args: { digests: [s.digest], detail: "full" }, got: `not returned (not_found: ${short(full.not_found)})`, raw: "the transaction exists" });
      continue;
    }
    const diffs = [];
    const summary = summaryAt.get(s.digest);
    if (!summary) diffs.push({ field: "default view", got: `not returned (not_found: ${short(batch.not_found)})` });
    else {
      for (const list of ["events", "move_calls", "balance_changes"]) {
        const shown = (summary.t[list] ?? []).map((r) => JSON.stringify(r));
        const all = (many[list] ?? []).map((r) => JSON.stringify(r));
        // Rows repeat (a Move call made twice), so the listed rows must be
        // found in the full list one for one.
        const unmatched = [...all];
        const extra = shown.filter((r) => {
          const at = unmatched.indexOf(r);
          if (at < 0) return true;
          unmatched.splice(at, 1);
          return false;
        });
        const left = batch.omitted?.lists?.[`transactions.${summary.i}.${list}`]?.count ?? 0;
        if (shown.length + left !== all.length || extra.length) {
          diffs.push({ field: `default view ${list}`, shown: shown.length, omitted: left, full: all.length, not_in_full: extra.slice(0, 2) });
        }
      }
    }
    if (normAddr(many.sender) !== normAddr(one.sender)) diffs.push({ field: "sender", batch: many.sender, single: one.sender });
    if (String(many.status).toLowerCase() !== String(one.status).toLowerCase()) diffs.push({ field: "status", batch: many.status, single: one.status });
    if (String(many.checkpoint) !== String(one.checkpoint)) diffs.push({ field: "checkpoint", batch: many.checkpoint, single: one.checkpoint });
    if (many.timestamp !== one.timestamp) diffs.push({ field: "timestamp", batch: many.timestamp, single: one.timestamp });
    // The batch reads one page of events per transaction and says so with
    // events_truncated. Then its events must be the first of the single read's.
    // get_transaction folds events that differ only in amounts into one row
    // naming their positions in `indices`; unfolded, they are the event list.
    const oneTypes = [];
    for (const e of one.events ?? []) for (const i of e.indices ?? [e.index ?? oneTypes.length]) oneTypes[i] = e.event_type ?? e.type;
    const manyTypes = (many.events ?? []).map((e) => e.type);
    if (many.events_truncated) {
      if (!(Number(one.event_count) > manyTypes.length && manyTypes.join() === oneTypes.slice(0, manyTypes.length).join() && /get_transaction/.test(many.events_note ?? "")))
        diffs.push({ field: "events (truncated page)", batch: many.event_count, single: one.event_count });
    } else {
      // Positions the single read left out past its budget are counted in its
      // `omitted`; every position it lists must match the batch's.
      const listed = oneTypes.filter((t) => t !== undefined).length;
      const oneLeft = one.omitted?.lists?.events?.count ?? 0;
      if (Number(many.event_count) !== Number(one.event_count) || manyTypes.length !== Number(many.event_count)) diffs.push({ field: "event_count", batch: many.event_count, listed: manyTypes.length, single: one.event_count });
      else if (listed + oneLeft !== manyTypes.length || manyTypes.some((t, i) => oneTypes[i] !== undefined && oneTypes[i] !== t)) {
        diffs.push({ field: "event types", batch: manyTypes.slice(0, 5), single: oneTypes.slice(0, 5), single_omitted: oneLeft });
      }
    }
    const bd = mapDiff(netMap(toolRows(many.balance_changes)), netMap(toolRows(one.balance_changes)));
    if (bd.length) diffs.push({ field: "balance_changes", diff: bd.slice(0, 5) });
    check(I.batch, diffs.length === 0, { seed: SEED, tool: "get_transactions", args: { digests: [s.digest] }, why: s.why, got: diffs });
  }
}

async function checkAttack(digest, raw, why) {
  const args = { digest };
  const a = await call("analyze_attack_tx", args);
  if (!a) return;
  const rows = [];
  for (const addr of a.addresses ?? []) for (const c of addr.coins ?? []) rows.push({ owner: addr.address, coin: c.coin_type, amount: c.amount });
  const diff = mapDiff(netMap(rows), netMap(raw.changes));
  check(I.attack, diff.length === 0, { seed: SEED, tool: "analyze_attack_tx", args, why, got: diff.slice(0, 6) });
}

async function checkTrace(digest, raw, why) {
  const args = { digest, direction: "forward", hops: 1 };
  const t = await call("trace_funds", args);
  if (!t) return;
  const hop = t.hops?.[0];
  if (!hop) {
    // A start with no balance change has nothing to follow.
    check(I.trace, raw.changes.length === 0, { seed: SEED, tool: "trace_funds", args, why, got: `no hop 1 (${t.stop_reason ?? "no reason"})`, raw: `${raw.changes.length} balance changes` });
    return;
  }
  const diff = mapDiff(netMap(toolRows(hop.balance_changes)), netMap(raw.changes));
  check(I.trace, hop.digest === digest && diff.length === 0, { seed: SEED, tool: "trace_funds", args, why, got: hop.digest !== digest ? `hop 1 is ${hop.digest}` : diff.slice(0, 6) });
}

// ---- address invariants ----------------------------------------------------
async function checkBalance(address, coinType) {
  // The current balance is a fullnode read, so it is compared with a raw gRPC
  // read on each side of the call. GraphQL lags the fullnode by a few
  // checkpoints, which on a busy address is a different balance.
  // An address whose balance moves every checkpoint (a busy address-balance
  // account) is read up to three times, until the raw value holds still across
  // the call. The fullnode is load-balanced, so reads are not monotone.
  const args = { owner: address, coin_type: coinType };
  let before, b, after;
  for (let attempt = 0; attempt < 3; attempt++) {
    before = await grpcBalance(address, coinType);
    b = await call("get_balance", args);
    after = await grpcBalance(address, coinType);
    if (!b || before.total === after.total) break;
  }
  if (!b) return;
  if (before.total !== after.total) return skip(I.balance, "balance moved across every read");
  const matches = (r) => BigInt(b.balance) === r.total && BigInt(b.coin_balance ?? -1) === r.coin && BigInt(b.address_balance ?? -1) === r.address;
  check(I.balance, (matches(before) || matches(after)) && BigInt(b.balance) === BigInt(b.coin_balance) + BigInt(b.address_balance), {
    seed: SEED, tool: "get_balance", args,
    got: { balance: b.balance, coin_balance: b.coin_balance, address_balance: b.address_balance },
    raw: { grpc_before: strs(before), grpc_after: strs(after) },
  });
  // The coin part against the coin objects themselves, when both sources
  // agree the address held still.
  const q = await rawBalance(address, coinType);
  if (before.total === after.total && q.total === after.total) {
    const coins = await rawCoinObjectSum(address, coinType);
    if (coins === null) skip(I.balance, "more than 500 coin objects");
    else check(I.balance, BigInt(b.coin_balance) === coins, { seed: SEED, tool: "get_balance", args, got: { coin_balance: b.coin_balance }, raw: { coin_objects_sum: coins.toString() } });
  } else skip(I.balance, "balance moved while it was read; coin objects not summed");

  // at_checkpoint at the newest indexed checkpoint against the raw read there,
  // and against the current path when the balance has not moved since.
  const cp = await latestCheckpoint();
  const atArgs = { owner: address, coin_type: coinType, at_checkpoint: cp };
  const at = await call("get_balance", atArgs);
  if (!at) return;
  const rawAt = await rawBalance(address, coinType, cp);
  const g1 = await grpcBalance(address, coinType);
  const now = await call("get_balance", args);
  const g2 = await grpcBalance(address, coinType);
  const still = g1.total === rawAt.total && g2.total === rawAt.total;
  check(I.balanceAt, BigInt(at.balance) === rawAt.total && (!now || !still || BigInt(now.balance) === BigInt(at.balance)), {
    seed: SEED, tool: "get_balance", args: atArgs,
    got: { at_checkpoint: at.balance, current: now?.balance, method: at.method },
    raw: { graphql_at_checkpoint: rawAt.total.toString(), grpc_current: [g1.total.toString(), g2.total.toString()] },
  });
}

/**
 * A past balance against a forward sum: every raw balance change of the address
 * from its first transaction to the end of `checkpoint`. The tool reconstructs
 * backwards from one anchor, so the two meet only if both are exact. Run where
 * the whole history is short enough to read, and where the forward sum over
 * all of it reaches today's balance (an address funded at genesis does not).
 */
async function checkBalancePast(address, coinType, checkpoint) {
  const all = await rawAddressWindow(address, null, null, 300);
  if (!all.complete) return skip(I.balancePast, "history over 300 transactions");
  const now = await rawBalance(address, coinType);
  let total = 0n;
  let upTo = 0n;
  for (const r of all.rows) {
    const t = await rawTx(r.digest);
    for (const c of t.changes) {
      if (normAddr(c.owner) !== normAddr(address) || c.coin !== normType(coinType)) continue;
      total += c.amount;
      if (r.checkpoint <= checkpoint) upTo += c.amount;
    }
  }
  const nowAfter = await rawBalance(address, coinType);
  if (now.total !== nowAfter.total) return skip(I.balancePast, "balance moved during the read");
  if (total !== now.total) return skip(I.balancePast, "forward sum does not reach the current balance (genesis or pre-history funds)");
  const args = { owner: address, coin_type: coinType, at_checkpoint: checkpoint };
  const b = await call("get_balance", args);
  if (!b) return;
  check(I.balancePast, BigInt(b.balance) === upTo, {
    seed: SEED, tool: "get_balance", args,
    got: { balance: b.balance, method: b.method, coin_balance: b.coin_balance, address_balance: b.address_balance },
    raw: { forward_sum: upTo.toString(), transactions: all.rows.filter((r) => r.checkpoint <= checkpoint).length },
  });
}

/** The checkpoint of each digest, from raw rows already read or else a raw lookup; null when the chain has no such transaction. */
async function checkpointsOf(digests, known) {
  for (const d of digests) {
    if (known.has(d)) continue;
    const t = (await gql(`query($d:String!){ transaction(digest:$d){ effects{ checkpoint{ sequenceNumber } } } }`, { d })).transaction;
    known.set(d, t ? Number(t.effects.checkpoint.sequenceNumber) : null);
  }
  return digests.map((d) => known.get(d));
}

/**
 * A tool's page of an address's transactions against the raw query. The
 * service answers a read at one checkpoint and shows a checkpoint's
 * transactions all at once, so the raw page read with `beforeCheckpoint` one
 * past the tool's newest row is the page the tool read; the rows it leaves out
 * are in later checkpoints. Both tools page the same `transactions` connection
 * as the raw read (newest first reverses it), so within a checkpoint too the
 * order is the connection's on both sides, and the two pages must be equal row
 * for row. The tool read after the raw page passed as `before`, so its newest
 * row is no older than that page's newest row. Returns the verdict, the raw
 * page compared with, and what differs.
 */
async function pageAtToolRead(address, order, limit, digests, before, known) {
  const beforeNewest = Math.max(-1, ...before.rows.map((r) => r.checkpoint));
  if (!digests.length) return { ok: before.rows.length === 0, raw: before, got: { rows: 0 }, want: { raw_rows_before_the_call: before.rows.length } };
  const cps = await checkpointsOf(digests, known);
  const at = (d, i) => `${d}@${cps[i] ?? "not on chain"}`;
  if (cps.includes(null)) return { ok: false, raw: before, got: { not_on_chain: digests.filter((_, i) => cps[i] === null), digests }, want: {} };
  const newest = Math.max(...cps);
  const raw = await rawAddressPage(address, { order, limit, before: newest + 1 });
  const rd = raw.rows.map((r) => r.digest);
  for (const r of raw.rows) known.set(r.digest, r.checkpoint);
  const first = digests.findIndex((d, i) => d !== rd[i]);
  const differs = first >= 0 || digests.length !== rd.length;
  return {
    ok: !differs && newest >= beforeNewest,
    raw,
    got: {
      newest_checkpoint: newest,
      first_difference: differs ? (first >= 0 ? first : Math.min(digests.length, rd.length)) : null,
      extra: digests.flatMap((d, i) => (rd.includes(d) ? [] : [at(d, i)])),
      missing: raw.rows.filter((r) => !digests.includes(r.digest)).map((r) => `${r.digest}@${r.checkpoint}`),
      digests: digests.map(at),
    },
    want: { newest_checkpoint_before_the_call: beforeNewest, at_the_tool_checkpoint: raw.rows.map((r) => `${r.digest}@${r.checkpoint}`) },
  };
}

/**
 * get_transaction_history and query_transactions against the raw page, both
 * orders, each by `pageAtToolRead`. History's default view lists the rows that
 * fit its budget and counts the rest in `omitted`; `detail: "full"` lists the
 * whole page, and the raw page is compared with that view. The default view
 * must be the full page in order with exactly `omitted` rows left out.
 */
async function checkHistory(address) {
  const out = {};
  for (const order of ["oldest", "newest"]) {
    const limit = 20;
    const hArgs = { address, limit, order, detail: "full" };
    const sArgs = { address, limit, order };
    const qArgs = { affected_address: address, limit, order };
    const rawBefore = await rawAddressPage(address, { order, limit });
    const h = await call("get_transaction_history", hArgs);
    const summary = await call("get_transaction_history", sArgs);
    const rawBetween = await rawAddressPage(address, { order, limit });
    const q = await call("query_transactions", qArgs);
    const known = new Map([...rawBefore.rows, ...rawBetween.rows].map((r) => [r.digest, r.checkpoint]));
    const hd = (h?.transactions ?? []).map((t) => t.digest);
    const qd = (q?.transactions ?? []).map((t) => t.digest);
    const hPage = h ? await pageAtToolRead(address, order, limit, hd, rawBefore, known) : null;
    if (hPage) check(I.historyList, hPage.ok, { seed: SEED, tool: "get_transaction_history", args: hArgs, got: hPage.got, raw: hPage.want });
    if (q) {
      const qPage = await pageAtToolRead(address, order, limit, qd, rawBetween, known);
      check(I.historyList, qPage.ok, { seed: SEED, tool: "query_transactions", args: qArgs, got: qPage.got, raw: qPage.want });
    }
    if (summary && h) {
      // The two views read the same page when the raw page read before the full
      // view and the one read after the default view are equal row for row,
      // and the full view equals them.
      const digestsOf = (r) => r.rows.map((x) => x.digest).join();
      if (digestsOf(rawBefore) !== digestsOf(rawBetween) || hd.join() !== digestsOf(rawBefore)) skip(I.historyList, "the page moved between the full and default reads");
      else {
        const sd = (summary.transactions ?? []).map((t) => t.digest);
        const left = summary.omitted?.lists?.transactions?.count ?? 0;
        const inOrder = sd.every((d, i) => i === 0 || hd.indexOf(d) > hd.indexOf(sd[i - 1])) && sd.every((d) => hd.includes(d));
        check(I.historyList, inOrder && sd.length + left === hd.length, { seed: SEED, tool: "get_transaction_history", args: sArgs, got: { listed: sd, omitted: left }, raw: `the full view's ${hd.length} rows` });
      }
    }
    out[order] = {
      rows: h?.transactions ?? [],
      // The raw page as of the full view's read, which the timeline check
      // takes its window and expected rows from.
      raw: hPage?.raw ?? rawBefore,
      args: hArgs,
      // Rows the tool itself names as read from part of their lists.
      incomplete: new Set((h?.incomplete_transactions ?? []).map((t) => t.digest)),
    };
  }
  return out;
}

async function checkSubjectFlow(address, history) {
  const rows = [...history.oldest.rows.slice(0, 6), ...history.newest.rows.slice(0, 4)];
  const incomplete = new Set([...history.oldest.incomplete, ...history.newest.incomplete]);
  for (const row of rows) {
    if (incomplete.has(row.digest)) {
      skip(I.subjectFlow, "the tool named the row incomplete (a continuation read failed)");
      continue;
    }
    const raw = await rawTx(row.digest);
    if (!raw) continue;
    const own = new Map();
    for (const c of raw.changes) if (normAddr(c.owner) === normAddr(address)) own.set(c.coin, (own.get(c.coin) ?? 0n) + c.amount);
    for (const [k, v] of own) if (v === 0n) own.delete(k);
    const tool = new Map();
    for (const f of row.subject_flow ?? []) tool.set(normType(f.raw_type), (tool.get(normType(f.raw_type)) ?? 0n) + BigInt(f.amount));
    const diff = mapDiff(tool, own);
    check(I.subjectFlow, diff.length === 0, { seed: SEED, tool: "get_transaction_history", args: { address, digest: row.digest }, got: diff });
  }
}

/**
 * A window both tools can answer exactly, as exclusive checkpoint bounds: the
 * checkpoints the page covers in full. A page can cut its last checkpoint
 * part-way (its first, for newest first) when more transactions follow.
 */
function sharedWindow(rows, order, more) {
  if (!rows.length) return null;
  const cps = rows.map((r) => r.checkpoint);
  let lo = Math.min(...cps);
  let hi = Math.max(...cps);
  if (more && order === "oldest") hi -= 1;
  if (more && order === "newest") lo += 1;
  return hi >= lo ? { after: lo - 1, before: hi + 1 } : null;
}

async function checkTimeline(address, history) {
  for (const order of ["oldest", "newest"]) {
    const page = history[order];
    const w = sharedWindow(page.raw.rows, order, page.raw.more);
    if (!w) {
      skip(I.timeline, "history page covers no whole checkpoint");
      continue;
    }
    const expected = page.raw.rows.filter((r) => r.checkpoint > w.after && r.checkpoint < w.before).map((r) => r.digest);
    const historyDigests = page.rows.map((r) => r.digest).filter((d) => expected.includes(d));
    // The full view lists every entry up to `limit`; the default view keeps
    // what fits its budget and counts the rest in `omitted`.
    const args = { addresses: [address], from: String(w.after), to: String(w.before), per_address: 60, limit: 200, detail: "full" };
    const t = await call("build_timeline", args);
    if (!t) continue;
    const ta = t.window?.after_checkpoint;
    const tb = t.window?.before_checkpoint;
    const got = (t.timeline ?? []).map((e) => e.digest);
    const rawWin = await rawAddressWindow(address, ta ?? w.after, tb ?? w.before, 200);
    const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
    check(I.timeline, sameSet(got, rawWin.rows.map((r) => r.digest)) && sameSet(got.filter((d) => expected.includes(d)), historyDigests) && sameSet(expected, historyDigests), {
      seed: SEED, tool: "build_timeline", args,
      got: { window: t.window, digests: got },
      raw: { history_in_window: historyDigests, raw_in_window: rawWin.rows.map((r) => r.digest) },
    });
    // Each entry's subject_flow for the address against the raw change.
    for (const e of (t.timeline ?? []).slice(0, 5)) {
      const raw = await rawTx(e.digest);
      const own = new Map();
      for (const c of raw.changes) if (normAddr(c.owner) === normAddr(address)) own.set(c.coin, (own.get(c.coin) ?? 0n) + c.amount);
      for (const [k, v] of own) if (v === 0n) own.delete(k);
      const tool = new Map();
      for (const f of e.subject_flow?.[address] ?? []) tool.set(normType(f.raw_type), (tool.get(normType(f.raw_type)) ?? 0n) + BigInt(f.amount));
      check(I.subjectFlow, mapDiff(tool, own).length === 0, { seed: SEED, tool: "build_timeline", args: { ...args, digest: e.digest }, got: mapDiff(tool, own) });
    }
    history.window ??= w;
  }
}

async function checkFlows(address, history) {
  const w = history.window;
  if (!w) return skip(I.flows, "no shared window");
  const args = { address, from: String(w.after), to: String(w.before), max_transactions: 200 };
  const f = await call("summarize_address_flows", args);
  if (!f) return;
  const after = f.window?.after_checkpoint ?? w.after;
  const before = f.window?.before_checkpoint ?? w.before;
  const win = await rawAddressWindow(address, after, before, 250);
  if (!win.complete || !f.coverage?.complete) return skip(I.flows, "window larger than the scan");
  // The documented rule: per transaction, the address's own change per coin with
  // the gas it paid added back (gas payer = sponsor, else sender); a gas-only
  // sponsor's SUI row is gas, not a flow.
  const coins = new Map();
  let gasPaid = 0n;
  for (const r of win.rows) {
    const t = await rawTx(r.digest);
    const payer = t.sponsor ?? t.sender;
    const own = new Map();
    for (const c of t.changes) {
      if (normAddr(c.owner) !== normAddr(address)) continue;
      own.set(c.coin, (own.get(c.coin) ?? 0n) + c.amount);
    }
    if (normAddr(payer) === normAddr(address) && t.gas) {
      gasPaid += t.gas.net;
      own.set(SUI_T, (own.get(SUI_T) ?? 0n) + t.gas.net);
    }
    // A sponsor that is not the sender: its SUI change is gas only.
    if (t.sponsor && t.sponsor !== t.sender && normAddr(t.sponsor) === normAddr(address)) own.delete(SUI_T);
    for (const [coin, v] of own) {
      if (v === 0n) continue;
      const e = coins.get(coin) ?? { in: 0n, out: 0n };
      if (v > 0n) e.in += v;
      else e.out -= v;
      coins.set(coin, e);
    }
  }
  const diffs = [];
  const toolCoins = new Map((f.coins ?? []).map((c) => [normType(c.coin_type), c]));
  for (const k of new Set([...coins.keys(), ...toolCoins.keys()])) {
    const e = coins.get(k) ?? { in: 0n, out: 0n };
    const c = toolCoins.get(k);
    const tin = BigInt(c?.raw?.in ?? 0);
    const tout = BigInt(c?.raw?.out ?? 0);
    if (tin !== e.in || tout !== e.out) diffs.push({ coin: k, tool: { in: tin.toString(), out: tout.toString() }, raw: { in: e.in.toString(), out: e.out.toString() } });
  }
  if (Number(f.coverage?.scanned_transactions) !== win.rows.length) diffs.push({ field: "scanned_transactions", tool: f.coverage?.scanned_transactions, raw: win.rows.length });
  const toolGas = Math.round(Number(f.gas?.paid_sui ?? 0) * 1e9);
  if (Math.abs(toolGas - Number(gasPaid)) > 1) diffs.push({ field: "gas.paid_sui", tool: f.gas?.paid_sui, raw: Number(gasPaid) / 1e9 });
  check(I.flows, diffs.length === 0, { seed: SEED, tool: "summarize_address_flows", args, got: diffs.slice(0, 6), raw: `${win.rows.length} transactions in (${after}, ${before})` });
}

async function checkFanout(address) {
  const max = 50;
  const args = { address, max_transactions: max };
  // The documented rule, coin by coin: another address that gained a coin the
  // subject lost on net is a recipient, one that lost a coin the subject gained
  // is a sender. A gas-only sponsor's SUI row is skipped.
  const recount = async () => {
    const page = await rawAddressPage(address, { order: "newest", limit: max });
    const recipients = new Set();
    const senders = new Set();
    for (const r of page.rows) {
      const t = await rawTx(r.digest);
      const rows = t.changes.filter((c) => !(t.sponsor && t.sponsor !== t.sender && c.owner === t.sponsor && c.coin === SUI_T));
      const own = new Map();
      for (const c of rows) if (c.owner === address) own.set(c.coin, (own.get(c.coin) ?? 0n) + c.amount);
      for (const c of rows) {
        if (!c.owner || c.owner === address) continue;
        const mine = own.get(c.coin) ?? 0n;
        if (mine < 0n && c.amount > 0n) recipients.add(c.owner);
        if (mine > 0n && c.amount < 0n) senders.add(c.owner);
      }
    }
    return { recipients: recipients.size, senders: senders.size, scanned: page.rows.length };
  };
  const before = await recount();
  const f = await call("get_address_fanout", args);
  if (!f) return;
  const after = await recount();
  const ok = (r) => f.recipient_count === r.recipients && f.sender_count === r.senders && f.scanned_transactions === r.scanned;
  check(I.fanout, ok(before) || ok(after), {
    seed: SEED, tool: "get_address_fanout", args,
    got: { recipient_count: f.recipient_count, sender_count: f.sender_count, scanned: f.scanned_transactions },
    raw: { recipients: after.recipients, senders: after.senders, scanned: after.scanned },
  });
}

async function checkIdentify(id, why) {
  const args = { address: id };
  const o = await rawObject(id);
  const r = await call("identify_address", args);
  if (!r) return !!o;
  let expected;
  if (o?.asMovePackage) expected = ["package"];
  else if (o) expected = o.owner?.__typename === "Shared" ? ["shared_object"] : ["object"];
  else expected = ["wallet", "validator", "wrapped_or_deleted_object"];
  let ok = expected.includes(r.type);
  if (ok && (r.type === "object" || r.type === "shared_object")) ok = normType(r.object_type) === normType(o.asMoveObject?.contents?.type?.repr);
  check(I.identify, ok, { seed: SEED, tool: "identify_address", args, why, got: { type: r.type, object_type: r.object_type }, raw: o ? { package: !!o.asMovePackage, owner: o.owner?.__typename, type: o.asMoveObject?.contents?.type?.repr } : "no object at this address" });
  return !!o;
}

/** The fullnode's current version of an object, read over gRPC. */
async function grpcObjectVersion(id) {
  const { response } = await grpc.ledgerService.getObject({ objectId: id, readMask: { paths: ["version"] } });
  return String(response.object?.version);
}

async function checkObject(id, why) {
  // The type against GraphQL, which does not change. The version is a fullnode
  // read, so it is compared with raw gRPC reads on each side of the call: a hot
  // shared object is several versions ahead on the fullnode of what GraphQL has
  // indexed.
  const args = { object_id: id };
  const o = await rawObject(id);
  const v1 = await grpcObjectVersion(id);
  const r = await call("get_object", args);
  const v2 = await grpcObjectVersion(id);
  if (!r || !o) return;
  const rawType = o.asMovePackage ? "package" : normType(o.asMoveObject?.contents?.type?.repr);
  const toolType = r.object_type === "package" ? "package" : normType(r.object_type);
  // A hot shared object advances between the reads; the tool's version must lie
  // between the raw reads taken on each side of the call.
  const versionOk = v1 != null && v2 != null && r.version != null && BigInt(v1) <= BigInt(r.version) && BigInt(r.version) <= BigInt(v2);
  check(I.object, toolType === rawType && versionOk, { seed: SEED, tool: "get_object", args, why, got: { type: r.object_type, version: r.version }, raw: { type: rawType, grpc_version: [v1, v2] } });
}

async function checkCheckpoint(seq) {
  const args = { sequence_number: String(seq) };
  const r = await call("get_checkpoint", args);
  if (!r) return;
  const d = await gql(`query($s:UInt53){ checkpoint(sequenceNumber:$s){ timestamp epoch{ epochId } networkTotalTransactions } }`, { s: seq });
  const c = d.checkpoint;
  const diffs = [];
  if (Date.parse(r.timestamp) !== Date.parse(c.timestamp)) diffs.push({ field: "timestamp", tool: r.timestamp, raw: c.timestamp });
  if (String(r.epoch) !== String(c.epoch.epochId)) diffs.push({ field: "epoch", tool: r.epoch, raw: c.epoch.epochId });
  if (String(r.sequence_number) !== String(seq)) diffs.push({ field: "sequence_number", tool: r.sequence_number, raw: seq });
  const toolTotal = r.total_network_transactions;
  if (String(toolTotal) !== String(c.networkTotalTransactions)) diffs.push({ field: "network_total_transactions", tool: toolTotal, raw: c.networkTotalTransactions });
  check(I.checkpoint, diffs.length === 0, { seed: SEED, tool: "get_checkpoint", args, got: diffs });
}

async function checkHolders(coinType) {
  const args = { type: coinType, mode: "token", limit: 10 };
  const h = await call("get_top_holders", args);
  if (!h) return;
  const ranked = h.top_holders ?? null;
  const list = ranked ?? h.sampled_holders ?? [];
  if (!list.length) {
    check(I.holders, false, { seed: SEED, tool: "get_top_holders", args, got: "no holders listed for a coin seen moving on chain" });
    return;
  }
  if (ranked) {
    const desc = ranked.every((x, i) => i === 0 || BigInt(ranked[i - 1].balance) >= BigInt(x.balance));
    check(I.holders, desc, { seed: SEED, tool: "get_top_holders", args, got: ranked.map((x) => x.balance) });
  } else skip(I.holders, "ranking incomplete (sampled holders), order not claimed");
  for (const x of list.slice(0, 5)) {
    if (x.balance == null) continue;
    // Read after the scan, by both sources: a busy holder may have moved.
    const r = await rawBalance(x.address, coinType);
    const g = await grpcBalance(x.address, coinType);
    check(I.holders, BigInt(x.balance) === r.total || BigInt(x.balance) === g.total, { seed: SEED, tool: "get_top_holders", args: { ...args, holder: x.address }, got: x.balance, raw: { graphql: r.total.toString(), grpc: g.total.toString() } });
  }
}

// ---- bridge exits and events -----------------------------------------------
const BRIDGE_EVENTS = [
  { type: "0x000000000000000000000000000000000000000000000000000000000000000b::bridge::TokenDepositedEvent", from: 60_000_000 },
  { type: "0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e::deposit_for_burn::DepositForBurn", from: 60_000_000 },
  // Any Wormhole message: a token transfer, NTT or a Mayan order carries a
  // beneficiary; other payloads may not, and then none is claimed.
  { type: "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::publish_message::WormholeMessage", from: 1_000_000, optional: true },
];

/** Every hex string a raw event payload can carry a beneficiary in: hex, base64, byte arrays. */
function payloadHex(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    const s = value.replace(/^0x/, "").toLowerCase();
    if (/^[0-9a-f]+$/.test(s)) out.push(s);
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length >= 8) out.push(Buffer.from(value, "base64").toString("hex"));
    return out;
  }
  if (Array.isArray(value) && value.every((x) => typeof x === "number")) {
    out.push(Buffer.from(value).toString("hex"));
    return out;
  }
  if (typeof value === "object") for (const v of Object.values(value)) payloadHex(v, out);
  return out;
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Hex(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return "00".repeat([...s].findIndex((c) => c !== "1") < 0 ? 0 : [...s].findIndex((c) => c !== "1")) + hex;
}

async function checkBridge(tip) {
  const kind = pick(BRIDGE_EVENTS);
  const before = randInt(kind.from, tip);
  const qArgs = { event_type: kind.type, before_checkpoint: before, limit: 10 };
  const ev = await call("query_events", qArgs);
  // query_events against the raw events query for the same filter.
  const raw = await gql(
    `query($t:String!,$b:UInt53){ events(last:10, filter:{type:$t, beforeCheckpoint:$b}){ nodes{ transaction{ digest } } } }`,
    { t: kind.type, b: before },
  );
  const rawDigests = raw.events.nodes.map((n) => n.transaction.digest).reverse();
  const toolDigests = (ev?.events ?? []).map((e) => e.digest ?? e.transaction_digest ?? e.tx_digest);
  if (ev) check(I.events, toolDigests.join() === rawDigests.join(), { seed: SEED, tool: "query_events", args: qArgs, got: toolDigests, raw: rawDigests });
  const digest = pick(rawDigests);
  if (!digest) return skip(I.bridge, `no ${kind.type.split("::").slice(1).join("::")} before ${before}`);
  const args = { digest, include_destination: false };
  const r = await call("resolve_bridge_transfer", args);
  if (!r) return;
  const t = await rawTx(digest);
  const hexes = t.events.flatMap((e) => payloadHex(e.contents?.json));
  const bens = r.beneficiaries ?? [];
  if (!bens.length && kind.optional) return skip(I.bridge, "a Wormhole message with no beneficiary decoded");
  if (!bens.length) {
    check(I.bridge, false, { seed: SEED, tool: "resolve_bridge_transfer", args, got: "no beneficiary", raw: `event ${kind.type}` });
    return;
  }
  for (const b of bens) {
    const forms = [b.address_raw, b.address].filter(Boolean).map((a) => (/^0x/.test(a) || /^[0-9a-f]+$/i.test(a) ? a.replace(/^0x/, "").toLowerCase() : base58Hex(a))).filter(Boolean);
    // A 20-byte EVM address sits left-padded in a 32-byte field.
    const found = forms.some((f) => hexes.some((h) => h.includes(f) || h.includes(f.replace(/^0+/, ""))));
    check(I.bridge, found, { seed: SEED, tool: "resolve_bridge_transfer", args, got: { protocol: b.protocol, address: b.address, address_raw: b.address_raw }, raw: hexes.slice(0, 4).map((h) => h.slice(0, 200)) });
  }
}

// ---- the run ---------------------------------------------------------------
const t0 = Date.now();
let exitCode = 0;
try {
  const tip = arg("tip") !== undefined ? Number(arg("tip")) : await latestCheckpoint();
  console.log(`invariant-pass  seed=${SEED}  n=${N}  tip=${tip}`);
  console.log(`reproduce: node scripts/probe/invariant-pass.mjs --seed ${SEED} --n ${N} --tip ${tip}`);
  const { txs, checkpoints } = await sample(tip);
  console.log(`sampled ${txs.length} transactions:`);
  for (const s of txs) console.log(`   ${s.digest}  ${s.why}`);

  // Transactions.
  console.log("\ntransactions");
  for (const s of txs) {
    console.log(` - ${s.digest} (${s.why})`);
    const r = await checkTransaction(s.digest, s.why);
    s.raw = r?.raw ?? r;
    s.tool = r?.tool ?? null;
  }
  await checkBatch(txs);
  for (const s of txs) {
    if (!s.raw || s.raw.kind !== "ProgrammableTransaction") {
      if (s.raw) {
        // A system transaction has no attacker; the tool must still answer.
        await checkAttack(s.digest, s.raw, s.why);
      }
      continue;
    }
    await checkAttack(s.digest, s.raw, s.why);
  }
  for (const s of txs.filter((x) => x.raw?.changes.length).slice(0, Math.ceil(N / 2) + 2)) await checkTrace(s.digest, s.raw, s.why);

  // Checkpoints.
  console.log("\ncheckpoints");
  for (const c of checkpoints.slice(0, 4)) await checkCheckpoint(c);

  // Addresses: senders first, then a recipient, then address-balance owners.
  const addrs = new Map();
  const add = (a, why) => {
    if (a && !/^0x0+$/.test(a) && !addrs.has(normAddr(a))) addrs.set(normAddr(a), why);
  };
  for (const s of txs) if (s.raw?.kind === "ProgrammableTransaction") add(s.raw.sender, `sender of ${s.digest.slice(0, 8)} (${s.why.split(" ")[0]})`);
  for (const s of txs) {
    const rec = pick((s.raw?.changes ?? []).filter((c) => c.amount > 0n && c.owner !== s.raw.sender));
    if (rec) add(rec.owner, `recipient in ${s.digest.slice(0, 8)}`);
  }
  for (const s of txs) for (const w of s.raw?.accumulatorWrites ?? []) add(w.address, `address-balance owner in ${s.digest.slice(0, 8)}`);
  const addressList = [...addrs.entries()].slice(0, N);

  console.log("\naddresses");
  for (const [address, why] of addressList) {
    console.log(` - ${address} (${why})`);
    await checkBalance(address, SUI);
    const other = (await gql(`query($a:SuiAddress!){ address(address:$a){ balances(first:10){ nodes{ coinType{ repr } totalBalance } } } }`, { a: address })).address?.balances?.nodes?.filter((b) => !isSui(b.coinType.repr));
    const coin = pick(other ?? []);
    if (coin) await checkBalance(address, coin.coinType.repr);
    // The checkpoint of the sampled transaction this address came from.
    const pastCp = txs.find((s) => normAddr(s.raw?.sender) === address || s.raw?.changes.some((c) => normAddr(c.owner) === address) || s.raw?.accumulatorWrites.some((w) => normAddr(w.address) === address))?.raw?.checkpoint;
    if (pastCp) await checkBalancePast(address, SUI, pastCp);
    const history = await checkHistory(address);
    await checkSubjectFlow(address, history);
    await checkTimeline(address, history);
    await checkFlows(address, history);
    await checkFanout(address);
    await checkIdentify(address, why);
  }

  // Objects and packages seen in the sample, plus a kiosk.
  console.log("\nobjects and packages");
  const ids = new Map();
  for (const s of txs) {
    for (const c of s.raw?.commands ?? []) if (c.moveCall?.package) ids.set(normAddr(c.moveCall.package), `package called in ${s.digest.slice(0, 8)}`);
    for (const i of s.raw?.inputs ?? []) if (i.kind === "SHARED" && i.objectId) ids.set(normAddr(i.objectId), `shared input of ${s.digest.slice(0, 8)}`);
    for (const i of s.raw?.inputs ?? []) if (i.kind === "IMMUTABLE_OR_OWNED" && i.objectId) ids.set(normAddr(i.objectId), `owned input of ${s.digest.slice(0, 8)}`);
    for (const w of s.raw?.accumulatorWrites ?? []) if (w.address) ids.set(normAddr(w.address), `address-balance owner in ${s.digest.slice(0, 8)}`);
  }
  const kioskTx = pick(await byFunction("0x2::kiosk::list", 60_000_000, tip, 3));
  if (kioskTx) {
    const t = await rawTx(kioskTx.digest);
    for (const i of t.inputs) if (i.kind === "SHARED") ids.set(normAddr(i.objectId), `shared input of kiosk::list ${kioskTx.digest.slice(0, 8)}`);
  }
  const idList = [...ids.entries()];
  const chosen = [];
  for (const prefix of ["package", "shared", "owned", "address-balance"]) {
    const c = pick(idList.filter(([id, w]) => w.startsWith(prefix) && !chosen.some(([x]) => x === id)));
    if (c) chosen.push(c);
  }
  const kiosk = idList.filter(([, w]) => w.includes("kiosk::list"));
  chosen.push(...kiosk.slice(0, 2));
  while (chosen.length < Math.min(idList.length, N) ) {
    const c = pick(idList.filter(([id]) => !chosen.some(([x]) => x === id)));
    if (!c) break;
    chosen.push(c);
  }
  for (const [id, why] of chosen) {
    console.log(` - ${id} (${why})`);
    const exists = await checkIdentify(id, why);
    if (exists) await checkObject(id, why);
  }

  // Holders of coins seen moving in the sample.
  console.log("\nholders");
  const coinTypes = [...new Set(txs.flatMap((s) => (s.raw?.changes ?? []).map((c) => c.coin)).filter((c) => !isSui(c)))];
  for (let i = 0; i < 2 && coinTypes.length; i++) {
    const c = coinTypes.splice(Math.floor(rand() * coinTypes.length), 1)[0];
    console.log(` - ${c}`);
    await checkHolders(c);
  }

  // Bridge exits.
  console.log("\nbridge exits");
  for (let i = 0; i < 2; i++) await checkBridge(tip);
} catch (err) {
  console.log(`\n!! the probe stopped: ${err?.stack ?? err}`);
  check("the probe runs to the end", false, { seed: SEED, got: String(err?.message ?? err) });
} finally {
  server.stop();
}

// ---- report ----------------------------------------------------------------
const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n${"=".repeat(78)}\ninvariant-pass  seed=${SEED}  n=${N}  ${secs}s  ${timings.length} tool calls`);
const slow = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 3);
console.log(`slowest calls: ${slow.map((s) => `${s.tool} ${(s.ms / 1000).toFixed(1)}s`).join(", ")}`);
console.log(`\n${"pass".padStart(5)} ${"fail".padStart(5)} ${"skip".padStart(5)}  invariant`);
let failures = 0;
for (const [name, r] of INVARIANTS) {
  console.log(`${String(r.pass).padStart(5)} ${String(r.fail).padStart(5)} ${String(r.skip).padStart(5)}  ${name}`);
  if (r.skip) console.log(`${" ".repeat(19)}skipped: ${[...new Set(r.skips)].join("; ")}`);
  failures += r.fail;
}
if (failures) {
  console.log(`\n${failures} FAILURE(S), seed ${SEED}:`);
  for (const [name, r] of INVARIANTS) {
    for (const f of r.failures) console.log(`\n  [${name}]\n    ${short(f, 1500)}`);
  }
  exitCode = 1;
} else console.log("\nevery invariant held");
process.exitCode = exitCode;
