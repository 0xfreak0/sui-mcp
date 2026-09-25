import { SUI_NETWORKS, type SuiNetwork } from "../config.js";

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

/** Longest error message a tool reply carries; the rest is noise from the transport. */
const MAX_ERROR_CHARS = 500;

/**
 * Reduce a failure to one line a reader can act on.
 *
 * gRPC-web percent-encodes its status message (`invalid%20owner`), and
 * `graphql-request` appends the whole request and response as JSON, which put
 * two thousand characters of query text in front of the one sentence that
 * mattered. This decodes the first, cuts the second, keeps the first non-empty
 * line, and caps the length.
 *
 * A not-found gets the network it was looked up on, since a digest or object
 * from testnet is simply absent on mainnet and nothing else in the message
 * says which network was asked.
 */
export function cleanErrorMessage(raw: string, network: SuiNetwork, notFound = false): string {
  let msg = raw;
  if (/%[0-9a-f]{2}/i.test(msg)) {
    try {
      msg = decodeURIComponent(msg);
    } catch {
      // A literal "%" that is not an escape: keep the text as it came.
    }
  }
  const dump = msg.indexOf(': {"response":');
  if (dump > 0) msg = msg.slice(0, dump);
  msg = msg.split("\n").map((line) => line.trim()).find(Boolean) ?? "Unknown error";
  if (msg.length > MAX_ERROR_CHARS) msg = `${msg.slice(0, MAX_ERROR_CHARS)}…`;
  if (/^NOT_FOUND$/i.test(msg)) msg = "Not found";
  if ((notFound || /\bnot[ _]found\b/i.test(msg)) && !/\bnetwork\b/i.test(msg)) {
    const others = SUI_NETWORKS.filter((n) => n !== network).map((n) => `'${n}'`).join(" or ");
    msg += ` (looked up on ${network}; if it came from another network, pass network: ${others})`;
  }
  return msg;
}

/** {@link cleanErrorMessage} for a thrown value of any shape. */
export function describeError(err: unknown, network: SuiNetwork): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  return cleanErrorMessage(raw ?? String(err), network, isNotFound(err));
}
