import { SuiGrpcClient } from "@mysten/sui/grpc";
const sui = new SuiGrpcClient({ network:"mainnet", baseUrl:"https://fullnode.mainnet.sui.io" });
const { response } = await sui.ledgerService.getEpoch({ epoch: undefined, readMask:{ paths:["epoch"] } });
console.log("current epoch:", response.epoch?.epoch);
console.log("entries seen had newer_value_epoch=566 -> active if current > 566");
