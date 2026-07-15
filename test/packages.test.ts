import { describe, it, expect } from "vitest";
import {
  formatVisibility,
  formatSignatureBody,
  formatSignature,
  formatDatatypeFields,
} from "../src/tools/packages.js";
import { GrpcTypes } from "@mysten/sui/grpc";

describe("formatVisibility", () => {
  it("returns 'public' for PUBLIC", () => {
    expect(formatVisibility(GrpcTypes.FunctionDescriptor_Visibility.PUBLIC)).toBe("public");
  });

  it("returns 'private' for PRIVATE", () => {
    expect(formatVisibility(GrpcTypes.FunctionDescriptor_Visibility.PRIVATE)).toBe("private");
  });

  it("returns 'public(friend)' for FRIEND", () => {
    expect(formatVisibility(GrpcTypes.FunctionDescriptor_Visibility.FRIEND)).toBe("public(friend)");
  });

  it("returns 'unknown' for undefined", () => {
    expect(formatVisibility(undefined)).toBe("unknown");
  });
});

describe("formatSignatureBody", () => {
  it("formats primitive types", () => {
    expect(
      formatSignatureBody({
        type: GrpcTypes.OpenSignatureBody_Type.BOOL,
        typeParameter: undefined,
        typeParameterInstantiation: [],
        typeName: undefined,
      } as unknown as GrpcTypes.OpenSignatureBody)
    ).toBe("bool");

    expect(
      formatSignatureBody({
        type: GrpcTypes.OpenSignatureBody_Type.U64,
        typeParameter: undefined,
        typeParameterInstantiation: [],
        typeName: undefined,
      } as unknown as GrpcTypes.OpenSignatureBody)
    ).toBe("u64");

    expect(
      formatSignatureBody({
        type: GrpcTypes.OpenSignatureBody_Type.ADDRESS,
        typeParameter: undefined,
        typeParameterInstantiation: [],
        typeName: undefined,
      } as unknown as GrpcTypes.OpenSignatureBody)
    ).toBe("address");
  });

  it("formats type parameter", () => {
    expect(
      formatSignatureBody({
        type: GrpcTypes.OpenSignatureBody_Type.TYPE_PARAMETER,
        typeParameter: 2,
        typeParameterInstantiation: [],
        typeName: undefined,
      } as unknown as GrpcTypes.OpenSignatureBody)
    ).toBe("T2");
  });

  it("formats vector type", () => {
    const inner = {
      type: GrpcTypes.OpenSignatureBody_Type.U8,
      typeParameter: undefined,
      typeParameterInstantiation: [],
      typeName: undefined,
    } as unknown as GrpcTypes.OpenSignatureBody;

    expect(
      formatSignatureBody({
        type: GrpcTypes.OpenSignatureBody_Type.VECTOR,
        typeParameter: undefined,
        typeParameterInstantiation: [inner],
        typeName: undefined,
      } as unknown as GrpcTypes.OpenSignatureBody)
    ).toBe("vector<u8>");
  });

  it("formats datatype with type parameters", () => {
    const param = {
      type: GrpcTypes.OpenSignatureBody_Type.TYPE_PARAMETER,
      typeParameter: 0,
      typeParameterInstantiation: [],
      typeName: undefined,
    } as unknown as GrpcTypes.OpenSignatureBody;

    expect(
      formatSignatureBody({
        type: GrpcTypes.OpenSignatureBody_Type.DATATYPE,
        typeParameter: undefined,
        typeParameterInstantiation: [param],
        typeName: "0x2::coin::Coin",
      } as unknown as GrpcTypes.OpenSignatureBody)
    ).toBe("0x2::coin::Coin<T0>");
  });

  it("formats datatype without type parameters", () => {
    expect(
      formatSignatureBody({
        type: GrpcTypes.OpenSignatureBody_Type.DATATYPE,
        typeParameter: undefined,
        typeParameterInstantiation: [],
        typeName: "0x2::object::UID",
      } as unknown as GrpcTypes.OpenSignatureBody)
    ).toBe("0x2::object::UID");
  });
});

describe("formatDatatypeFields", () => {
  const bodyU64 = {
    type: GrpcTypes.OpenSignatureBody_Type.U64,
    typeParameter: undefined,
    typeParameterInstantiation: [],
    typeName: undefined,
  } as unknown as GrpcTypes.OpenSignatureBody;
  const bodyAddr = {
    type: GrpcTypes.OpenSignatureBody_Type.ADDRESS,
    typeParameter: undefined,
    typeParameterInstantiation: [],
    typeName: undefined,
  } as unknown as GrpcTypes.OpenSignatureBody;

  it("returns fields in BCS declaration order regardless of descriptor order", () => {
    const dt = {
      fields: [
        { name: "balance", position: 1, type: bodyU64 },
        { name: "owner", position: 0, type: bodyAddr },
      ],
    } as unknown as GrpcTypes.DatatypeDescriptor;

    expect(formatDatatypeFields(dt)).toEqual([
      { name: "owner", type: "address" },
      { name: "balance", type: "u64" },
    ]);
  });

  it("handles missing field type gracefully", () => {
    const dt = {
      fields: [{ name: "x", position: 0, type: undefined }],
    } as unknown as GrpcTypes.DatatypeDescriptor;
    expect(formatDatatypeFields(dt)).toEqual([{ name: "x", type: "unknown" }]);
  });

  it("returns empty for a datatype with no fields (e.g. enum)", () => {
    const dt = { fields: [] } as unknown as GrpcTypes.DatatypeDescriptor;
    expect(formatDatatypeFields(dt)).toEqual([]);
  });
});

describe("formatSignature", () => {
  it("returns 'unknown' for missing body", () => {
    expect(formatSignature({} as GrpcTypes.OpenSignature)).toBe("unknown");
  });

  it("delegates to formatSignatureBody for valid sig", () => {
    const sig = {
      body: {
        type: GrpcTypes.OpenSignatureBody_Type.U64,
        typeParameter: undefined,
        typeParameterInstantiation: [],
        typeName: undefined,
      },
    } as unknown as GrpcTypes.OpenSignature;
    expect(formatSignature(sig)).toBe("u64");
  });
});
