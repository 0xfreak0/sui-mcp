import { SuiGrpcClient } from "@mysten/sui/grpc";
import { isVerifiedCoin } from "../../dist/utils/coin-registry.js";
const sui=new SuiGrpcClient({network:"mainnet",baseUrl:"https://fullnode.mainnet.sui.io"});
const {response:latest}=await sui.ledgerService.getCheckpoint({checkpointId:{oneofKind:undefined},readMask:{paths:["sequence_number"]}});
const seq=latest.checkpoint.sequenceNumber;
let scanned=0; const coins=new Set();
outer: for (let i=0n;i<120n;i++){
  const {response:cp}=await sui.ledgerService.getCheckpoint({
    checkpointId:{oneofKind:"sequenceNumber",sequenceNumber:seq-i},
    readMask:{paths:["transactions.digest","transactions.balance_changes"]}});
  for (const tx of cp.checkpoint.transactions ?? []) {
    for (const bc of tx.balanceChanges ?? []) {
      const t=bc.coinType; if(!t||!t.includes("::")) continue; scanned++; coins.add(t);
      if (!isVerifiedCoin(t)) { console.log("digest:",tx.digest); console.log("coin  :",t); break outer; }
    }
  }
}
console.log('scanned balance changes:',scanned,'| distinct coins:',coins.size);
console.log('unverified among them:',[...coins].filter(c=>!isVerifiedCoin(c)).length);
