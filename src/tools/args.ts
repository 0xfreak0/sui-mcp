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
 * `null`, blank strings and unknown argument names are handled one level up,
 * by {@link toolArgsSchema}: a `null` argument is absent, so an optional
 * field falls back to its default and a required one reports "Required"; a
 * blank string is refused; an argument the tool does not take is refused.
 */

import { z, ZodNumber, type ParseInput, type ParseReturnType, type ZodNumberCheck } from "zod";
import { canonicalSuiAddress } from "../utils/chain-id.js";

/** A decimal number as text: `8`, `-1.5`, `.5`, `1e3`. Not hex, not blank. */
const NUMERIC_STRING = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Most characters of a caller's input an argument error quotes back. */
const QUOTE_CHARS = 80;

/**
 * A caller's input, quoted for an error message: JSON-escaped so control
 * characters and newlines stay on one line, and cut at {@link QUOTE_CHARS}
 * so a 10,000-character argument does not come back as a 10,000-character
 * error.
 */
export function quoteInput(value: string): string {
  return JSON.stringify(value.length > QUOTE_CHARS ? `${value.slice(0, QUOTE_CHARS)}…` : value);
}

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
              : `Expected a number, received ${quoteInput(input.data)}.`,
        } as z.ZodIssue);
        return z.INVALID;
      }
      input.data = Number(text);
    }
    if (input.data === Infinity || input.data === -Infinity) {
      const ctx = this._getOrReturnCtx(input);
      ctx.common.issues.push({
        code: z.ZodIssueCode.custom,
        path: ctx.path,
        message: "Expected a finite number, received one too large to represent.",
      } as z.ZodIssue);
      return z.INVALID;
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
      message: `Not a Sui address: ${quoteInput(raw)}. Expected 0x followed by up to 64 hex digits, or a SuiNS name ending in .sui.`,
    });
    return z.NEVER;
  });
};

/** Largest value of a Move `u64`. */
const U64_MAX = 2n ** 64n - 1n;

/**
 * A `u64` carried as a decimal string (an epoch, a checkpoint, an object
 * version, a raw coin amount), returned trimmed. A whole JSON number is
 * accepted too, as `numArg` accepts a number's string form. Anything that is
 * not a whole number from 0 to 2^64-1 is refused: `BigInt(" ")` is 0, so a
 * blank or padded placeholder used to ask for epoch 0 or checkpoint 0.
 *
 * The JSON schema stays `{"type": "string"}`.
 */
export const u64StringArg = () =>
  z.preprocess(
    (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : v),
    z.string().transform((raw, ctx) => {
      const text = raw.trim();
      if (/^\d+$/.test(text) && BigInt(text) <= U64_MAX) return text;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected a whole number from 0 to 2^64-1, received ${quoteInput(raw)}.`,
      });
      return z.NEVER;
    }),
  );

/** An ISO 8601 date, optionally with a time and zone: `2025-09-07`, `2025-09-07T16:00:00Z`. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * Why `value` is not a point on the chain's timeline, or null when it is one.
 * A point is a whole non-negative number (a checkpoint, or Unix seconds where
 * the field says so), `'now'`, or an ISO 8601 time. `Date.parse("-5")` is a
 * date in 6 BC, so a negative number written as text read as a time.
 */
export function pointProblem(value: string | number): string | null {
  const expected = "Expected an ISO 8601 time (2025-09-07T16:00:00Z), 'now', or a whole non-negative number";
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? null : `${expected}, received ${value}.`;
  }
  const text = value.trim();
  if (/^\d+$/.test(text) || /^now$/i.test(text)) return null;
  if (ISO_TIME.test(text) && !Number.isNaN(Date.parse(text))) return null;
  return `${expected}, received ${quoteInput(value)}.`;
}

/** `.superRefine` for a field that takes a point as a string or a number. */
export function refinePoint(value: string | number, ctx: z.RefinementCtx): void {
  const problem = pointProblem(value);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
}

/**
 * A point on the chain's timeline given as a string (see {@link pointProblem}),
 * returned trimmed. The JSON schema stays `{"type": "string"}`.
 */
export const timePointArg = () =>
  z.string().transform((raw, ctx) => {
    refinePoint(raw, ctx);
    return raw.trim();
  });

/** A Move identifier: a module or struct name, at most 128 characters as Sui allows. */
const MOVE_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MOVE_PRIMITIVES: Record<string, true> = {
  bool: true, u8: true, u16: true, u32: true, u64: true, u128: true, u256: true, address: true, signer: true,
};

/** Split a type-argument list at its top-level commas. */
function splitTypeArgs(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "<") depth++;
    else if (text[i] === ">" && --depth < 0) return null;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(text.slice(start));
  return parts;
}

/** Is `text` a Move struct type `0x…::module::Name<…>`, or, as a type argument, any Move type? */
function isMoveType(text: string, typeArgument: boolean): boolean {
  const t = text.trim();
  if (typeArgument && MOVE_PRIMITIVES[t]) return true;
  if (typeArgument && t.startsWith("vector<") && t.endsWith(">")) return isMoveType(t.slice(7, -1), true);
  const lt = t.indexOf("<");
  const [address, module, name, ...rest] = (lt < 0 ? t : t.slice(0, lt)).split("::");
  if (rest.length || !/^0x[0-9a-fA-F]{1,64}$/.test(address) || !MOVE_IDENT.test(module ?? "") || !MOVE_IDENT.test(name ?? "")) {
    return false;
  }
  if (lt < 0) return true;
  if (!t.endsWith(">")) return false;
  const args = splitTypeArgs(t.slice(lt + 1, -1));
  return !!args && args.every((a) => isMoveType(a, true));
}

/**
 * A full Move coin or struct type (`0x2::sui::SUI`, `0x…::pool::Pool<A, B>`),
 * returned trimmed. A malformed type used to reach the chain as a filter that
 * matched nothing, so `0x2::a::b::c` read as "no deny list" and a trace
 * restricted to it read as "no flows".
 *
 * The JSON schema stays `{"type": "string"}`.
 */
export const coinTypeArg = () =>
  z.string().transform((raw, ctx) => {
    if (isMoveType(raw, false)) return raw.trim();
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Not a Move type: ${quoteInput(raw)}. Expected 0x<address>::<module>::<Name>, e.g. 0x2::sui::SUI.`,
    });
    return z.NEVER;
  });

/** An MVR name: `@org/app`, `org.sui/app`, optionally pinned as `@org/app/3`. */
const MVR_NAME = /^(?:@[a-z0-9-]+|(?:[a-z0-9-]+\.)+sui)\/[a-z0-9-]+(?:\/\d+)?$/;

/**
 * A Move Registry name, returned trimmed and lower-cased. The name goes into
 * the registry's URL path, so a malformed one either reached a different
 * endpoint or came back as "not registered".
 *
 * The JSON schema stays `{"type": "string"}`.
 */
export const mvrNameArg = () =>
  z.string().transform((raw, ctx) => {
    const text = raw.trim().toLowerCase();
    if (MVR_NAME.test(text)) return text;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Not an MVR name: ${quoteInput(raw)}. Expected @org/app, optionally pinned as @org/app/3.`,
    });
    return z.NEVER;
  });

/** A struct named through MVR: `@org/app::module::Type`, optionally pinned. The JSON schema stays `{"type": "string"}`. */
export const mvrTypeArg = () =>
  z.string().transform((raw, ctx) => {
    const text = raw.trim();
    const [name, module, type, ...rest] = text.split("::");
    if (!rest.length && MVR_NAME.test(name.toLowerCase()) && MOVE_IDENT.test(module ?? "") && /^[A-Za-z_][A-Za-z0-9_]{0,127}(?:<.+>)?$/.test(type ?? "")) {
      return `${name.toLowerCase()}::${module}::${type}`;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Not an MVR struct path: ${quoteInput(raw)}. Expected @org/app::module::Type.`,
    });
    return z.NEVER;
  });

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

/** Edit distance between two argument names, for "did you mean". */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** The argument a misspelt or shortened name most likely meant, if one is close. */
function closestArgument(key: string, names: string[]): string | undefined {
  const lower = key.toLowerCase();
  const byPart = names.find((n) => n.split("_").includes(lower) || lower.startsWith(n));
  if (byPart) return byPart;
  let best: string | undefined;
  let bestDistance = 3;
  for (const n of names) {
    const d = editDistance(lower, n);
    if (d < bestDistance) [best, bestDistance] = [n, d];
  }
  return best;
}

/** The message for arguments a tool does not take, naming the ones it does. */
export function unknownArgumentsMessage(keys: string[], names: string[]): string {
  const listed = keys.map((k) => {
    const near = closestArgument(k, names);
    return near ? `${quoteInput(k)} (did you mean ${near}?)` : quoteInput(k);
  });
  const valid = names.length ? `Valid arguments: ${names.join(", ")}.` : "This tool takes no arguments.";
  return `Unknown argument${keys.length > 1 ? "s" : ""} ${listed.join(", ")}. ${valid}`;
}

/** Does this field, under its optional/default/describe wrappers, take an array? */
function takesArray(schema: z.ZodTypeAny): boolean {
  let node: z.ZodTypeAny | undefined = schema;
  while (node) {
    const def = node._def as { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    if (def.typeName === z.ZodFirstPartyTypeKind.ZodArray) return true;
    node = def.innerType ?? def.schema;
  }
  return false;
}

const BLANK = "Empty string. Omit the argument to leave it unset.";

/**
 * Accept the argument shapes a model sends for "unset" and "one of these",
 * and refuse a blank string.
 *
 * `null` means the caller is leaving the argument out: an optional field falls
 * back to its default and a required one reports "Required". Without this,
 * `limit: null` reached a number coercion as 0 and returned an empty page with
 * `has_next_page: false`, which reads as "this address never sent anything".
 *
 * A bare string where the field takes a list becomes a one-item list, so
 * `digests: "abc"` works the same as `digests: ["abc"]`.
 *
 * A blank string, alone or in a list, is refused for every field. No argument
 * here means anything when blank, and handlers read one as unset (`if
 * (coin_type)`), as zero (`BigInt(" ")`), or as a match-everything filter, so
 * `search_token` with `query: ""` returned every token it knew.
 *
 * All of it runs as a preprocess on the field, so the generated JSON schema is
 * the field's own.
 */
function lenientField(schema: z.ZodTypeAny): z.ZodTypeAny {
  const array = takesArray(schema);
  return z.preprocess((v, ctx) => {
    if (v === null) return undefined;
    if (typeof v === "string" && v.trim() === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: BLANK, fatal: true });
      return v;
    }
    if (Array.isArray(v)) {
      const blank = v.findIndex((item) => typeof item === "string" && item.trim() === "");
      if (blank >= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Item ${blank} is an empty string.`, fatal: true });
        return v;
      }
    }
    return array && typeof v === "string" ? [v] : v;
  }, schema);
}

/**
 * The object a tool's arguments are parsed with.
 *
 * Unknown keys are refused. A plain `z.object` strips them, so a misspelt
 * argument (`module` for `module_name`) was dropped and the tool answered a
 * different question as if nothing were wrong. The refusal names the
 * arguments the tool takes and the closest match. The advertised JSON schema
 * already says `additionalProperties: false`, so this makes the server do
 * what it publishes.
 *
 * Every field is wrapped by {@link lenientField}, so `null` is unset, a bare
 * string fills a list, and a blank string is refused, for every tool.
 */
export function toolArgsSchema(shape: z.ZodRawShape) {
  const names = Object.keys(shape);
  const fields = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, lenientField(v)]));
  return z
    .object(fields, {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.unrecognized_keys
          ? { message: unknownArgumentsMessage(issue.keys, names) }
          : { message: ctx.defaultError },
    })
    .strict();
}
