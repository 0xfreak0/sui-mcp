import { z } from "zod";
import { describeSignatures } from "../utils/multisig.js";
import { isDigest, invalidDigestMessage, normalizeDigest } from "../utils/digest.js";
import { boolArg, numArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { formatStatus, describeFailure, formatGas, bigintToString, timestampToIso } from "../utils/formatting.js";
import { errorResult } from "../utils/errors.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { gqlQuery } from "../clients/graphql.js";
import { collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { prefetchProtocolNames, lookupProtocol, lookupProtocolDisplay } from "../protocols/registry.js";

/**
 * Curated-only resolver for object types, matching what `trace.ts` passes at
 * its own `readGrpcObjectChanges` call site. The display tier includes MVR
 * names anyone can register, and this resolver gates a `defi-position`
 * promotion rather than only naming something.
 */
function protocolForObjectType(packageId: string): { name: string } | null {
  const p = lookupProtocol(packageId);
  return p ? { name: p.name } : null;
}
import { fetchEventJson, packageOfEventType } from "../utils/event-json.js";
import { fetchTransactions, MAX_DIGESTS } from "../utils/multi-tx.js";
import { custodyChanges, readGrpcObjectChanges, summarizeObjectChanges } from "../utils/object-flow.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerTransactionTools(server: McpServer) {
  server.tool(
    "get_transaction",
    "Get a Sui transaction by its digest. Returns sender, status, gas, balance changes, protocol-aware decoded actions (e.g. 'swap on Cetus', 'deposit on Suilend'), and events WITH their decoded fields — so there is no need to hand-write GraphQL to read an event's values. Protocols are identified from the events as well as the Move calls, which matters when a transaction calls an obfuscated wrapper: `protocols_from_events_only` marks that case.",
    {
      digest: z.string().describe("Transaction digest (Base58)"),
      max_event_field_bytes: numArg()
        .int()
        .min(0)
        .max(500_000)
        .optional()
        .describe(
          "Optional byte cap on decoded event fields. UNSET BY DEFAULT: every event comes back with its fields, because an investigation must not be silently working from a subset. Set this only when you knowingly want to bound the payload — anything skipped is reported — or set 0 to skip decoding entirely.",
        ),
    },
    async ({ digest: rawDigest, max_event_field_bytes }) => {
      const digest = normalizeDigest(rawDigest);
      // No default cap. A budget that silently omits decoded values would let
      // an investigation draw a conclusion from a subset of the events without
      // the reader having chosen that trade-off, which is the failure this
      // whole codebase is built to avoid. Measured, it would almost never fire
      // anyway: the 99th percentile of transactions with events carries 12 KB
      // of decoded fields. Bounding the payload is the caller's call to make.
      const fieldBudget = max_event_field_bytes ?? Number.POSITIVE_INFINITY;

      // Checked here so a typo comes back as "that is not a digest" rather than
      // a thrown transport error about Base58 — and so it is never mistaken for
      // the transaction not existing. get_transactions has always done this;
      // the single-digest path had not.
      if (!isDigest(digest)) return errorResult(invalidDigestMessage(digest));

      const req = {
        digest,
        readMask: {
          paths: [
            "digest", "transaction", "effects", "events",
            "checkpoint", "timestamp", "balance_changes",
            // Who authorised this transaction. For a multisig this is the only
            // place the per-transaction signer set exists: the committee is
            // fixed, but WHICH members signed varies transaction to
            // transaction, and that is the question a treasury drain asks.
            "signatures",
          ],
        },
      };
      // Pruned digests come back as a NOT_FOUND throw, which the helper's catch
      // path routes to the archive. The emptiness predicate is belt-and-braces.
      const res: GrpcTypes.GetTransactionResponse = await withArchiveFallback(
        (client) => client.ledgerService.getTransaction(req),
        (r) => !r.transaction,
      );

      const tx = res.transaction;
      const effects = tx?.effects;
      const transaction = tx?.transaction;
      const kind = transaction?.kind;
      const sender = transaction?.sender;

      // Protocol-aware decoding.
      //
      // `commandCount` is reported because an empty `actions` array had more
      // than one cause and no way to tell them apart: a transaction that ran no
      // commands, and commands that could not be decoded. Verified on mainnet:
      // an empty PTB carries `commands` as an EMPTY ARRAY, so the count is
      // real rather than inferred from its absence.
      //
      // `kindUnreadable` covers a third case that no mainnet probe has
      // produced — a transaction present in the response with no readable kind.
      // A nonexistent or pruned digest throws NOT_FOUND instead and never
      // reaches here. It is labelled rather than removed because the branch
      // already existed and was returning an empty `actions` silently.
      let decoded;
      let commandCount: number | null = null;
      let kindUnreadable = false;
      if (kind?.data.oneofKind === "programmableTransaction") {
        const ptb = kind.data.programmableTransaction;
        commandCount = ptb.commands?.length ?? 0;
        await prefetchProtocolNames(collectPackageIds(ptb.commands));
        decoded = decodeTransaction(ptb.commands, tx?.balanceChanges, sender);
      } else if (kind?.data.oneofKind) {
        decoded = {
          protocols: [] as string[],
          actions: [`System transaction: ${kind.data.oneofKind}`],
          token_flow: [] as { coin: string; amount: string; raw_type: string }[],
        };
      } else {
        kindUnreadable = true;
        decoded = {
          protocols: [] as string[],
          actions: [] as string[],
          token_flow: [] as { coin: string; amount: string; raw_type: string }[],
        };
      }

      // What the transaction touched, which is the only evidence that anything
      // happened when it moved no coin and ran no command. The response
      // already carries `changedObjects`, so this reads data already paid for.
      //
      // `lookupProtocol`, not the display resolver: `readGrpcObjectChanges`
      // uses it to promote a type to `defi-position`, which may only happen
      // behind a curated vouch. `trace.ts` passes the curated one at its own
      // call site and the two must not disagree.
      const changedObjects = effects?.changedObjects ?? [];
      const objectMovements = readGrpcObjectChanges(changedObjects, protocolForObjectType);
      const custody = custodyChanges(objectMovements);
      const objectSummary = summarizeObjectChanges(changedObjects);

      // Who authorised this transaction. The gRPC `UserSignature` carries the
      // signature's own BCS, so the shared parser handles it and one code path
      // covers both transports.
      const authorization = describeSignatures(
        (tx?.signatures ?? [])
          .map((s) => (s.bcs?.value ? Buffer.from(s.bcs.value).toString("base64") : ""))
          .filter(Boolean),
      ).map((sig, i) => ({
        // Sender first, then the gas sponsor when one paid. Stated positionally
        // AND resolved by derivation, so a reader can check it either way.
        role: sig.address && sig.address === sender ? "sender" : i === 0 ? "sender" : "gas_sponsor",
        scheme: sig.scheme,
        ...(sig.address ? { address: sig.address } : {}),
        ...(sig.multisig
          ? {
              multisig: {
                shape: sig.multisig.members.every((m) => m.weight === 1)
                  ? `${sig.multisig.threshold}-of-${sig.multisig.members.length}`
                  : `threshold ${sig.multisig.threshold} of ${sig.multisig.total_weight} weight`,
                threshold: sig.multisig.threshold,
                // The point of reading signatures per transaction: WHICH keys
                // authorised THIS one. The committee is fixed for the life of
                // the address, so this is the only thing that varies.
                signed_by: sig.multisig.members
                  .filter((m) => m.signed_source_tx)
                  .map((m) => ({ index: m.index, address: m.address, weight: m.weight })),
                did_not_sign: sig.multisig.members
                  .filter((m) => !m.signed_source_tx)
                  .map((m) => ({ index: m.index, address: m.address, weight: m.weight })),
              },
            }
          : {}),
        ...(sig.zklogin ? { zklogin: sig.zklogin } : {}),
      }));

      const rawEvents = tx?.events?.events ?? [];

      // Decoded event contents, which gRPC does not carry. One extra request,
      // and only when there is something to decode.
      const parsed =
        rawEvents.length > 0 && fieldBudget > 0 ? await fetchEventJson(digest) : null;
      // Joined by position, which is emission order on both transports. Guarded
      // on length: attaching fields from a mismatched list would put one event's
      // values under another's type, which is worse than omitting them.
      const parsedUsable = parsed !== null && parsed.length === rawEvents.length;

      // Decoded fields are attached in order until a byte budget is spent.
      //
      // The constraint is the caller's context, not any single event: measured
      // on mainnet, the 99th percentile of transactions with events sits at
      // 12 KB of decoded fields, but a 59-event DeepBook transaction reaches
      // 53 KB — roughly 13k tokens for one lookup, and a ten-hop trace would
      // spend its whole budget on event bodies. Types and senders are cheap and
      // always useful, so they are never dropped; only the decoded values are
      // rationed, and what was skipped is reported rather than silently missing.
      let spent = 0;
      let fieldsOmitted = 0;
      const events = rawEvents.map((e: GrpcTypes.Event, i: number) => {
        const base = {
          package_id: e.packageId,
          module: e.module,
          event_type: e.eventType,
          sender: e.sender,
        };
        if (!parsedUsable) return base;
        const json = parsed![i].json;
        const size = JSON.stringify(json ?? null).length;
        if (spent + size > fieldBudget) {
          fieldsOmitted++;
          return base;
        }
        spent += size;
        return { ...base, parsed: json };
      });

      // Protocols the EVENTS implicate, which the call targets can miss
      // entirely. Both the defining package of each event type and the emitting
      // package are resolved: the definer is the informative one when a wrapper
      // is in play, the emitter is worth naming when it happens to be known.
      const eventPackages = [
        ...new Set(
          rawEvents
            .flatMap((e: GrpcTypes.Event) => [packageOfEventType(e.eventType), e.packageId ?? null])
            .filter((p): p is string => Boolean(p)),
        ),
      ];
      if (eventPackages.length > 0) await prefetchProtocolNames(eventPackages);
      const fromEvents = [
        ...new Set(
          eventPackages
            .map((p) => lookupProtocolDisplay(p)?.name)
            .filter((n): n is string => Boolean(n)),
        ),
      ];
      // Named by their events but not by their calls. Reported separately
      // rather than folded in, because the gap is itself the finding: a
      // transaction whose calls are unreadable and whose events name a known
      // protocol is what a wrapper or router looks like.
      const onlyFromEvents = fromEvents.filter((n) => !decoded.protocols.includes(n));
      const allProtocols = [...new Set([...decoded.protocols, ...fromEvents])];
      const balanceChanges = tx?.balanceChanges?.map((bc: GrpcTypes.BalanceChange) => ({
        address: bc.address,
        coin_type: bc.coinType,
        amount: bc.amount,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                digest: tx?.digest,
                sender,
                status: formatStatus(effects?.status),
                // Why it failed, from data already in `effects`. Absent on
                // success, so a reader never has to check a field that says
                // nothing.
                ...(describeFailure(effects?.status)
                  ? { failure: describeFailure(effects?.status) }
                  : {}),
                timestamp: timestampToIso(tx?.timestamp),
                protocols: allProtocols,
                ...(onlyFromEvents.length
                  ? {
                      protocols_from_events_only: onlyFromEvents,
                      protocol_attribution_note:
                        "These protocols were identified from the transaction's EVENTS, not its Move calls — the calls alone did not name them. That gap is usually a wrapper or router package sitting in front of the real protocol, which is worth a look: a package chooses its own name, but the events it emits carry the type of whoever defined them.",
                    }
                  : {}),
                actions: decoded.actions,
                ...(commandCount !== null ? { command_count: commandCount } : {}),
                // Said outright, because an empty `actions` used to cover this
                // case, a decode failure and an unreadable kind alike.
                ...(commandCount === 0
                  ? {
                      empty_transaction_note:
                        "This transaction ran no commands, which is not a decode failure: it executed and committed, and its only on-chain effect is whatever object_changes and object_transfers report below. Read those before concluding nothing happened. An empty transaction is used to advance the version of whatever object paid for it, and to publish a sender's public key for the first time.",
                    }
                  : {}),
                ...(kindUnreadable
                  ? {
                      kind_unreadable_note:
                        "The transaction kind could not be read, so no actions could be derived. That is a failed read, NOT a transaction that did nothing — do not report it as inactivity.",
                    }
                  : {}),
                token_flow: decoded.token_flow,
                // Reported always, because "no coin moved" is only an absence
                // of value when nothing else moved either. A balance change is
                // derived from Coin<T>, so an NFT, a capability or a DeFi
                // position changes hands without producing one.
                object_changes: objectSummary,
                ...(custody.length
                  ? {
                      object_transfers: custody.map((m) => ({
                        object_id: m.object_id,
                        type: m.type_short ?? m.type,
                        kind: m.kind,
                        // The owner KIND travels with the address. A
                        // kiosk-held NFT is owned by the Kiosk object, so
                        // reporting a bare address made a kiosk id read as a
                        // wallet — verified on a TradePort sale where BOTH
                        // parties were kiosks. `trace.ts` renders the same
                        // movement as "kiosk/object 0x…" and the two tools must
                        // not disagree about who a party is.
                        from: m.from ? { kind: m.from.kind, address: m.from.address } : null,
                        to: m.to ? { kind: m.to.kind, address: m.to.address } : null,
                        ...(m.high_consequence ? { high_consequence: true } : {}),
                        ...(m.renounced ? { renounced: true } : {}),
                        ...(m.source_unrecorded ? { source_unrecorded: true } : {}),
                        ...(m.protocol ? { protocol: m.protocol } : {}),
                      })),
                    }
                  : {}),
                ...(authorization.length ? { authorization } : {}),
                ...(authorization.some((a) => a.multisig)
                  ? {
                      authorization_note:
                        "This transaction was authorised by a multisig. `signed_by` is the set of keys that signed THIS transaction — the committee itself is fixed for the life of the address, so a member under `did_not_sign` is still authorised and may have signed others. Use analyze_multisig for which keys are live across the wallet's history.",
                    }
                  : {}),
                gas: formatGas(effects?.gasUsed),
                epoch: bigintToString(effects?.epoch),
                checkpoint: bigintToString(tx?.checkpoint),
                event_count: events.length,
                ...(fieldsOmitted
                  ? {
                      event_fields_omitted: fieldsOmitted,
                      event_fields_budget_note:
                        `Decoded fields for ${fieldsOmitted} event(s) were omitted because you set max_event_field_bytes=${fieldBudget} and it was spent. Their types and senders are still listed. Remove the cap to see them — this response is NOT the complete event data.`,
                    }
                  : {}),
                ...(rawEvents.length > 0 && fieldBudget > 0 && !parsedUsable
                  ? {
                      event_fields_note:
                        "Decoded event fields could not be attached — the parsed-contents lookup failed or returned a different number of events, and guessing the alignment would file one event's values under another's type. Event types and senders below are unaffected.",
                    }
                  : {}),
                events,
                balance_changes: balanceChanges,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_transactions",
    "Read up to 50 Sui transactions in ONE call, given their digests. Returns sender, status, timing, balance changes, Move call targets and events WITH their decoded fields for each, plus the protocols involved. Use this whenever you hold several digests at once — the outputs of a fan-out, the evidence on a cluster edge, a set of hops to compare — instead of calling get_transaction repeatedly; ten digests go from ten round trips to one. Digests that could not be read come back in `not_found` rather than being dropped. For ONE transaction, or for a transaction with more than 50 events, prefer get_transaction: it pages events to the end.",
    {
      digests: z
        .array(z.string())
        .min(1)
        .max(MAX_DIGESTS)
        .describe(`Transaction digests, Base58 (1-${MAX_DIGESTS}). Duplicates are collapsed.`),
    },
    async ({ digests }) => {
      try {
        const { found, not_found, invalid, packages } = await fetchTransactions(digests);

        // One prefetch for the whole batch, then synchronous lookups. Protocols
        // come from the Move call targets AND the event types, since a
        // transaction calling an obfuscated wrapper is named only by its events.
        if (packages.length > 0) await prefetchProtocolNames(packages);
        const protocolsFor = (tx: (typeof found)[number]) => {
          const names = new Set<string>();
          for (const call of tx.move_calls) {
            const n = lookupProtocolDisplay(call.split("::")[0])?.name;
            if (n) names.add(n);
          }
          for (const ev of tx.events) {
            const pkg = packageOfEventType(ev.type);
            const n = pkg ? lookupProtocolDisplay(pkg)?.name : undefined;
            if (n) names.add(n);
          }
          return [...names];
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  requested: digests.length,
                  returned: found.length,
                  ...(invalid.length
                    ? {
                        invalid_digests: invalid,
                        invalid_note:
                          "These are not Base58 and were never sent. They are reported rather than silently dropped, and rejecting them here is deliberate: the server refuses an entire batch over one malformed key, so a single typo would otherwise return nothing at all.",
                      }
                    : {}),
                  ...(not_found.length
                    ? {
                        not_found,
                        not_found_note:
                          "These digests returned nothing from GraphQL. Do NOT read that as 'the transaction does not exist' — this batch path has no archive fallback, so a pruned transaction looks identical to a wrong digest. get_transaction DOES fall back to the archive and will often return these; retry each one there before concluding anything. Old digests are pruned continuously, so a digest that resolved minutes ago can land here.",
                      }
                    : {}),
                  transactions: found.map((t) => ({ ...t, protocols: protocolsFor(t) })),
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

  server.tool(
    "query_transactions",
    "Query raw Sui transactions with specific filters (sender, affected address/object, function, checkpoint range). Note: only ONE of affected_address, affected_object, or function can be used per query (Sui GraphQL limitation). For human-readable wallet activity, prefer get_transaction_history instead.\n\nATTRIBUTION WARNING: the `function` filter matches any transaction containing that call, including PTBs where it is one leg among several protocols. A transaction's balance changes cover the WHOLE PTB, so summing them per protocol over-attributes — a big Cetus swap in the same PTB will be counted as your protocol's volume. Set include_functions to see every Move call in each transaction, and prefer the protocol's own events (query_events) when measuring per-protocol flow.",
    {
      sender: z.string().optional().describe("Filter by sender address"),
      affected_address: z
        .string()
        .optional()
        .describe("Filter by affected address (sender, sponsor, or recipient). Mutually exclusive with affected_object and function."),
      affected_object: z
        .string()
        .optional()
        .describe("Filter by affected object ID. Mutually exclusive with affected_address and function."),
      function: z
        .string()
        .optional()
        .describe("Filter by Move function (e.g. 0x2::coin::transfer or 0x2::pay). Mutually exclusive with affected_address and affected_object."),
      after_checkpoint: z
        .string()
        .optional()
        .describe("Only transactions after this checkpoint"),
      before_checkpoint: z
        .string()
        .optional()
        .describe("Only transactions before this checkpoint"),
      limit: numArg().optional().describe("Max results (default 20)"),
      after: z.string().optional().describe("Pagination cursor"),
      include_functions: boolArg()
        .optional()
        .describe(
          "Return every Move call in each transaction, so you can see whether the filtered package was the whole transaction or one leg of a multi-protocol PTB.",
        ),
    },
    async ({
      sender,
      affected_address,
      affected_object,
      function: fn,
      after_checkpoint,
      before_checkpoint,
      limit,
      after,
      include_functions,
    }) => {
      // Sui GraphQL only allows one of these per query
      const exclusiveFilters = [
        affected_address && "affected_address",
        affected_object && "affected_object",
        fn && "function",
      ].filter(Boolean);

      if (exclusiveFilters.length > 1) {
        return errorResult(
          `Only one of [affected_address, affected_object, function] can be specified per query. Got: ${exclusiveFilters.join(", ")}. Use separate queries for each filter.`
        );
      }

      const filterParts: Record<string, unknown> = {};
      if (sender) filterParts.sentAddress = sender;
      if (affected_address) filterParts.affectedAddress = affected_address;
      if (affected_object) filterParts.affectedObject = affected_object;
      if (fn) filterParts.function = fn;
      if (after_checkpoint)
        filterParts.afterCheckpoint = parseInt(after_checkpoint);
      if (before_checkpoint)
        filterParts.beforeCheckpoint = parseInt(before_checkpoint);

      // Commands are only selected on request: they multiply response size on
      // a page of 50, and most callers only want the digest list.
      const includeFns = include_functions
        ? `kind { ... on ProgrammableTransaction {
             commands(first: 25) { nodes { ... on MoveCallCommand {
               function { name module { name package { address } } }
             } } }
           } }`
        : "";

      const query = `
        query($filter: TransactionFilter, $first: Int, $after: String) {
          transactions(filter: $filter, first: $first, after: $after) {
            nodes {
              digest
              sender { address }
              gasInput { gasSponsor { address } }
              ${includeFns}
              effects {
                status
                gasEffects {
                  gasSummary {
                    computationCost
                    storageCost
                    storageRebate
                  }
                }
                checkpoint { sequenceNumber }
                timestamp
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;
      const variables = {
        filter: Object.keys(filterParts).length > 0 ? filterParts : undefined,
        first: limit ?? 20,
        after: after ?? undefined,
      };
      const data = await gqlQuery<{
        transactions: {
          nodes: Array<{
            digest: string;
            sender?: { address: string };
            gasInput?: { gasSponsor?: { address: string } | null };
            kind?: {
              commands?: {
                nodes: Array<{
                  function?: { name: string; module: { name: string; package: { address: string } } };
                }>;
              };
            };
            effects?: {
              status: string;
              gasEffects?: {
                gasSummary?: {
                  computationCost: string;
                  storageCost: string;
                  storageRebate: string;
                };
              };
              checkpoint?: { sequenceNumber: number };
              timestamp?: string;
            };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor?: string };
        };
      }>(query, variables);

      const transactions = data.transactions.nodes.map((n) => {
        const sponsor = n.gasInput?.gasSponsor?.address ?? null;
        const calls = (n.kind?.commands?.nodes ?? [])
          .filter((c) => c.function)
          .map((c) => `${c.function!.module.package.address}::${c.function!.module.name}::${c.function!.name}`);

        return {
          digest: n.digest,
          sender: n.sender?.address,
          status: n.effects?.status,
          checkpoint: n.effects?.checkpoint?.sequenceNumber,
          timestamp: n.effects?.timestamp,
          gas_sponsor: sponsor,
          // Sponsorship is one of the stronger coordination signals on Sui: a
          // swarm of wallets whose gas is paid by one address is not organic.
          // The sponsor equals the sender for ordinary self-paid transactions.
          gas_sponsored: sponsor !== null && sponsor !== n.sender?.address,
          ...(include_functions
            ? {
                move_calls: calls,
                // How much of this PTB belongs to the filtered package, so
                // over-attribution is visible instead of assumed.
                ...(fn
                  ? {
                      matched_calls: calls.filter((c) => c.startsWith(fn.split("::")[0])).length,
                      total_calls: calls.length,
                    }
                  : {}),
              }
            : {}),
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                transactions,
                has_next_page: data.transactions.pageInfo.hasNextPage,
                next_cursor: data.transactions.pageInfo.endCursor,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

}
