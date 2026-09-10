import { describe, it, expect } from "vitest";
import { GrpcTypes } from "@mysten/sui/grpc";
import { formatStatus, describeFailure } from "../src/utils/formatting.js";

const KIND = GrpcTypes.ExecutionError_ExecutionErrorKind;

/**
 * Shapes here are copied from real mainnet failures captured by
 * `scripts/probe/failed-tx.mjs`, not invented. The fields the node actually
 * populates are the ones worth parsing.
 */
const moveAbort = {
  success: false,
  error: {
    command: 1n,
    kind: KIND.MOVE_ABORT,
    description:
      'MoveAbort(MoveLocation { module: ModuleId { address: caf6ba05, name: Identifier("balance_manager") }, function: 20, instruction: 55, function_name: Some("withdraw_with_proof") }, 3) in command 1',
    errorDetails: {
      oneofKind: "abort" as const,
      abort: {
        abortCode: 3n,
        location: {
          package: "0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a",
          module: "balance_manager",
          function: 20,
          instruction: 55,
          functionName: "withdraw_with_proof",
        },
      },
    },
  },
} as unknown as GrpcTypes.ExecutionStatus;

describe("formatStatus", () => {
  it("still reports the one-word status", () => {
    expect(formatStatus({ success: true } as GrpcTypes.ExecutionStatus)).toBe("success");
    expect(formatStatus(moveAbort)).toBe("failure");
    expect(formatStatus(undefined)).toBe("unknown");
  });
});

describe("describeFailure", () => {
  it("says nothing about a successful transaction", () => {
    expect(describeFailure({ success: true } as GrpcTypes.ExecutionStatus)).toBeUndefined();
    expect(describeFailure(undefined)).toBeUndefined();
  });

  it("names the abort code and where it aborted", () => {
    const f = describeFailure(moveAbort)!;
    expect(f.kind).toBe("MOVE_ABORT");
    expect(f.abort_code).toBe("3");
    expect(f.command).toBe(1);
    expect(f.location).toMatchObject({
      package: "0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a",
      module: "balance_manager",
      function: "withdraw_with_proof",
      instruction: 55,
    });
  });

  /**
   * The abort code alone is meaningless across packages — every package numbers
   * its own aborts from 0, so "3" is only interpretable next to the module that
   * raised it.
   */
  it("keeps the raw description, which names the module inline", () => {
    expect(describeFailure(moveAbort)!.description).toContain("balance_manager");
  });

  it("prefers a clever error's constant name over the bare code", () => {
    const clever = {
      success: false,
      error: {
        kind: KIND.MOVE_ABORT,
        errorDetails: {
          oneofKind: "abort" as const,
          abort: {
            abortCode: 9223372054034247681n,
            location: { package: "0xp", module: "vault", functionName: "withdraw" },
            cleverError: {
              errorCode: 1n,
              lineNumber: 142n,
              constantName: "EInsufficientBalance",
              constantType: "u64",
              value: { oneofKind: "rendered" as const, rendered: "balance too low" },
            },
          },
        },
      },
    } as unknown as GrpcTypes.ExecutionStatus;
    const f = describeFailure(clever)!;
    expect(f.clever_error).toMatchObject({
      constant_name: "EInsufficientBalance",
      line_number: 142,
      rendered: "balance too low",
    });
  });

  /**
   * A deny-list rejection names the address and the coin outright, so it needs
   * no interpretation — and it is the one failure kind that is itself an
   * attribution fact.
   */
  it("reports a deny-list rejection with its address and coin", () => {
    const denied = {
      success: false,
      error: {
        kind: KIND.ADDRESS_DENIED_FOR_COIN,
        errorDetails: {
          oneofKind: "coinDenyListError" as const,
          coinDenyListError: { address: "0xbad", coinType: "0xabc::usdc::USDC" },
        },
      },
    } as unknown as GrpcTypes.ExecutionStatus;
    const f = describeFailure(denied)!;
    expect(f.kind).toBe("ADDRESS_DENIED_FOR_COIN");
    expect(f.deny_list).toMatchObject({ address: "0xbad", coin_type: "0xabc::usdc::USDC" });
    expect(f.note).toMatch(/issuer/i);
  });

  it("reports a global pause distinctly from a per-address denial", () => {
    const paused = {
      success: false,
      error: { kind: KIND.COIN_TYPE_GLOBAL_PAUSE, errorDetails: { oneofKind: undefined } },
    } as unknown as GrpcTypes.ExecutionStatus;
    expect(describeFailure(paused)!.kind).toBe("COIN_TYPE_GLOBAL_PAUSE");
  });

  it("names insufficient gas without needing error details", () => {
    const oog = {
      success: false,
      error: { kind: KIND.INSUFFICIENT_GAS, errorDetails: { oneofKind: undefined } },
    } as unknown as GrpcTypes.ExecutionStatus;
    expect(describeFailure(oog)!.kind).toBe("INSUFFICIENT_GAS");
  });

  /**
   * An unrecognised kind must still produce a failure record. A new error kind
   * added by a protocol upgrade would otherwise read as "no detail available",
   * which is indistinguishable from a bug in this parser.
   */
  it("reports an unknown kind by its number rather than dropping it", () => {
    const future = {
      success: false,
      error: { kind: 9999 as never, errorDetails: { oneofKind: undefined } },
    } as unknown as GrpcTypes.ExecutionStatus;
    const f = describeFailure(future)!;
    expect(f.kind).toBe("kind_9999");
  });

  it("survives a failure with no error object at all", () => {
    const bare = { success: false } as GrpcTypes.ExecutionStatus;
    expect(describeFailure(bare)).toMatchObject({ kind: "unknown" });
  });

  it("reports congested objects, which is a retry not a rejection", () => {
    const congested = {
      success: false,
      error: {
        kind: KIND.EXECUTION_CANCELED_DUE_TO_CONSENSUS_OBJECT_CONGESTION,
        errorDetails: { oneofKind: "congestedObjects" as const, congestedObjects: { objects: ["0xpool"] } },
      },
    } as unknown as GrpcTypes.ExecutionStatus;
    const f = describeFailure(congested)!;
    expect(f.congested_objects).toEqual(["0xpool"]);
    expect(f.note).toMatch(/congest/i);
  });
});
