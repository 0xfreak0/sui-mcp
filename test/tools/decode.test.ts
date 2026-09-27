import { describe, it, expect, vi } from "vitest";
import fixture from "../fixtures/address-balance-txs.json" with { type: "json" };
import { createMockClient } from "../helpers/mock-grpc.js";

// Signatures are read over gRPC to decode pure arguments; none is readable here.
const mockSui = createMockClient();
mockSui.getMoveFunction.mockRejectedValue(new Error("offline"));
vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));

const { registerDecodeTools } = await import("../../src/tools/decode.js");

const tools = new Map<string, Function>();
registerDecodeTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as Parameters<typeof registerDecodeTools>[0]); // only `tool` is called during registration

const decode = async (transaction_bcs: string) =>
  JSON.parse((await tools.get("decode_ptb")!({ transaction_bcs })).content[0].text);

describe("decode_ptb on address-balance withdrawals", () => {
  /**
   * The signed bytes of mainnet CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay
   * (GraphQL `transactionBcs`): withdraw 1951 MIST of SUI from the sender's
   * address balance, redeem it and send_funds it on. The decoded withdrawal
   * input carries its amount, the one number a drainer PTB turns on.
   */
  it("shows the amount, coin type and source of a FundsWithdrawal input", async () => {
    const j = await decode(fixture.CD2e4_transaction_bcs);
    expect(j.inputs[1]).toEqual({
      type: "FundsWithdrawal",
      amount: "1951",
      coin_type: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
      withdraw_from: "Sender",
    });
  });

  it("reports an empty gas payment as gas paid from the address balance", async () => {
    const j = await decode(fixture.CD2e4_transaction_bcs);
    expect(j.gas_source).toBe("address_balance");
    expect(j.gas_coins).toBeUndefined();
  });
});

describe("decode_ptb on bytes that are not one transaction", () => {
  // BCS parsing stops where the struct ends, so 10,000 base64 'A's decoded
  // as a transaction from 0x0 with no commands and the rest was ignored.
  it("refuses bytes left over after the transaction data", async () => {
    const result = await tools.get("decode_ptb")!({ transaction_bcs: "A".repeat(10_000) });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/^Not one transaction: the first \d+ bytes decode .* and \d+ bytes follow it\.$/);
  });

  it("still decodes a real transaction that ends where its bytes end", async () => {
    const result = await tools.get("decode_ptb")!({ transaction_bcs: fixture.CD2e4_transaction_bcs });
    expect(result.isError).toBeUndefined();
  });
});

describe("decode_ptb arguments", () => {
  it("takes exactly one of transaction_bcs and digest", async () => {
    const both = await tools.get("decode_ptb")!({ transaction_bcs: fixture.CD2e4_transaction_bcs, digest: "CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay" });
    const neither = await tools.get("decode_ptb")!({});
    expect(both.isError).toBe(true);
    expect(neither.isError).toBe(true);
    expect(mockSui.ledgerService.getTransaction).not.toHaveBeenCalled();
  });

  it("names the Move calls whose signatures could not be read and keeps their pure arguments as bytes", async () => {
    const j = await decode(fixture.CD2e4_transaction_bcs);
    const calls = j.commands.filter((c: { type: string }) => c.type === "MoveCall");
    expect(j.signatures_unavailable).toEqual([...new Set(calls.map((c: { target: string }) => c.target))]);
    // send_funds' recipient: raw bytes, still read as address-shaped for the anomaly pass.
    const recipient = j.commands[1].arguments[1];
    expect(recipient.value_type).toBeUndefined();
    expect(recipient.bytes).toBe(j.inputs[0].bytes);
    expect(recipient.address).toBe(j.inputs[0].possible_address);
  });
});

describe("decode_ptb anomaly checks", () => {
  it("names every check it ran and, for bytes not yet signed, points to the simulation that shows the effects", async () => {
    const j = await decode(fixture.CD2e4_transaction_bcs);
    expect(j.checks_run.map((c: { code: string }) => c.code)).toEqual(
      expect.arrayContaining(["unverified-package-call", "stale-package-version", "transfers-to-non-sender", "blocklisted-package-call"]),
    );
    expect(j.checks_note).toContain("simulate_transaction");
  });
});
