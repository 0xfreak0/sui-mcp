import { describe, it, expect, vi, afterEach } from "vitest";
import { sui } from "../src/clients/grpc.js";
import { describeError } from "../src/utils/errors.js";
import type * as Config from "../src/config.js";

// Retries without real waits: the policy is the point, not the clock.
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Config>();
  return { ...actual, GRPC_TRANSPORT: { ...actual.GRPC_TRANSPORT, baseDelayMs: 1, maxDelayMs: 1 } };
});

/** What the fullnode sends when it rate-limits a gRPC-web call: HTTP 429 and no grpc-status. */
const rateLimited = () =>
  new Response("Too Many Requests", { status: 429, headers: { "content-type": "text/plain" } });

/** An empty gRPC-web-text reply: one zero-length message frame, then `grpc-status: 0`. */
function emptyReply(): Response {
  const trailer = new TextEncoder().encode("grpc-status:0\r\n");
  const frames = new Uint8Array(5 + 5 + trailer.length);
  frames[5] = 0x80;
  new DataView(frames.buffer).setUint32(6, trailer.length);
  frames.set(trailer, 10);
  return new Response(Buffer.from(frames).toString("base64"), {
    status: 200,
    headers: { "content-type": "application/grpc-web-text+proto" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fullnode gRPC-web client", () => {
  it("retries a 429 instead of failing the call", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockImplementation(async () => emptyReply());
    vi.stubGlobal("fetch", fetch);
    const { response } = await sui.ledgerService.getServiceInfo({});
    expect(response).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[0][0])).toContain("LedgerService/GetServiceInfo");
  });

  it("queues a burst rather than sending it all at once", async () => {
    const held: Array<(r: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const { promise, resolve } = Promise.withResolvers<Response>();
        held.push(resolve);
        return promise;
      }),
    );
    const all = Promise.all(Array.from({ length: 40 }, () => sui.ledgerService.getServiceInfo({})));
    await vi.waitFor(() => expect(held.length).toBe(8));
    let served = 0;
    while (served < 40) {
      await vi.waitFor(() => expect(held.length).toBeGreaterThan(served));
      // Never more than eight requests are waiting on the fullnode.
      expect(held.length - served).toBeLessThanOrEqual(8);
      held[served++](emptyReply());
    }
    await all;
  });

  it("names the rate limit when retries run out", async () => {
    const fetch = vi.fn().mockImplementation(async () => rateLimited());
    vi.stubGlobal("fetch", fetch);
    const err = await sui.ledgerService.getServiceInfo({}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(describeError(err, "mainnet")).toMatch(/^Rate-limited by the Sui fullnode \(gRPC RESOURCE_EXHAUSTED\)/);
  });
});
