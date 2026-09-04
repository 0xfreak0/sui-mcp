/**
 * Parsed event fields, and the protocols an event set implicates.
 *
 * Two things live here because they come from the same place and were missing
 * for the same reason.
 *
 * **Parsed fields.** The gRPC `Event` carries `eventType`, `module`, `sender`
 * and BCS — but no decoded JSON. So `get_transaction` could report that an
 * `order_info::OrderPlaced` fired and not what was ordered, which sends anyone
 * who needs the actual values off to hand-write GraphQL. GraphQL exposes the
 * decoded value under `contents.json`; this is the same documented exception
 * the bridge resolvers rely on, where a point lookup reaches for GraphQL
 * because gRPC cannot answer.
 *
 * **Protocol attribution.** Protocols used to be derived from Move call
 * targets alone. A transaction that calls an obfuscated wrapper and emits a
 * dozen DeepBook events therefore reported `protocols: []` — while the
 * registry, asked directly, resolves the event's own package to DeepBook by
 * upgrade lineage. Nobody asked it.
 *
 * That failure runs the wrong way round for investigation work. Hashed module
 * names (`h86261::h8b64d`) are exactly what a bot or a laundering route looks
 * like, so it is precisely the transactions worth naming that went unnamed. An
 * event type is also the harder thing to lie about: a wrapper package chooses
 * its own name, but the event it emits carries the type of whoever defined it.
 */

import { gqlQuery } from "../clients/graphql.js";

/**
 * Note the explicit `first` and the cursor.
 *
 * The events connection defaults to **20 nodes and paginates**, while gRPC
 * returns every event. Asking without a page argument therefore produced a
 * short list for any busy transaction — a 59-event transaction came back with
 * 20 — and the length guard downstream then correctly refused to attach
 * anything, so the feature silently did nothing on exactly the transactions
 * that needed it. Page size is capped at 50 server-side.
 */
const EVENT_JSON_QUERY = `query ($digest: String!, $first: Int!, $after: String) {
  transaction(digest: $digest) {
    effects {
      events(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          contents { type { repr } json }
        }
      }
    }
  }
}`;

/** GraphQL's hard page cap. */
const PAGE = 50;

/**
 * Pages to walk before giving up.
 *
 * 20 pages is 1000 events, far beyond anything observed (the 99th percentile of
 * transactions with events sits at 20 events). The bound exists so a pathological
 * transaction cannot turn one lookup into an unbounded crawl.
 */
const MAX_PAGES = 20;

interface EventJsonResult {
  transaction: {
    effects: {
      events: {
        pageInfo?: { hasNextPage: boolean; endCursor?: string };
        nodes: Array<{ contents?: { type?: { repr?: string }; json?: unknown } }>;
      };
    } | null;
  } | null;
}

export interface ParsedEvent {
  type: string | null;
  json: unknown;
}

/**
 * Decoded contents for a transaction's events, in emission order.
 *
 * Returns null rather than throwing: parsed fields are an enrichment, and a
 * GraphQL hiccup must not fail a transaction lookup that gRPC already answered.
 */
export async function fetchEventJson(digest: string): Promise<ParsedEvent[] | null> {
  const out: ParsedEvent[] = [];
  let after: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await gqlQuery<EventJsonResult>(EVENT_JSON_QUERY, { digest, first: PAGE, after });
      const events = r.transaction?.effects?.events;
      if (!events?.nodes) return out.length > 0 ? out : null;
      for (const n of events.nodes) {
        out.push({ type: n.contents?.type?.repr ?? null, json: n.contents?.json ?? null });
      }
      // A response without pageInfo is treated as a single complete page
      // rather than an error: returning what was read beats discarding it.
      if (!events.pageInfo?.hasNextPage) return out;
      after = events.pageInfo.endCursor;
      // A connection claiming another page but handing back no cursor would
      // loop forever on the same one.
      if (!after) return out;
    }
    // Ran out of pages. Returning a partial list would fail the caller's length
    // check anyway; null says "no answer" rather than "this is all of them".
    return null;
  } catch {
    return null;
  }
}

/**
 * The package that *defines* an event type, which is not always the one that
 * emitted it.
 *
 * A wrapper calls into DeepBook and DeepBook's own type comes back out, so the
 * defining package is the informative half. Both are collected by the caller,
 * since the emitter is worth resolving too when it happens to be known.
 */
export function packageOfEventType(eventType: string | null | undefined): string | null {
  if (!eventType) return null;
  const pkg = eventType.split("::")[0];
  return pkg?.startsWith("0x") ? pkg : null;
}
