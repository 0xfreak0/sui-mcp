import { GrpcTypes } from "@mysten/sui/grpc";

export function formatOwner(owner?: GrpcTypes.Owner): string {
  if (!owner) return "unknown";
  switch (owner.kind) {
    case GrpcTypes.Owner_OwnerKind.ADDRESS:
      return `address:${owner.address}`;
    case GrpcTypes.Owner_OwnerKind.OBJECT:
      return `object:${owner.address}`;
    case GrpcTypes.Owner_OwnerKind.SHARED:
      return `shared(initial_version:${owner.version})`;
    case GrpcTypes.Owner_OwnerKind.IMMUTABLE:
      return "immutable";
    case GrpcTypes.Owner_OwnerKind.CONSENSUS_ADDRESS:
      return `consensus:${owner.address}`;
    default:
      return "unknown";
  }
}

export function formatGas(gas?: GrpcTypes.GasCostSummary) {
  if (!gas) return null;
  return {
    computation_cost: gas.computationCost?.toString(),
    storage_cost: gas.storageCost?.toString(),
    storage_rebate: gas.storageRebate?.toString(),
    non_refundable_storage_fee: gas.nonRefundableStorageFee?.toString(),
  };
}

export function formatStatus(status?: GrpcTypes.ExecutionStatus) {
  if (!status) return "unknown";
  return status.success ? "success" : "failure";
}

/** Reverse the generated enum: 13 -> "MOVE_ABORT". */
const ERROR_KIND_NAME = new Map<number, string>(
  Object.entries(GrpcTypes.ExecutionError_ExecutionErrorKind)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => [v as number, k]),
);

/**
 * Notes for the failure kinds where the name alone misleads.
 *
 * Deliberately sparse. Most kinds say what they are — `INSUFFICIENT_GAS` needs
 * no gloss — and a note on every one would bury the few that change what a
 * reader should conclude.
 */
const KIND_NOTES: Record<string, string> = {
  ADDRESS_DENIED_FOR_COIN:
    "The coin's issuer has denied this address. That is an off-chain decision recorded on chain by whoever holds the DenyCap, not a protocol rule — it is attribution, and it is reversible by the issuer.",
  COIN_TYPE_GLOBAL_PAUSE:
    "The issuer paused ALL transfers of this coin type, so this says nothing about the sender specifically.",
  EXECUTION_CANCELED_DUE_TO_CONSENSUS_OBJECT_CONGESTION:
    "Cancelled for congestion on a shared object, not rejected. The transaction was never invalid and an identical retry may succeed, so this is weak evidence of intent.",
  INSUFFICIENT_GAS:
    "Ran out of gas budget. The transaction may have been perfectly valid.",
  INPUT_OBJECT_DELETED:
    "An input object no longer exists — usually a race with another transaction that consumed it first.",
};

export interface MoveFailureLocation {
  package?: string;
  module?: string;
  /** Resolved function name where available, else the bytecode index. */
  function?: string;
  instruction?: number;
}

export interface FailureDetail {
  /** Enum name, e.g. `MOVE_ABORT`. `kind_<n>` for a kind this build predates. */
  kind: string;
  /** PTB command index that failed, when the node reported one. */
  command?: number;
  /**
   * Move abort code, as a string because it is a u64.
   *
   * Only meaningful next to the module that raised it — every package numbers
   * its own aborts from zero, so `3` means nothing on its own.
   */
  abort_code?: string;
  location?: MoveFailureLocation;
  /**
   * A "clever error": the abort code resolved back to the named constant and
   * source line the package author wrote. When present this is the answer, and
   * the raw abort code is an implementation detail.
   */
  clever_error?: {
    constant_name?: string;
    constant_type?: string;
    line_number?: number;
    rendered?: string;
  };
  /** Present when a coin deny list rejected the transaction. */
  deny_list?: { address?: string; coin_type?: string };
  /** Shared objects that were congested, when execution was cancelled for it. */
  congested_objects?: string[];
  /** The node's own rendering. Names the module inline, so it is kept verbatim. */
  description?: string;
  note?: string;
}

/**
 * Everything the chain says about why a transaction failed.
 *
 * `formatStatus` answers "did it work". This answers "why not", which is the
 * question an investigation actually asks and which the status string cannot
 * carry. The data is already in `effects` — no extra request — and previously
 * all of it except the command index was discarded.
 *
 * Returns undefined for a successful or absent status, so a caller can spread
 * it in without branching.
 */
export function describeFailure(status?: GrpcTypes.ExecutionStatus): FailureDetail | undefined {
  if (!status || status.success) return undefined;

  const err = status.error;
  // A failure with no error object still gets a record. "Failed, reason not
  // reported" and "did not fail" must not look the same to a reader.
  if (!err) return { kind: "unknown" };

  const kind =
    err.kind === undefined
      ? "unknown"
      : (ERROR_KIND_NAME.get(err.kind) ?? `kind_${err.kind}`);

  const out: FailureDetail = { kind };
  if (err.command !== undefined) out.command = Number(err.command);
  if (err.description) out.description = err.description;

  const details = err.errorDetails;
  if (details?.oneofKind === "abort") {
    const a = details.abort;
    if (a.abortCode !== undefined) out.abort_code = a.abortCode.toString();
    if (a.location) {
      out.location = {
        ...(a.location.package ? { package: a.location.package } : {}),
        ...(a.location.module ? { module: a.location.module } : {}),
        // Prefer the resolved name; fall back to the bytecode index, which is
        // all the node has for a function it could not name.
        ...(a.location.functionName
          ? { function: a.location.functionName }
          : a.location.function !== undefined
            ? { function: String(a.location.function) }
            : {}),
        ...(a.location.instruction !== undefined ? { instruction: a.location.instruction } : {}),
      };
    }
    const c = a.cleverError;
    if (c) {
      out.clever_error = {
        ...(c.constantName ? { constant_name: c.constantName } : {}),
        ...(c.constantType ? { constant_type: c.constantType } : {}),
        ...(c.lineNumber !== undefined ? { line_number: Number(c.lineNumber) } : {}),
        ...(c.value?.oneofKind === "rendered" ? { rendered: c.value.rendered } : {}),
      };
    }
  } else if (details?.oneofKind === "coinDenyListError") {
    const d = details.coinDenyListError;
    out.deny_list = {
      ...(d.address ? { address: d.address } : {}),
      ...(d.coinType ? { coin_type: d.coinType } : {}),
    };
  } else if (details?.oneofKind === "congestedObjects") {
    const objects = details.congestedObjects.objects ?? [];
    if (objects.length) out.congested_objects = objects;
  }

  const note = KIND_NOTES[kind];
  if (note) out.note = note;
  return out;
}

export function bigintToString(val?: bigint): string | undefined {
  return val !== undefined ? val.toString() : undefined;
}

export function timestampToIso(ts?: { seconds: bigint; nanos: number }): string | undefined {
  if (!ts) return undefined;
  const millis = Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1_000_000);
  return new Date(millis).toISOString();
}
