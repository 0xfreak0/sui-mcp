import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, GraphQLClient } from "graphql-request";
import {
  type SuiNetwork,
  GRAPHQL_TRANSPORT,
  RATE_WINDOW_MS,
  getNetwork,
  getNetworkConfig,
  rateLimitFor,
} from "../config.js";

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
  /** Clock for the rate window. A seam for tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Requests per {@link RATE_WINDOW_MS} window for this host; null for none.
   * Defaults to {@link rateLimitFor} the endpoint's host.
   */
  rateLimit?: number | null;
  /** Names the service in a timeout or connection error (default "GraphQL"). */
  service?: string;
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

/** At most `limit` request starts in any window of `windowMs`, in arrival order. */
export class RateWindow {
  private readonly starts: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => performance.now(),
    private readonly wait: (ms: number) => Promise<unknown> = sleep,
  ) {}

  /** Resolves when a request may start; callers are served first come, first served. */
  acquire(): Promise<void> {
    const turn = this.tail.then(() => this.take());
    this.tail = turn.catch(() => {});
    return turn;
  }

  private async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.starts.length && this.starts[0] <= t - this.windowMs) this.starts.shift();
      if (this.starts.length < this.limit) {
        this.starts.push(t);
        return;
      }
      await this.wait(this.starts[0] + this.windowMs - t + 1);
    }
  }
}

/** One window per host, shared by every client that talks to it. */
const hostWindows = new Map<string, RateWindow>();

function windowFor(hostname: string, limit: number, options: GraphqlTransportOptions): RateWindow {
  if (options.now || options.sleep) return new RateWindow(limit, RATE_WINDOW_MS, options.now, options.sleep);
  const key = `${hostname}|${limit}`;
  let w = hostWindows.get(key);
  if (!w) hostWindows.set(key, (w = new RateWindow(limit, RATE_WINDOW_MS)));
  return w;
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
 * A `fetch` for one GraphQL or gRPC-web endpoint that queues, times out and retries.
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
  const url = new URL(endpoint);
  const host = url.host;
  const limit = options.rateLimit === undefined ? rateLimitFor(url.hostname) : options.rateLimit;
  const window = limit ? windowFor(url.hostname, limit, options) : null;
  const wait = options.sleep ?? sleep;
  const service = options.service ?? "GraphQL";

  return async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= options.attempts;
      const backoff = Math.min(
        options.maxDelayMs,
        options.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2),
      );

      await limiter.acquire();
      if (window) await window.acquire();
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(options.timeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        response = await globalThis.fetch(input, { ...init, signal });
      } catch (err) {
        if ((err as Error)?.name === "TimeoutError") {
          throw new Error(`${service} request to ${host} timed out after ${options.timeoutMs / 1000}s`);
        }
        const code = errorCode(err);
        if (!code || !RETRYABLE_CODES.has(code)) throw err;
        if (last) {
          throw new Error(`${service} request to ${host} failed (${code}); tried ${attempt} times`);
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
