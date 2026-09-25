import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkpointChain } from "./helpers/service-shapes.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
const digestsSentBy = vi.fn();
const readAttackTransactions = vi.fn();
vi.mock("../src/utils/attack-read.js", () => ({ digestsSentBy, readAttackTransactions }));

const { registerAttackTools } = await import("../src/tools/attack.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlers: Record<string, Handler> = {};
registerAttackTools({
  tool: (name: string, _d: string, _s: unknown, h: Handler) => {
    handlers[name] = h;
  },
} as never);

const SENDER = "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06";
// One checkpoint a second: checkpoint N is stamped T0 + N seconds.
const T0 = Date.parse("2025-05-01T00:00:00Z");
const at = (seq: number) => T0 + seq * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  mockGqlQuery.mockReset();
  const chain = checkpointChain(2_000_000, at);
  mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => chain(q, v));
  digestsSentBy.mockReset().mockResolvedValue({ digests: ["DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x"], truncated: false });
  // The window is the subject here; stop once the digests are listed.
  readAttackTransactions.mockReset().mockRejectedValue(new Error("stop"));
});

describe("summarize_incident_losses: the sender window", () => {
  it("holds exactly the checkpoints stamped inside a time window", async () => {
    // Checkpoint 500,000 is stamped 0.1s before the start and 600,001 is 0.1s
    // after the end: neither is inside. Resolved to the nearest checkpoint, as
    // a point in time is, both were read.
    await handlers.summarize_incident_losses({ sender: SENDER, start: iso(at(500_000) + 100), end: iso(at(600_001) - 100) });

    expect(digestsSentBy).toHaveBeenCalledTimes(1);
    expect(digestsSentBy.mock.calls[0][1]).toEqual({ afterCheckpoint: 500_000, beforeCheckpoint: 600_001 });
  });

  it("includes both checkpoints given as numbers", async () => {
    await handlers.summarize_incident_losses({ sender: SENDER, start: 148114818, end: "148118869" });

    expect(digestsSentBy.mock.calls[0][1]).toEqual({ afterCheckpoint: 148114817, beforeCheckpoint: 148118870 });
  });

  it("refuses a window beside a digest list instead of ignoring it", async () => {
    const r = await handlers.summarize_incident_losses({ digests: ["DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x"], start: "2025-05-22T10:30:00Z" });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/start.*end.*sender/);
    expect(digestsSentBy).not.toHaveBeenCalled();
  });
});
