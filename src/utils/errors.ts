/**
 * Standard error response for MCP tools.
 * Uses the SDK's isError flag so clients can distinguish errors from data.
 */
export function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Is this a gRPC NOT_FOUND?
 *
 * The distinction matters wherever absence is itself an answer. `getObject`
 * throwing NOT_FOUND means there is genuinely no object at that address —
 * which is how `identify_address` concludes an address is a wallet. Every
 * other failure means the question could not be asked, and treating the two
 * alike turns an outage into a confident misclassification.
 *
 * Matches on the gRPC status rather than message text, falling back to the
 * string only when no code is present.
 */
export function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code.toUpperCase() === "NOT_FOUND";
  // grpc-js uses numeric status codes; 5 is NOT_FOUND.
  if (typeof code === "number") return code === 5;
  return /\bNOT_FOUND\b/i.test((err as Error).message ?? "");
}
