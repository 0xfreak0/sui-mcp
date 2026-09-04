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

  it("names the protocol behind an upgraded package via its lineage", async () => {
    // The investigative case: someone pastes the ID of a live package version
    // that predates the last registry curation. Cetus v12 is not in
    // protocols.json; its root is, so the lineage tier identifies it — and the
    // root comes from getPackage's own response, costing no extra round trip.
    const CETUS_V12 = "0x75b2e9ecad34944b8d0c874e568c90db0cf9437f0d7392abfd4cb902972f3e40";
    const CETUS_ROOT = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: CETUS_V12,
          objectType: "package",
          owner: { kind: GrpcTypes.Owner_OwnerKind.IMMUTABLE },
        },
      },
    });
    mockSui.movePackageService.getPackage.mockResolvedValue({
      response: {
        package: { originalId: CETUS_ROOT, version: 12n, modules: [{ name: "pool" }] },
      },
    });
    mockGqlQuery.mockResolvedValue({
      packageVersions: { nodes: [{ address: "0xnewer", version: 16 }] },
    });

    const handler = tools.get("identify_address")!;
    const data = JSON.parse((await handler({ address: CETUS_V12 })).content[0].text);

    expect(data.protocol).toEqual({ name: "Cetus", type: "dex", identified_via: "lineage" });
    expect(data.lineage).toMatchObject({
      root_package_id: CETUS_ROOT,
      version: 12,
      latest_version: 16,
      latest_package_id: "0xnewer",
      is_latest: false,
    });
  });

  it("reports a package as current when it is the newest version", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: { objectId: "0xpkg", objectType: "package", owner: { kind: GrpcTypes.Owner_OwnerKind.IMMUTABLE } },
      },
    });
    mockSui.movePackageService.getPackage.mockResolvedValue({
      response: { package: { originalId: "0xroot", version: 3n, modules: [] } },
    });
    mockGqlQuery.mockResolvedValue({
      packageVersions: { nodes: [{ address: "0xpkg", version: 3 }] },
    });

    const handler = tools.get("identify_address")!;
    const data = JSON.parse((await handler({ address: "0xpkg" })).content[0].text);

    expect(data.lineage.is_latest).toBe(true);
    expect(data.protocol).toBeNull();
  });

  it("still identifies the package when the lineage query fails", async () => {
    // Version metadata is a nicety; the module list is the answer. A GraphQL
    // outage must not turn a working identification into an error.
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: { objectId: "0xpkg", objectType: "package", owner: { kind: GrpcTypes.Owner_OwnerKind.IMMUTABLE } },
      },
    });
    mockSui.movePackageService.getPackage.mockResolvedValue({
      response: { package: { originalId: "0xroot", version: 2n, modules: [{ name: "m" }] } },
    });
    mockGqlQuery.mockRejectedValue(new Error("502"));

    const handler = tools.get("identify_address")!;
    const data = JSON.parse((await handler({ address: "0xpkg" })).content[0].text);

    expect(data.type).toBe("package");
    expect(data.module_count).toBe(1);
    expect(data.lineage).toMatchObject({ root_package_id: "0xroot", version: 2 });
    expect(data.lineage.latest_version).toBeNull();
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
          activeValidators: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
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
            pageInfo: { hasNextPage: false, endCursor: null },
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
