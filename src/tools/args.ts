/**
 * Argument types that tolerate how models actually call tools.
 *
 * MCP arguments arrive as JSON, and a model composing that JSON will sometimes
 * quote a number: `max_hops: "8"`. Strict `z.number()` rejects it and the whole
 * call fails with a validation error, which is a hard failure for something
 * trivially recoverable — the caller's intent was never ambiguous.
 *
 * Coercion does **not** loosen the advertised contract. `z.coerce.number()`
 * still generates `{"type": "integer"}` in the tool's JSON schema, so a client
 * reading the schema sees exactly what it saw before; the server is simply
 * lenient about what it accepts. Genuine nonsense (`"abc"`) still fails.
 */

import { z } from "zod";

/** A number that also accepts its string form. Chains like `z.number()`. */
export const numArg = () => z.coerce.number();

/**
 * A boolean that also accepts `"true"` / `"false"`.
 *
 * Deliberately NOT `z.coerce.boolean()`, which is a trap: it applies JavaScript
 * truthiness, so the string `"false"` becomes `true` — silently inverting the
 * caller's intent, which is worse than the rejection this is meant to fix.
 * Only the two exact strings are mapped; anything else is left alone for
 * `z.boolean()` to reject on its own terms.
 */
export const boolArg = () =>
  z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());
