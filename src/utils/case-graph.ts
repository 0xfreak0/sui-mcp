/**
 * A case's findings as a fund-flow graph: the transfers inside the
 * transactions its findings cite, between the addresses they name, plus a
 * dashed link from each finding's Sui addresses to the accounts it names on
 * other chains (a bridge beneficiary, a destination wallet). Pure: the caller
 * reads the transactions.
 */

import { chainDisplayName } from "./chain-id.js";
import { splitReference } from "./case-report.js";
import { shortAddress, type ExportGraph } from "./flow-export.js";
import { sameCoin, withoutGas, type GasCharge, type HopChange } from "./trace-hop.js";
import type { Finding } from "./store.js";

/** What the graph needs of one transaction. */
export interface CaseTx {
  digest: string;
  sender: string | null;
  timestamp: string | null;
  changes: HopChange[];
  gas: GasCharge;
  /** Bridge protocols the transaction's calls or events matched, when it is an exit. */
  bridges?: string[];
}

export interface CaseGraphOptions {
  /** Display name for a Sui address (label or SuiNS), when one is known. */
  nameOf?: (address: string) => string | undefined;
  /** Amount with its symbol, for edge labels. */
  formatAmount?: (raw: bigint, coinType: string) => string;
}

/**
 * Transfers in `txs` where the payer or the recipient is one of the case's Sui
 * addresses, each recipient paired with the largest payer of that coin in the
 * same transaction. Gas is removed first, so paying for a transaction is not a
 * transfer.
 */
export function buildCaseGraph(findings: Finding[], txs: CaseTx[], opts: CaseGraphOptions = {}): ExportGraph {
  const g: ExportGraph = { directed: true, nodes: [], edges: [] };
  const seen = new Set<string>();
  const sui = new Set<string>();
  const addNode = (id: string, chain: string | null, address: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const onSui = chain === null || chain.startsWith("sui:");
    const name = onSui ? opts.nameOf?.(address) : undefined;
    const label = onSui
      ? name
        ? [name, shortAddress(address)]
        : [shortAddress(address)]
      : [`${chain ? chainDisplayName(chain) : "unknown chain"} ${shortAddress(address)}`];
    g.nodes.push({ id, label, kind: onSui ? "wallet" : "foreign", attrs: { address, ...(chain ? { chain } : {}) } });
  };

  for (const f of findings) {
    for (const ref of f.addresses) {
      const { chain, address } = splitReference(ref);
      const onSui = chain === null || chain.startsWith("sui:");
      if (onSui) sui.add(address);
      addNode(onSui ? address : `${chain}:${address}`, chain, address);
    }
  }

  const fmt = opts.formatAmount ?? ((raw: bigint) => raw.toString());
  const merged = new Map<string, { from: string; to: string; coin: string; amount: bigint; digests: string[] }>();
  for (const tx of txs) {
    const cs = withoutGas(tx.changes, tx.gas);
    for (const r of cs) {
      if (BigInt(r.amount) <= 0n) continue;
      let payer: HopChange | null = null;
      for (const c of cs) {
        if (c.address === r.address || !sameCoin(c.coin_type, r.coin_type) || BigInt(c.amount) >= 0n) continue;
        if (!payer || BigInt(c.amount) < BigInt(payer.amount)) payer = c;
      }
      if (!payer || !(sui.has(payer.address) || sui.has(r.address))) continue;
      const key = `${payer.address}>${r.address}>${r.coin_type}`;
      const m = merged.get(key) ?? { from: payer.address, to: r.address, coin: r.coin_type, amount: 0n, digests: [] };
      m.amount += BigInt(r.amount);
      if (!m.digests.includes(tx.digest)) m.digests.push(tx.digest);
      merged.set(key, m);
    }
  }
  // A bridge exit burns or locks the coin, so no recipient shows it: what
  // the sender paid beyond what other addresses received goes to an exit node.
  for (const tx of txs) {
    if (!tx.bridges?.length || !tx.sender || !sui.has(tx.sender)) continue;
    const id = `exit:${tx.digest}`;
    const cs = withoutGas(tx.changes, tx.gas);
    for (const c of cs) {
      if (c.address !== tx.sender || BigInt(c.amount) >= 0n) continue;
      const received = cs
        .filter((o) => o.address !== tx.sender && sameCoin(o.coin_type, c.coin_type) && BigInt(o.amount) > 0n)
        .reduce((sum, o) => sum + BigInt(o.amount), 0n);
      const burned = -BigInt(c.amount) - received;
      if (burned <= 0n) continue;
      if (!seen.has(id)) {
        seen.add(id);
        g.nodes.push({ id, label: [`${tx.bridges.join(" + ")} exit`, `${tx.digest.slice(0, 10)}…`], kind: "bridge_exit", attrs: { digest: tx.digest } });
      }
      const key = `${tx.sender}>${id}>${c.coin_type}`;
      const m = merged.get(key) ?? { from: tx.sender, to: id, coin: c.coin_type, amount: 0n, digests: [tx.digest] };
      m.amount += burned;
      merged.set(key, m);
    }
  }
  for (const m of merged.values()) {
    addNode(m.from, null, m.from);
    if (!m.to.startsWith("exit:")) addNode(m.to, null, m.to);
    g.edges.push({
      from: m.from,
      to: m.to,
      label: `${fmt(m.amount, m.coin)}${m.digests.length > 1 ? `, ${m.digests.length} txs` : ""}`,
      attrs: { coin_type: m.coin, amount: m.amount.toString(), digests: m.digests },
    });
  }

  // A finding that names accounts on two chains is a recorded cross-chain
  // link; it is drawn dashed because the finding asserts it, not a transfer
  // read here.
  for (const f of findings) {
    const refs = f.addresses.map(splitReference);
    const here = refs.filter((r) => r.chain === null || r.chain.startsWith("sui:"));
    const there = refs.filter((r) => r.chain !== null && !r.chain.startsWith("sui:"));
    const title = f.title.length > 40 ? `${f.title.slice(0, 39)}…` : f.title;
    for (const a of here) {
      for (const b of there) {
        g.edges.push({
          from: a.address,
          to: `${b.chain}:${b.address}`,
          label: `finding ${f.id ?? "?"}: ${title}`,
          dashed: true,
          attrs: { finding: f.id, evidence_tier: f.evidence_tier },
        });
      }
    }
  }
  return g;
}
