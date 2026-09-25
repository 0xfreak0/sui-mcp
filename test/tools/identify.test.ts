import { describe, it, expect, vi, beforeEach } from "vitest";
import { grpcError, notFoundError } from "../helpers/service-shapes.js";
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

// Loaded after the mocks above: both import the grpc/graphql clients.
const { registerIdentifyTools } = await import("../../src/tools/identify.js");
const { registeredTools, unknownToolsIn } = await import("../helpers/tool-names.js");

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

  /**
   * The jupnet bridge Bank 0x44cf…4b4b holds ~118k USDC and ~764 SUI in its
   * own address balance and none of it among its fields. Identified as a
   * plain shared object, it pointed at get_object, which showed no funds.
   */
  it("lists funds a shared object holds in its own address balance", async () => {
    const BANK = "0x44cf357eda762cf0cd86547f7bfcaa51a4b55de615c57903ab461f38ffed4b4b";
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: BANK,
          objectType: "0x58978a0c0678f010ff0ced45da75bf76f2cc33b96508c9a616dc547651f78341::liquidity_pool::Bank",
          owner: { kind: GrpcTypes.Owner_OwnerKind.SHARED, version: 896326318n },
          version: 1019907195n,
        },
      },
    });
    mockSui.listBalances.mockResolvedValue({
      balances: [
        {
          coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
          balance: "763614393142",
          coinBalance: "0",
          addressBalance: "763614393142",
        },
        {
          coinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
          balance: "118304380703",
          coinBalance: "0",
          addressBalance: "118304380703",
        },
      ],
      hasNextPage: false,
      cursor: null,
    });

    const data = JSON.parse((await tools.get("identify_address")!({ address: BANK })).content[0].text);

    expect(mockSui.listBalances).toHaveBeenCalledWith(expect.objectContaining({ owner: BANK }));
    expect(data.type).toBe("shared_object");
    expect(data.address_balances).toEqual([
      {
        coin_type: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
        balance: "763614393142",
        formatted: "763.614393142 SUI",
      },
      {
        coin_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
        balance: "118304380703",
        formatted: "118304.380703 USDC",
      },
    ]);
    expect(data.address_balances_note).toMatch(/withdraw_funds_from_object/);
    expect(data.hint).toMatch(/not among those fields/);
  });

  /** An absent `address_balances` reads as "holds nothing", so a failed lookup is said. */
  it("says when an object's address balances could not be read", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xshared",
          objectType: "0xdex::pool::Pool",
          owner: { kind: GrpcTypes.Owner_OwnerKind.SHARED, version: 1n },
          version: 100n,
        },
      },
    });
    mockSui.listBalances.mockRejectedValue(grpcError("UNAVAILABLE"));

    const data = JSON.parse((await tools.get("identify_address")!({ address: "0xshared" })).content[0].text);

    expect(data.address_balances).toBeUndefined();
    expect(data.address_balances_error).toMatch(/Could not read/);
  });

  it("identifies a wallet address", async () => {
    // No object found at this address
    mockSui.ledgerService.getObject.mockRejectedValue(notFoundError());

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

  it("reports a SuiNS name another address sent the wallet as received, not as its own", async () => {
    // The Cetus attacker: 0x407fb974 sent it registration 0xb00a20b5 in
    // 2uE2WRav after validators froze the wallet. Node shape as mainnet returns it.
    const HOLDER = "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06";
    const SENDER = "0x407fb97400abc8f37defc658ab9c9f53a8953a1a446cd820561382fb3728ca20";
    mockSui.ledgerService.getObject.mockRejectedValue(notFoundError());
    mockSui.getBalance.mockResolvedValue({ balance: { coinType: "0x2::sui::SUI", balance: "50000000" } });
    mockSui.nameService.reverseLookupName.mockResolvedValue({ response: {} });
    mockSui.listBalances.mockResolvedValue({ balances: [] });
    mockGqlQuery.mockImplementation(async (q: string) => {
      if (String(q).includes("validatorSet")) {
        return {
          epoch: { validatorSet: { activeValidators: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
        };
      }
      if (String(q).includes("multiGetAddresses")) {
        return {
          multiGetAddresses: [
            {
              address: HOLDER,
              objects: {
                nodes: [
                  {
                    address: "0xb00a20b5e2fd72a27e9dc07e0e9e448f17c30ade559edb65432615e001069f6d",
                    contents: {
                      json: {
                        domain_name: "give-the-funds-back-you-maniac-yngmi.sui",
                        expiration_timestamp_ms: "1779832301904",
                      },
                    },
                    previousTransaction: {
                      digest: "2uE2WRavBRGLDwdvqNVmacytHdExqEmeoqdu4DgZzSCw",
                      sender: { address: SENDER },
                      effects: { timestamp: "2025-05-27T04:07:50.218Z" },
                    },
                  },
                ],
              },
            },
          ],
        };
      }
      if (String(q).includes("multiGetObjects")) return { multiGetObjects: [null] };
      return {};
    });

    const data = JSON.parse((await tools.get("identify_address")!({ address: HOLDER })).content[0].text);
    expect(data.names_held).toEqual([
      expect.objectContaining({
        name: "give-the-funds-back-you-maniac-yngmi.sui",
        provenance: "received_from_third_party",
        received_from: SENDER,
        last_tx: "2uE2WRavBRGLDwdvqNVmacytHdExqEmeoqdu4DgZzSCw",
      }),
    ]);
    expect(data.names_note).toContain(SENDER);
    expect(data.names_note).not.toMatch(/known by/);
  });

  it("identifies a validator", async () => {
    // Not an object
    mockSui.ledgerService.getObject.mockRejectedValue(notFoundError());

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
    // Raw MIST reads as nine trillion SUI; the unit travels with it.
    expect(data.staking_pool_sui_balance_formatted).toBe("9000 SUI");
    // The hint used to name get_validator_detail, which does not exist.
    const names = new Set(registeredTools().map((t) => t.name));
    expect(unknownToolsIn(data.hint, names)).toEqual([]);
  });
});

describe("identify_address error handling", () => {
  it("does not report a wallet when the object lookup fails for any other reason", async () => {
    // An outage must not read as "there is no object here". The CASE 4 reads
    // also swallow their errors, so the old code answered
    // `type: "wallet", sui_balance: "0"` for a package or a pool during an
    // outage — and this is the recommended first step, so a wrong answer
    // steers every tool call after it.
    mockSui.ledgerService.getObject.mockRejectedValue(grpcError("UNAVAILABLE"));
    const handler = tools.get("identify_address")!;
    const res = await handler({ address: "0xsomething" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not evidence the address is a wallet/i);
  });

  it("reports a failed balance, name or token read as unknown, not zero", async () => {
    mockSui.ledgerService.getObject.mockRejectedValue(notFoundError());
    mockGqlQuery.mockResolvedValue({
      epoch: {
        validatorSet: {
          activeValidators: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    });
    mockSui.getBalance.mockRejectedValue(grpcError("UNAVAILABLE"));
    mockSui.nameService.reverseLookupName.mockRejectedValue(grpcError("DEADLINE_EXCEEDED"));
    mockSui.listBalances.mockRejectedValue(grpcError("UNAVAILABLE"));

    const res = await tools.get("identify_address")!({ address: "0xwallet" });
    const data = JSON.parse(res.content[0].text);
    expect(data.type).toBe("wallet");
    expect(data.sui_balance).toBeNull();
    expect(data.sui_balance_unavailable).toMatch(/unknown, not zero/);
    expect(data.sui_name).toBeNull();
    expect(data.sui_name_unavailable).toMatch(/DEADLINE_EXCEEDED/);
    expect(data.token_count).toBeNull();
    expect(data.token_count_unavailable).toBeDefined();
  });

  it("does not flag a name lookup that found no name", async () => {
    mockSui.ledgerService.getObject.mockRejectedValue(notFoundError());
    mockGqlQuery.mockResolvedValue({
      epoch: {
        validatorSet: {
          activeValidators: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    });
    mockSui.getBalance.mockResolvedValue({ balance: { coinType: "0x2::sui::SUI", balance: "0" } });
    mockSui.nameService.reverseLookupName.mockRejectedValue(notFoundError("no name record"));
    mockSui.listBalances.mockResolvedValue({ balances: [] });

    const data = JSON.parse((await tools.get("identify_address")!({ address: "0xwallet" })).content[0].text);
    expect(data.sui_name).toBeNull();
    expect(data.sui_name_unavailable).toBeUndefined();
    expect(data.sui_balance).toBe("0");
    expect(data.sui_balance_unavailable).toBeUndefined();
  });
});
