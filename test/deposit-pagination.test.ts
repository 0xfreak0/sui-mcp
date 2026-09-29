import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyDepositAddress, readDepositPattern, scanForDeposit } from "../src/utils/deposit.js";
import { inboundSenders, inferDepositLabel, readWalletPage } from "../src/utils/deposit-labels.js";
import { addSessionLabel, removeSessionLabel } from "../src/utils/labels.js";
import { measureFanout } from "../src/utils/fanout.js";
import { registerFundingTools } from "../src/tools/funding.js";
import type * as FanoutModule from "../src/utils/fanout.js";
import type { FanoutResult } from "../src/utils/fanout.js";
import type { GqlBalanceChangeNode } from "../src/utils/gql-adapters.js";
import type * as ValuationModule from "../src/utils/valuation.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/utils/fanout.js", async (original) => ({
  ...(await original<typeof FanoutModule>()),
  measureFanout: vi.fn(),
}));

vi.mock("../src/utils/valuation.js", async (original) => ({
  ...(await original<typeof ValuationModule>()),
  prefetchCoinScale: vi.fn().mockResolvedValue(undefined),
}));

const addr = (byte: string) => "0x" + byte.repeat(32);
const SUBJECT = addr("d1");
const HOT = addr("a1");
const CUSTOMER = addr("c1");
const SPONSOR = addr("5e");
const SUI = "0x" + "0".repeat(63) + "2::sui::SUI";
const OTHER_COIN = addr("f1") + "::test::TOKEN";
const row = (owner: string, amount: string, coin = SUI) => ({ owner: { address: owner }, amount, coinType: { repr: coin } });
const padding = Array.from({ length: 48 }, (_, i) => row("0x" + (i + 256).toString(16).padStart(64, "0"), "-1", OTHER_COIN));
const node = (digest: string, sender: string, changes: GqlBalanceChangeNode[], more = false) => ({
  digest,
  sender: { address: sender },
  gasInput: { gasSponsor: { address: SPONSOR } },
  effects: {
    timestamp: null,
    balanceChanges: { nodes: changes, pageInfo: { hasNextPage: more, endCursor: more ? "after-50" : null } },
  },
});
const ctx = { exchangeWallets: new Map([[HOT, "SyntheticExchange"]]), labelled: new Set<string>() };

function serve(missing: "destination" | "subject" | "other-recipient", fail = false) {
  const first = missing === "other-recipient"
    ? [row(SUBJECT, "-100"), row(HOT, "99")]
    : [missing === "destination" ? row(SUBJECT, "-100") : row(HOT, "100"), row(SPONSOR, "5")];
  const decisive = missing === "other-recipient"
    ? row(addr("b1"), "1")
    : missing === "destination" ? row(HOT, "100") : row(SUBJECT, "-100");
  const nodes = [
    node("deposit-1", CUSTOMER, [row(CUSTOMER, "-100"), row(SUBJECT, "100")]),
    node("sweep-1", SUBJECT, [row(SUBJECT, "-100"), row(HOT, "100")]),
    node("deposit-2", CUSTOMER, [row(CUSTOMER, "-100"), row(SUBJECT, "100")]),
    node("sweep-2", SUBJECT, [...first, ...padding], true),
  ];
  gqlQuery.mockImplementation(async (_query: string, vars: { digest?: string; after?: string }) => {
    if (vars.digest) {
      if (vars.digest !== "sweep-2" || vars.after !== "after-50") throw new Error("Unexpected continuation");
      if (fail) throw new Error("Synthetic continuation unavailable");
      return { transactionEffects: { balanceChanges: { nodes: [decisive], pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    return {
      address: { balances: { nodes: [{ coinType: { repr: SUI }, totalBalance: "0" }], pageInfo: { hasNextPage: false } } },
      transactions: { nodes, pageInfo: { hasPreviousPage: false, startCursor: null } },
    };
  });
}

beforeEach(() => {
  gqlQuery.mockReset();
  addSessionLabel(HOT, { label: "Synthetic exchange wallet", category: "cex" });
});
afterEach(() => {
  removeSessionLabel(HOT);
  vi.mocked(measureFanout).mockReset();
});

describe("deposit balance-change pagination", () => {
  it.each(["destination", "subject"] as const)("uses a %s row after 50 to classify and infer both sweeps", async (missing) => {
    serve(missing);
    const result = await classifyDepositAddress(SUBJECT, { measureSponsor: false, measureDestination: false });
    expect(result.verdict).toBe("likely");
    expect(result.sweeps.map((s) => [s.digest, s.full_balance])).toEqual([["sweep-2", true], ["sweep-1", true]]);
    expect(inferDepositLabel(await scanForDeposit(SUBJECT), ctx)).toMatchObject({
      kind: "deposit",
      deposit: { swept_to: HOT, sweep_count: 2, evidence_txs: ["sweep-1", "sweep-2"] },
    });
  });

  it("completes exchange wallet pages before finding senders and inferring labels", async () => {
    serve("destination");
    const page = await readWalletPage(HOT, null);
    expect(inboundSenders([page.txs[3]!], HOT)).toEqual([SUBJECT]);
    const scan = { address: SUBJECT, txs: page.txs, complete: page.before === null, currentBalances: new Map([[SUI, 0n]]) };
    expect(readDepositPattern(scan).otherOutflows).toEqual([]);
    expect(inferDepositLabel(scan, ctx)).toMatchObject({ kind: "deposit", deposit: { sweep_count: 2 } });
  });

  it.each(["destination", "subject", "other-recipient"] as const)("withholds the verdict when the %s continuation fails", async (missing) => {
    serve(missing, true);
    const result = await classifyDepositAddress(SUBJECT, { measureSponsor: false, measureDestination: false });
    expect(result.verdict).toBe("unknown");
    expect(result).toMatchObject({ window_complete: false, incomplete_transactions: ["sweep-2"], sweep_count: null, deposit_count: null });
    expect(Object.values(result.checks)).toEqual([null, null, null, null, null]);
    expect(Object.keys(result.checks_not_run).sort()).toEqual(Object.keys(result.checks).sort());
    expect(result.reasons.join(" ")).toMatch(/incomplete.*sweep-2/i);
    await expect(scanForDeposit(SUBJECT).then((scan) => inferDepositLabel(scan, ctx))).rejects.toThrow(/incomplete.*sweep-2/i);
    await expect(readWalletPage(HOT, null)).rejects.toThrow(/incomplete.*sweep-2/i);
  });

  it("rejects an apparent deposit when a second recipient appears after 50", async () => {
    serve("other-recipient");
    expect(inferDepositLabel(await scanForDeposit(SUBJECT), ctx)).toEqual({ kind: "rejected", reason: "other-outflow" });
    const result = await classifyDepositAddress(SUBJECT, { measureSponsor: false, measureDestination: false });
    expect(result.verdict).toBe("no");
    expect(result.checks.single_destination).toBe(false);
  });

  it("exposes an unread deposit check through get_address_fanout", async () => {
    serve("destination", true);
    vi.mocked(measureFanout).mockResolvedValue({ classification: "narrow", recipient_count: 1, sender_count: 1 } as FanoutResult);
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
    registerFundingTools({ tool: (name: string, _d: string, _s: unknown, handler: never) => tools.set(name, handler) } as never);
    const result = JSON.parse((await tools.get("get_address_fanout")!({ address: SUBJECT })).content[0]!.text);
    expect(result.deposit_address.verdict).toBe("unknown");
    expect(result.deposit_address.reasons.join(" ")).toMatch(/incomplete.*sweep-2/i);
    expect(result.deposit_address.hot_wallet).toBeNull();
  });
});
