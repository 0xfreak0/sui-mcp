import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";
import { SUI_NETWORK, FULLNODE_URL, ARCHIVE_HOST } from "../config.js";

export const sui = new SuiGrpcClient({
  network: SUI_NETWORK,
  baseUrl: FULLNODE_URL,
});

// Archive serves native gRPC (not gRPC-Web), so we use GrpcTransport
// instead of the default GrpcWebFetchTransport.
// Archive is only available on mainnet.
export const archive: SuiGrpcClient = ARCHIVE_HOST
  ? new SuiGrpcClient({
      network: SUI_NETWORK,
      transport: new GrpcTransport({
        host: ARCHIVE_HOST,
        channelCredentials: ChannelCredentials.createSsl(),
      }),
    })
  : sui; // fallback to fullnode on networks without archive
