import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockClient } from "../helpers/mock-grpc.js";
import { notFoundError } from "../helpers/service-shapes.js";

const sui = createMockClient();
const query = vi.fn();
vi.mock("../../src/clients/grpc.js", () => ({ sui, archive: sui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: query }));
// Load after the client mocks: these modules capture the gRPC/GraphQL clients.
const { withNetworkParam } = await import("../../src/tools/with-network.js");
const { registerTransactionTools } = await import("../../src/tools/transactions.js");
const { registerDecodeTools } = await import("../../src/tools/decode.js");
const { registerEventTools } = await import("../../src/tools/events.js");
const { registerAggregateTools } = await import("../../src/tools/aggregate.js");
const { registerIdentifyTools } = await import("../../src/tools/identify.js");
const { registerStakingTools } = await import("../../src/tools/staking.js");
const { DEFAULT_NETWORK, getNetwork, runWithNetwork } = await import("../../src/config.js");
const { readStoredResult } = await import("../../src/utils/output-cap.js");
const { resetStore, saveResult } = await import("../../src/utils/store.js");

type Args = Record<string, unknown>;
type Call = { tool: string; args?: Args; repeat_with?: Args };
type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: unknown };
const tools = new Map<string, { schema: z.ZodTypeAny; handler: (args: Args) => Promise<Result> }>();
const server = withNetworkParam({
  registerTool(name: string, config: { inputSchema: z.ZodTypeAny }, handler: (args: Args) => Promise<Result>) {
    tools.set(name, { schema: config.inputSchema, handler });
  },
} as unknown as McpServer);
registerTransactionTools(server);
registerDecodeTools(server);
registerEventTools(server);
registerAggregateTools(server);
registerIdentifyTools(server);
registerStakingTools(server);

function calls(value: unknown): Call[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  return [
    ...(typeof row.tool === "string" && (row.args || row.repeat_with) ? [row as Call] : []),
    ...Object.values(row).flatMap(calls),
  ];
}

const DIGEST = "7pTrudZb57z2acJFvC2CnBCuaU6RA1UpU9auDZQEESit";
const OWNER = `0x${"11".repeat(32)}`;
let bytes: Uint8Array;
let reads: string[];
let dir: string;
beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "sui-continuations-"));
  vi.stubEnv("SUI_STORE_PATH", join(dir, "store.db"));
  resetStore();
  reads = [];
  const tx = new Transaction();
  tx.setSender(OWNER);
  tx.setGasPrice(1000);
  tx.setGasBudget(1_000_000);
  tx.setGasPayment([]);
  tx.setExpiration({ None: true });
  for (let i = 0; i < 400; i++) tx.splitCoins(tx.gas, [tx.pure.u64(i + 1)]);
  bytes = await tx.build();
  sui.ledgerService.getTransaction.mockImplementation(async () => {
    reads.push(getNetwork());
    return { response: { transaction: {
      digest: DIGEST,
      transaction: { sender: OWNER, bcs: { value: bytes },
        kind: { data: { oneofKind: "programmableTransaction", programmableTransaction: { inputs: [], commands: [] } } },
      },
      effects: { status: { success: true }, changedObjects: [] },
      balanceChanges: [],
      events: { events: [] },
    } } };
  });
  sui.ledgerService.getObject.mockRejectedValue(notFoundError());
  query.mockImplementation(async (_q, vars) => {
    reads.push(getNetwork());
    if (String(_q).includes("validatorSet")) return { epoch: { epochId: 100, validatorSet: {
      activeValidators: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { contents: { json: { metadata: { sui_address: OWNER, name: "Validator" },
          staking_pool: { sui_balance: "9000000000000" }, commission_rate: "200" } } },
      ] },
      contents: { json: { total_stake: "9000000000000" } },
    } } };
    const cursor = Number(vars?.before ?? vars?.after ?? 0) + 1;
    const page = { nodes: [], edges: [], pageInfo: {
      hasNextPage: true, hasPreviousPage: true, startCursor: String(cursor), endCursor: String(cursor),
    } };
    return { events: page, transactions: page };
  });
});
afterEach(() => {
  resetStore();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("continuations stay on the originating chain", () => {
  it.each([
    { tool: "decode_ptb", args: { digest: DIGEST }, path: "commands_omitted.next_call", next: "decode_ptb" },
    { tool: "get_transaction", args: { digest: DIGEST, detail: "full" }, path: "commands_omitted.next_call", next: "decode_ptb" },
    { tool: "get_transaction", args: { digest: DIGEST, detail: "full", commands: [0] }, path: "inputs_omitted.next_call", next: "get_transaction" },
    { tool: "query_events", args: { sender: OWNER, limit: 1 }, path: "scan.next_call", next: "query_events" },
    { tool: "query_transactions", args: { sender: OWNER, limit: 1 }, path: "scan.next_call", next: "query_transactions" },
    { tool: "aggregate_events", args: { sender: OWNER, max_reads: 1 }, path: "scan.next_call", next: "aggregate_events" },
    { tool: "identify_address", args: { address: OWNER }, path: "next_call", next: "get_validators" },
  ])("$tool ($path) preserves testnet when followed", async ({ tool, args, path, next }) => {
    const original = { ...args, network: "testnet" };
    const registered = tools.get(tool)!;
    const result = await registered.handler(registered.schema.parse(original));
    expect(result.isError, result.content[0].text).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    const expected = path.split(".").reduce((value, key) => value?.[key], payload);
    expect(expected).toMatchObject({ tool: next });
    const continuations = calls(payload);
    for (const continuation of continuations) {
      const args = continuation.args ?? { ...original, ...continuation.repeat_with };
      expect(args.network ?? DEFAULT_NETWORK).toBe("testnet");
    }
    const nextArgs = expected.args ?? { ...original, ...expected.repeat_with };
    reads = [];
    const target = tools.get(expected.tool)!;
    const followed = await target.handler(target.schema.parse(nextArgs));
    expect(followed.isError, followed.content[0].text).toBeUndefined();
    expect(new Set(reads)).toEqual(new Set(["testnet"]));
  });

  it("uses the stored chain, not the resource reader's chain, for calls and repeat args", () => {
    const id = saveResult("testnet", "decode_ptb", { digest: DIGEST }, {
      rows: [{ next_call: { tool: "get_transaction", args: { digest: DIGEST } } },
        { next_call: { tool: "decode_ptb", repeat_with: { command_offset: 5 } } }],
    })!;
    const root = runWithNetwork("devnet", () => readStoredResult(id, {}));
    expect((root.args as Args).network ?? DEFAULT_NETWORK).toBe("testnet");
    const first = runWithNetwork("mainnet", () => readStoredResult(id, { path: "rows", limit: "1" }));
    expect(calls(first)[0].args?.network ?? DEFAULT_NETWORK).toBe("testnet");
    const uri = new URL(first.next_page as string);
    const second = runWithNetwork("devnet", () => readStoredResult(id, Object.fromEntries(uri.searchParams)));
    const repeat = calls(second)[0];
    expect({ ...(root.args as Args), ...repeat.repeat_with }).toMatchObject({ network: "testnet", command_offset: 5 });
    const nested = runWithNetwork("devnet", () => readStoredResult(id, { path: "rows.0.next_call" }));
    expect(calls(nested)[0].args?.network ?? DEFAULT_NETWORK).toBe("testnet");
  });
});
