import { SuiGrpcClient } from "@mysten/sui/grpc";

const sui = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io" });
const enc = (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : typeof v === "bigint" ? v.toString() : v);

const { response: latest } = await sui.ledgerService.getCheckpoint({
  checkpointId: { oneofKind: undefined },
  readMask: { paths: ["sequence_number", "digest"] },
});
const seq = latest.checkpoint.sequenceNumber;
console.log("latest checkpoint", seq);

const schemes = new Map();
let total = 0;
const multisigHits = [];
const N = Number(process.env.N ?? 20);

for (let i = 0n; i < BigInt(N); i++) {
  const { response: cp } = await sui.ledgerService.getCheckpoint({
    checkpointId: { oneofKind: "sequenceNumber", sequenceNumber: seq - i },
    readMask: { paths: ["sequence_number", "transactions.digest", "transactions.signatures", "transactions.transaction.sender"] },
  });
  for (const tx of cp.checkpoint.transactions ?? []) {
    for (const s of tx.signatures ?? []) {
      total++;
      const k = `${s.scheme}/${s.signature?.oneofKind}`;
      schemes.set(k, (schemes.get(k) ?? 0) + 1);
      if (s.signature?.oneofKind === "multisig") {
        multisigHits.push({ digest: tx.digest, sender: tx.transaction?.sender, ms: s.signature.multisig });
      }
    }
  }
}
console.log("checkpoints scanned", N, "total signatures", total);
console.log([...schemes.entries()]);
console.log("multisig hits", multisigHits.length);
for (const h of multisigHits.slice(0, 3)) {
  console.log("---- digest", h.digest, "sender", h.sender);
  console.log(JSON.stringify(h.ms, enc, 2));
}
