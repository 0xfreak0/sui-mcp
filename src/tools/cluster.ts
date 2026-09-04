import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import { getLabel } from "../utils/labels.js";
import { batchResolveNames } from "../utils/names.js";
import { buildWalletEdges } from "../utils/edge-probe.js";
import { clusterEdges } from "../utils/wallet-edges.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Shared-control clustering, built live rather than from an analytics warehouse.
 *
 * The output deliberately separates two things a reader will otherwise conflate:
 *
 *   - `edges` are **facts**. "These two addresses were first funded by the same
 *     address, in transactions X and Y" is chain-derived and checkable.
 *   - `clusters` are an **inference** drawn from those facts, and this server's
 *     first `heuristic`-tier output. Nothing here proves common ownership.
 *
 * Keeping them apart is the same discipline the bridge resolvers apply to
 * `chain-derived` versus `indexer-attested`: the weaker claim must not borrow
 * the stronger one's confidence on its way into a report.
 */
export function registerClusterTools(server: McpServer) {
  server.tool(
    "build_wallet_edges",
    "(Incident investigation) Find addresses that appear to share an operator with the ones you give it, and say why. Builds shared-control signals live — no analytics warehouse needed — from four sources: a shared first funder, one address first-funding another, a shared gas sponsor, and co-appearance in a single transaction. Every intermediary is measured before it is trusted, so an exchange or a sponsorship relayer is discarded rather than used to link thousands of strangers together. Returns `edges` (facts, each with the transaction digests to check it) separately from `clusters` (an inference — heuristic tier, never proof of ownership). Use it when a fund trace hands off to a fresh address and you want to know whether it is really a new party or the same one moving money between their own wallets.",
    {
      addresses: z
        .array(z.string())
        .min(1)
        .max(25)
        .describe("Seed addresses to examine (1-25). Give it every address you already suspect belongs together — links between seeds are the exactly-verified ones."),
      expand: z
        .boolean()
        .optional()
        .describe(
          "Also look for unknown siblings, not just links among the seeds (default true). Each candidate is verified by computing its own first funder before it is admitted.",
        ),
      expand_budget: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe("Sibling candidates to verify while expanding (default 25). Unverified candidates are reported, never silently dropped."),
      popularity_limit: z
        .number()
        .int()
        .min(5)
        .max(500)
        .optional()
        .describe(
          "Distinct counterparties past which a funder or sponsor is treated as a service and discarded (default 50). Raise it only if you have a reason — this is the control that stops an exchange from linking the whole chain together.",
        ),
      min_signal_types: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe(
          "Independent signal types a pair needs before it may merge (default 1). Set 2 for the strict batch-pipeline rule: far higher precision, but it misses ordinary personal alt-wallets, which typically share exactly one mechanism.",
        ),
      max_cluster_size: z
        .number()
        .int()
        .min(2)
        .max(1000)
        .optional()
        .describe("Refuse merges beyond this size (default 100). A runaway cluster is worse than no answer."),
      query_budget: z
        .number()
        .int()
        .min(10)
        .max(600)
        .optional()
        .describe("Hard ceiling on GraphQL requests (default 150). Check `truncated` in the response."),
    },
    async ({
      addresses,
      expand,
      expand_budget,
      popularity_limit,
      min_signal_types,
      max_cluster_size,
      query_budget,
    }) => {
      try {
        // Clustering an exchange is meaningless work — it shares a funder or a
        // sponsor with everybody. Flagged rather than refused: an investigator
        // may deliberately want to see what sits around one.
        const labeledSeeds = addresses
          .map((a) => ({ address: a, label: getLabel(a) }))
          .filter((x) => x.label && ["cex", "bridge", "protocol"].includes(x.label.category));

        const built = await buildWalletEdges(addresses, {
          expand,
          expandBudget: expand_budget,
          popularityLimit: popularity_limit,
          queryBudget: query_budget,
        });

        const clustered = clusterEdges(built.edges, {
          minSignalTypes: min_signal_types,
          maxClusterSize: max_cluster_size,
        });

        const named = await batchResolveNames(built.examined);
        const describe = (a: string) => {
          const label = getLabel(a);
          const name = named.get(a);
          return {
            address: a,
            ...(name ? { name } : {}),
            ...(label ? { label: label.label, category: label.category } : {}),
          };
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  seeds: addresses,
                  examined_count: built.examined.length,
                  queries_used: built.queries_used,
                  truncated: built.truncated,

                  // --- facts ---
                  edge_count: built.edges.length,
                  edges: built.edges.map((e) => ({
                    ...e,
                    wallet_a_info: describe(e.wallet_a),
                    wallet_b_info: describe(e.wallet_b),
                  })),

                  // --- inference ---
                  evidence_tier: "heuristic",
                  clusters: clustered.clusters.map((c) => ({
                    ...c,
                    members: c.members.map(describe),
                  })),
                  ...(clustered.size_capped
                    ? {
                        size_capped_merges: clustered.size_capped,
                        size_cap_note:
                          "Merges were refused for exceeding max_cluster_size. That usually means an intermediary slipped past the popularity filter — inspect excluded_intermediaries and the widest edges before raising the cap.",
                      }
                    : {}),
                  ...(clustered.untrusted_edges.length
                    ? {
                        observed_but_below_threshold: clustered.untrusted_edges,
                        below_threshold_note:
                          "These pairs share a signal but not enough to merge under the current rule. Reported rather than dropped — they are leads, and lowering min_signal_types or reading the evidence yourself may change the picture.",
                      }
                    : {}),

                  ...(built.excluded_intermediaries.length
                    ? {
                        excluded_intermediaries: built.excluded_intermediaries,
                        exclusion_note:
                          "Measured and discarded. These addresses pay or sponsor too many distinct parties for shared ancestry through them to mean anything — this is the control that keeps a single exchange from linking every wallet on the chain into one cluster.",
                      }
                    : {}),
                  ...(labeledSeeds.length
                    ? {
                        warning_labeled_seeds: labeledSeeds.map((x) => ({
                          address: x.address,
                          label: x.label!.label,
                          category: x.label!.category,
                        })),
                        labeled_seed_note:
                          "One or more seeds is a known exchange, bridge or protocol. Those share funders and sponsors with everyone, so edges touching them describe the service, not an operator.",
                      }
                    : {}),
                  ...(built.notes.length ? { notes: built.notes } : {}),

                  caveat:
                    "Edges are facts; clusters are an inference and this server's only heuristic-tier output — never record one as a finding without confirming it yourself. Critically, ABSENCE OF AN EDGE IS NOT EVIDENCE OF SEPARATE CONTROL: every signal here comes from a capped scan of public data, so two wallets funded out-of-band, sponsored by nobody and never sharing a transaction produce no edge no matter who controls them.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
