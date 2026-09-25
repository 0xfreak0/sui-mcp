import { boolArg, numArg, addressListArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { getLabel } from "../utils/labels.js";
import { describeAddresses, identityNote } from "../utils/identity.js";
import { buildWalletEdges } from "../utils/edge-probe.js";
import {
  addCoSignerEdges,
  clusterEdges,
  EdgeSet,
  type CommitteeMembership,
} from "../utils/wallet-edges.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Shared-control clustering, built live rather than from an analytics warehouse.
 *
 * The output deliberately separates two things a reader will otherwise conflate:
 *
 *   - `edges` are **facts**. "These two addresses were first funded by the same
 *     address, in transactions X and Y" is chain-derived and checkable.
 *   - `clusters` are an **inference** drawn from those facts. Nothing here
 *     proves common ownership.
 *
 * Keeping them apart is the same discipline the bridge resolvers apply to
 * `chain-derived` versus `indexer-attested`: the weaker claim must not borrow
 * the stronger one's confidence on its way into a report.
 *
 * Clusters used to be uniformly `heuristic`, and mostly still are. `co_signer`
 * is the exception and it is a different KIND of claim, not a stronger guess:
 * every other signal says two addresses behaved the way co-controlled wallets
 * tend to, measured against a base rate, while co-signature says a key is in
 * the committee that hashes to the wallet's address. So the tier moved onto
 * each cluster. A component that needed one behavioural edge to hold together
 * is heuristic however strong the rest of it looks — the same weakest-link
 * rule `min_edge_weight` already follows.
 *
 * What co-signature still does NOT establish is ownership. Holding a spending
 * key is control; a custodian holds one for a client. And a multi-party
 * committee is as much evidence its members are separate parties as that they
 * share an operator, which is why a member who cannot spend alone is weighted
 * below the merge floor rather than treated as a weaker co-signer.
 */
export function registerClusterTools(server: McpServer) {
  server.tool(
    "build_wallet_edges",
    "(Incident investigation) Find addresses that appear to share an operator with the ones you give it, and say why. Builds shared-control signals live — no analytics warehouse needed — from six sources: multisig co-signature (a key that can spend a wallet, read from the committee that hashes to its address — the one signal here that is not behavioural), a shared first funder, one address first-funding another, value moving in BOTH directions between two non-service addresses, a shared gas sponsor, and co-appearance in a single transaction. Every intermediary is measured before it is trusted, so an exchange or a sponsorship relayer is discarded rather than used to link thousands of strangers together. Returns `edges` (facts, each with the transaction digests to check it, except co_signer which cites the address hash itself) separately from `clusters` (an inference — each carries its own evidence_tier, and none is proof of ownership). Use it when a fund trace hands off to a fresh address and you want to know whether it is really a new party or the same one moving money between their own wallets.",
    {
      addresses: addressListArg()
        .min(1)
        .max(25)
        .describe("Seed addresses to examine (1-25). Give it every address you already suspect belongs together — links between seeds are the exactly-verified ones."),
      expand: boolArg()
        .optional()
        .describe(
          "Also look for unknown siblings, not just links among the seeds (default true). Each candidate is verified by computing its own first funder before it is admitted.",
        ),
      expand_budget: numArg()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe("Sibling candidates to verify while expanding (default 25). Unverified candidates are reported, never silently dropped."),
      popularity_limit: numArg()
        .int()
        .min(5)
        .max(500)
        .optional()
        .describe(
          "Distinct counterparties past which a funder or sponsor is treated as a service and discarded (default 50). Raise it only if you have a reason — this is the control that stops an exchange from linking the whole chain together.",
        ),
      min_signal_types: numArg()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe(
          "Independent signal types a pair needs before it may merge (default 1). Set 2 for the strict batch-pipeline rule: far higher precision, but it misses ordinary personal alt-wallets, which typically share exactly one mechanism.",
        ),
      max_cluster_size: numArg()
        .int()
        .min(2)
        .max(1000)
        .optional()
        .describe("Refuse merges beyond this size (default 100). A runaway cluster is worse than no answer."),
      reciprocal_budget: numArg()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("Reciprocal counterparties to measure for popularity (default 15). Value moving both ways is a strong signal, but the counterparty must be checked before it is trusted."),
      query_budget: numArg()
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
      reciprocal_budget,
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
          reciprocalBudget: reciprocal_budget,
          queryBudget: query_budget,
        });

        // Identities are resolved BEFORE clustering, because a multisig's
        // committee is itself an edge source. Every other signal comes from
        // the probe's bounded scan; this one comes from the address hash, so
        // it costs no extra queries beyond the authentication read that
        // `expandMembers` already performs.
        const identities = await describeAddresses(built.examined, {
          expandMembers: true,
        });

        const committees: CommitteeMembership[] = [];
        for (const [address, id] of identities) {
          const ms = id.authentication?.multisig;
          if (!ms) continue;
          committees.push({
            multisig: address,
            threshold: ms.threshold,
            members: ms.members
              .filter((m): m is typeof m & { address: string } => Boolean(m.address))
              .map((m) => ({ address: m.address, weight: m.weight })),
          });
        }

        // Members are new addresses the probe never examined, so they need
        // describing too — one extra batch, and only when a multisig was
        // actually found.
        const edgeSet = new EdgeSet();
        for (const e of built.edges) {
          for (const sig of e.signals) {
            edgeSet.add(sig.type, e.wallet_a, e.wallet_b, sig.detail, sig.digests, sig.via, sig.weight);
          }
        }
        const coSigner = addCoSignerEdges(edgeSet, committees);
        const allEdges = edgeSet.edges();

        if (committees.length > 0) {
          const memberAddresses = committees.flatMap((c) => c.members.map((m) => m.address));
          for (const [addr, id] of await describeAddresses(memberAddresses)) {
            if (!identities.has(addr)) identities.set(addr, id);
          }
        }

        const clustered = clusterEdges(allEdges, {
          minSignalTypes: min_signal_types,
          maxClusterSize: max_cluster_size,
        });
        const describe = (a: string) => {
          const id = identities.get(a);
          const note = id ? identityNote(id) : undefined;
          return {
            address: a,
            ...(id?.name ? { name: id.name } : {}),
            ...(id?.label ? { label: id.label, category: id.label_category } : {}),
            // A package or shared object in a cluster is not a co-owned wallet;
            // it is infrastructure several parties touch.
            ...(id && id.kind !== "wallet" ? { kind: id.kind } : {}),
            ...(id?.protocol ? { protocol: id.protocol } : {}),
            ...(id?.names_held?.length ? { names_held: id.names_held } : {}),
            ...(note ? { note } : {}),
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
                  edge_count: allEdges.length,
                  edges: allEdges.map((e) => ({
                    ...e,
                    wallet_a_info: describe(e.wallet_a),
                    wallet_b_info: describe(e.wallet_b),
                  })),

                  // --- inference ---
                  // Per-cluster now, not blanket. A cluster built purely on
                  // unilateral co-signature is read from the address hash, so
                  // calling it heuristic alongside a shared-funder guess would
                  // understate it as badly as the reverse would overstate one.
                  evidence_tier: clustered.clusters.every((c) => c.evidence_tier === "chain-derived")
                    ? "chain-derived"
                    : clustered.clusters.some((c) => c.evidence_tier === "chain-derived")
                      ? "mixed — see each cluster's evidence_tier"
                      : "heuristic",
                  clusters: clustered.clusters.map((c) => ({
                    ...c,
                    members: c.members.map(describe),
                    ...(c.evidence_tier === "chain-derived"
                      ? {
                          basis:
                            "Every merge in this cluster is a key that can spend the wallet it is linked to, on its own, read from the committee that hashes to the address. This is not a behavioural coincidence and no popularity judgement was made. It still shows CONTROL rather than ownership — a custodian holds a key for a client.",
                        }
                      : {}),
                    ...(c.evidence_tier !== "chain-derived" && c.independent_intermediaries < 2
                      ? {
                          single_point_of_failure:
                            "Every edge in this cluster rests on ONE intermediary. That is one fact stated many times, not corroboration — the edge count is not evidence of strength. If that address turns out to be a payout service or exchange, the whole cluster falls at once. Check it in used_intermediaries before relying on this.",
                        }
                      : {}),
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

                  ...(built.used_intermediaries.length
                    ? {
                        used_intermediaries: built.used_intermediaries,
                        used_intermediary_note:
                          "The shared funders and sponsors the edges above rest on. `scan_complete: false` means the scan hit its page cap before reaching the end of that address's history, so calling it narrow is provisional — a widely-distributing address that has since gone quiet can read as narrow from recent activity alone.",
                      }
                    : {}),
                  ...(coSigner.excluded.length
                    ? {
                        excluded_co_signers: coSigner.excluded,
                        excluded_co_signer_note:
                          "These keys sit on more committees than the co-signer limit, so they are wallet-provider or custody keys rather than operators. Each one CAN spend every wallet it signs for — that part is chain-derived and may matter on its own — but it says nothing about whether those wallets share an owner, so no edges were drawn through them. The count is over the committees examined here, so it is a lower bound.",
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
                    "Edges are facts; clusters are an inference — never record a heuristic-tier one as a finding without confirming it yourself. The exception is `co_signer`, which is read from the committee that hashes to the multisig's address rather than from behaviour, so a cluster marked `chain-derived` rests on arithmetic; it still shows control, not ownership. Critically, ABSENCE OF AN EDGE IS NOT EVIDENCE OF SEPARATE CONTROL: every behavioural signal here comes from a capped scan of public data, so two wallets funded out-of-band, sponsored by nobody and never sharing a transaction produce no edge no matter who controls them. And a multi-party committee is as much evidence its members are SEPARATE parties as that they share an operator — that is what a treasury multisig is for.",
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
