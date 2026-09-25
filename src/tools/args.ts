/**
 * Argument types that tolerate how models actually call tools.
 *
 * MCP arguments arrive as JSON, and a model composing that JSON will sometimes
 * quote a number (`max_hops: "8"`), send `null` for an argument it means to
 * leave unset, or paste an address in upper case or without its leading zeros.
 * Strict validation turns the first two into hard failures for something whose
 * intent was never ambiguous. Passing the third through unchanged is worse:
 * the chain reports every address in canonical form, so a raw string compared
 * against it never matches and a funding walk reads as a dead end.
 *
 * Leniency does **not** loosen the advertised contract. The generated JSON
 * schema is the same as for `z.number()` / `z.boolean()` / `z.string()`, so a
 * client reading the schema sees exactly what it saw before; the server is
 * simply lenient about what it accepts. Genuine nonsense (`"abc"`, `""`,
 * `"0xzz"`) still fails.
 *
 * `null` is handled one level up: `withNetworkParam` treats a `null` argument
 * as absent for every tool, so an optional field falls back to its default and
 * a required one reports "Required".
 */

import { z, ZodNumber, type ParseInput, type ParseReturnType, type ZodNumberCheck } from "zod";
import { canonicalSuiAddress } from "../utils/chain-id.js";

/** A decimal number as text: `8`, `-1.5`, `.5`, `1e3`. Not hex, not blank. */
const NUMERIC_STRING = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * `z.number()` that also accepts a number's decimal string form.
 *
 * Deliberately NOT `z.coerce.number()`, which applies `Number()` to anything:
 * `Number("")`, `Number("  ")` and `Number(false)` are all 0, so an empty or
 * placeholder argument became `limit: 0` and the tool answered with an empty
 * page that read as "no activity". Only a string that spells a decimal number
 * is converted; everything else is left for `z.number()` to reject.
 *
 * `.int()`, `.min()`, `.max()` and the rest build a new schema through
 * `_addCheck` / `setLimit`, which zod hard-codes to `new ZodNumber`. Both are
 * overridden so a chained refinement keeps this parse.
 */
class NumArg extends ZodNumber {
  override _parse(input: ParseInput): ParseReturnType<number> {
    if (typeof input.data === "string") {
      const text = input.data.trim();
      if (!NUMERIC_STRING.test(text)) {
        const ctx = this._getOrReturnCtx(input);
        ctx.common.issues.push({
          code: z.ZodIssueCode.custom,
          path: ctx.path,
          message:
            text === ""
              ? "Expected a number, received an empty string. Omit the argument to leave it unset."
              : `Expected a number, received "${input.data}".`,
        } as z.ZodIssue);
        return z.INVALID;
      }
      input.data = Number(text);
    }
    return super._parse(input);
  }

  override _addCheck(check: ZodNumberCheck): NumArg {
    return new NumArg(super._addCheck(check)._def);
  }

  protected override setLimit(
    kind: "min" | "max",
    value: number,
    inclusive: boolean,
    message?: string,
  ): NumArg {
    return new NumArg(super.setLimit(kind, value, inclusive, message)._def);
  }
}

/** A number that also accepts its decimal string form. Chains like `z.number()`. */
export const numArg = () => new NumArg({ checks: [], typeName: z.ZodFirstPartyTypeKind.ZodNumber, coerce: false });

/**
 * A boolean that also accepts `"true"` / `"false"`.
 *
 * Deliberately NOT `z.coerce.boolean()`, which is a trap: it applies JavaScript
 * truthiness, so the string `"false"` becomes `true`, silently inverting the
 * caller's intent, which is worse than the rejection this is meant to fix.
 * Only the two exact strings are mapped; anything else is left alone for
 * `z.boolean()` to reject on its own terms.
 */
export const boolArg = () =>
  z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());

/** A SuiNS name: one or more dot-separated labels ending in `.sui`. */
const SUINS_NAME = /^(?:[a-z0-9-]+\.)+sui$/;

/** Is this canonicalised argument a SuiNS name still waiting to be resolved? */
export function isSuinsName(value: string): boolean {
  return SUINS_NAME.test(value);
}

/** The base string schema of every address argument, for {@link isAddressSchema}. */
const addressBases = new WeakSet<z.ZodTypeAny>();

/**
 * A Sui address, object ID or package ID, returned in canonical form
 * (`0x` + 64 lower-case hex digits). Also accepts a SuiNS name (`name.sui`),
 * which `withNetworkParam` resolves on the call's network before the handler
 * runs and reports back as `resolved_from`.
 *
 * The JSON schema stays `{"type": "string"}`.
 */
export const addressArg = () => {
  const base = z.string();
  addressBases.add(base);
  return base.transform((raw, ctx) => {
    const text = raw.trim().toLowerCase();
    if (isSuinsName(text)) return text;
    const address = canonicalSuiAddress(text);
    if (address) return address;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Not a Sui address: "${raw}". Expected 0x followed by up to 64 hex digits, or a SuiNS name ending in .sui.`,
    });
    return z.NEVER;
  });
};

/** A list of {@link addressArg}. Chains like `z.array()`. */
export const addressListArg = () => z.array(addressArg());

/**
 * Does this schema hold address arguments, and how many?
 *
 * Looks through the wrappers a tool file adds (`.optional()`, `.default()`,
 * `.describe()`, `z.preprocess`) for an {@link addressArg} base. Returns
 * `"one"` for a single address, `"list"` for an array of them, or null.
 */
export function isAddressSchema(schema: z.ZodTypeAny): "one" | "list" | null {
  let node: z.ZodTypeAny | undefined = schema;
  let list = false;
  while (node) {
    if (addressBases.has(node)) return list ? "list" : "one";
    const def = node._def as {
      typeName?: z.ZodFirstPartyTypeKind;
      innerType?: z.ZodTypeAny;
      schema?: z.ZodTypeAny;
      type?: z.ZodTypeAny;
    };
    switch (def.typeName) {
      case z.ZodFirstPartyTypeKind.ZodOptional:
      case z.ZodFirstPartyTypeKind.ZodNullable:
      case z.ZodFirstPartyTypeKind.ZodDefault:
        node = def.innerType;
        break;
      case z.ZodFirstPartyTypeKind.ZodEffects:
        node = def.schema;
        break;
      case z.ZodFirstPartyTypeKind.ZodArray:
        if (list) return null;
        list = true;
        node = def.type;
        break;
      default:
        return null;
    }
  }
  return null;
}
