import { describe, it, expect, vi } from "vitest";
import { Transaction, type TransactionPlugin } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { SuiClientTypes } from "@mysten/sui/client";

/**
 * `build_transfer` resolves a coin through the SDK's `coinWithBalance`
 * intent, which reads the client's core API at build time. The client is the
 * real one, so the SDK's own resolver runs; only the core methods that would
 * reach the network are stubbed, typed as the core responses.
 *
 * The sender is a real mainnet holder, 0xa766…0c07, whose CETUS sits entirely
 * in its address balance (coinBalance 0). Selecting from listCoins found no
 * coins for it and refused to build.
 */
const SENDER = "0xa766f11b571df4a5d00464bd1009d57b1e5457bc0be08e2dfc0ce14cb1a50c07";
const RECIPIENT = "0xa727cd9023836d0ac8435918ece422bc0b6a90c3086a5eea0c65a497402e0be6";
const CETUS = "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const gasCoin: SuiClientTypes.Coin = {
  objectId: "0x26c391bbb2a91d66d25218f9001b3252cde0b0f3887538e9f1d4ae662eee5caa",
  version: "876743621",
  digest: "ActF5NatiH1jK9zaYvPjoUAm8NnyRV9EuQZ7NqoQLkRV",
  owner: { $kind: "AddressOwner", AddressOwner: SENDER },
  type: `0x2::coin::Coin<${SUI}>`,
  balance: "5000000000",
};

// The gRPC client normally resolves gas server-side in one SimulateTransaction
// call. Returning no plugin makes the SDK fall back to its generic resolver,
// which reads the stubbed core methods below. The coinWithBalance intent under
// test resolves before either and is the same on both paths.
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "http://127.0.0.1:9" });
vi.spyOn(client.core, "resolveTransactionPlugin").mockReturnValue(undefined as unknown as TransactionPlugin);
vi.spyOn(client.core, "getBalance").mockImplementation(
  async ({ coinType }): Promise<SuiClientTypes.GetBalanceResponse> => ({
    balance:
      coinType === CETUS
        ? { coinType: CETUS, balance: "470091298300000", coinBalance: "0", addressBalance: "470091298300000" }
        : { coinType: SUI, balance: "5000000000", coinBalance: "5000000000", addressBalance: "0" },
  }),
);
vi.spyOn(client.core, "listCoins").mockImplementation(
  async ({ coinType }): Promise<SuiClientTypes.ListCoinsResponse> => ({
    objects: coinType === CETUS ? [] : [gasCoin],
    hasNextPage: false,
    cursor: null,
  }),
);
vi.spyOn(client.core, "getCurrentSystemState").mockResolvedValue({
  // Only the gas price is read while building.
  systemState: { referenceGasPrice: "100", epoch: "1261" } as SuiClientTypes.SystemStateInfo,
});
vi.spyOn(client.core, "simulateTransaction").mockResolvedValue({
  $kind: "Transaction",
  // Only the gas used is read while building.
  Transaction: {
    effects: {
      gasUsed: { computationCost: "100000", storageCost: "1976000", storageRebate: "978120", nonRefundableStorageFee: "9880" },
    },
  },
} as unknown as SuiClientTypes.SimulateTransactionResult<{ effects: true }>);

vi.spyOn(client.core, "getChainIdentifier").mockResolvedValue({
  chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
});

vi.mock("../../src/clients/grpc.js", () => ({ sui: client, archive: client }));

const { registerPtbTools } = await import("../../src/tools/ptb.js");

const tools = new Map<string, Function>();
registerPtbTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as Parameters<typeof registerPtbTools>[0]); // only `tool` is called during registration

describe("build_transfer for a coin other than SUI", () => {

  it("builds from the sender's address balance when it holds no coin objects", async () => {
    const result = await tools.get("build_transfer")!({
      sender: SENDER,
      recipient: RECIPIENT,
      coin_type: CETUS,
      amount: "1000000000",
    });
    expect(result.isError).toBeUndefined();

    const data = Transaction.from(JSON.parse(result.content[0].text).transaction_bcs).getData();
    const withdrawal = data.inputs.find((i) => i.$kind === "FundsWithdrawal")?.FundsWithdrawal;
    expect(withdrawal).toMatchObject({
      reservation: { MaxAmountU64: "1000000000" },
      typeArg: { Balance: CETUS },
      withdrawFrom: { $kind: "Sender" },
    });
    expect(data.commands.map((c) => c.$kind)).toEqual(["MoveCall", "TransferObjects"]);
    expect(data.commands[0].MoveCall).toMatchObject({ module: "coin", function: "redeem_funds" });
  });

  it("refuses an amount above what the sender holds in coins and address balance together", async () => {
    await expect(
      tools.get("build_transfer")!({
        sender: SENDER,
        recipient: RECIPIENT,
        coin_type: CETUS,
        amount: "470091298300001",
      }),
    ).rejects.toThrow(/Insufficient balance/);
  });
});
