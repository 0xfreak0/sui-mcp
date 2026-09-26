/**
 * GraphQL shapes for `trace_funds` tests, as the service returns them: coin
 * types padded, connections carrying `pageInfo`, gas summaries present.
 * Built through `gqlPage` so an over-cap page cannot be mocked.
 */
import { gqlPage } from "./service-shapes.js";

export const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
export const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
export const CETUS = "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS";

export interface HopSpec {
  digest: string;
  sender: string;
  checkpoint?: number;
  timestamp?: string;
  /** [owner, signed amount, coin type (default SUI)] */
  changes: Array<[string, string, string?]>;
  /** Defaults to the sender. */
  gasPayer?: string;
  /** Net gas charged to the payer, in MIST. Default 0. */
  netGas?: number;
  /** [package, module, function] */
  calls?: Array<[string, string, string]>;
  events?: string[];
  signatures?: string[];
}

const balanceNodes = (h: HopSpec) =>
  h.changes.map(([address, amount, coin]) => ({ coinType: { repr: coin ?? SUI }, amount, owner: { address } }));

const gasSummary = (h: HopSpec) => ({ computationCost: h.netGas ?? 0, storageCost: 0, storageRebate: 0 });

/** The response to trace.ts's single-transaction query. */
export function gqlTx(h: HopSpec) {
  return {
    transaction: {
      digest: h.digest,
      sender: { address: h.sender },
      gasInput: { gasSponsor: { address: h.gasPayer ?? h.sender } },
      signatures: (h.signatures ?? []).map((signatureBytes) => ({ signatureBytes })),
      effects: {
        status: "SUCCESS",
        timestamp: h.timestamp ?? "2026-01-01T00:00:00Z",
        checkpoint: { sequenceNumber: h.checkpoint ?? 100 },
        gasEffects: { gasSummary: gasSummary(h) },
        balanceChanges: gqlPage(balanceNodes(h)),
        events: gqlPage((h.events ?? []).map((repr) => ({ contents: { type: { repr } } }))),
        objectChanges: gqlPage([]),
      },
      kind: {
        commands: gqlPage(
          (h.calls ?? []).map(([pkg, mod, fn]) => ({
            __typename: "MoveCallCommand",
            function: { name: fn, module: { name: mod, package: { address: pkg } } },
          })),
        ),
      },
    },
  };
}

/** A `transactions(...)` page of hop candidates, in ascending order. */
export function candidates(hops: HopSpec[], paging: "forward" | "backward" = "forward") {
  const page = gqlPage(
    hops.map((h) => ({
      digest: h.digest,
      sender: { address: h.sender },
      gasInput: { gasSponsor: { address: h.gasPayer ?? h.sender } },
      effects: { gasEffects: { gasSummary: gasSummary(h) }, balanceChanges: gqlPage(balanceNodes(h)) },
    })),
  );
  return {
    transactions: {
      nodes: page.nodes,
      pageInfo:
        paging === "forward"
          ? { hasNextPage: false, endCursor: null }
          : { hasPreviousPage: false, startCursor: null },
    },
  };
}

/**
 * The `transactions(...)` page a search query gets from `hops`, as the
 * service filters and pages it: the address sent the transaction
 * (`sentAddress`) or appears in its balance changes (`affectedAddress`), the
 * checkpoint lies strictly between the query's bounds, and pages hold 50,
 * forward from `after` or backward from `before`.
 */
export function searchPage(hops: HopSpec[], query: string, vars: Record<string, unknown>) {
  const address = String(vars.address);
  const after = typeof vars.afterCheckpoint === "number" ? vars.afterCheckpoint : -Infinity;
  const before = typeof vars.beforeCheckpoint === "number" ? vars.beforeCheckpoint : Infinity;
  const list = hops.filter(
    (h) =>
      (query.includes("sentAddress") ? h.sender === address : h.changes.some(([a]) => a === address)) &&
      (h.checkpoint ?? 100) > after &&
      (h.checkpoint ?? 100) < before,
  );
  if (query.includes("last:")) {
    const end = typeof vars.before === "string" ? Number(vars.before.slice(2)) : list.length;
    const start = Math.max(0, end - 50);
    const page = candidates(list.slice(start, end), "backward");
    if (start > 0) page.transactions.pageInfo = { hasPreviousPage: true, startCursor: `c-${start}` };
    return page;
  }
  const start = typeof vars.after === "string" ? Number(vars.after.slice(2)) : 0;
  const page = candidates(list.slice(start, start + 50), "forward");
  if (start + 50 < list.length) page.transactions.pageInfo = { hasNextPage: true, endCursor: `c-${start + 50}` };
  return page;
}
