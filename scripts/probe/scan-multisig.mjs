import { SuiGrpcClient } from "@mysten/sui/grpc";
const sui = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io" });
const enc = (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : typeof v === "bigint" ? v.toString() : v);

const { response: latest } = await sui.ledgerService.getCheckpoint({
  checkpointId: { oneofKind: undefined }, readMask: { paths: ["sequence_number"] },
});
const seq = latest.checkpoint.sequenceNumber;
const N = BigInt(process.env.N ?? 400);
const CONC = 16;

const schemes = new Map();
let total = 0, txs = 0;
const hits = [];

async function one(i) {
  try {
    const { response: cp } = await sui.ledgerService.getCheckpoint({
      checkpointId: { oneofKind: "sequenceNumber", sequenceNumber: seq - i },
      readMask: { paths: ["transactions.digest", "transactions.signatures", "transactions.transaction.sender"] },
    });
    for (const tx of cp.checkpoint.transactions ?? []) {
      txs++;
      for (const s of tx.signatures ?? []) {
        total++;
        const k = String(s.scheme);
        schemes.set(k, (schemes.get(k) ?? 0) + 1);
        if (s.signature?.oneofKind === "multisig") hits.push({ digest: tx.digest, sender: tx.transaction?.sender, ms: s.signature.multisig });
      }
    }
  } catch (e) { /* skip */ }
}

let idx = 0n;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (idx < N) { const i = idx++; await one(i); }
}));

console.log("checkpoints", N.toString(), "txs", txs, "sigs", total);
console.log("schemes", [...schemes.entries()].sort());
console.log("multisig hits", hits.length);
const bySender = new Map();
for (const h of hits) bySender.set(h.sender, (bySender.get(h.sender) ?? 0) + 1);
console.log("distinct multisig senders", bySender.size, [...bySender.entries()].slice(0,10));
if (hits.length) console.log(JSON.stringify(hits[0], enc, 2));
