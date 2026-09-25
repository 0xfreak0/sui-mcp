import { describe, it, expect, vi, beforeEach } from "vitest";
import fixtures from "./fixtures/signatures.json" with { type: "json" };

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/identity.js", () => ({ describeAddresses: async () => new Map(), identityNote: () => undefined }));

const { registerMultisigTools } = await import("../src/tools/multisig.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const handlers = new Map<string, Handler>();
registerMultisigTools({
  tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h),
} as never);

const MS = fixtures.ms_2of3;

/** A sent transaction as `transactions(filter: { sentAddress })` returns it. */
const tx = (n: number, timestamp: string) => ({
  digest: `D${n}`,
  effects: { timestamp },
  gasInput: { gasSponsor: { address: MS.address } },
  signatures: MS.signatures.map((signatureBytes) => ({ signatureBytes })),
});

// 150 sent transactions: 50 in January, 50 in June, 50 in December.
const history = Array.from({ length: 150 }, (_, i) =>
  tx(i, `2025-${i < 50 ? "01" : i < 100 ? "06" : "12"}-15T00:00:${String(i % 60).padStart(2, "0")}Z`),
);

beforeEach(() => {
  mockGqlQuery.mockReset();
  // The service's connection semantics: `first`/`after` from the oldest row,
  // `last`/`before` from the newest, each page in ascending order.
  mockGqlQuery.mockImplementation(async (_q: string, v: Record<string, unknown>) => {
    const rows = v.a === MS.address ? history : [];
    if (typeof v.last === "number") {
      const end = v.before ? Number(v.before) : rows.length;
      const start = Math.max(0, end - v.last);
      return {
        transactions: {
          pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
          nodes: rows.slice(start, end),
        },
      };
    }
    const start = v.after ? Number(v.after) : 0;
    const end = Math.min(rows.length, start + Number(v.first));
    return {
      transactions: { pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) }, nodes: rows.slice(start, end) },
    };
  });
});

describe("analyze_multisig reads the most recent signatures", () => {
  it("examines the newest transactions when the budget is shorter than the history", async () => {
    const res = await handlers.get("analyze_multisig")!({ address: MS.address, max_transactions: 50 });
    const out = JSON.parse(res.content[0].text);
    expect(out.transactions_examined).toBe(50);
    expect(out.history_complete).toBe(false);
    const signed = out.members.filter((m: { signed_count: number }) => m.signed_count > 0);
    expect(signed.length).toBeGreaterThan(0);
    for (const m of signed) {
      expect(m.first_signed.startsWith("2025-12")).toBe(true);
      expect(m.last_signed.startsWith("2025-12")).toBe(true);
    }
  });

  it("reads the whole history when the budget covers it", async () => {
    const res = await handlers.get("analyze_multisig")!({ address: MS.address, max_transactions: 500 });
    const out = JSON.parse(res.content[0].text);
    expect(out.transactions_examined).toBe(150);
    expect(out.history_complete).toBe(true);
    const signed = out.members.filter((m: { signed_count: number }) => m.signed_count > 0);
    for (const m of signed) {
      expect(m.first_signed.startsWith("2025-01")).toBe(true);
      expect(m.last_signed.startsWith("2025-12")).toBe(true);
    }
  });
});
