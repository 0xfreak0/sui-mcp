/** Can we attribute a package to the address that published it? */
import { SuiGrpcClient } from "@mysten/sui/grpc";
const sui = new SuiGrpcClient({ network:"mainnet", baseUrl:"https://fullnode.mainnet.sui.io" });
// An obfuscated package seen aborting in the failed-tx probe.
for (const pkg of ["0xc72126457c84430ad439c8daf19679cfe87c84fc70912ba9b1df3060b64a5c50",
                   "0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a"]) {
  const { response } = await sui.ledgerService.getObject({
    objectId: pkg, readMask:{ paths:["object_id","version","previous_transaction","owner","object_type"] } });
  const prev = response.object?.previousTransaction;
  console.log(`\npackage ${pkg.slice(0,16)}…  version=${response.object?.version}  prevTx=${prev?.slice(0,20)}…`);
  if (!prev) continue;
  const { response: tx } = await sui.ledgerService.getTransaction({
    digest: prev, readMask:{ paths:["transaction","timestamp"] } });
  const kind = tx.transaction?.transaction?.kind;
  console.log("   sender:", tx.transaction?.transaction?.sender);
  console.log("   kind  :", kind?.data?.oneofKind);
}
