import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import fixtures from "./fixtures/signatures.json" with { type: "json" };

/**
 * `scanAliasDelegators` / `findAliasSignedTransactions`: the reverse scan
 * that answers "which owners' `0x2::address_alias` set names this key".
 * Covered behaviour:
 *
 * - The scan is cached, so a second call does not re-run it.
 * - A failed or capped scan is reported as such, never as an empty result
 *   indistinguishable from "not a delegate at all".
 * - Every delegating owner is checked, and a delegation with no matching
 *   sampled signature is still surfaced.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { findAliasSignedTransactions, resetAliasDelegateCache } = await import("../src/utils/identity.js");

const ALIAS = fixtures.ed25519.address;

/** One `AddressAliases` object naming `delegate` in `owner`'s set. */
const aliasNode = (owner: string, delegate: string) => ({
  owner: { address: { address: owner } },
  asMoveObject: { contents: { json: { aliases: { contents: [delegate] } } } },
});

beforeEach(() => {
  mockGqlQuery.mockReset();
  resetAliasDelegateCache();
});

describe("scanAliasDelegators caching", () => {
  it("does not re-scan every AddressAliases object on a second call", async () => {
    const owner = "0xa0";
    mockGqlQuery.mockImplementation(async (q: string) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        return { objects: { nodes: [aliasNode(owner, ALIAS)], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      return { o0: { nodes: [] } };
    });

    await findAliasSignedTransactions([ALIAS]);
    await findAliasSignedTransactions([ALIAS]);

    const scanCalls = mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("address_alias::AddressAliases"));
    expect(scanCalls).toHaveLength(1);
  });

  /**
   * The delegate map is cached while the forward read (`fetchAliases`) is
   * live. A cache hit reports when the scan read chain state, not when it
   * was served, and a scan past the TTL reads again.
   */
  it("reports the scan's own read time on a cache hit, and a new one after the TTL", async () => {
    let now = Date.parse("2026-09-26T10:00:00Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    mockGqlQuery.mockImplementation(async (q: string) => {
      if (String(q).includes("address_alias::AddressAliases")) {
        return { objects: { nodes: [aliasNode("0xa0", ALIAS)], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      return { o0: { nodes: [] } };
    });
    try {
      const first = await findAliasSignedTransactions([ALIAS]);
      expect(first.scanReadAt).toBe(Date.parse("2026-09-26T10:00:00Z"));

      now += 4 * 60_000;
      const cached = await findAliasSignedTransactions([ALIAS]);
      expect(cached.scanReadAt).toBe(Date.parse("2026-09-26T10:00:00Z"));

      now += 2 * 60_000;
      const fresh = await findAliasSignedTransactions([ALIAS]);
      expect(fresh.scanReadAt).toBe(Date.parse("2026-09-26T10:06:00Z"));
      expect(mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("address_alias::AddressAliases"))).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("a failed or capped scan is reported, not returned empty", () => {
  it("marks the lookup failed when the scan throws, and does not cache the failure", async () => {
    mockGqlQuery.mockImplementation(async (q: string) => {
      if (String(q).includes("address_alias::AddressAliases")) throw new Error("429 Too Many Requests");
      return { o0: { nodes: [] } };
    });

    const first = await findAliasSignedTransactions([ALIAS]);
    expect(first.status).toBe("failed");
    expect(first.matches.size).toBe(0);

    // A failed scan must not be cached: the next call retries and can succeed.
    const owner = "0xa0";
    mockGqlQuery.mockImplementation(async (q: string) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        return { objects: { nodes: [aliasNode(owner, ALIAS)], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      return { o0: { nodes: [] } };
    });
    const second = await findAliasSignedTransactions([ALIAS]);
    expect(second.status).toBe("complete");
    expect(second.delegateFor.get(ALIAS)).toEqual([normalizeSuiAddress(owner)]);
  });

  it("marks the lookup truncated when the on-chain scan hits its cap", async () => {
    // One oversized page (2,000 nodes) with more pages remaining hits
    // ALIAS_SCAN_CAP on the first request, without needing 40 real pages.
    const owner = "0xa0";
    const nodes = Array.from({ length: 2000 }, (_, i) => aliasNode(`0xf${i}`, `0xc${i}`));
    nodes.push(aliasNode(owner, ALIAS));
    mockGqlQuery.mockImplementation(async (q: string) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        return { objects: { nodes, pageInfo: { hasNextPage: true, endCursor: "more" } } };
      }
      return { o0: { nodes: [] } };
    });

    const r = await findAliasSignedTransactions([ALIAS]);
    expect(r.status).toBe("truncated");
  });
});

describe("every delegating owner is checked", () => {
  it("finds a signature from the 7th delegating owner", async () => {
    const owners = Array.from({ length: 7 }, (_, i) => `0xa${i}`);
    mockGqlQuery.mockImplementation(async (q: string) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        return {
          objects: { nodes: owners.map((o) => aliasNode(o, ALIAS)), pageInfo: { hasNextPage: false, endCursor: null } },
        };
      }
      if (query.includes("o0:")) {
        const resp: Record<string, { nodes: unknown[] }> = {};
        owners.forEach((_, j) => {
          resp[`o${j}`] =
            j === 6
              ? { nodes: [{ digest: "OwnerTx6", signatures: fixtures.ed25519.signatures.map((signatureBytes) => ({ signatureBytes })) }] }
              : { nodes: [] };
        });
        return resp;
      }
      return { nodes: [] };
    });

    const r = await findAliasSignedTransactions([ALIAS]);
    expect(r.status).toBe("complete");
    expect(r.matches.get(ALIAS)?.[0]?.owner).toBe(normalizeSuiAddress(owners[6]));
    expect(r.delegateFor.get(ALIAS)).toEqual(owners.map((o) => normalizeSuiAddress(o)));
  });

  it("still reports delegateFor when no sampled owner transaction carries the signature", async () => {
    const owners = ["0xa0", "0xa1"];
    mockGqlQuery.mockImplementation(async (q: string) => {
      const query = String(q);
      if (query.includes("address_alias::AddressAliases")) {
        return {
          objects: { nodes: owners.map((o) => aliasNode(o, ALIAS)), pageInfo: { hasNextPage: false, endCursor: null } },
        };
      }
      if (query.includes("o0:")) return { o0: { nodes: [] }, o1: { nodes: [] } };
      return { nodes: [] };
    });

    const r = await findAliasSignedTransactions([ALIAS]);
    expect(r.matches.has(ALIAS)).toBe(false);
    expect(r.delegateFor.get(ALIAS)).toEqual(owners.map((o) => normalizeSuiAddress(o)));
  });
});
