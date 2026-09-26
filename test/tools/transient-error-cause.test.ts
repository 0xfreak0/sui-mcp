import { describe, it, expect, vi, afterEach } from "vitest";
import { registerRestrictionTools } from "../../src/tools/restrictions.js";
import { registerAnalyzePackageTools } from "../../src/tools/analyze-package.js";
import type * as Config from "../../src/config.js";

/**
 * A rate-limited fullnode is named as the cause of a failed read in
 * `check_coin_restrictions` and `analyze_package`. The gRPC-web transport
 * turns an HTTP 429 into `RESOURCE_EXHAUSTED` with an empty message, so
 * `err.message` alone names no cause. The failure is produced here by the
 * real transport, not a hand-built error, so the shape is the one a live 429
 * gives.
 */

// Retries without real waits: the retry policy is not what is under test.
vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Config>();
  return { ...actual, GRPC_TRANSPORT: { ...actual.GRPC_TRANSPORT, baseDelayMs: 1, maxDelayMs: 1 } };
});

const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
const server = {
  tool: (name: string, _desc: string, _schema: unknown, handler: never) => tools.set(name, handler),
} as never;
registerRestrictionTools(server);
registerAnalyzePackageTools(server);

/** What the fullnode sends when it rate-limits a gRPC-web call: HTTP 429 and no grpc-status. */
const rateLimited = () => new Response("Too Many Requests", { status: 429, headers: { "content-type": "text/plain" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a rate-limited fullnode is named in the error, not left blank", () => {
  it("check_coin_restrictions says why the epoch could not be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => rateLimited()));
    const r = await tools.get("check_coin_restrictions")!({
      coin_type: "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM",
    });
    expect(r.isError).toBe(true);
    const { error } = JSON.parse(r.content[0].text);
    expect(error).toMatch(/^Could not read the current epoch \(Rate-limited by the Sui fullnode \(gRPC RESOURCE_EXHAUSTED\)/);
  });

  it("analyze_package says why the package could not be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => rateLimited()));
    const r = await tools.get("analyze_package")!({
      package_id: "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9",
    });
    expect(r.isError).toBe(true);
    const { error } = JSON.parse(r.content[0].text);
    expect(error).toMatch(/^Rate-limited by the Sui fullnode \(gRPC RESOURCE_EXHAUSTED\)/);
  });
});
