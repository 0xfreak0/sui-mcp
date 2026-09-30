import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyDepositAddress } from "../src/utils/deposit.js";
import { addSessionLabel, removeSessionLabel } from "../src/utils/labels.js";
import type * as ValuationModule from "../src/utils/valuation.js";
import type { GqlBalanceChangeNode } from "../src/utils/gql-adapters.js";
import { depositRole } from "../src/utils/deposit-role.js";
import { runWithNetwork } from "../src/config.js";
import { registerLabelTools } from "../src/tools/labels.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/utils/valuation.js", async (original) => ({
  ...(await original<typeof ValuationModule>()),
  prefetchCoinScale: vi.fn().mockResolvedValue(undefined),
}));
const address = "0x" + "d3".repeat(32);
const hot = "0x" + "e3".repeat(32);
const customer = "0x" + "c3".repeat(32);
const coin = "0x" + "0".repeat(63) + "2::sui::SUI";
const row = (owner: string, amount: string) => ({ owner: { address: owner }, coinType: { repr: coin }, amount });
const tx = (digest: string, cp: number, changes: GqlBalanceChangeNode[]) => ({
  digest, sender: { address }, gasInput: { gasSponsor: { address: customer } },
  effects: { timestamp: new Date(cp * 1000).toISOString(), checkpoint: { sequenceNumber: cp }, balanceChanges: { nodes: changes, pageInfo: { hasNextPage: false } } },
});
const opts = { measureSponsor: false, measureDestination: false };
function serve() {
  gqlQuery.mockImplementation(async (query: string, vars: Record<string, any>) => {
    if (query.includes("availableRange")) return { serviceConfig: { availableRange: { first: { sequenceNumber: 90, timestamp: null }, last: { sequenceNumber: 110, timestamp: null } } } };
    const historical = vars.filter?.beforeCheckpoint === 21;
    const reconstruction = vars.filter?.afterCheckpoint === 20;
    const nodes = reconstruction ? [tx("later-deposit", 80, [row(customer, "-3000000000"), row(address, "3000000000")])]
      : historical ? [tx("old-sweep", 20, [row(address, "-100"), row(hot, "100")])]
      : [tx("recent-deposit", 80, [row(customer, "-3000000000"), row(address, "3000000000")])];
    return {
      address: { balances: { nodes: [{ coinType: { repr: coin }, totalBalance: "3000000000" }], pageInfo: { hasNextPage: false } } },
      transactions: { nodes, pageInfo: { hasPreviousPage: false, startCursor: null } },
    };
  });
}
beforeEach(() => { gqlQuery.mockReset(); addSessionLabel(hot, { label: "Synthetic exchange", category: "cex" }); });
afterEach(() => { removeSessionLabel(hot); });

describe("deposit verdict windows", () => {
  it("judges historical sweeps against the balance then, not a later deposit", async () => {
    serve();
    expect((await classifyDepositAddress(address, opts)).verdict).toBe("unknown");
    const result = await classifyDepositAddress(address, { ...opts, from: 10, to: 21 });
    expect(result.verdict).toBe("likely");
    expect(result.sweeps[0]).toMatchObject({ digest: "old-sweep", full_balance: true, coins: [{ balance_after_raw: "0" }] });
    expect(result.window).toMatchObject({ after_checkpoint: 10, before_checkpoint: 21, oldest: { checkpoint: 20 }, newest: { checkpoint: 20 }, complete: true });
  });

  it("states the actual recent window and the next older window when capped", async () => {
    serve();
    const base = gqlQuery.getMockImplementation()!;
    gqlQuery.mockImplementation(async (q: string, v: Record<string, any>) => {
      const r = await base(q, v);
      r.transactions.pageInfo = { hasPreviousPage: true, startCursor: "older" };
      return r;
    });
    const result = await classifyDepositAddress(address, { ...opts, last: 1 });
    expect(result.window_complete).toBe(false);
    expect(result.window).toMatchObject({ complete: false, max_transactions: 1, oldest: { checkpoint: 80 }, newest: { checkpoint: 80 }, continue_with: { to: "81" } });
  });

  it("does not call a partial historical reconstruction a full-balance sweep", async () => {
    serve();
    const base = gqlQuery.getMockImplementation()!;
    gqlQuery.mockImplementation(async (q: string, v: Record<string, any>) => {
      const r = await base(q, v);
      if (v?.filter?.afterCheckpoint === 20) r.transactions.pageInfo = { hasPreviousPage: true, startCursor: "older" };
      return r;
    });
    const result = await classifyDepositAddress(address, { ...opts, from: 10, to: 21, maxBalanceTransactions: 1 });
    expect(result.verdict).toBe("unknown");
    expect(result.checks.full_balance_sweeps).toBeNull();
    expect(result.balance_reconstruction).toMatchObject({ complete: false, scanned_transactions: 1, max_transactions: 1 });
  });

  it("shares independent window verdicts without creating a trace sink or crossing networks", async () => {
    serve();
    await runWithNetwork("mainnet", async () => {
      await classifyDepositAddress(address, { ...opts, from: 10, to: 21 });
      await classifyDepositAddress(address, opts);
      expect(depositRole(address, { from: 10, to: 21 })).toMatchObject({
        role: "likely exchange deposit", verdict: "likely", stops_trace: false,
      });
      expect(depositRole(address, {})).toMatchObject({ role: null, verdict: "unknown" });
      expect(depositRole(address, { from: 30, to: 40 })).toMatchObject({
        status: "not classified", role: null,
        next_call: { tool: "classify_deposit_address", args: { address, network: "mainnet", from: 30, to: 40 } },
      });
      addSessionLabel(address, { label: "Investigator attribution", category: "other" });
      expect(depositRole(address, { from: 10, to: 21 })).toMatchObject({ role: null, stops_trace: false });
      removeSessionLabel(address);
    });
    expect(runWithNetwork("testnet", () => depositRole(address))).toMatchObject({
      status: "not classified", role: null, next_call: { args: { network: "testnet" } },
    });
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
    registerLabelTools({ tool: (name: string, _d: string, _s: unknown, h: never) => tools.set(name, h) } as never);
    gqlQuery.mockRejectedValue(new Error("Role lookup must not read the chain"));
    const lookup = JSON.parse((await tools.get("manage_labels")!({ action: "lookup", address })).content[0]!.text);
    expect(lookup.deposit_address.session_verdicts.map((r: { verdict: string }) => r.verdict)).toEqual(["unknown", "likely"]);
    expect(lookup.is_sink).toBe(false);
  });
});
