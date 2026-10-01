import { AsyncLocalStorage } from "node:async_hooks";
import type { PriceSource } from "./price-providers.js";

export interface ProviderState { failures: number; reason: string }

/** One provider circuit per independent MCP call, shared by all its pricing reads. */
export const providerContext = new AsyncLocalStorage<Map<PriceSource, ProviderState>>();

/** Direct utility callers also get one isolated circuit when no tool call is active. */
export function withPriceProviderCall<T>(read: () => Promise<T>): Promise<T> {
  return providerContext.getStore() ? read() : providerContext.run(new Map(), read);
}
