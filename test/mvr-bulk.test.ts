import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { reverseResolveBulk } = await import("../src/utils/mvr-client.js");

// mvrFetch reads res.text(), not res.json().
const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: async () => JSON.stringify(body),
});
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `0xpkg${from + i}`);
/** The runner invokes a mock implementation once with no arguments. */
const NO_INIT = { body: JSON.stringify({ package_ids: [] }) };
const resolution = (list: string[]) =>
  ok({ resolution: Object.fromEntries(list.map((id) => [id, { name: `@org/${id}` }])) });

beforeEach(() => fetchMock.mockReset());

describe("reverseResolveBulk", () => {
  it("chunks past MVR's batch limit instead of failing the whole call", async () => {
    // The server answers 51+ with `400 Batch size limit exceeded`, and the only
    // caller swallows the throw — so the failure was silent AND total: every
    // name was lost, not just the ones past the limit. Batching transactions
    // made this easy to reach, since a batch collects packages across all of
    // them.
    fetchMock.mockImplementation(async (_u: string, init = NO_INIT) =>
      resolution(JSON.parse(init.body).package_ids),
    );

    const all = ids(120);
    const out = await reverseResolveBulk(all);
    const real = fetchMock.mock.calls.filter((c) => c[1]?.body);
    expect(real).toHaveLength(3); // 50 + 50 + 20
    expect(out.size).toBe(120);
    expect(out.get("0xpkg119")).toBe("@org/0xpkg119");
    for (const call of fetchMock.mock.calls) {
      if (!call[1]?.body) continue;
      expect(JSON.parse(call[1].body).package_ids.length).toBeLessThanOrEqual(50);
    }
  });

  it("keeps the pages that succeeded when one fails", async () => {
    // A failed page costs only its own names, rather than discarding pages
    // already in hand.
    let n = 0;
    fetchMock.mockImplementation(async (_u: string, init = NO_INIT) => {
      if (!init.body) return resolution([]);
      if (++n === 2) return { ok: false, status: 500, statusText: "Server Error", text: async () => "" };
      return resolution(JSON.parse(init.body).package_ids);
    });

    const out = await reverseResolveBulk(ids(120));
    expect(out.size).toBe(70); // first and third pages
    expect(out.has("0xpkg0")).toBe(true);
    expect(out.has("0xpkg50")).toBe(false);
  });

  it("sends exactly one request at the limit", async () => {
    fetchMock.mockImplementation(async (_u: string, init = NO_INIT) =>
      resolution(JSON.parse(init.body).package_ids),
    );
    await reverseResolveBulk(ids(50));
    expect(fetchMock.mock.calls.filter((c) => c[1]?.body)).toHaveLength(1);
  });

  it("makes no request for an empty set", async () => {
    expect((await reverseResolveBulk([])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records an unregistered package as null, not as absent", async () => {
    // The caller distinguishes the two: null is cached as "no name", absent is
    // left uncached so a transient outage does not poison it.
    fetchMock.mockResolvedValue(ok({ resolution: {} }));
    const out = await reverseResolveBulk(["0xpkg0"]);
    expect(out.get("0xpkg0")).toBeNull();
  });
});
