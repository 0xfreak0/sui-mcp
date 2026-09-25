import { describe, it, expect, vi } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));

const { registerControlTools } = await import("../src/tools/control.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
let handler: Handler | undefined;
registerControlTools({ tool: (_n: string, _d: string, _s: unknown, h: Handler) => (handler = h) } as never);

// One checkpoint a second up to 150,000, then four a second, as mainnet sped
// up. Uneven spacing is what makes a within-a-minute estimate land off the edge.
const LATEST = 1_000_000;
const stampMs = (n: number) => (n < 150_000 ? n * 1000 : 150_000_000 + (n - 150_000) * 250);

const who = (c: string) => `0x${c.repeat(64)}`;
/** Events by checkpoint; the window below runs from inside 100,000 to 102,000 inclusive. */
const EVENTS = [
  { checkpoint: 99_999, sender: who("a") },
  { checkpoint: 100_001, sender: who("b") },
  { checkpoint: 101_000, sender: who("c") },
  { checkpoint: 102_000, sender: who("d") },
  { checkpoint: 102_001, sender: who("e") },
];

mockGqlQuery.mockImplementation(async (query: string, v: Record<string, unknown>) => {
  if (query.includes("checkpoints(last: 1)")) {
    return { checkpoints: { nodes: [{ sequenceNumber: LATEST, timestamp: new Date(stampMs(LATEST)).toISOString() }] } };
  }
  if (query.includes("checkpoint(sequenceNumber")) {
    const seq = Number(v.seq);
    return { checkpoint: seq > LATEST ? null : { sequenceNumber: seq, timestamp: new Date(stampMs(seq)).toISOString() } };
  }
  // events(filter: { afterCheckpoint, beforeCheckpoint }): both exclusive.
  const f = v.filter as { afterCheckpoint?: number; beforeCheckpoint?: number };
  const nodes = EVENTS.filter(
    (e) => (f.afterCheckpoint == null || e.checkpoint > f.afterCheckpoint) && (f.beforeCheckpoint == null || e.checkpoint < f.beforeCheckpoint),
  ).map((e) => ({ sender: { address: e.sender } }));
  return { events: { nodes, pageInfo: { hasNextPage: false, endCursor: "end" } } };
});

describe("sample_control_addresses window", () => {
  it("draws from every checkpoint stamped inside the window, and none outside it", async () => {
    const res = await handler!({
      event_type: "0xabc::m::E",
      from: new Date(100_000_500).toISOString(),
      to: new Date(102_000_000).toISOString(),
      size: 10,
      seed: 1,
    });
    const out = JSON.parse(res.content[0].text);
    expect([...out.addresses].sort()).toEqual([who("b"), who("c"), who("d")]);
    expect(out.window.after_checkpoint).toBe(100_000);
    expect(out.window.before_checkpoint).toBe(102_001);
  });
});
