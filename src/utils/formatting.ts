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
export const KIND_NOTES: Record<string, string> = {
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

/**
 * The display text of each `ExecutionFailureStatus` variant in sui-types,
 * mapped to the enum name gRPC reports for it.
 *
 * GraphQL's `ExecutionError` has no kind field. It carries `message`, which is
 * that display text, and `abortCode`, which is set for Move aborts only. So a
 * failure read over GraphQL can only be named by its message, and without
 * this every one of them read as MOVE_ABORT: an out-of-gas transaction, which
 * may have been valid, looked like a contract rejecting it.
 */
const MESSAGE_KINDS: Array<[RegExp, string]> = [
  [/^Insufficient Gas\b/, "INSUFFICIENT_GAS"],
  [/^Invalid Gas Object\b/, "INVALID_GAS_OBJECT"],
  [/^INVARIANT VIOLATION\b/, "INVARIANT_VIOLATION"],
  [/^Attempted to used feature that is not supported yet/, "FEATURE_NOT_YET_SUPPORTED"],
  [/^Move object with size \d+ is larger than the maximum/, "OBJECT_TOO_BIG"],
  [/^Move package with size \d+ is larger than the maximum/, "PACKAGE_TOO_BIG"],
  [/^Circular Object Ownership\b/, "CIRCULAR_OBJECT_OWNERSHIP"],
  [/^Insufficient coin balance for operation\b/, "INSUFFICIENT_COIN_BALANCE"],
  [/^The coin balance overflows u64\b/, "COIN_BALANCE_OVERFLOW"],
  [/^Publish Error, Non-zero Address\b/, "PUBLISH_ERROR_NON_ZERO_ADDRESS"],
  [/^Sui Move Bytecode Verification Error\b/, "SUI_MOVE_VERIFICATION_ERROR"],
  [/^Move Primitive Runtime Error\b/, "MOVE_PRIMITIVE_RUNTIME_ERROR"],
  [/^Move Runtime Abort\b/, "MOVE_ABORT"],
  [/^Move Bytecode Verification Error\b/, "VM_VERIFICATION_OR_DESERIALIZATION_ERROR"],
  [/^MOVE VM INVARIANT VIOLATION\b/, "VM_INVARIANT_VIOLATION"],
  [/^Function Not Found\b/, "FUNCTION_NOT_FOUND"],
  [/^Arity mismatch for Move function\b/, "ARITY_MISMATCH"],
  [/^Type arity mismatch for Move function\b/, "TYPE_ARITY_MISMATCH"],
  [/^Non Entry Function Invoked\b/, "NON_ENTRY_FUNCTION_INVOKED"],
  [/^Invalid command argument at \d+/, "COMMAND_ARGUMENT_ERROR"],
  [/^Error for type argument at index \d+/, "TYPE_ARGUMENT_ERROR"],
  [/^Unused result without the drop ability\b/, "UNUSED_VALUE_WITHOUT_DROP"],
  [/^Invalid public Move function signature\b/, "INVALID_PUBLIC_FUNCTION_RETURN_TYPE"],
  [/^Invalid Transfer Object\b/, "INVALID_TRANSFER_OBJECT"],
  [/^Effects of size \d+ bytes too large\b/, "EFFECTS_TOO_LARGE"],
  [/^Publish\/Upgrade Error, Missing dependency\b/, "PUBLISH_UPGRADE_MISSING_DEPENDENCY"],
  [/^Publish\/Upgrade Error, Dependency downgrade\b/, "PUBLISH_UPGRADE_DEPENDENCY_DOWNGRADE"],
  [/^Invalid package upgrade\b/, "PACKAGE_UPGRADE_ERROR"],
  [/^Written objects of \d+ bytes too large\b/, "WRITTEN_OBJECTS_TOO_LARGE"],
  [/^Certificate is on the deny list\b/, "CERTIFICATE_DENIED"],
  [/^Sui Move Bytecode Verification Timeout\b/, "SUI_MOVE_VERIFICATION_TIMEDOUT"],
  [/^The shared object operation is not allowed\b/, "CONSENSUS_OBJECT_OPERATION_NOT_ALLOWED"],
  [/^Certificate cannot be executed due to a dependency on a deleted shared object\b/, "INPUT_OBJECT_DELETED"],
  [/^Certificate is cancelled due to congestion on shared objects\b/, "EXECUTION_CANCELED_DUE_TO_CONSENSUS_OBJECT_CONGESTION"],
  [/^Address \S+ is denied for coin\b/, "ADDRESS_DENIED_FOR_COIN"],
  [/^Coin type is globally paused for use\b/, "COIN_TYPE_GLOBAL_PAUSE"],
  [/^Certificate is cancelled because randomness could not be generated\b/, "EXECUTION_CANCELED_DUE_TO_RANDOMNESS_UNAVAILABLE"],
  [/^Move vector element \(passed to MakeMoveVec\) with size\b/, "MOVE_VECTOR_ELEM_TOO_BIG"],
  [/^Move value \(possibly an upgrade ticket or a dev-inspect value\) with size\b/, "MOVE_RAW_VALUE_TOO_BIG"],
  [/^A valid linkage was unable to be determined\b/, "INVALID_LINKAGE"],
  [/^Insufficient funds for funds accumulator withdrawal\b/, "INSUFFICIENT_FUNDS_FOR_WITHDRAW"],
  [/^Non-exclusive write input object \S+ has been modified\b/, "NON_EXCLUSIVE_WRITE_INPUT_OBJECT_MODIFIED"],
];

/**
 * The failure kind of a GraphQL `ExecutionError`, named as gRPC names it.
 *
 * A non-null `abortCode` is what makes a failure a Move abort; the message of
 * an abort may be a package's own rendered clever error, so it is not matched
 * for that case. Anything else is named from its message, and a message this
 * build does not recognise is `unknown` rather than a guess.
 */
export function failureKindFromGraphql(message: string | null | undefined, abortCode: unknown): string {
  if (abortCode !== null && abortCode !== undefined) return "MOVE_ABORT";
  const text = (message ?? "").trim();
  return MESSAGE_KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? "unknown";
}

export function bigintToString(val?: bigint): string | undefined {
  return val !== undefined ? val.toString() : undefined;
}

export function timestampToIso(ts?: { seconds: bigint; nanos: number }): string | undefined {
  if (!ts) return undefined;
  const millis = Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1_000_000);
  return new Date(millis).toISOString();
}

/**
 * Each distinct entry once, in first-seen order, with ` ×N` after one that
 * occurred N > 1 times. A PTB repeats the same call hundreds of times: one Nemo
 * exploit transaction decoded to 46k characters of actions in a single history
 * row. `get_transaction` keeps every command in order.
 */
export function foldRepeats(items: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts].map(([item, n]) => (n > 1 ? `${item} ×${n}` : item));
}
