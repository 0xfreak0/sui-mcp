import { SuiGrpcClient } from "@mysten/sui/grpc";
const sui = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io" });
const { response } = await sui.ledgerService.getTransaction({
  digest: "F2o6xiYX5CDquFcxsPNgtii4SSqH327keWhj7a1KfeTv",
  readMask: { paths: ["transaction", "signatures"] },
});
const t = response.transaction;
const kind = t.transaction?.kind;
console.log("sender:", t.transaction?.sender);
console.log("gas owner:", t.transaction?.gasPayment?.owner);
console.log("sig schemes:", t.signatures.map(s => `${s.scheme}/${s.signature?.oneofKind}`));
