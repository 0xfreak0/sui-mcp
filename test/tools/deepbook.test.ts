import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const indexer = vi.hoisted(() => ({
  resolvePool: vi.fn(), fetchTrades: vi.fn(), fetchPools: vi.fn(),
  fetchOrderbook: vi.fn(), fetchCandles: vi.fn(),
}));
vi.mock("../../src/utils/deepbook-indexer.js", () => indexer);

const { registerDeepBookTools } = await import("../../src/tools/deepbook.js");
const tools = new Map<string, Function>();
registerDeepBookTools({ tool: (name: string, _description: string, _schema: unknown, handler: Function) => tools.set(name, handler) } as unknown as McpServer);

describe("deepbook_trades", () => {
  it("reports a capped maker leg even when deduplication shortens the displayed list", async () => {
    indexer.resolvePool.mockResolvedValue({ pool_name: "SUI_USDC", base_asset_symbol: "SUI", quote_asset_symbol: "USDC" });
    const trade = {
      digest: "tx", timestamp: 100, price: 1, base_volume: 1, quote_volume: 1,
      taker_is_bid: true, maker_balance_manager_id: "0x1", taker_balance_manager_id: "0x2"
    };
    indexer.fetchTrades.mockResolvedValueOnce([trade, trade]).mockResolvedValueOnce([trade]);
    const result = await tools.get("deepbook_trades")!({ pool_name: "SUI_USDC", limit: 2, balance_manager_id: "0x1" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ truncated: true, trade_count: 1, trades: [{ digest: "tx", timestamp: 100 }] });
    expect(payload.truncation_note).toMatch(/indexer has no cursor/);
  });
});
