import { EXTERNAL_HTTP_TIMEOUT_MS, getMvrUrl } from "../config.js";

/**
 * Low-level Move Registry HTTP call for the current call's network.
 *
 * Shared by the `mvr_*` tools and by protocol-name enrichment so there is one
 * place that knows the base URL, the timeout, and MVR's error shape.
 */
export async function mvrFetch(path: string, init?: RequestInit): Promise<unknown> {
  const base = getMvrUrl();
  if (!base) {
    throw new Error("Move Registry is not available on this network (devnet has no MVR endpoint).");
  }
  const res = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "message" in (body as object)
        ? (body as { message: unknown }).message
        : text || res.statusText;
    throw new Error(`MVR ${res.status}: ${msg}`);
  }
  return body;
}

/**
 * Reverse-resolve many package IDs to their MVR names in one request.
 *
 * Returns a map covering every requested ID; unregistered packages map to null.
 * MVR coverage is thin — most mainnet packages are not registered — so nulls
 * are the common case, not an error.
 */
/**
 * MVR's server-side batch limit.
 *
 * Exceeding it returns `400 Batch size limit exceeded: 86 > 50`, which the only
 * caller catches — so the failure was silent and total: 51 packages lost their
 * names, not just the 51st. Batching transactions made this easy to reach,
 * since a batch collects packages across every transaction in it.
 */
const MVR_BULK_LIMIT = 50;

export async function reverseResolveBulk(
  packageIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (packageIds.length === 0) return out;

  for (let i = 0; i < packageIds.length; i += MVR_BULK_LIMIT) {
    const chunk = packageIds.slice(i, i + MVR_BULK_LIMIT);
    // Per chunk, so one failed page costs only its own names rather than
    // discarding the pages that already succeeded.
    try {
      const data = (await mvrFetch("/reverse-resolution/bulk", {
        method: "POST",
        body: JSON.stringify({ package_ids: chunk }),
      })) as { resolution?: Record<string, { name?: string | null } | null> };

      for (const id of chunk) {
        out.set(id, data.resolution?.[id]?.name ?? null);
      }
    } catch {
      // Leave this chunk unresolved. The caller distinguishes "absent from the
      // map" from "resolved to null", and only the latter is cached.
    }
  }
  return out;
}
