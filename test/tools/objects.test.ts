import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient } from "../helpers/mock-grpc.js";
import { GrpcTypes } from "@mysten/sui/grpc";

const mockSui = createMockClient();
const mockArchive = createMockClient();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockArchive,
}));

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
