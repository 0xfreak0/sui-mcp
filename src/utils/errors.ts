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
