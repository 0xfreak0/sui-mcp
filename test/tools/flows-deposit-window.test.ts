import { describe, expect, it, vi } from "vitest";
import { gqlPage } from "../helpers/service-shapes.js";
import { registerFlowTools } from "../../src/tools/flows.js";
import { rememberDepositVerdict } from "../../src/utils/deposit-role.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../../src/utils/identity.js", async (original) => ({
  ...(await original<object>()),
  describeAddresses: async (addresses: string[]) => new Map(addresses.map((address) => [address, { address, kind: "wallet" }])),
  fetchKinds: async (addresses: string[]) => new Map(addresses.map((address) => [address, { kind: "wallet" }])),
}));
const subject = "0x" + "ac".repeat(32);
const source = "0x" + "bd".repeat(32);
const recipient = "0x" + "ce".repeat(32);
const sponsor = "0x" + "df".repeat(32);
const coin = "0x2::sui::SUI";
const row = (address: string, amount: string) => ({ owner: { address }, coinType: { repr: coin }, amount });

function observe(address: string, after: number, before: number) {
  rememberDepositVerdict({
    address, verdict: "likely", hot_wallet: "0x" + "ea".repeat(32),
    checks: { single_destination: true, full_balance_sweeps: true, sponsored_sweeps: true, sponsor_relayer_shaped: true, destination_is_exchange: true },
    checks_not_run: {}, reasons: [], balance_reconstruction: null,
    window: {
      from: after, to: before, after_checkpoint: after, before_checkpoint: before,
      oldest: null, newest: null, max_transactions: 50, scanned_transactions: 2,
      reads: 1, max_reads: 100, older_transactions_remaining: false, complete: true, note: "Synthetic observed window",
    },
  });
}

describe("flow counterparty deposit windows", () => {
  it("selects only incident-window observations for sources, recipients and gas sponsors, retaining classification bounds", async () => {
    for (const address of [source, recipient, sponsor]) observe(address, 70, 101);
    gqlQuery.mockResolvedValue({
      transactions: {
        nodes: [
          { digest: "in", sender: { address: source }, gasInput: { gasSponsor: { address: sponsor } }, kind: { commands: gqlPage([]) }, effects: {
            status: "SUCCESS", timestamp: null, checkpoint: { sequenceNumber: 19 },
            gasEffects: { gasSummary: { computationCost: "1", storageCost: "0", storageRebate: "0" } },
            balanceChanges: gqlPage([row(source, "-100"), row(subject, "100"), row(sponsor, "-1")]), events: gqlPage([]),
          } },
          { digest: "out", sender: { address: subject }, gasInput: { gasSponsor: { address: sponsor } }, kind: { commands: gqlPage([]) }, effects: {
            status: "SUCCESS", timestamp: null, checkpoint: { sequenceNumber: 20 },
            gasEffects: { gasSummary: { computationCost: "1", storageCost: "0", storageRebate: "0" } },
            balanceChanges: gqlPage([row(subject, "-100"), row(recipient, "100"), row(sponsor, "-1")]), events: gqlPage([]),
          } },
        ], pageInfo: { hasPreviousPage: false, startCursor: null },
      },
    });
    type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const tools = new Map<string, Handler>();
    registerFlowTools({ tool: (name: string, _description: string, _schema: unknown, handler: Handler) => tools.set(name, handler) } as never);
    const args = { address: subject, from: "10", to: "21", coin_type: coin };
    const result = JSON.parse((await tools.get("summarize_address_flows")!(args)).content[0].text);
    for (const counterparty of [result.inflow_sources[0], result.top_recipients[0], result.gas_sponsorship.sponsored_by[0]]) {
      expect(counterparty.deposit_address).toMatchObject({
        status: "not classified", role: null, other_session_observations: 1,
        next_call: { tool: "classify_deposit_address", args: { address: counterparty.address, from: "10", to: "21" } },
      });
      expect(counterparty.deposit_address.session_verdict).toBeUndefined();
    }
    observe(source, 10, 21);
    const matching = JSON.parse((await tools.get("summarize_address_flows")!(args)).content[0].text);
    expect(matching.inflow_sources[0].deposit_address).toMatchObject({
      role: "likely exchange deposit", session_verdict: { verdict: "likely", window: { after_checkpoint: 10, before_checkpoint: 21 } },
    });
    expect(matching.top_recipients[0].deposit_address.status).toBe("not classified");
  });
});
