import { SuiGrpcClient } from "@mysten/sui/grpc";

export const sui = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io",
});

export const archive = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://archive.mainnet.sui.io",
});
