import { DEFAULT_NETWORK } from "../config.js";

/**
 * Bind complete tool calls in decoded output to the chain that produced it.
 * `repeat_with` is a patch to the caller's original args, which retain network.
 * Returns whether it changed the JSON tree; callers own the decoded value.
 */
export function bindContinuationNetwork(value: unknown, network: string): boolean {
  if (network === DEFAULT_NETWORK || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    let changed = false;
    for (const child of value) changed = bindContinuationNetwork(child, network) || changed;
    return changed;
  }
  const object = value as Record<string, unknown>;
  let changed = false;
  if (typeof object.tool === "string" && object.args && typeof object.args === "object" && !Array.isArray(object.args)) {
    const args = object.args as Record<string, unknown>;
    if (args.network === undefined) {
      args.network = network;
      changed = true;
    }
  }
  for (const child of Object.values(object)) changed = bindContinuationNetwork(child, network) || changed;
  return changed;
}
