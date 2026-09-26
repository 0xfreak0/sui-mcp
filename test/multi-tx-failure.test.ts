import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));

const { fetchTransactions } = await import("../src/utils/multi-tx.js");
const { failureKindFromGraphql, commandIndexFromGraphqlMessage } = await import("../src/utils/formatting.js");

// A mainnet transaction that failed by running out of gas.
const OUT_OF_GAS = "BTMCNZd2kt6b1ALvntNC99GGo1nancJtJHAbxi5SnCpR";
// A real-coin send that failed with insufficient coin balance.
const INSUFFICIENT_BALANCE = "HoTxYf4HP4VZYbBEh2xHTNPpEogqBZhre4AtCrxo51qG";

const failed = (digest: string, executionError: Record<string, unknown>) => ({
  multiGetTransactions: [
    {
      digest,
      sender: { address: "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06" },
      kind: { __typename: "ProgrammableTransaction", commands: { nodes: [] } },
      effects: {
        status: "FAILURE",
        executionError,
        timestamp: "2025-05-22T10:00:00.000Z",
        epoch: { epochId: 756 },
        checkpoint: { sequenceNumber: 148000000 },
        balanceChanges: { nodes: [] },
        events: { pageInfo: { hasNextPage: false }, nodes: [] },
      },
    },
  ],
});

const noLocation = {
  instructionOffset: null,
  identifier: null,
  constant: null,
  sourceLineNumber: null,
  module: null,
  function: null,
};

beforeEach(() => mockGqlQuery.mockReset());

describe("get_transactions failure kind", () => {
  /**
   * A GraphQL failure is named by its kind, as get_transaction (gRPC) names
   * it. This one ran out of gas: INSUFFICIENT_GAS, with the note that the
   * transaction may have been valid.
   */
  it("names an out-of-gas failure INSUFFICIENT_GAS, not MOVE_ABORT", async () => {
    // Exactly what mainnet GraphQL returns for this digest.
    mockGqlQuery.mockResolvedValue(failed(OUT_OF_GAS, { abortCode: null, message: "Insufficient Gas.", ...noLocation }));
    const [tx] = (await fetchTransactions([OUT_OF_GAS], 0)).found;
    expect(tx.failure).toMatchObject({ kind: "INSUFFICIENT_GAS", description: "Insufficient Gas." });
    expect(tx.failure?.abort_code).toBeUndefined();
    expect(tx.failure?.note).toMatch(/may have been perfectly valid/);
  });

  /**
   * Mainnet GraphQL's message for this digest is "Error in 1st command,
   * Insufficient coin balance for operation.". The kind is read past the
   * command-index prefix, so it matches the INSUFFICIENT_COIN_BALANCE that
   * get_transaction (gRPC) names for the same digest.
   */
  it("names an insufficient-balance failure from a command-prefixed message", async () => {
    // Exactly what mainnet GraphQL returns for this digest.
    mockGqlQuery.mockResolvedValue(
      failed(INSUFFICIENT_BALANCE, {
        abortCode: null,
        message: "Error in 1st command, Insufficient coin balance for operation.",
        ...noLocation,
      }),
    );
    const [tx] = (await fetchTransactions([INSUFFICIENT_BALANCE], 0)).found;
    expect(tx.failure).toMatchObject({
      kind: "INSUFFICIENT_COIN_BALANCE",
      command: 0,
      description: "Error in 1st command, Insufficient coin balance for operation.",
    });
  });

  it("still names a Move abort from its abort code", async () => {
    mockGqlQuery.mockResolvedValue(
      failed(OUT_OF_GAS, {
        ...noLocation,
        abortCode: "3",
        instructionOffset: 55,
        message: "Error from '0xcaf6::balance_manager::withdraw_with_proof' (instruction 55), abort code: 3",
        module: { name: "balance_manager", package: { address: "0xcaf6" } },
        function: { name: "withdraw_with_proof" },
      }),
    );
    const [tx] = (await fetchTransactions([OUT_OF_GAS], 0)).found;
    expect(tx.failure).toMatchObject({
      kind: "MOVE_ABORT",
      abort_code: "3",
      location: { package: "0xcaf6", module: "balance_manager", function: "withdraw_with_proof", instruction: 55 },
    });
  });
});

describe("failureKindFromGraphql", () => {
  it("names non-abort failures from sui-types' display text", () => {
    const cases: Array<[string, string]> = [
      ["Move Primitive Runtime Error. Location: 0x2::balance::split (function index 5) at offset 12. Arithmetic error, stack overflow, max value depth, etc.", "MOVE_PRIMITIVE_RUNTIME_ERROR"],
      ["Error in 1st command, Insufficient coin balance for operation.", "INSUFFICIENT_COIN_BALANCE"],
      ["Invalid command argument at 2. The type of the value does not match the expected type", "COMMAND_ARGUMENT_ERROR"],
      ["Address 0xabc is denied for coin 0xdba3::usdc::USDC", "ADDRESS_DENIED_FOR_COIN"],
      ["Certificate is cancelled due to congestion on shared objects: CongestedObjects([0x6])", "EXECUTION_CANCELED_DUE_TO_CONSENSUS_OBJECT_CONGESTION"],
      ["Type arity mismatch for Move function. Mismatch between the number of actual versus expected type arguments.", "TYPE_ARITY_MISMATCH"],
      ["Arity mismatch for Move function. The number of arguments does not match the number of parameters", "ARITY_MISMATCH"],
    ];
    for (const [message, kind] of cases) expect(failureKindFromGraphql(message, null)).toBe(kind);
  });

  it("does not guess at a message it does not recognise", () => {
    expect(failureKindFromGraphql("Something new in a later protocol version", null)).toBe("unknown");
  });
});

describe("failureKindFromGraphql command prefix", () => {
  /**
   * Mainnet GraphQL wraps every command-level failure message in
   * "Error in Nth command, ", 1-based. Every MESSAGE_KINDS pattern anchors at
   * `^` against sui-types' own text, so the prefix is stripped before
   * matching, for every command-level failure kind.
   */
  it("strips the command prefix so the underlying kind still matches", () => {
    expect(
      failureKindFromGraphql("Error in 1st command, Insufficient coin balance for operation.", null),
    ).toBe("INSUFFICIENT_COIN_BALANCE");
    expect(
      failureKindFromGraphql("Error in 2nd command, Insufficient coin balance for operation.", null),
    ).toBe("INSUFFICIENT_COIN_BALANCE");
    expect(
      failureKindFromGraphql("Error in 21st command, Invalid command argument at 2. The type of the value does not match the expected type", null),
    ).toBe("COMMAND_ARGUMENT_ERROR");
  });

  it("still names a message that never carried the prefix (a whole-transaction failure)", () => {
    expect(failureKindFromGraphql("Insufficient Gas.", null)).toBe("INSUFFICIENT_GAS");
  });

  it("reads the 0-based command index out of the prefix, matching gRPC's err.command", () => {
    expect(commandIndexFromGraphqlMessage("Error in 1st command, Insufficient coin balance for operation.")).toBe(0);
    expect(commandIndexFromGraphqlMessage("Error in 3rd command, Insufficient coin balance for operation.")).toBe(2);
    expect(commandIndexFromGraphqlMessage("Insufficient Gas.")).toBeUndefined();
  });
});
