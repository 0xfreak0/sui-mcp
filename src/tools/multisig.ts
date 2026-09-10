/**
 * Multisig-specific tools: what a committee actually does, and which committee
 * a set of known keys might share.
 *
 * `identify_address` already says a wallet IS a multisig and names its members
 * — that is read from the address hash and costs one query. These two answer
 * questions that need history or search, and are kept separate so the cheap
 * classification stays cheap.
 */

import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { numArg } from "./args.js";
import { describeAddresses, identityNote } from "../utils/identity.js";
import {
  describeSignatures,
  enumerateCommittees,
  publicKeyFromSignatures,
  readAuthentication,
  MAX_COMMITTEE_CANDIDATES,
} from "../utils/multisig.js";
import { summarizeSigners, signerHistoryNote, type SignerObservation } from "../utils/signer-history.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** GraphQL page cap. */
const PAGE = 50;

/** Aliased queries per request — the service's store-backed limit. */
const ALIAS_BATCH = 20;

const SENT_PAGE = `query ($a: SuiAddress!, $first: Int!, $after: String) {
  transactions(filter: { sentAddress: $a }, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { digest effects { timestamp } signatures { signatureBytes } }
  }
}`;

interface SentPageResult {
  transactions: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: {
      digest: string;
      effects?: { timestamp?: string | null } | null;
      signatures: { signatureBytes: string }[];
    }[];
  };
}

export function registerMultisigTools(server: McpServer) {
  server.tool(
    "analyze_multisig",
    "(Multisig investigation) For a multisig wallet, work out which committee keys are actually live and which have never signed, across its transaction history. The committee itself is fixed for the life of the address, so the only thing that varies is WHO signs each transaction — this reads that across many transactions rather than one. Answers 'is this treasury really controlled by 7 people or by 2', 'has the active signer set shifted', and 'which key has never been used'. Use identify_address first to learn a wallet is a multisig; use this to learn how it operates.",
    {
      address: z.string().describe("The multisig wallet's address (0x...)"),
      max_transactions: numArg()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Transactions to examine (default 200). More is strictly better here — a key looks dormant until the one transaction it signed comes into view.",
        ),
    },
    async ({ address, max_transactions }) => {
      const limit = max_transactions ?? 200;
      const observations: SignerObservation[] = [];
      let committee = null;
      let after: string | null = null;
      let nonMultisig = 0;

      try {
        while (observations.length < limit) {
          const r: SentPageResult = await gqlQuery<SentPageResult>(SENT_PAGE, {
            a: address,
            first: Math.min(PAGE, limit - observations.length),
            after,
          });
          const conn = r.transactions;
          if (!conn?.nodes?.length) break;

          for (const tx of conn.nodes) {
            const sigs = tx.signatures.map((s) => s.signatureBytes);
            const auth = readAuthentication(address, sigs);
            if (!auth?.multisig) {
              // A sender's signature that is not this address's multisig means
              // the address is not a multisig at all; counted so the caller is
              // told rather than shown an empty history.
              nonMultisig++;
              continue;
            }
            // Every transaction restates the same committee — it is part of the
            // address — so the first one is as good as any, and disagreement
            // would mean the derivation is wrong rather than that it rotated.
            committee ??= auth.multisig;
            observations.push({
              digest: tx.digest,
              signers: auth.multisig.members
                .filter((m) => m.signed_source_tx)
                .map((m) => m.index),
              ...(tx.effects?.timestamp ? { timestamp: tx.effects.timestamp } : {}),
            });
          }
          if (!conn.pageInfo.hasNextPage) break;
          after = conn.pageInfo.endCursor;
        }
      } catch (err) {
        return errorResult(
          `Could not read ${address}'s transaction history: ${err instanceof Error ? err.message : String(err)}. ` +
            "This is not evidence about its signers — retry rather than treating the history as empty.",
        );
      }

      if (!committee) {
        return errorResult(
          nonMultisig > 0
            ? `${address} has sent ${nonMultisig} transaction(s) but none is signed by a multisig, so it is not a multisig wallet. Use identify_address to see how it does authenticate.`
            : `${address} has never sent a transaction, so there are no signatures to read. A multisig that has only ever RECEIVED is indistinguishable from any other unused address — this is not evidence it is not one.`,
        );
      }

      const history = summarizeSigners(committee, observations);
      const memberAddresses = committee.members
        .map((m) => m.address)
        .filter((a): a is string => Boolean(a));
      const identities = await describeAddresses(memberAddresses).catch(() => new Map());

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                committee: {
                  threshold: committee.threshold,
                  member_count: committee.members.length,
                  total_weight: committee.total_weight,
                  shape: committee.members.every((m) => m.weight === 1)
                    ? `${committee.threshold}-of-${committee.members.length}`
                    : `threshold ${committee.threshold} of ${committee.total_weight} weight`,
                },
                transactions_examined: history.transactions_examined,
                // The count is what a dormancy claim rests on. Said next to the
                // claim, not only in the metadata.
                history_complete: history.transactions_examined < limit,
                members: history.members.map((m) => {
                  const id = m.address ? identities.get(m.address) : undefined;
                  return {
                    ...m,
                    ...(id?.name ? { name: id.name } : {}),
                    ...(id?.label ? { label: id.label, category: id.label_category } : {}),
                    ...(id?.names_held?.length ? { names_held: id.names_held } : {}),
                  };
                }),
                signer_sets: history.signer_sets,
                dormant_members: history.dormant_members,
                always_present: history.always_present,
                active_signers_meet_threshold: history.active_signers_meet_threshold,
                ...(signerHistoryNote(history, committee.threshold)
                  ? { note: signerHistoryNote(history, committee.threshold) }
                  : {}),
                caveat:
                  "The committee cannot change — it is part of the address hash — so a shifting signer set is a change in who ACTS, never in who is authorised. A key that signed none of the transactions examined is dormant over that window only: it still holds its weight and can sign at any time. Nothing here shows ownership; a key is control, and a custodian may hold one for someone else.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "find_shared_multisig",
    "(Multisig investigation) Given several addresses you already suspect are related, find any multisig wallet they jointly control — even one that never appeared in your trace. Works by deriving every committee those keys could form and checking which of those addresses exist on chain, so a hit is proof (the address IS the hash of its committee), not a guess. Use it when a trace links wallets and you want to know whether they also share a treasury. Each address must have SENT a transaction, since that is where its public key becomes visible.",
    {
      addresses: z
        .array(z.string())
        .min(2)
        .max(5)
        .describe(
          "2-5 addresses to test for a shared multisig. Member order is part of a multisig's address, so the search is factorial in committee size — 4 addresses is 192 candidates, 5 is 1,560, and 6 is refused.",
        ),
    },
    async ({ addresses }) => {
      const unique = [...new Set(addresses)];
      const keys: { address: string; publicKey: ReturnType<typeof publicKeyFromSignatures> }[] = [];
      const unusable: { address: string; reason: string }[] = [];

      for (const a of unique) {
        try {
          const r = await gqlQuery<SentPageResult>(SENT_PAGE, { a, first: 1, after: null });
          const node = r.transactions?.nodes?.[0];
          if (!node) {
            unusable.push({
              address: a,
              reason:
                "has never sent a transaction, so it has published no public key. Being funded is not enough — a key becomes visible only when it signs.",
            });
            continue;
          }
          const sigs = node.signatures.map((s) => s.signatureBytes);
          const pk = publicKeyFromSignatures(a, sigs);
          if (!pk) {
            const scheme = describeSignatures(sigs).find((s) => s.address === a)?.scheme;
            unusable.push({
              address: a,
              reason:
                scheme === "multisig"
                  ? "is itself a multisig. A committee cannot contain another committee, so it cannot be a member of one."
                  : scheme === "zklogin"
                    ? "authenticates with zkLogin, which has no plain public key to enumerate over."
                    : `signs with ${scheme ?? "an unreadable scheme"}, which exposes no usable public key.`,
            });
            continue;
          }
          keys.push({ address: a, publicKey: pk });
        } catch (err) {
          unusable.push({
            address: a,
            reason: `lookup failed (${err instanceof Error ? err.message : String(err)}) — this is not evidence about the address.`,
          });
        }
      }

      if (keys.length < 2) {
        return errorResult(
          `Only ${keys.length} of ${unique.length} address(es) exposed a usable public key, and at least 2 are needed. ` +
            unusable.map((u) => `${u.address} ${u.reason}`).join(" "),
        );
      }

      let candidates;
      try {
        candidates = enumerateCommittees(
          keys as { address: string; publicKey: NonNullable<typeof keys[0]["publicKey"]> }[],
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      // Existence is asked as "has anything ever touched this address",
      // deliberately wider than "has it sent". A treasury that only ever
      // received is exactly the multisig this search is most useful for, and it
      // has no sent transaction to find.
      const found: typeof candidates = [];
      for (let i = 0; i < candidates.length; i += ALIAS_BATCH) {
        const chunk = candidates.slice(i, i + ALIAS_BATCH);
        const query =
          "query {\n" +
          chunk
            .map(
              (c, j) =>
                `  c${j}: transactions(filter: { affectedAddress: ${JSON.stringify(c.address)} }, first: 1) { nodes { digest } }`,
            )
            .join("\n") +
          "\n}";
        try {
          const r = await gqlQuery<Record<string, { nodes: { digest: string }[] }>>(query);
          chunk.forEach((c, j) => {
            if (r[`c${j}`]?.nodes?.length) found.push(c);
          });
        } catch {
          // A failed chunk is unsearched, not empty. Reported below via the
          // count so a negative answer is never claimed over a gap.
          return errorResult(
            `The existence check failed partway through ${candidates.length} candidates. A partial search cannot support "no shared multisig found" — retry.`,
          );
        }
      }

      const identities = await describeAddresses(
        found.map((f) => f.address),
        { expandMembers: true },
      ).catch(() => new Map());

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                addresses_tested: keys.map((k) => k.address),
                ...(unusable.length ? { addresses_skipped: unusable } : {}),
                candidates_checked: candidates.length,
                found_count: found.length,
                found: found.map((f) => {
                  const id = identities.get(f.address);
                  const note = id ? identityNote(id) : undefined;
                  return {
                    address: f.address,
                    shape: `${f.threshold}-of-${f.members.length}`,
                    threshold: f.threshold,
                    members_in_order: f.members,
                    evidence_tier: "chain-derived",
                    basis:
                      "This address IS the hash of this committee. Its existence on chain is not a match against a pattern — the derivation reproduces the address exactly.",
                    ...(id?.name ? { name: id.name } : {}),
                    ...(id?.label ? { label: id.label, category: id.label_category } : {}),
                    ...(note ? { note } : {}),
                  };
                }),
                caveat:
                  "WEIGHT-1 COMMITTEES ONLY. Weights are unbounded, so admitting them makes the search space infinite; a committee giving one member weight 2 is invisible here. A nil result therefore means 'no equal-weight multisig of these exact keys', NOT 'these addresses share no multisig'. It also only tests the keys given — a committee including one more member than you passed will not be found.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
