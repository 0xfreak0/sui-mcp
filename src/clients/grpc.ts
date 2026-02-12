import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";

export const sui = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io",
});

// Archive serves native gRPC (not gRPC-Web), so we use GrpcTransport
// instead of the default GrpcWebFetchTransport.
const archiveTransport = new GrpcTransport({
  host: "archive.mainnet.sui.io:443",
  channelCredentials: ChannelCredentials.createSsl(),
});

export const archive = new SuiGrpcClient({
  network: "mainnet",
  transport: archiveTransport,
});
