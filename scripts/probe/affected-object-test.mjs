import { SuiGrpcClient } from "@mysten/sui/grpc";
const sui=new SuiGrpcClient({network:"mainnet",baseUrl:"https://fullnode.mainnet.sui.io"});
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
// Grab an object touched in a very recent checkpoint.
const {response:latest}=await sui.ledgerService.getCheckpoint({checkpointId:{oneofKind:undefined},readMask:{paths:["sequence_number"]}});
const {response:cp}=await sui.ledgerService.getCheckpoint({
  checkpointId:{oneofKind:"sequenceNumber",sequenceNumber:latest.checkpoint.sequenceNumber-5n},
  readMask:{paths:["transactions.digest","transactions.effects"]}});
const tx=cp.checkpoint.transactions?.[0];
const changed=tx?.effects?.changedObjects?.[0]?.objectId;
console.log("recent tx:", tx?.digest, "\nchanged object:", changed);
for (const [label,id] of [["recent object",changed],
  ["an UpgradeCap","0x00002291352bf71d0522e82f7b5be95f6d351005fe4104d5debacf90b01acb1c"]]) {
  if(!id) continue;
  const r=await ask(`query($o:SuiAddress!){ transactions(filter:{affectedObject:$o}, first:5){ nodes{ digest } } }`,{o:id});
  console.log(`${label.padEnd(16)} affectedObject -> ${r.data?.transactions?.nodes?.length ?? "ERR"} tx(s)`, r.errors?JSON.stringify(r.errors[0].message).slice(0,80):"");
}
