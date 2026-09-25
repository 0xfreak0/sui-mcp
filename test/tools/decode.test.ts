import { describe, it, expect } from "vitest";
import fixture from "../fixtures/address-balance-txs.json" with { type: "json" };
import { registerDecodeTools } from "../../src/tools/decode.js";

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
   * address balance, redeem it and send_funds it on. The withdrawal input came
   * back as a bare `{type: "FundsWithdrawal"}`, hiding the one number a
   * drainer PTB turns on.
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
