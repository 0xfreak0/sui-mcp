import { describe, it, expect, vi, afterEach } from "vitest";
import { retryingFetch, gqlQuery, RateWindow, type GraphqlTransportOptions } from "../src/clients/graphql.js";

const ENDPOINT = "https://graphql.mainnet.sui.io/graphql";
const waits: number[] = [];
const FAST: GraphqlTransportOptions = {
  attempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 8000,
  timeoutMs: 1000,
  concurrency: 8,
  sleep: async (ms: number) => waits.push(ms),
};

/** What the public endpoint sends when it rate-limits: HTML, not JSON. */
const rateLimited = (retryAfter = "0") =>
  new Response("<!doctype html><html><body>429 Too Many Requests</body></html>", {
    status: 429,
    headers: { "content-type": "text/html", "retry-after": retryAfter },
  });
const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
const connReset = () =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

afterEach(() => {
  vi.unstubAllGlobals();
  waits.length = 0;
});

describe("retryingFetch", () => {
  it("retries a 429 and returns the answer that follows", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(ok({ n: 1 }));
    vi.stubGlobal("fetch", fetch);
    const res = await retryingFetch(ENDPOINT, FAST)(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx and a connection reset", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockRejectedValueOnce(connReset())
      .mockResolvedValueOnce(ok({}));
    vi.stubGlobal("fetch", fetch);
    const res = await retryingFetch(ENDPOINT, FAST)(ENDPOINT, {});
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops after the configured attempts and hands back the last response", async () => {
    const fetch = vi.fn().mockImplementation(async () => rateLimited());
    vi.stubGlobal("fetch", fetch);
    const res = await retryingFetch(ENDPOINT, FAST)(ENDPOINT, {});
    expect(res.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry a client error", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const res = await retryingFetch(ENDPOINT, FAST)(ENDPOINT, {});
    expect(res.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("waits as long as Retry-After asks, up to the cap, and backs off otherwise", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimited("2"))
      .mockResolvedValueOnce(rateLimited("600"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(ok({}));
    vi.stubGlobal("fetch", fetch);
    await retryingFetch(ENDPOINT, FAST)(ENDPOINT, {});
    expect(waits[0]).toBe(2000);
    expect(waits[1]).toBe(8000);
    // Third attempt, no Retry-After: 100 * 2^2, jittered into [50%, 100%].
    expect(waits[2]).toBeGreaterThanOrEqual(200);
    expect(waits[2]).toBeLessThanOrEqual(400);
  });

  it("times out a request that never answers", async () => {
    // AbortSignal.timeout runs on the platform clock, which fake timers do not drive.
    vi.stubGlobal(
      "fetch",
      vi.fn((_: unknown, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      }),
    );
    await expect(retryingFetch(ENDPOINT, { ...FAST, timeoutMs: 20 })(ENDPOINT, {})).rejects.toThrow(
      "GraphQL request to graphql.mainnet.sui.io timed out after 0.02s",
    );
  });

  it("keeps no more than `concurrency` requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        for (let i = 0; i < 5; i++) await Promise.resolve();
        inFlight--;
        return ok({});
      }),
    );
    const f = retryingFetch(ENDPOINT, { ...FAST, concurrency: 2 });
    await Promise.all(Array.from({ length: 7 }, () => f(ENDPOINT, {})));
    expect(peak).toBe(2);
  });
});

describe("gqlQuery errors", () => {
  it("reports the first GraphQL error on one line, without the request dump", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: null,
            errors: [{ message: "Page size is too large: 1000 > 50" }, { message: "second" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await expect(gqlQuery("query { a }")).rejects.toThrow(
      /^GraphQL error: Page size is too large: 1000 > 50 \(\+1 more\)$/,
    );
  });

  it("reports an exhausted rate limit as one line naming the endpoint, not the HTML page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => rateLimited()));
    const err = await gqlQuery("query { a }").catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "Rate-limited by graphql.mainnet.sui.io (HTTP 429) after 4 attempts. Retry shortly, or set SUI_GRAPHQL_URL to a private endpoint for heavy use.",
    );
  });
});

describe("request rate window", () => {
  /** A clock the window's waits advance, so a test runs instantly. */
  function fakeClock() {
    const clock = { t: 1_000_000, waited: [] as number[] };
    return {
      clock,
      now: () => clock.t,
      sleep: async (ms: number) => {
        clock.waited.push(ms);
        clock.t += ms;
      },
    };
  }

  it("starts at most `limit` requests in any window and holds the rest until the oldest ages out", async () => {
    const { clock, now, sleep } = fakeClock();
    const w = new RateWindow(3, 10_000, now, sleep);
    const starts: number[] = [];
    await Promise.all([1, 2, 3, 4, 5].map(async () => {
      await w.acquire();
      starts.push(clock.t);
    }));
    // Three start at once; the fourth waits until the first is 10s old.
    expect(starts.slice(0, 3)).toEqual([1_000_000, 1_000_000, 1_000_000]);
    expect(starts[3]).toBeGreaterThan(1_000_000 + 10_000 - 1);
    // Never more than 3 starts inside any 10s span.
    for (const s of starts) expect(starts.filter((x) => x > s - 10_000 && x <= s).length).toBeLessThanOrEqual(3);
  });

  it("counts every attempt, retries included, against the window", async () => {
    const { clock, now, sleep } = fakeClock();
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok({ n: 1 }))
      .mockResolvedValueOnce(rateLimited("0"))
      .mockResolvedValueOnce(ok({ n: 2 }));
    vi.stubGlobal("fetch", fetch);
    const f = retryingFetch(ENDPOINT, { ...FAST, now, sleep, rateLimit: 2 });
    await f(ENDPOINT, { method: "POST" });
    await f(ENDPOINT, { method: "POST" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(clock.waited.some((ms) => ms >= 9_000)).toBe(true);
  });

  it("reads SUI_RATE_LIMIT for any host, 0 turns it off, and leaves other hosts alone by default", async () => {
    const { rateLimitFor } = await import("../src/config.js");
    vi.stubEnv("SUI_RATE_LIMIT", "");
    expect(rateLimitFor("graphql.mainnet.sui.io")).toBe(180);
    expect(rateLimitFor("fullnode.testnet.sui.io")).toBe(180);
    expect(rateLimitFor("my-node.example.com")).toBeNull();
    expect(rateLimitFor("evilsui.io.example.com")).toBeNull();
    vi.stubEnv("SUI_RATE_LIMIT", "500");
    expect(rateLimitFor("my-node.example.com")).toBe(500);
    vi.stubEnv("SUI_RATE_LIMIT", "0");
    expect(rateLimitFor("graphql.mainnet.sui.io")).toBeNull();
    vi.unstubAllEnvs();
  });
});
