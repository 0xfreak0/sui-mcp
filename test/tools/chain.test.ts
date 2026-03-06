import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
const mockArchive = createMockClient();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockArchive,
}));

// Must import after mock setup
const { registerChainTools } = await import("../../src/tools/chain.js");

// Capture registered tool handlers
const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerChainTools(mockServer);

describe("get_chain_info", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns current chain info when no epoch specified", async () => {
    mockSui.ledgerService.getServiceInfo.mockResolvedValue({
      response: {
        chainId: "35834a8a",
        chain: "mainnet",
        epoch: 500n,
        checkpointHeight: 100000n,
        timestamp: { seconds: 1700000000n, nanos: 0 },
        lowestAvailableCheckpoint: 0n,
        lowestAvailableCheckpointObjects: 0n,
        server: "sui-node/1.0",
      },
    });

    const handler = tools.get("get_chain_info")!;
    const result = await handler({ epoch: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(data.chain_id).toBe("35834a8a");
    expect(data.chain).toBe("mainnet");
    expect(data.epoch).toBe("500");
    expect(data.checkpoint_height).toBe("100000");
    expect(data.timestamp).toBe("2023-11-14T22:13:20.000Z");
  });

  it("queries specific epoch with archive fallback", async () => {
    mockSui.ledgerService.getEpoch.mockRejectedValue(new Error("not found"));
    mockArchive.ledgerService.getEpoch.mockResolvedValue({
      response: {
        epoch: {
          epoch: 100n,
          firstCheckpoint: 5000n,
          lastCheckpoint: 6000n,
          start: { seconds: 1690000000n, nanos: 0 },
          end: { seconds: 1690100000n, nanos: 0 },
          referenceGasPrice: 750n,
          protocolConfig: { protocolVersion: 42n },
        },
      },
    });

    const handler = tools.get("get_chain_info")!;
    const result = await handler({ epoch: "100" });
    const data = JSON.parse(result.content[0].text);

    expect(data.epoch).toBe("100");
    expect(data.first_checkpoint).toBe("5000");
    expect(data.last_checkpoint).toBe("6000");
    expect(data.reference_gas_price).toBe("750");
    expect(data.protocol_version).toBe("42");
    expect(mockArchive.ledgerService.getEpoch).toHaveBeenCalled();
  });
});

describe("get_checkpoint", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns latest checkpoint when no args", async () => {
    mockSui.ledgerService.getCheckpoint.mockResolvedValue({
      response: {
        checkpoint: {
          sequenceNumber: 99999n,
          digest: "Abc123",
          summary: {
            epoch: 500n,
            timestamp: { seconds: 1700000000n, nanos: 0 },
            totalNetworkTransactions: 5000000n,
            previousDigest: "Xyz789",
          },
        },
      },
    });

    const handler = tools.get("get_checkpoint")!;
    const result = await handler({ sequence_number: undefined, digest: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(data.sequence_number).toBe("99999");
    expect(data.digest).toBe("Abc123");
    expect(data.epoch).toBe("500");
    expect(data.total_network_transactions).toBe("5000000");
  });

  it("fetches by sequence number with archive fallback", async () => {
    mockSui.ledgerService.getCheckpoint.mockRejectedValue(new Error("pruned"));
    mockArchive.ledgerService.getCheckpoint.mockResolvedValue({
      response: {
        checkpoint: {
          sequenceNumber: 100n,
          digest: "OldDigest",
          summary: {
            epoch: 10n,
            timestamp: { seconds: 1680000000n, nanos: 0 },
            totalNetworkTransactions: 1000n,
            previousDigest: "PrevDigest",
          },
        },
      },
    });

    const handler = tools.get("get_checkpoint")!;
    const result = await handler({ sequence_number: "100", digest: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(data.sequence_number).toBe("100");
    expect(mockArchive.ledgerService.getCheckpoint).toHaveBeenCalled();
  });

  it("fetches by digest", async () => {
    mockSui.ledgerService.getCheckpoint.mockResolvedValue({
      response: {
        checkpoint: {
          sequenceNumber: 500n,
          digest: "TargetDigest",
          summary: {
            epoch: 50n,
            timestamp: { seconds: 1695000000n, nanos: 0 },
            totalNetworkTransactions: 50000n,
          },
        },
      },
    });

    const handler = tools.get("get_checkpoint")!;
    const result = await handler({ sequence_number: undefined, digest: "TargetDigest" });
    const data = JSON.parse(result.content[0].text);

    expect(data.digest).toBe("TargetDigest");
    expect(data.sequence_number).toBe("500");
  });
});
