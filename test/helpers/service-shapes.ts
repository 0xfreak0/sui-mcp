/**
 * Builders for responses the real services can actually produce.
 *
 * Three separate bugs shipped green because a mock answered something the
 * service never sends:
 *
 *   - `activeValidators(first: 200)` was mocked as a single page with no
 *     `pageInfo`. Mainnet rejects that query outright — "Page size is too
 *     large: 200 > 50" — so `identify_address` had *never once* detected a
 *     validator and `get_staking_summary` failed on every call naming one. The
 *     tests passed throughout.
 *   - Absence was mocked as `new Error("not found")`. The service signals it
 *     with a gRPC `NOT_FOUND` status, so a fix that keys on the status looked
 *     broken while the buggy catch-everything looked correct.
 *   - Both let a completely dead code path report success.
 *
 * A mock is an assertion about the outside world. When it asserts something
 * false, the test stops testing anything. These builders encode the
 * constraints the services actually impose, and **throw** rather than build a
 * response that could not occur — so an impossible assumption fails loudly at
 * authoring time instead of silently passing forever.
 */

/** GraphQL page cap. Documented in CLAUDE.md and enforced by the service. */
export const GQL_MAX_PAGE_SIZE = 50;

/**
 * A GraphQL connection page.
 *
 * Always carries `pageInfo`, because every real connection does and code that
 * paginates reads it. Refuses more than the service's page cap: a test that
 * wants 200 nodes in one page is describing a request the service rejects with
 * a validation error, and mocking it hides that.
 */
export function gqlPage<T>(
  nodes: T[],
  opts: { hasNextPage?: boolean; endCursor?: string | null } = {},
): { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] } {
  if (nodes.length > GQL_MAX_PAGE_SIZE) {
    throw new Error(
      `gqlPage: ${nodes.length} nodes exceeds the GraphQL page cap of ${GQL_MAX_PAGE_SIZE}. ` +
        "The service rejects an over-cap request with a validation error rather than returning " +
        "a large page, so this response cannot occur. Split it into pages with hasNextPage.",
    );
  }
  const hasNextPage = opts.hasNextPage ?? false;
  if (hasNextPage && opts.endCursor === null) {
    throw new Error(
      "gqlPage: hasNextPage is true but endCursor is null. A pager would stop early or spin; " +
        "the service always returns a cursor when more pages exist.",
    );
  }
  return {
    pageInfo: { hasNextPage, endCursor: opts.endCursor ?? (hasNextPage ? "cursor" : null) },
    nodes,
  };
}

/**
 * Split a list into service-shaped pages, each within the cap and linked by
 * cursors. Use when a test needs multi-page behaviour without hand-writing it.
 */
export function gqlPages<T>(all: T[], pageSize = GQL_MAX_PAGE_SIZE) {
  const pages: ReturnType<typeof gqlPage<T>>[] = [];
  for (let i = 0; i < all.length; i += pageSize) {
    const slice = all.slice(i, i + pageSize);
    const more = i + pageSize < all.length;
    pages.push(gqlPage(slice, { hasNextPage: more, endCursor: more ? `cursor-${i}` : null }));
  }
  return pages.length ? pages : [gqlPage<T>([])];
}

/* ------------------------------------------------------------------ *
 * gRPC status errors
 * ------------------------------------------------------------------ */

/** gRPC status codes this codebase distinguishes. */
export const GRPC_STATUS = {
  NOT_FOUND: 5,
  UNAVAILABLE: 14,
  DEADLINE_EXCEEDED: 4,
  PERMISSION_DENIED: 7,
} as const;

/**
 * The error the service throws when a thing does not exist.
 *
 * CLAUDE.md records that pruned and nonexistent data both surface as a gRPC
 * `NOT_FOUND` **throw**, not an empty response — and callers conclude real
 * things from that distinction (`identify_address` answers "wallet" on it).
 * A bare `new Error("not found")` carries no status, so any code that checks
 * the status correctly will treat it as an unknown failure.
 */
export function notFoundError(message = "object not found"): Error {
  return Object.assign(new Error(`5 NOT_FOUND: ${message}`), {
    code: "NOT_FOUND",
    status: GRPC_STATUS.NOT_FOUND,
  });
}

/**
 * A transport-level failure: the question could not be asked.
 *
 * Distinct from {@link notFoundError} on purpose. Absence is an answer;
 * an outage is not, and code that conflates them turns a service blip into a
 * confident wrong classification.
 */
export function grpcError(
  code: keyof typeof GRPC_STATUS = "UNAVAILABLE",
  message = "connection refused",
): Error {
  if (code === "NOT_FOUND") {
    throw new Error(
      "grpcError: use notFoundError() for NOT_FOUND. Absence is a different kind of answer from " +
        "a failure, and tests should make which one they mean explicit.",
    );
  }
  return Object.assign(new Error(`${GRPC_STATUS[code]} ${code}: ${message}`), {
    code,
    status: GRPC_STATUS[code],
  });
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

/** A `fetch` response mock, for providers reached over HTTP. */
export function httpOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

/**
 * A failing HTTP response.
 *
 * 401 is worth reaching for by name: Pyth's Hermes endpoint began
 * authenticating price queries, and every call site treated the failure softly
 * enough that prices silently became null. A test that wants to prove a
 * provider degrades correctly should say 401, not "some error".
 */
export function httpError(status = 500, body: unknown = { error: "failed" }) {
  return {
    ok: false,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
