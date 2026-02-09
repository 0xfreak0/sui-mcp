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
  if (status.success) return "success";
  const err = status.error;
  if (err) {
    return `failure: command=${err.command ?? "?"}`;
  }
  return "failure";
}

export function bigintToString(val?: bigint): string | undefined {
  return val !== undefined ? val.toString() : undefined;
}

export function timestampToIso(ts?: { seconds: bigint; nanos: number }): string | undefined {
  if (!ts) return undefined;
  const millis = Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1_000_000);
  return new Date(millis).toISOString();
}
