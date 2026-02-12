// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function protoValueToJson(val?: any): unknown {
  if (!val) return undefined;
  const kind = val.kind;
  if (!kind) return null;
  switch (kind.oneofKind) {
    case "nullValue":
      return null;
    case "numberValue":
      return kind.numberValue;
    case "stringValue":
      return kind.stringValue;
    case "boolValue":
      return kind.boolValue;
    case "structValue": {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(kind.structValue.fields)) {
        obj[k] = protoValueToJson(v);
      }
      return obj;
    }
    case "listValue":
      return kind.listValue.values.map(protoValueToJson);
    default:
      return null;
  }
}
