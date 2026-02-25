import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockSui,
}));

const { registerCoinTools } = await import("../../src/tools/coins.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerCoinTools(mockServer);

describe("get_balance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns SUI balance", async () => {
    mockSui.getBalance.mockResolvedValue({
      balance: {
        coinType: "0x2::sui::SUI",
        balance: "5000000000",
      },
    });

    const handler = tools.get("get_balance")!;
    const result = await handler({ owner: "0xowner", coin_type: undefined });
    const data = JSON.parse(result.content[0].text);

    expect(data.coin_type).toBe("0x2::sui::SUI");
    expect(data.balance).toBe("5000000000");
  });

  it("returns specific coin type balance", async () => {
    mockSui.getBalance.mockResolvedValue({
      balance: {
        coinType: "0xdba::usdc::USDC",
        balance: "1000000",
      },
    });

    const handler = tools.get("get_balance")!;
    const result = await handler({ owner: "0xowner", coin_type: "0xdba::usdc::USDC" });
    const data = JSON.parse(result.content[0].text);

    expect(data.coin_type).toBe("0xdba::usdc::USDC");
    expect(data.balance).toBe("1000000");
  });
});

describe("get_coin_info", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns coin metadata and supply", async () => {
    mockSui.stateService.getCoinInfo.mockResolvedValue({
      response: {
        coinType: "0x2::sui::SUI",
        metadata: {
          name: "Sui",
          symbol: "SUI",
          decimals: 9,
          description: "The native token",
          iconUrl: "https://example.com/sui.png",
        },
        treasury: {
          totalSupply: 10000000000000000000n,
        },
      },
    });

    const handler = tools.get("get_coin_info")!;
    const result = await handler({ coin_type: "0x2::sui::SUI" });
    const data = JSON.parse(result.content[0].text);

    expect(data.coin_type).toBe("0x2::sui::SUI");
    expect(data.name).toBe("Sui");
    expect(data.symbol).toBe("SUI");
    expect(data.decimals).toBe(9);
    expect(data.description).toBe("The native token");
    expect(data.icon_url).toBe("https://example.com/sui.png");
    expect(data.total_supply).toBe("10000000000000000000");
  });

  it("handles missing metadata gracefully", async () => {
    mockSui.stateService.getCoinInfo.mockResolvedValue({
      response: {
        coinType: "0xunknown::token::TOKEN",
        metadata: undefined,
        treasury: undefined,
      },
    });

    const handler = tools.get("get_coin_info")!;
    const result = await handler({ coin_type: "0xunknown::token::TOKEN" });
    const data = JSON.parse(result.content[0].text);

    expect(data.coin_type).toBe("0xunknown::token::TOKEN");
    expect(data.name).toBeUndefined();
    expect(data.symbol).toBeUndefined();
    expect(data.total_supply).toBeUndefined();
  });
});
