/** What does a real mainnet failure actually carry? */
import { SuiGrpcClient } from "@mysten/sui/grpc";
const sui = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io" });
const enc = (k,v)=> v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v==='bigint'? v.toString(): v;

const { response: latest } = await sui.ledgerService.getCheckpoint({
  checkpointId:{oneofKind:undefined}, readMask:{paths:["sequence_number"]} });
const seq = latest.checkpoint.sequenceNumber;

const failures = [];
for (let i=0n; i<25n && failures.length<6; i++) {
  try {
    const { response: cp } = await sui.ledgerService.getCheckpoint({
      checkpointId:{oneofKind:"sequenceNumber",sequenceNumber:seq-i},
      readMask:{paths:["transactions.digest","transactions.effects","transactions.transaction"]} });
    for (const tx of cp.checkpoint.transactions ?? []) {
      const st = tx.effects?.status;
      if (st && st.success === false) failures.push({ digest: tx.digest, status: st });
    }
  } catch {}
}
console.log("failed txs found:", failures.length);
for (const f of failures.slice(0,4)) {
  console.log("\n--- " + f.digest);
  console.log(JSON.stringify(f.status, enc, 1));
}
