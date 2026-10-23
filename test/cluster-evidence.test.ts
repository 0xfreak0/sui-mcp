import { describe, expect, it } from "vitest";
import { pageEdgeEvidence } from "../src/tools/cluster.js";
import { EdgeSet } from "../src/utils/wallet-edges.js";

describe("cluster edge evidence pages", () => {
  it("keeps the full evidence for scoring and exposes each digest in a finite continuation", () => {
    const set = new EdgeSet();
    for (let i = 0; i < 12; i++) set.add("sponsor", "0xaa", "0xbb", "gas sponsor", [`digest-${i}`], "0xcc");
    const edge = set.edges()[0];
    const args = { addresses: ["0xaa", "0xbb"] };
    const first = pageEdgeEvidence(edge, 0, args).signals[0];
    expect(first.digests).toEqual(Array.from({ length: 5 }, (_, i) => `digest-${i}`));
    expect(first.digest_listing).toMatchObject({ total: 12, next_call: { tool: "build_wallet_edges", args: { ...args, format: "json", digest_offset: 5 } } });
    const second = pageEdgeEvidence(edge, 5, args).signals[0];
    const last = pageEdgeEvidence(edge, 10, args).signals[0];
    expect([...first.digests, ...second.digests, ...last.digests]).toEqual(edge.signals[0].digests);
    expect(last.digest_listing).toMatchObject({ total: 12, offset: 10 });
    expect(last.digest_listing).not.toHaveProperty("next_call");
  });
});
