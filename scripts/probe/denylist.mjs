/** Is the runtime DenyList (0x403) readable, and what's in it? */
import { SuiGrpcClient } from "@mysten/sui/grpc";
const sui = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io" });
const enc=(k,v)=> v instanceof Uint8Array? Buffer.from(v).toString('base64'): typeof v==='bigint'? v.toString(): v;
try {
  const { response } = await sui.ledgerService.getObject({
    objectId: "0x0000000000000000000000000000000000000000000000000000000000000403",
    readMask: { paths: ["object_id","version","object_type","owner","json"] },
  });
  const o = response.object;
  console.log("type:", o?.objectType);
  console.log("owner:", JSON.stringify(o?.owner, enc));
  console.log("version:", o?.version);
  console.log("json:", JSON.stringify(o?.json, enc, 1).slice(0, 900));
} catch (e) { console.log("ERR:", e.message.slice(0,200)); }
