import { describe, expect, it } from "vitest";
import { capOwnership, suiAddress, validatorRow } from "../scripts/lib/validator-labels.mjs";

const address = `0x${"a".repeat(64)}`;
const capId = `0x${"b".repeat(64)}`;
const row = {
  address, name: "Example", project_url: "https://validator.example",
  staking_pool_id: `0x${"c".repeat(64)}`, operation_cap_id: capId,
};
const cap = (owner: object, overrides: Record<string, unknown> = {}) => ({
  version: 11,
  previousTransaction: { digest: "example-tx" },
  owner,
  asMoveObject: {
    contents: {
      type: { repr: "0x3::validator_cap::UnverifiedValidatorOperationCap" },
      json: { id: capId, authorizer_validator_address: address },
    }
  },
  ...overrides,
});

describe("mainnet validator label evidence", () => {
  it("normalizes account IDs and refuses malformed addresses and missing names", () => {
    expect(suiAddress("0xA")).toBe(`0x${"0".repeat(63)}a`);
    expect(suiAddress("0xnot-hex")).toBeNull();
    expect(validatorRow({
      contents: {
        json: {
          metadata: { sui_address: "0xA", name: " Example ", project_url: "https://validator.example" },
          operation_cap_id: "0xB", staking_pool: { id: "0xC" },
        }
      }
    })).toEqual({
      address: `0x${"0".repeat(63)}a`, name: "Example", project_url: "https://validator.example",
      operation_cap_id: `0x${"0".repeat(63)}b`, staking_pool_id: `0x${"0".repeat(63)}c`,
    });
    expect(validatorRow({ contents: { json: { metadata: { sui_address: "0xA", name: "   " } } } })).toBeNull();
  });

  it("claims direct custody only from a matching cap's owner", () => {
    expect(capOwnership(cap({ __typename: "AddressOwner", address: { address: "0xD" } }), row))
      .toMatchObject({ operation_cap_holder: `0x${"0".repeat(63)}d`, operation_cap_holder_status: "direct_owner", operation_cap_source_tx: "example-tx" });
    expect(capOwnership(cap({ __typename: "ConsensusAddressOwner", address: { address: "0xD" } }), row))
      .toMatchObject({ operation_cap_holder: `0x${"0".repeat(63)}d`, operation_cap_owner_kind: "consensus" });
    expect(capOwnership(cap({ __typename: "ObjectOwner", address: { address: "0xD" } }), row))
      .toMatchObject({ operation_cap_holder: null, operation_cap_owner_object: `0x${"0".repeat(63)}d`, operation_cap_holder_status: "object_owned_holder_unproven" });
  });

  it("never manufactures cap custody from the embedded authorizer or a wrong object", () => {
    expect(capOwnership(null, row)).toMatchObject({ operation_cap_holder: null, operation_cap_holder_status: "operation_cap_object_unavailable" });
    expect(capOwnership(null, { ...row, operation_cap_id: null })).toMatchObject({ operation_cap_holder: null, operation_cap_holder_status: "operation_cap_id_unavailable" });
    expect(capOwnership(cap({ __typename: "Immutable" }), row))
      .toMatchObject({ operation_cap_holder: null, operation_cap_holder_status: "operation_cap_owner_unavailable" });
    expect(capOwnership(cap({ __typename: "AddressOwner", address: { address } }, {
      asMoveObject: { contents: { type: { repr: "0x3::other::UnverifiedValidatorOperationCap" }, json: { id: capId, authorizer_validator_address: address } } },
    }), row)).toMatchObject({ operation_cap_holder: null, operation_cap_holder_status: "operation_cap_identity_unverified" });
    expect(capOwnership(cap({ __typename: "AddressOwner", address: { address } }, {
      asMoveObject: { contents: { type: { repr: "0x3::validator_cap::UnverifiedValidatorOperationCap" }, json: { id: capId, authorizer_validator_address: "0xD" } } },
    }), row)).toMatchObject({ operation_cap_holder: null, operation_cap_holder_status: "operation_cap_identity_unverified" });
  });
});
