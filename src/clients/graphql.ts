import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, GraphQLClient } from "graphql-request";
import { type SuiNetwork, GRAPHQL_TRANSPORT, getNetwork, getNetworkConfig } from "../config.js";

/** Connection failures worth another try: the request never got an answer. */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Settings for {@link retryingFetch}; defaults to {@link GRAPHQL_TRANSPORT}. */
export interface GraphqlTransportOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  concurrency: number;
  /** How to wait between attempts. A seam for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<unknown>;
}

/** A FIFO counting semaphore. */
class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  /** Hand the slot straight to the next waiter, or free it. */
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

/** Milliseconds a `Retry-After` header asks for (seconds or an HTTP date), or null. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A `fetch` for one GraphQL endpoint that queues, times out and retries.
 *
 * Each attempt waits for a slot in the endpoint's limiter and runs under its
 * own `AbortSignal.timeout`. A 429 or 5xx is retried after the `Retry-After`
 * the server asked for, or a jittered exponential backoff, and the slot is
 * given up while waiting. After the last attempt the final response is
 * returned as-is, so `graphql-request` reports its status.
 */
export function retryingFetch(
  endpoint: string,
  options: GraphqlTransportOptions = GRAPHQL_TRANSPORT,
): typeof fetch {
  const limiter = new Limiter(options.concurrency);
  const host = new URL(endpoint).host;
  const wait = options.sleep ?? sleep;

  return async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= options.attempts;
      const backoff = Math.min(
        options.maxDelayMs,
        options.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2),
      );

      await limiter.acquire();
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(options.timeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        response = await globalThis.fetch(input, { ...init, signal });
      } catch (err) {
        if ((err as Error)?.name === "TimeoutError") {
          throw new Error(`GraphQL request to ${host} timed out after ${options.timeoutMs / 1000}s`);
        }
        const code = errorCode(err);
        if (!code || !RETRYABLE_CODES.has(code)) throw err;
        if (last) {
          throw new Error(`GraphQL request to ${host} failed (${code}); tried ${attempt} times`);
        }
        await wait(backoff);
        continue;
      } finally {
        limiter.release();
      }

      if (last || (response.status !== 429 && response.status < 500)) return response;
      const asked = retryAfterMs(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => {});
      await wait(asked === null ? backoff : Math.min(asked, options.maxDelayMs));
    }
  };
}

/**
 * Reduce a `graphql-request` failure to one line.
 *
 * `ClientError.message` carries the whole request and response as JSON, which
 * for a 429 from the public endpoint is an HTML page. The reader needs the
 * first GraphQL error, or the HTTP status and what to do about it.
 */
function graphqlError(err: unknown, endpoint: string): Error {
  if (!(err instanceof ClientError)) return err as Error;
  const host = new URL(endpoint).host;
  const { errors, status } = err.response;
  if (errors?.length) {
    const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
    return new Error(`GraphQL error: ${errors[0].message}${more}`);
  }
  if (status === 429) {
    return new Error(
      `Rate-limited by ${host} (HTTP 429) after ${GRAPHQL_TRANSPORT.attempts} attempts. ` +
        "Retry shortly, or set SUI_GRAPHQL_URL to a private endpoint for heavy use.",
    );
  }
  return new Error(`GraphQL request to ${host} failed with HTTP ${status}`);
}

// One GraphQL client per network, built on first use and reused thereafter.
const clientCache = new Map<SuiNetwork, GraphQLClient>();

/** Get the GraphQL client for a network (defaults to the current call's network). */
export function getGraphqlClient(network: SuiNetwork = getNetwork()): GraphQLClient {
  let client = clientCache.get(network);
  if (!client) {
    const endpoint = getNetworkConfig(network).graphql;
    client = new GraphQLClient(endpoint, { fetch: retryingFetch(endpoint) });
    clientCache.set(network, client);
  }
  return client;
}

/** Run a GraphQL query against the current call's network endpoint. */
export async function gqlQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const network = getNetwork();
  try {
    return await getGraphqlClient(network).request<T>(query, variables);
  } catch (err) {
    throw graphqlError(err, getNetworkConfig(network).graphql);
  }
}
