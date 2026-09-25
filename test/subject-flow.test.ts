import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A history or timeline row is about the queried address, and `token_flow` is
 * the SENDER's balance change. On a transfer the subject received, token_flow
 * shows the sender's outflow, so an inflow reads as a negative raw amount.
 * `subject_flow` is the subject's own side. Nodes are the shapes mainnet
 * returned for the two transactions named below.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
vi.mock("../src/protocols/registry.js", () => ({
  prefetchProtocolNames: async () => {},
  lookupProtocol: () => null,
  lookupProtocolDisplay: () => null,
  lookupOperation: () => null,
}));

const { registerHistoryTools } = await import("../src/tools/history.js");
const { registerTimelineTools } = await import("../src/tools/timeline.js");

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const tools = new Map<string, Handler>();
const server = { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as never;
registerHistoryTools(server);
registerTimelineTools(server);
const run = async (name: string, a: Record<string, unknown>) => JSON.parse((await tools.get(name)!(a)).content[0].text);

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const node = (digest: string, sender: string, changes: [string, string][]) => ({
  digest,
  sender: { address: sender },
  effects: {
    status: "SUCCESS",
    timestamp: "2026-09-02T20:15:07.596Z",
    checkpoint: { sequenceNumber: 317997373 },
    balanceChanges: {
      nodes: changes.map(([address, amount]) => ({ coinType: { repr: SUI }, amount, owner: { address } })),
    },
  },
  kind: { commands: { nodes: [] } },
});

const page = (nodes: unknown[]) => ({
  transactions: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
});

beforeEach(() => mockGqlQuery.mockReset());

describe("get_transaction_history subject_flow", () => {
  // FjkAurXTGnmq…: 0x1f7b27 sent the Nemo attacker 39.44771725 SUI.
  const ATTACKER = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
  const SENDER = "0x1f7b27844f2c4a0262b2c481f7ab956d10ace524c5a7b06c3742cfb8701db714";
  const tx = node("FjkAurXTGnmq4uiMr1yWETvRCtYWmVpFbrD9MGSyUc3S", SENDER, [
    [ATTACKER, "39447717250"],
    [SENDER, "-39449215130"],
  ]);

  it("shows the queried address's inflow as positive, beside the sender's token_flow", async () => {
    mockGqlQuery.mockResolvedValue(page([tx]));
    const [row] = (await run("get_transaction_history", { address: ATTACKER })).transactions;
    expect(row.subject_flow).toEqual([
      { coin: "SUI", amount: "39447717250", formatted: "39.44771725 SUI", raw_type: SUI, coin_verified: true },
    ]);
    expect(row.token_flow[0].amount).toBe("-39449215130");
  });

  it("shows the sender its own outflow when the sender is the subject", async () => {
    mockGqlQuery.mockResolvedValue(page([tx]));
    const [row] = (await run("get_transaction_history", { address: SENDER })).transactions;
    expect(row.subject_flow.map((f: { formatted: string }) => f.formatted)).toEqual(["-39.44921513 SUI"]);
  });
});

describe("build_timeline subject_flow", () => {
  // FS8u6Lub…: 0x7c8e paid 101847 MIST (gas included) and 0xb71e received 1847.
  const RECEIVER = "0xb71effa1cc4425928e0bda7c3b690a356245e705b01b5380b5d4d1a3497c1d47";
  const SENDER = "0x7c8e2ceb0839680a3b1f7aa1021d45670405d92f3c88e79aa1d3aa8a600bbdbf";
  const tx = node("FS8u6Lubkp1JPBt3nqJ1btnDUDLTNgUeGEsozktLub17", SENDER, [
    [SENDER, "-101847"],
    [RECEIVER, "1847"],
  ]);

  it("keys each involved address to its own signed flow", async () => {
    mockGqlQuery.mockResolvedValue(page([tx]));
    const [row] = (await run("build_timeline", { addresses: [RECEIVER, SENDER] })).timeline;
    expect(row.subject_flow[RECEIVER]).toEqual([
      { coin: "SUI", amount: "1847", formatted: "0.000001847 SUI", raw_type: SUI, coin_verified: true },
    ]);
    expect(row.subject_flow[SENDER][0].amount).toBe("-101847");
    expect(row.token_flow[0].amount).toBe("-101847");
  });

  it("shows only the tracked address when the sender is not tracked", async () => {
    mockGqlQuery.mockResolvedValue(page([tx]));
    const [row] = (await run("build_timeline", { addresses: [RECEIVER] })).timeline;
    expect(Object.keys(row.subject_flow)).toEqual([RECEIVER]);
    expect(row.subject_flow[RECEIVER][0].amount).toBe("1847");
  });
});
