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

const EVENT_JSON_QUERY = `query ($digest: String!) {
  transaction(digest: $digest) {
    effects {
      events {
        nodes {
          contents { type { repr } json }
        }
      }
    }
  }
}`;

interface EventJsonResult {
  transaction: {
    effects: {
      events: { nodes: Array<{ contents?: { type?: { repr?: string }; json?: unknown } }> };
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
  try {
    const r = await gqlQuery<EventJsonResult>(EVENT_JSON_QUERY, { digest });
    const nodes = r.transaction?.effects?.events?.nodes;
    if (!nodes) return null;
    return nodes.map((n) => ({ type: n.contents?.type?.repr ?? null, json: n.contents?.json ?? null }));
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
