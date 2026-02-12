import { describe, it, expect } from "vitest";
import { protoValueToJson } from "../src/utils/proto.js";

describe("protoValueToJson", () => {
  it("returns undefined for undefined input", () => {
    expect(protoValueToJson(undefined)).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(protoValueToJson(null)).toBeUndefined();
  });

  it("returns null for nullValue kind", () => {
    expect(protoValueToJson({ kind: { oneofKind: "nullValue" } })).toBeNull();
  });

  it("returns number for numberValue kind", () => {
    expect(
      protoValueToJson({ kind: { oneofKind: "numberValue", numberValue: 42 } })
    ).toBe(42);
  });

  it("returns string for stringValue kind", () => {
    expect(
      protoValueToJson({ kind: { oneofKind: "stringValue", stringValue: "hello" } })
    ).toBe("hello");
  });

  it("returns boolean for boolValue kind", () => {
    expect(
      protoValueToJson({ kind: { oneofKind: "boolValue", boolValue: true } })
    ).toBe(true);
  });

  it("converts structValue to object", () => {
    const input = {
      kind: {
        oneofKind: "structValue",
        structValue: {
          fields: {
            name: { kind: { oneofKind: "stringValue", stringValue: "Alice" } },
            age: { kind: { oneofKind: "numberValue", numberValue: 30 } },
          },
        },
      },
    };
    expect(protoValueToJson(input)).toEqual({ name: "Alice", age: 30 });
  });

  it("converts listValue to array", () => {
    const input = {
      kind: {
        oneofKind: "listValue",
        listValue: {
          values: [
            { kind: { oneofKind: "numberValue", numberValue: 1 } },
            { kind: { oneofKind: "numberValue", numberValue: 2 } },
          ],
        },
      },
    };
    expect(protoValueToJson(input)).toEqual([1, 2]);
  });

  it("handles nested struct within list", () => {
    const input = {
      kind: {
        oneofKind: "listValue",
        listValue: {
          values: [
            {
              kind: {
                oneofKind: "structValue",
                structValue: {
                  fields: {
                    id: { kind: { oneofKind: "stringValue", stringValue: "0x1" } },
                  },
                },
              },
            },
          ],
        },
      },
    };
    expect(protoValueToJson(input)).toEqual([{ id: "0x1" }]);
  });

  it("returns null for unknown oneofKind", () => {
    expect(protoValueToJson({ kind: { oneofKind: "unknownType" } })).toBeNull();
  });

  it("returns null when kind exists but has no oneofKind", () => {
    expect(protoValueToJson({ kind: {} })).toBeNull();
  });
});
