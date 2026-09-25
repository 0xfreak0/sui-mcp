import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP metadata every tool carries, applied in the registration wrapper
 * (`withNetworkParam`) so a tool file never has to state it and a new tool is
 * covered the moment it registers.
 *
 * The default describes a chain read: it changes nothing and it talks to the
 * outside world (Sui, an indexer, a price API). Only the exceptions are listed
 * in {@link OVERRIDES}.
 *
 * Read-only means the tool leaves no state a later call can observe as
 * changed. Tools that fill the local cache (`saveTransaction`, `saveFanout`,
 * `saveFirstFunder`, `saveKioskOwners`) stay read-only: a cached answer is the
 * same answer. A tool that writes a record (a finding, a label, a watch, a
 * watch cursor) is not, and `test/tool-annotations.test.ts` fails when one is
 * marked read-only.
 */
export interface ToolPolicy {
  title: string;
  annotations: ToolAnnotations;
  /** Inject the per-call `network` argument. Off for tools that never read the chain. */
  network: boolean;
  /**
   * Also return the first JSON object in the result as `structuredContent`.
   * Opt-in per tool: it sends the payload twice, and a client that forwards
   * both to the model pays for it twice.
   */
  structured: boolean;
  /** Tool-list `_meta`, e.g. Claude Code's per-tool result-size limit. */
  meta?: Record<string, unknown>;
}

/** Claude Code's ceiling for `anthropic/maxResultSizeChars`. */
export const MAX_RESULT_SIZE_CHARS = 500_000;

/**
 * Tools whose complete answer is the point. Claude Code writes a result over
 * ~50k characters to a file and shows the model a preview; these declare the
 * ceiling so the whole result arrives inline.
 */
const FULL_SIZE = { "anthropic/maxResultSizeChars": MAX_RESULT_SIZE_CHARS };

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
/** Reads only the local store. */
const LOCAL_READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

interface Override {
  title?: string;
  annotations?: ToolAnnotations;
  network?: boolean;
  structured?: boolean;
  meta?: Record<string, unknown>;
}

/**
 * Every tool that differs from the chain-read default.
 *
 * `network: false` is for tools that never touch the chain and never qualify a
 * bare address with the call's network. `save_finding`, `manage_labels` and
 * `watch_addresses` keep it: a bare address they are given is recorded against
 * the network the call targets.
 */
export const OVERRIDES: Record<string, Override> = {
  // Records. The write is the operation.
  save_finding: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  delete_finding: {
    network: false,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  list_findings: { network: false, annotations: LOCAL_READ },
  export_case: { network: false, annotations: LOCAL_READ },
  // add/import write labels and `remove` deletes one.
  manage_labels: {
    title: "Manage address labels",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  // add reads the current checkpoint; remove deletes a watch.
  watch_addresses: {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  // Advances each watch's cursor, so a second poll answers differently.
  poll_watch: {
    title: "Poll watched addresses",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  // Changes which tools this session lists, nothing outside it.
  enable_tools: { title: "Enable tool profiles", annotations: LOCAL_READ },

  // Policy-complete results: declare the size, and return structured JSON
  // where the result is one object.
  get_transaction: { meta: FULL_SIZE },
  get_transactions: { meta: FULL_SIZE },
  find_funding_sources: { meta: FULL_SIZE, structured: true },
  analyze_attack_tx: { title: "Analyze attack transaction", meta: FULL_SIZE, structured: true },
  summarize_incident_losses: { meta: FULL_SIZE },
  screen_address: { meta: FULL_SIZE, structured: true },
  trace_funds: { structured: true },
  build_wallet_edges: { structured: true },
};

/** Words a title spells differently from the tool name. */
const TITLE_WORDS: Record<string, string> = {
  nft: "NFT",
  nfts: "NFTs",
  ptb: "PTB",
  mvr: "MVR",
  defi: "DeFi",
  deepbook: "DeepBook",
  tx: "transaction",
  sui: "Sui",
};

/** `get_nft_sales` → "Get NFT sales". */
export function titleFromName(name: string): string {
  const words = name.split("_").map((w) => TITLE_WORDS[w] ?? w);
  const [head = "", ...rest] = words;
  return [head.charAt(0).toUpperCase() + head.slice(1), ...rest].join(" ");
}

/** The metadata a tool registers with: the default, then its override. */
export function toolPolicy(name: string): ToolPolicy {
  const o = OVERRIDES[name] ?? {};
  return {
    title: o.title ?? titleFromName(name),
    annotations: { ...READ, ...o.annotations },
    network: o.network ?? true,
    structured: o.structured ?? false,
    ...(o.meta ? { meta: o.meta } : {}),
  };
}

interface TextResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * Add `structuredContent` from the first text item that is a JSON object.
 * A tool that leads with prose (trace_funds) puts its JSON in a later item;
 * a result with no JSON object, or an error, is returned unchanged.
 */
export function withStructuredContent<T extends TextResult>(result: T): T {
  if (!result?.content || result.isError || result.structuredContent) return result;
  for (const item of result.content) {
    if (item.type !== "text" || !item.text) continue;
    const text = item.text.trimStart();
    if (!text.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...result, structuredContent: parsed as Record<string, unknown> };
      }
    } catch {
      // Not JSON: try the next item.
    }
  }
  return result;
}
