import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import fixture from "../fixtures/address-balance-txs.json" with { type: "json" };

/**
 * A real mainnet digest. get_transaction rejects a malformed one before making
 * any request, so a placeholder like "TxDigest123" no longer reaches the
 * handler under test.
 */
const TEST_DIGEST = "6rbfmByTyP4k7EREQBV9XZNhaG4RPm2ExT5bhVDfhGpu";
/** A second one, so the archive case stays distinguishable from the fullnode case. */
const ARCHIVED_DIGEST = "CBjycKjVXizZ2VcxVjE2u6xBhP8YJgSgLziZA7N7crXK";

const mockSui = createMockClient();
const mockArchive = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockArchive,
}));

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: mockGqlQuery,
}));

const { registerTransactionTools } = await import("../../src/tools/transactions.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerTransactionTools(mockServer);

describe("get_transaction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns decoded transaction with protocol info", async () => {
    mockSui.ledgerService.getTransaction.mockResolvedValue({
      response: {
        transaction: {
          digest: TEST_DIGEST,
          timestamp: { seconds: 1700000000n, nanos: 0 },
          checkpoint: 50000n,
          transaction: {
            sender: "0xsender",
            kind: {
              data: {
                oneofKind: "programmableTransaction",
                programmableTransaction: {
                  commands: [
                    {
                      command: {
                        oneofKind: "moveCall",
                        moveCall: {
                          package: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
                          module: "pool",
                          function: "swap_a2b",
                          typeArguments: [
                            "0x2::sui::SUI",
                            "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          effects: {
            status: { success: true },
            gasUsed: {
              computationCost: 1000n,
              storageCost: 2000n,
              storageRebate: 500n,
              nonRefundableStorageFee: 100n,
            },
            epoch: 500n,
          },
          events: { events: [] },
          balanceChanges: [
            { address: "0xsender", coinType: "0x2::sui::SUI", amount: "-1000000000" },
            { address: "0xsender", coinType: "0xdba::usdc::USDC", amount: "500000" },
          ],
        },
      },
    });

    const handler = tools.get("get_transaction")!;
    const result = await handler({ digest: TEST_DIGEST });
    const data = JSON.parse(result.content[0].text);

    expect(data.digest).toBe(TEST_DIGEST);
    expect(data.sender).toBe("0xsender");
    expect(data.status).toBe("success");
    expect(data.protocols).toContain("Cetus");
    expect(data.actions[0]).toContain("Swap");
    expect(data.token_flow).toHaveLength(2);
    expect(data.gas.computation_cost).toBe("1000");
  });

  it("falls back to archive on fullnode error", async () => {
    mockSui.ledgerService.getTransaction.mockRejectedValue(new Error("not found"));
    mockArchive.ledgerService.getTransaction.mockResolvedValue({
      response: {
        transaction: {
          digest: ARCHIVED_DIGEST,
          transaction: { sender: "0xsender", kind: { data: { oneofKind: undefined } } },
          effects: { status: { success: true } },
          events: { events: [] },
          balanceChanges: [],
        },
      },
    });

    const handler = tools.get("get_transaction")!;
    const result = await handler({ digest: ARCHIVED_DIGEST });
    const data = JSON.parse(result.content[0].text);

    expect(data.digest).toBe(ARCHIVED_DIGEST);
    expect(mockArchive.ledgerService.getTransaction).toHaveBeenCalled();
  });
});

describe("query_transactions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns filtered transactions from GraphQL", async () => {
    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: [
          {
            digest: "Tx1",
            sender: { address: "0xsender" },
            effects: {
              status: "SUCCESS",
              checkpoint: { sequenceNumber: 100 },
              timestamp: "2024-01-01T00:00:00Z",
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const handler = tools.get("query_transactions")!;
    const result = await handler({
      sender: "0xsender",
      affected_address: undefined,
      affected_object: undefined,
      function: undefined,
      after_checkpoint: undefined,
      before_checkpoint: undefined,
      limit: 10,
      after: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0].digest).toBe("Tx1");
    expect(data.has_next_page).toBe(false);
  });

  it("rejects multiple exclusive filters", async () => {
    const handler = tools.get("query_transactions")!;
    const result = await handler({
      sender: undefined,
      affected_address: "0xaddr",
      affected_object: "0xobj",
      function: undefined,
      after_checkpoint: undefined,
      before_checkpoint: undefined,
      limit: undefined,
      after: undefined,
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("Only one of");
  });
});

/**
 * What the tool says when a transaction moved no coin.
 *
 * These assert on the HANDLER's output, not on the helpers it calls. The first
 * version of this cover exercised `summarizeObjectChanges` and `custodyChanges`
 * directly, so reverting the owner kind to a bare address — the exact defect it
 * was written to guard — left the whole suite green.
 */
describe("get_transaction reports what a transaction touched", () => {
  const EMPTY = "F7xprc5y7LmkzMQqRjaEWexzupdtFTSPUXoF49GNepjY";

  /** A transaction with no commands, whose one changed object is its own gas coin. */
  function emptyTx(overrides: Record<string, unknown> = {}) {
    return {
      response: {
        transaction: {
          digest: EMPTY,
          timestamp: { seconds: 1700000000n, nanos: 0 },
          checkpoint: 50000n,
          transaction: {
            sender: "0xsender",
            kind: {
              data: {
                oneofKind: "programmableTransaction",
                programmableTransaction: { inputs: [], commands: [] },
              },
            },
          },
          effects: {
            status: { success: true },
            gasUsed: { computationCost: 1n, storageCost: 1n, storageRebate: 1n, nonRefundableStorageFee: 1n },
            epoch: 500n,
            changedObjects: [
              {
                objectId: "0xgascoin",
                objectType: "0x2::coin::Coin<0x2::sui::SUI>",
                idOperation: 1,
                inputState: 2,
                inputOwner: { kind: 1, address: "0xsender" },
                outputOwner: { kind: 1, address: "0xsender" },
              },
            ],
            ...(overrides.effects as object ?? {}),
          },
          events: { events: [] },
          balanceChanges: [],
        },
      },
    };
  }

  const run = async (payload: unknown, digest = EMPTY) => {
    mockSui.ledgerService.getTransaction.mockResolvedValue(payload);
    mockGqlQuery.mockResolvedValue({ transactionBlock: null });
    const r = await tools.get("get_transaction")!({ digest, max_event_field_bytes: 0 });
    return JSON.parse(r.content[0].text);
  };

  it("reports a command count of zero rather than only an empty actions list", async () => {
    const j = await run(emptyTx());
    expect(j.command_count).toBe(0);
    expect(j.actions).toEqual([]);
    expect(j.empty_transaction_note).toMatch(/ran no commands/);
  });

  it("counts the objects it touched", async () => {
    const j = await run(emptyTx());
    expect(j.object_changes).toEqual({ changed: 1, created: 0, deleted: 0 });
  });

  /**
   * A kiosk-held NFT is owned by the Kiosk object. Reporting a bare address
   * made a kiosk id read as a wallet, on a real TradePort sale where BOTH
   * parties were kiosks.
   */
  it("names each party's owner KIND, so a kiosk is not reported as a wallet", async () => {
    const kioskSale = emptyTx({
      effects: {
        status: { success: true },
        gasUsed: { computationCost: 1n, storageCost: 1n, storageRebate: 1n, nonRefundableStorageFee: 1n },
        epoch: 500n,
        changedObjects: [
          {
            objectId: "0xnft",
            objectType: "0xabc::popkins_nft::Popkins",
            idOperation: 1,
            inputState: 2,
            inputOwner: { kind: 2, address: "0xsellerkiosk" },
            outputOwner: { kind: 2, address: "0xbuyerkiosk" },
          },
        ],
      },
    });
    const j = await run(kioskSale);
    expect(j.object_transfers).toHaveLength(1);
    expect(j.object_transfers[0]).toMatchObject({
      kind: "transferred",
      from: { kind: "object", address: "0xsellerkiosk" },
      to: { kind: "object", address: "0xbuyerkiosk" },
    });
  });

  /** The note a capability handover carries is the loudest finding this tool has. */
  it("carries the note explaining what a transferred capability grants", async () => {
    const capMove = emptyTx({
      effects: {
        status: { success: true },
        gasUsed: { computationCost: 1n, storageCost: 1n, storageRebate: 1n, nonRefundableStorageFee: 1n },
        epoch: 500n,
        changedObjects: [
          {
            objectId: "0xcap",
            objectType: "0x2::package::UpgradeCap",
            idOperation: 1,
            inputState: 2,
            inputOwner: { kind: 1, address: "0xold" },
            outputOwner: { kind: 1, address: "0xnew" },
          },
        ],
      },
    });
    const j = await run(capMove);
    expect(j.object_transfers[0]).toMatchObject({ high_consequence: true });
    expect(j.object_transfers[0].note).toMatch(/publish new code/i);
  });

  it("omits object_transfers when nothing changed hands", async () => {
    const j = await run(emptyTx());
    expect(j.object_transfers).toBeUndefined();
  });
});

/**
 * Funds that move without a coin object. The effects, inputs and gas payment
 * are real gRPC responses captured from mainnet (test/fixtures), with the
 * fixture's `"123n"` strings revived as the bigints the client returns.
 */
describe("get_transaction reports address-balance activity", () => {
  const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

  type Captured = (typeof fixture)["CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay"];
  function response(digest: keyof typeof fixture) {
    const fx: Captured = JSON.parse(JSON.stringify(fixture[digest]), (_k, v) =>
      typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    );
    return {
      response: {
        transaction: {
          digest,
          timestamp: { seconds: 1790000000n, nanos: 0 },
          checkpoint: 326000000n,
          transaction: {
            sender: fx.sender,
            gasPayment: fx.gasPayment,
            kind: {
              data: {
                oneofKind: "programmableTransaction",
                programmableTransaction: { inputs: fx.inputs, commands: [] },
              },
            },
          },
          effects: {
            status: { success: true },
            gasUsed: { computationCost: 100000n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n },
            epoch: 1254n,
            changedObjects: fx.changedObjects,
          },
          events: { events: [] },
          balanceChanges: fx.balanceChanges,
        },
      },
    };
  }

  const run = async (digest: "CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay" | "34q8kUTe8Uoe3f6cD5wKmS7ZqgYg3uX8J7nAJEuGeGTF" | "8eHgw5hBnALFJKPstXWcPgKjeh1av1CzFAz8n85Primr") => {
    mockSui.ledgerService.getTransaction.mockResolvedValue(response(digest));
    const r = await tools.get("get_transaction")!({ digest, max_event_field_bytes: 0 });
    return JSON.parse(r.content[0].text);
  };

  /**
   * CD2e4… redeemed 1951 MIST from the sender's address balance and sent it
   * on, paying gas from the address balance too. No object was written, yet
   * it reported two changed objects and "none changed hands".
   */
  it("shows withdrawals and deposits instead of phantom object changes", async () => {
    const j = await run("CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay");
    expect(j.object_changes).toEqual({ changed: 0, created: 0, deleted: 0 });
    expect(j.object_changes_note).toBeUndefined();
    expect(j.address_balance_ops).toEqual([
      { owner: "0xb71effa1cc4425928e0bda7c3b690a356245e705b01b5380b5d4d1a3497c1d47", coin_type: SUI, op: "deposit", amount: "1951" },
      { owner: "0x7c8e2ceb0839680a3b1f7aa1021d45670405d92f3c88e79aa1d3aa8a600bbdbf", coin_type: SUI, op: "withdraw", amount: "101951" },
    ]);
    expect(j.funds_withdrawals).toEqual([{ amount: "1951", coin_type: SUI, source: "sender" }]);
    expect(j.gas_source).toBe("address_balance");
  });

  /**
   * 34q8k…: a 704,848 SUI gas coin was deleted and merged into its owner's
   * address balance while balance_changes showed only the -100k payment.
   */
  it("flags a coin folded into its owner's address balance", async () => {
    const j = await run("34q8kUTe8Uoe3f6cD5wKmS7ZqgYg3uX8J7nAJEuGeGTF");
    const own = j.address_balance_ops.find(
      (o: { owner: string }) => o.owner === "0xa727cd9023836d0ac8435918ece422bc0b6a90c3086a5eea0c65a497402e0be6",
    );
    expect(own.converted_from_coins).toEqual(["0x6b0e59544cd4d7c161e038fa13b6fb7314f442c1f86d2b0ce55576367469c40e"]);
    expect(own.note).toMatch(/no value moved/);
    expect(j.gas_source).toBe("coins_and_address_balance");
  });

  /**
   * 8eHgw5…: Cetus's multisig minted MessageFromCetus NFTs to both exploiter
   * addresses, and the note said nothing changed hands.
   */
  it("lists objects minted to someone other than the sender", async () => {
    const j = await run("8eHgw5hBnALFJKPstXWcPgKjeh1av1CzFAz8n85Primr");
    expect(j.object_changes_note).toBeUndefined();
    expect(j.created_for.map((m: { to: { address: string } }) => m.to.address)).toEqual([
      "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06",
      "0xcd8962dad278d8b50fa0f9eb0186bfa4cbdecc6d59377214c88d0286a0ac9562",
    ]);
    expect(j.created_for[0]).toMatchObject({ type: "message_from_cetus::MessageFromCetus", kind: "created" });
    expect(j.gas_source).toBe("coins");
  });
});
