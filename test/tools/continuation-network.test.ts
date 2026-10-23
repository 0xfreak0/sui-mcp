import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockClient } from "../helpers/mock-grpc.js";
import { notFoundError } from "../helpers/service-shapes.js";
import { bindContinuationNetwork } from "../../src/utils/continuation-network.js";

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
const { registerWorkflowTools } = await import("../../src/tools/workflow.js");
const { registerHistoryTools } = await import("../../src/tools/history.js");
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
registerWorkflowTools(server);
registerHistoryTools(server);

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
        return {
            response: {
                transaction: {
      digest: DIGEST,
                    transaction: {
                        sender: OWNER, bcs: { value: bytes },
        kind: { data: { oneofKind: "programmableTransaction", programmableTransaction: { inputs: [], commands: [] } } },
      },
      effects: { status: { success: true }, changedObjects: [] },
      balanceChanges: [],
      events: { events: [] },
                }
            }
        };
  });
  sui.ledgerService.getObject.mockRejectedValue(notFoundError());
  query.mockImplementation(async (_q, vars) => {
    reads.push(getNetwork());
        if (String(_q).includes("validatorSet")) return {
            epoch: {
                epochId: 100, validatorSet: {
                    activeValidators: {
                        pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
                            {
                                contents: {
                                    json: {
                                        metadata: { sui_address: OWNER, name: "Validator" },
                                        staking_pool: { sui_balance: "9000000000000" }, commission_rate: "200"
                                    }
                                }
                            },
                        ]
                    },
      contents: { json: { total_stake: "9000000000000" } },
                }
            }
        };
    const cursor = Number(vars?.before ?? vars?.after ?? 0) + 1;
        const page = {
            nodes: [], edges: [], pageInfo: {
      hasNextPage: true, hasPreviousPage: true, startCursor: String(cursor), endCursor: String(cursor),
            }
        };
    return { events: page, transactions: page };
  });
});
afterEach(() => {
  resetStore();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it("binds venue and audit continuations without treating decoded data as a call", () => {
    const call = () => ({ tool: "find_pools", args: { token_a: "SUI", token_b: "USDC" } });
    const payload = {
        continue_with: call(),
        results: [{ continue_with: call() }],
        venues: [{ next_call: call() }],
        pool_discovery: { venues: [{ next_call: call() }] },
        liquidity_custody: { pools: [{ scan: { next_call: call() } }] },
        shared_funders: [{ fanout_next_call: call() }],
        co_funded_in_one_transaction: [{ recipient_count_next_call: call() }],
        unexpanded: [{ next_call: call() }],
        bridge_destinations_unread: [{ next_call: call() }],
        terminals: [{ entries_next_call: call() }],
        largest_pruned_page: { next_call: call() },
        explored: {
            terminals: [{ entries_next_call: call() }],
            largest_pruned_page: { next_call: call() },
        },
        objects_page: { next_call: call() },
        state_deltas: { read_more_with: call() },
        state_reads: { follow_up_calls: [call()], read_more_with: call() },
        objects_follow_up_calls: [call()],
        object_values_page: { next_call: call() },
        objects_unread_follow_up_calls: [call()],
        discovery_scan_next_call: call(),
        holdings_next_call: call(),
        staked_sui_count_next_call: call(),
        collections_next_call: call(),
        estimated_value: { next_call: call(), market_next_call: call() },
        valuation: { next_call: call(), market_next_call: call() },
        nft_scan_next_call: call(),
        nft_market_next_call: call(),
        owned_scan_next_call: call(),
        position_scan_next_call: call(),
        operated_scan: { next_call: call(), incomplete_transactions: [{ next_call: call() }] },
        leads: [{ listed_with_next_call: call() }],
        coverage: { not_recognised_types: [{ next_call: call() }] },
        holder_scan_next_call: call(),
        digest_listing: { next_call: call() },
        group_digest_listing: { next_call: call() },
        edges: [{ signals: [{ digest_listing: { next_call: call() } }] }],
        expansion_scan: { next_call: call() },
        reciprocal_scan: { next_call: call() },
        address_balances_next_call: call(),
        kiosk_cap_holder_next_call: call(),
        pnl: { senders_next_call: call(), digests_next_call: call(), transactions_next_call: call() },
        event_types_page: { next_call: call() },
        bytecode_scan: { version_gates: { next_call: call() } },
        events: [{ parsed: { next_call: call() } }],
    };
    expect(bindContinuationNetwork(payload, "testnet")).toBe(true);
    const all = calls(payload);
    expect(all.filter((entry) => entry.args?.network === "testnet")).toHaveLength(49);
    expect(payload.events[0].parsed.next_call.args).not.toHaveProperty("network");
});

describe("continuations stay on the originating chain", () => {
  it.each([
    { tool: "decode_ptb", args: { digest: DIGEST }, path: "commands_omitted.next_call", next: "decode_ptb" },
    { tool: "get_transaction", args: { digest: DIGEST, detail: "full" }, path: "commands_omitted.next_call", next: "decode_ptb" },
    { tool: "get_transaction", args: { digest: DIGEST, detail: "full", commands: [0] }, path: "inputs_omitted.next_call", next: "get_transaction" },
    { tool: "query_events", args: { sender: OWNER, limit: 1 }, path: "scan.next_call", next: "query_events" },
    { tool: "query_transactions", args: { sender: OWNER, limit: 1 }, path: "scan.next_call", next: "query_transactions" },
    { tool: "aggregate_events", args: { sender: OWNER, max_reads: 1 }, path: "scan.next_call", next: "aggregate_events" },
    { tool: "get_wallet_packages", args: { address: OWNER }, path: "scan.next_call", next: "get_wallet_packages" },
    { tool: "get_wallet_overview", args: { address: OWNER }, path: "package_activity.scan.next_call", next: "get_wallet_packages" },
    { tool: "get_wallet_overview", args: { address: OWNER }, path: "recent_transactions_next_call", next: "get_transaction_history" },
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

  it("identify_address (package_activity_next_call) retries a failed package scan on testnet", async () => {
    const WALLET = `0x${"22".repeat(32)}`;
    sui.getBalance.mockResolvedValue({ balance: { coinType: "0x2::sui::SUI", balance: "0" } });
    sui.nameService.reverseLookupName.mockResolvedValue({ response: {} });
    sui.listBalances.mockResolvedValue({ balances: [] });
    const answer = query.getMockImplementation()!;
    let scanFails = true;
    query.mockImplementation(async (q: string, vars: unknown) => {
      if (scanFails && String(q).includes("sentAddress: $address")) {
        reads.push(getNetwork());
        throw new Error("GraphQL request failed (503)");
      }
      return answer(q, vars);
    });
    const original = { address: WALLET, network: "testnet" };
    const registered = tools.get("identify_address")!;
    const result = await registered.handler(registered.schema.parse(original));
    expect(result.isError, result.content[0].text).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.type).toBe("wallet");
    expect(payload.package_activity).toBeNull();
    expect(payload.package_activity_next_call).toMatchObject({ tool: "get_wallet_packages", args: { address: WALLET } });
    for (const continuation of calls(payload)) {
      expect((continuation.args ?? { ...original, ...continuation.repeat_with }).network ?? DEFAULT_NETWORK).toBe("testnet");
    }
    scanFails = false;
    reads = [];
    const target = tools.get("get_wallet_packages")!;
    const followed = await target.handler(target.schema.parse(payload.package_activity_next_call.args));
    expect(followed.isError, followed.content[0].text).toBeUndefined();
    expect(new Set(reads)).toEqual(new Set(["testnet"]));
  });

  it("uses the stored chain, not the resource reader's chain, for calls and repeat args", () => {
    const id = saveResult("testnet", "diff_package_upgrade", { package: OWNER }, {
            diff: {
                changed_modules: [
        { sample_next_call: { tool: "disassemble_module", args: { package_id: OWNER, module_name: "pool" } } },
        { sample_next_call: { tool: "diff_package_upgrade", repeat_with: { max_sample_lines: 200 } } },
                ]
            },
    })!;
    const root = runWithNetwork("devnet", () => readStoredResult(id, {}));
    expect((root.args as Args).network ?? DEFAULT_NETWORK).toBe("testnet");
    const first = runWithNetwork("mainnet", () => readStoredResult(id, { path: "diff.changed_modules", limit: "1" }));
    expect(calls(first)[0].args?.network ?? DEFAULT_NETWORK).toBe("testnet");
    const uri = new URL(first.next_page as string);
    const second = runWithNetwork("devnet", () => readStoredResult(id, Object.fromEntries(uri.searchParams)));
    const repeat = calls(second)[0];
    expect({ ...(root.args as Args), ...repeat.repeat_with }).toMatchObject({ network: "testnet", max_sample_lines: 200 });
    const nested = runWithNetwork("devnet", () => readStoredResult(id, { path: "diff.changed_modules.0.sample_next_call" }));
    expect(calls(nested)[0].args?.network ?? DEFAULT_NETWORK).toBe("testnet");
  });

  it("does not rewrite decoded event data or stored object content that resembles a call", async () => {
    const decoded = {
      tool: "router", args: { amount: "1" },
      next_call: { tool: "get_transaction", args: { digest: DIGEST } },
      omitted: { next_call: { tool: "decode_ptb", args: { digest: DIGEST } } },
    };
        query.mockResolvedValue({
            events: {
      nodes: [{ contents: { type: { repr: "0x2::router::Event" }, json: decoded }, transaction: { digest: DIGEST } }],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            }
        });
    const registered = tools.get("query_events")!;
    const result = await registered.handler(registered.schema.parse({ sender: OWNER, network: "testnet" }));
    expect(result.isError, result.content[0].text).toBeUndefined();
    expect(JSON.parse(result.content[0].text).events[0].data).toEqual(decoded);
    const id = saveResult("testnet", "get_object", { object_id: OWNER }, { content: decoded })!;
    const stored = runWithNetwork("devnet", () => readStoredResult(id, { path: "content" }));
    expect(stored.value).toEqual(decoded);
  });
});
