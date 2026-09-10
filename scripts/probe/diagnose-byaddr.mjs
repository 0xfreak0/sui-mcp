import { SuiGrpcClient } from "@mysten/sui/grpc";
const sui=new SuiGrpcClient({network:"mainnet",baseUrl:"https://fullnode.mainnet.sui.io"});
const ADDR="0x0da83d0a41509fdc91bea1ee7a46d422179571ac4daa5e570c190218d868338b";
const COIN="0x20042e47b0169e3c411b053033a48144ba30fde68394c2ddc28b5522c2c42fc8::bluebirdy::BLUEBIRDY";
let cursor=null, all=[], pages=0;
do {
  const r=await sui.listBalances({owner:ADDR,limit:50,cursor});
  all.push(...(r.balances??[]));
  cursor=r.nextPageToken ?? null; pages++;
} while (cursor && pages<10);
const nonZero=all.filter(b=>b.balance!=="0");
console.log("total balance entries:", all.length, "| non-zero:", nonZero.length, "| pages:", pages);
const idx=nonZero.findIndex(b=>b.coinType===COIN);
console.log("BLUEBIRDY position among non-zero:", idx, idx>=0?`(balance ${nonZero[idx].balance})`:"(NOT HELD)");
console.log("the tool checks only the first 25 -> would", idx>=0&&idx<25?"find it":"MISS it");
