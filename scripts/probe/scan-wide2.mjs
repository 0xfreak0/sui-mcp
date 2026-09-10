import { SuiGrpcClient } from "@mysten/sui/grpc";
import fs from "node:fs";
const sui = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io" });
const { response: latest } = await sui.ledgerService.getCheckpoint({ checkpointId:{oneofKind:undefined}, readMask:{paths:["sequence_number"]} });
const seq = latest.checkpoint.sequenceNumber;
const N = BigInt(process.env.N ?? 4000), CONC = Number(process.env.CONC ?? 8);
let txs=0, sigs=0, idx=0n, ok=0, fail=0; const hits=[]; const errs=new Map();
async function one(i){
  for (let attempt=0; attempt<3; attempt++) {
    try{
      const { response: cp } = await sui.ledgerService.getCheckpoint({ checkpointId:{oneofKind:"sequenceNumber",sequenceNumber:seq-i}, readMask:{paths:["transactions.digest","transactions.signatures","transactions.transaction.sender"]} });
      ok++;
      for(const tx of cp.checkpoint.transactions ?? []){ txs++;
        for(const s of tx.signatures ?? []){ sigs++;
          if(s.signature?.oneofKind==="multisig"){ const m=s.signature.multisig; hits.push({digest:tx.digest,sender:tx.transaction?.sender,threshold:m.committee?.threshold,bitmap:m.bitmap,legacy:!!(m.legacyBitmap&&m.legacyBitmap.length),members:(m.committee?.members??[]).map(x=>({scheme:x.publicKey?.scheme,weight:x.weight,zk:!!x.publicKey?.zklogin,pk:x.publicKey?.publicKey?Buffer.from(x.publicKey.publicKey).toString("base64"):null,iss:x.publicKey?.zklogin?.iss??null}))}); } } }
      return;
    }catch(e){ if(attempt===2){ fail++; const k=String(e?.message??e).slice(0,60); errs.set(k,(errs.get(k)??0)+1);} }
  }
}
await Promise.all(Array.from({length:CONC},async()=>{ while(idx<N){ const i=idx++; await one(i);} }));
console.log("checkpoints requested",N.toString(),"ok",ok,"failed",fail,"txs",txs,"sigs",sigs);
console.log("errors:",[...errs.entries()]);
console.log("multisig sigs",hits.length,"distinct senders",new Set(hits.map(h=>h.sender)).size);
fs.writeFileSync("scripts/probe/multisig-hits.json", JSON.stringify(hits,null,1));
const shapes=new Map();
for(const h of hits){ const k=`t=${h.threshold} weights=[${h.members.map(m=>m.weight).join(",")}] schemes=[${h.members.map(m=>m.zk?"zk:"+m.iss:m.scheme).join(",")}] legacy=${h.legacy}`; shapes.set(k,(shapes.get(k)??0)+1); }
for(const [k,n] of [...shapes.entries()].sort((a,b)=>b[1]-a[1])) console.log("  ",n,k);
