import { describe, expect, it } from "vitest";
import { fetchMetadata } from "../scripts/sync-verified-coins.mjs";

describe("verified-coin metadata sync", () => {
  const types = Array.from({ length: 201 }, (_, i) => `coin-${i}`);

  it("requests at most 100 types at a time and preserves positional order", async () => {
    const batches: string[][] = [];
    const meta = await fetchMetadata(types, async (url, init) => {
      expect(url).toBe("https://aftermath.finance/api/coins/metadata");
      expect(init.method).toBe("POST");
      const batch = JSON.parse(init.body).coins as string[];
      batches.push(batch);
      return batch.map((coin) => ({ symbol: coin }));
    });
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 1]);
    expect(batches.flat()).toEqual(types);
    expect(meta.map((m: { symbol: string }) => m.symbol)).toEqual(types);
  });

  it("rejects a short or failed batch instead of returning partial metadata", async () => {
    for (const broken of ["short", "failed"] as const) {
      let calls = 0;
      await expect(fetchMetadata(types, async (_url, init) => {
        calls++;
        const batch = JSON.parse(init.body).coins as string[];
        if (calls === 2) {
          if (broken === "failed") throw new Error("HTTP 400");
          return batch.slice(1).map((coin) => ({ symbol: coin }));
        }
        return batch.map((coin) => ({ symbol: coin }));
      })).rejects.toThrow(broken === "failed" ? "HTTP 400" : "batch 101-200 came back 99 for 100 coins");
      expect(calls).toBe(2);
    }
  });
});
