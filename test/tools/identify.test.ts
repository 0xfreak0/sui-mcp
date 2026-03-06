import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import { GrpcTypes } from "@mysten/sui/grpc";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockSui,
}));

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: mockGqlQuery,
}));

const { registerIdentifyTools } = await import("../../src/tools/identify.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerIdentifyTools(mockServer);

describe("identify_address", () => {
  beforeEach(() => vi.clearAllMocks());

  it("identifies a Move package", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xpkg",
          objectType: "package",
          owner: { kind: GrpcTypes.Owner_OwnerKind.IMMUTABLE },
        },
      },
    });
    mockSui.movePackageService.getPackage.mockResolvedValue({
      response: {
        package: {
          modules: [
            { name: "module_a" },
            { name: "module_b" },
          ],
        },
      },
    });

    const handler = tools.get("identify_address")!;
    const result = await handler({ address: "0xpkg" });
    const data = JSON.parse(result.content[0].text);

    expect(data.type).toBe("package");
    expect(data.module_count).toBe(2);
    expect(data.modules).toContain("module_a");
    expect(data.modules).toContain("module_b");
  });

  it("identifies a shared object", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xshared",
          objectType: "0xdex::pool::Pool<0x2::sui::SUI, 0xusdc::USDC>",
          owner: { kind: GrpcTypes.Owner_OwnerKind.SHARED, version: 1n },
          version: 100n,
        },
      },
    });

    const handler = tools.get("identify_address")!;
    const result = await handler({ address: "0xshared" });
    const data = JSON.parse(result.content[0].text);

    expect(data.type).toBe("shared_object");
    expect(data.object_type).toContain("Pool");
  });

  it("identifies a wallet address", async () => {
    // No object found at this address
    mockSui.ledgerService.getObject.mockRejectedValue(new Error("not found"));

    // Not a validator
    mockGqlQuery.mockResolvedValue({
      epoch: {
        validatorSet: {
          activeValidators: { nodes: [] },
        },
      },
    });

    // Wallet data
    mockSui.getBalance.mockResolvedValue({
      balance: { coinType: "0x2::sui::SUI", balance: "5000000000" },
    });
    mockSui.nameService.reverseLookupName.mockResolvedValue({
      response: { record: { name: "alice.sui" } },
    });
    mockSui.listBalances.mockResolvedValue({
      balances: [
        { coinType: "0x2::sui::SUI", balance: "5000000000" },
        { coinType: "0xusdc::USDC", balance: "1000000" },
        { coinType: "0xempty::TOKEN", balance: "0" },
      ],
    });

    const handler = tools.get("identify_address")!;
    const result = await handler({ address: "0xwallet" });
    const data = JSON.parse(result.content[0].text);

    expect(data.type).toBe("wallet");
    expect(data.sui_name).toBe("alice.sui");
    expect(data.sui_balance).toBe("5000000000");
    expect(data.token_count).toBe(2); // only non-zero
  });

  it("identifies a validator", async () => {
    // Not an object
    mockSui.ledgerService.getObject.mockRejectedValue(new Error("not found"));

    // Is a validator
    mockGqlQuery.mockResolvedValue({
      epoch: {
        validatorSet: {
          activeValidators: {
            nodes: [
              {
                contents: {
                  json: {
                    metadata: { sui_address: "0xval", name: "Big Validator" },
                    staking_pool: { sui_balance: "9000000000000" },
                    commission_rate: "200",
                  },
                },
              },
            ],
          },
        },
      },
    });

    const handler = tools.get("identify_address")!;
    const result = await handler({ address: "0xval" });
    const data = JSON.parse(result.content[0].text);

    expect(data.type).toBe("validator");
    expect(data.name).toBe("Big Validator");
    expect(data.staking_pool_sui_balance).toBe("9000000000000");
  });
});
