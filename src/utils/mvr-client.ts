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
export async function reverseResolveBulk(
  packageIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (packageIds.length === 0) return out;

  const data = (await mvrFetch("/reverse-resolution/bulk", {
    method: "POST",
    body: JSON.stringify({ package_ids: packageIds }),
  })) as { resolution?: Record<string, { name?: string | null } | null> };

  for (const id of packageIds) {
    out.set(id, data.resolution?.[id]?.name ?? null);
  }
  return out;
}
