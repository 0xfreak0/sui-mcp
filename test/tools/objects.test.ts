import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import { GrpcTypes } from "@mysten/sui/grpc";

const mockSui = createMockClient();
const mockArchive = createMockClient();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockArchive,
}));

// The rendered Display is a GraphQL read; these objects have none.
const mockGqlQuery = createMockGraphql();
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerObjectTools } = await import("../../src/tools/objects.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerObjectTools(mockServer);

describe("get_object", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns object with content and display metadata", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xabc",
          version: 42n,
          digest: "objdigest",
          objectType: "0xnft::collection::NFT",
          owner: {
            kind: GrpcTypes.Owner_OwnerKind.ADDRESS,
            address: "0xowner",
          },
          previousTransaction: "0xtxdigest",
          storageRebate: 1000n,
          json: {
            kind: {
              oneofKind: "structValue",
              structValue: {
                fields: {
                  name: { kind: { oneofKind: "stringValue", stringValue: "Cool NFT #1" } },
                  description: { kind: { oneofKind: "stringValue", stringValue: "A cool NFT" } },
                  image_url: { kind: { oneofKind: "stringValue", stringValue: "https://example.com/nft.png" } },
                },
              },
            },
          },
          balance: undefined,
        },
      },
    });

    const handler = tools.get("get_object")!;
    const result = await handler({ object_id: "0xabc", version: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(data.object_id).toBe("0xabc");
    expect(data.version).toBe("42");
    expect(data.object_type).toBe("0xnft::collection::NFT");
    expect(data.owner).toBe("address:0xowner");
    expect(data.display).toBeDefined();
    expect(data.display.name).toBe("Cool NFT #1");
    expect(data.display.description).toBe("A cool NFT");
    expect(data.display.image_url).toBe("https://example.com/nft.png");
  });

  it("falls back to archive for historical version", async () => {
    mockSui.ledgerService.getObject.mockRejectedValue(new Error("pruned"));
    mockArchive.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xold",
          version: 5n,
          digest: "olddigest",
          objectType: "0x2::coin::Coin<0x2::sui::SUI>",
          owner: {
            kind: GrpcTypes.Owner_OwnerKind.ADDRESS,
            address: "0xowner2",
          },
          json: undefined,
          balance: 1000000000n,
        },
      },
    });

    const handler = tools.get("get_object")!;
    const result = await handler({ object_id: "0xold", version: "5" });
    const data = JSON.parse(result.content[0].text);

    expect(data.object_id).toBe("0xold");
    expect(data.balance).toBe("1000000000");
    expect(mockArchive.ledgerService.getObject).toHaveBeenCalled();
  });

  it("omits display when content has no display fields", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xplain",
          version: 1n,
          objectType: "0x2::coin::Coin<0x2::sui::SUI>",
          owner: { kind: GrpcTypes.Owner_OwnerKind.IMMUTABLE },
          json: {
            kind: {
              oneofKind: "structValue",
              structValue: {
                fields: {
                  balance: { kind: { oneofKind: "numberValue", numberValue: 100 } },
                },
              },
            },
          },
        },
      },
    });

    const handler = tools.get("get_object")!;
    const result = await handler({ object_id: "0xplain", version: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(data.display).toBeUndefined();
  });

  /**
   * The jupnet bridge Bank 0x44cf…4b4b holds ~118k USDC in its own address
   * balance. Its content lists a balances bag and no amounts, so the funds
   * were invisible here.
   */
  it("lists funds the object holds in its own address balance", async () => {
    const BANK = "0x44cf357eda762cf0cd86547f7bfcaa51a4b55de615c57903ab461f38ffed4b4b";
    mockGqlQuery.mockResolvedValue({ object: { asMoveObject: { contents: { display: null } } } });
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: BANK,
          version: 1019907195n,
          objectType: "0x58978a0c0678f010ff0ced45da75bf76f2cc33b96508c9a616dc547651f78341::liquidity_pool::Bank",
          owner: { kind: GrpcTypes.Owner_OwnerKind.SHARED, version: 896326318n },
        },
      },
    });
    mockSui.listBalances.mockResolvedValue({
      balances: [
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

    const data = JSON.parse((await tools.get("get_object")!({ object_id: BANK })).content[0].text);

    expect(data.address_balances).toEqual([
      {
        coin_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
        balance: "118304380703",
        formatted: "118304.380703 USDC",
      },
    ]);
    expect(data.address_balances_note).toMatch(/not among its fields/);
  });

  /** Address balances are current state; a historical version must not claim them. */
  it("does not attach current address balances to a historical version", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xbank",
          version: 5n,
          objectType: "0xabc::liquidity_pool::Bank",
          owner: { kind: GrpcTypes.Owner_OwnerKind.SHARED, version: 1n },
        },
      },
    });

    const data = JSON.parse((await tools.get("get_object")!({ object_id: "0xbank", version: "5" })).content[0].text);

    expect(mockSui.listBalances).not.toHaveBeenCalled();
    expect(data.address_balances).toBeUndefined();
  });

  it("reports no address balances when the object holds none", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xpool",
          version: 5n,
          objectType: "0xabc::pool::Pool",
          owner: { kind: GrpcTypes.Owner_OwnerKind.SHARED, version: 1n },
        },
      },
    });
    mockSui.listBalances.mockResolvedValue({ balances: [], hasNextPage: false, cursor: null });

    const data = JSON.parse((await tools.get("get_object")!({ object_id: "0xpool" })).content[0].text);

    expect(data.address_balances).toBeUndefined();
    expect(data.address_balances_error).toBeUndefined();
  });
});

describe("list_owned_objects", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists objects with pagination", async () => {
    mockSui.listOwnedObjects.mockResolvedValue({
      objects: [
        {
          objectId: "0xobj1",
          version: "10",
          type: "0x2::coin::Coin<0x2::sui::SUI>",
          digest: "d1",
          owner: { $kind: "AddressOwner", AddressOwner: "0xowner" },
        },
        {
          objectId: "0xobj2",
          version: "20",
          type: "0xnft::col::NFT",
          digest: "d2",
          owner: { $kind: "AddressOwner", AddressOwner: "0xowner" },
        },
      ],
      cursor: "next_page_cursor",
      hasNextPage: true,
    });

    const handler = tools.get("list_owned_objects")!;
    const result = await handler({
      owner: "0xowner",
      object_type: undefined,
      limit: 2,
      cursor: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.objects).toHaveLength(2);
    expect(data.objects[0].object_id).toBe("0xobj1");
    expect(data.objects[0].owner).toBe("address:0xowner");
    expect(data.next_cursor).toBe("next_page_cursor");
  });
});

describe("list_dynamic_fields", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists dynamic fields", async () => {
    mockSui.listDynamicFields.mockResolvedValue({
      dynamicFields: [
        { fieldId: "0xf1", type: "0x2::object::ID", valueType: "0x2::sui::SUI" },
      ],
      hasNextPage: false,
      cursor: null,
    });

    const handler = tools.get("list_dynamic_fields")!;
    const result = await handler({ parent_id: "0xparent", limit: undefined, cursor: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(data.dynamic_fields).toHaveLength(1);
    expect(data.dynamic_fields[0].field_id).toBe("0xf1");
    expect(data.has_next_page).toBe(false);
  });
});
