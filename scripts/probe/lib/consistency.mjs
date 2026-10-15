/* Compare only facts with the same scope. Coin amounts are raw integer units. */
export const norm = (id) => id?.replace(/0x[0-9a-fA-F]+(?=::|$)/g, (part) => `0x${part.slice(2).toLowerCase().padStart(64, "0")}`);
export const sorted = (values) => [...values].sort();
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const coinChanges = (rows) => sorted(rows.map((b) => `${norm(b.address)}|${norm(b.coin_type)}|${BigInt(b.amount)}`));
export const firstHop = (result) => {
 const step = result.first_hop ?? result.chain?.[0];
 return step ? { funder: step.funded_by ?? result.first_funder, digest: step.funding_tx ?? null } : null;
};
export const fundingAgreement = (single, batch, edges, address) => {
 const row = batch.results?.find((r) => r.address === address);
 if (!row) return { unavailable: "batch has no row for seed" };
 const edge = edges.first_funders?.[address];
 // The shared cluster budget can stop before the seed is measured. Missing is
 // not equivalent to an affirmative finding that no first funder exists.
 if (edges.truncated && edge === undefined) return { unavailable: "cluster funding read incomplete" };
 return { single: firstHop(single), batch: firstHop(row), edge: edge ?? null };
};
export const custodyRows = (rows) => sorted((rows ?? []).map((row) =>
 JSON.stringify({
  id: norm(row.object_id), type: row.type, kind: row.kind,
  category: row.category, from: row.from ? { kind: row.from.kind, address: norm(row.from.address) } : null,
  to: row.to ? { kind: row.to.kind, address: norm(row.to.address) } : null
 })));

export const transactionAgreement = (single, batch) => ({
 single: { sender: norm(single.sender), status: single.status, checkpoint: String(single.checkpoint), balances: coinChanges(single.balance_changes ?? []) },
 batch: { sender: norm(batch.sender), status: batch.status, checkpoint: String(batch.checkpoint), balances: coinChanges(batch.balance_changes ?? []) },
});
export const rawNet = (rows) => {
 const net = new Map();
 for (const row of rows) for (const item of row.subject_flow ?? []) {
  const type = norm(item.raw_type);
  if (!type) continue;
  net.set(type, (net.get(type) ?? 0n) + BigInt(item.amount));
 }
 return Object.fromEntries([...net].map(([coin, amount]) => [coin, String(amount)]).sort());
};

/**
 * A SUI figure printed as a JS number (`summarize_address_flows` gas) back to
 * signed MIST. Net gas is negative when rebates exceed costs, and a figure
 * under 1e-6 prints in exponent form, so string splitting is not exact.
 */
export function suiToMist(sui) {
 const n = Number(sui);
 if (!Number.isFinite(n) || Math.abs(n) * 1e9 > Number.MAX_SAFE_INTEGER) throw Error(`not an exact SUI figure: ${sui}`);
 return BigInt(Math.round(n * 1e9));
}

/** `package::module::function` of each MoveCall in a fully listed decode_ptb page, in order. */
export function moveCallTargets(commands) {
 return commands.filter((c) => c.type === "MoveCall").map((c) => norm(c.target));
}

/** An external credit needs no gas adjustment when the subject did not pay gas. */
export function externalCredits(rows, subject) {
 const credits = new Map();
 for (const row of rows) {
  if (norm(row.sender) === norm(subject) || norm(row.gas_payer) === norm(subject)) continue;
  for (const item of row.subject_flow ?? []) {
   const amount = BigInt(item.amount);
   if (amount <= 0n) continue;
   const coin = norm(item.raw_type);
   credits.set(coin, (credits.get(coin) ?? 0n) + amount);
  }
 }
 return Object.fromEntries([...credits].map(([coin, amount]) => [coin, String(amount)]).sort());
}

export function attributedCredits(sources) {
 const credits = new Map();
 for (const source of sources) for (const item of source.coins ?? []) {
  const coin = norm(item.coin_type);
  credits.set(coin, (credits.get(coin) ?? 0n) + BigInt(item.raw.in));
 }
 return Object.fromEntries([...credits].map(([coin, amount]) => [coin, String(amount)]).sort());
}

/** Root outflows are comparable to the flow scan only for direct coin sends. */
export function directRootOut(graph, address) {
 const root = graph.nodes?.find((n) => n.address === address && n.depth === 0);
 if (!root || graph.coverage?.partial || graph.coverage?.branches_pruned) return null;
 const edges = graph.edges?.filter((e) => e.from === root.id) ?? [];
 if (edges.some((e) => e.basis !== "direct" || !e.coin_type)) return null;
 const amounts = new Map();
 for (const e of edges) {
  const coin = norm(e.coin_type);
  amounts.set(coin, (amounts.get(coin) ?? 0n) + BigInt(e.amount));
 }
 return Object.fromEntries([...amounts].map(([coin, n]) => [coin, n.toString()]).sort());
}
