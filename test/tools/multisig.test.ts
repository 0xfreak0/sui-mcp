import { describe, it, expect, vi, beforeEach } from "vitest";
import fixtures from "../fixtures/signatures.json" with { type: "json" };

const mockGqlQuery = vi.fn();
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerMultisigTools } = await import("../../src/tools/multisig.js");

const tools = new Map<string, Function>();
registerMultisigTools({
  tool: (name: string, _d: string, _s: unknown, handler: Function) => tools.set(name, handler),
} as never);
const analyze = tools.get("analyze_multisig")!;

/** A sent page that always claims another, like a busy wallet's history. */
const sentPage = (signatures: string[], digest: string) => ({
  transactions: {
    pageInfo: { hasNextPage: true, endCursor: `after-${digest}` },
    nodes: [{ digest, effects: { timestamp: null }, gasInput: null, signatures: signatures.map((signatureBytes) => ({ signatureBytes })) }],
  },
});

beforeEach(() => mockGqlQuery.mockReset());

describe("analyze_multisig", () => {
  it("answers after one page for a wallet that signs with its own single key", async () => {
    // An active ed25519 wallet timed out at 120s: non-multisig signatures never
    // counted toward the loop's target, so it paged the whole history.
    let calls = 0;
    mockGqlQuery.mockImplementation(async () => {
      if (++calls > 20) throw new Error("paged past the first page");
      return sentPage(fixtures.ed25519.signatures, `d${calls}`);
    });
    const res = await analyze({ address: fixtures.ed25519.address });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/is not a multisig wallet: it signed d1 with its own ed25519 key/);
    expect(calls).toBe(1);
  });

  it("reports transactions sent in the address's name but signed by someone else", async () => {
    // 0xcd8962… sent one transaction, signed by a 31-of-64 multisig; the tool
    // said "none is signed by a multisig" as if that settled the question.
    mockGqlQuery.mockResolvedValue({
      transactions: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ digest: "B2eGLFo", effects: null, gasInput: null, signatures: fixtures.ms_2of3.signatures.map((signatureBytes) => ({ signatureBytes })) }],
      },
    });
    const res = await analyze({ address: fixtures.ed25519.address });
    expect(res.content[0].text).toMatch(/none carries its own signature: they were authorized by 0xa1eb94d1/);
  });
});
