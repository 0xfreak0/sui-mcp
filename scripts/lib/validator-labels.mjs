/** Pure validation of one active validator and its operation cap at a checkpoint. */
const HEX = /^0x[0-9a-f]{1,64}$/i;
const CAP_TYPE = /^0x0*3::validator_cap::UnverifiedValidatorOperationCap$/i;

export function suiAddress(value) {
  if (typeof value !== "string" || !HEX.test(value)) return null;
  return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function validatorRow(node) {
  const state = node?.contents?.json;
  const address = suiAddress(state?.metadata?.sui_address);
  const name = state?.metadata?.name;
  if (!address || typeof name !== "string" || !name.trim()) return null;
  const pool = suiAddress(state.staking_pool?.id);
  const operationCap = suiAddress(state.operation_cap_id);
  const url = state.metadata.project_url;
  return {
    address,
    name: name.trim(),
    project_url: typeof url === "string" && /^https?:\/\/[^\s]+$/i.test(url) ? url : null,
    staking_pool_id: pool,
    operation_cap_id: operationCap,
  };
}

export function capOwnership(cap, row) {
  const unavailable = (reason) => ({
    operation_cap_holder: null,
    operation_cap_owner_kind: null,
    operation_cap_owner_object: null,
    operation_cap_holder_status: reason,
    operation_cap_source_tx: null,
    operation_cap_object_version: null,
  });
  if (!row.operation_cap_id) return unavailable("operation_cap_id_unavailable");
  if (!cap) return unavailable("operation_cap_object_unavailable");
  const contents = cap.asMoveObject?.contents;
  if (!CAP_TYPE.test(contents?.type?.repr ?? "") ||
    suiAddress(contents?.json?.id) !== row.operation_cap_id ||
    suiAddress(contents?.json?.authorizer_validator_address) !== row.address) {
    return unavailable("operation_cap_identity_unverified");
  }
  const owner = cap.owner;
  const ownerAddress = suiAddress(owner?.address?.address);
  const ownerKind = owner?.__typename;
  if (!ownerAddress || !["AddressOwner", "ConsensusAddressOwner", "ObjectOwner"].includes(ownerKind)) {
    return unavailable("operation_cap_owner_unavailable");
  }
  const direct = ownerKind !== "ObjectOwner";
  return {
    operation_cap_holder: direct ? ownerAddress : null,
    operation_cap_owner_kind: direct ? (ownerKind === "AddressOwner" ? "address" : "consensus") : "object",
    operation_cap_owner_object: direct ? null : ownerAddress,
    operation_cap_holder_status: direct ? "direct_owner" : "object_owned_holder_unproven",
    operation_cap_source_tx: cap.previousTransaction?.digest ?? null,
    operation_cap_object_version: Number.isSafeInteger(cap.version) ? cap.version : null,
  };
}
