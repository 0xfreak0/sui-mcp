import { z } from "zod";
import { boolArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { caip2ForSuiNetwork } from "../utils/chain-id.js";
import { errorResult } from "../utils/errors.js";
import { detectBridges } from "../utils/bridge/detect.js";
import {
  CCTP_DEPOSIT_EVENT_SUFFIX,
  CCTP_MESSAGE_EVENT_SUFFIX,
  parseDepositForBurn,
  parseMessageHeader,
} from "../utils/bridge/cctp.js";
import {
  CLAIM_EVENT_SUFFIX,
  DEPOSIT_EVENT_SUFFIXES,
  parseClaimEvent,
  parseDepositEvent,
  suiBridgeChainLabel,
} from "../utils/bridge/sui-native.js";
import {
  EVIDENCE_TIER_MEANING,
  WORMHOLE_CHAIN_SUI,
  extractWormholeMessages,
  toForeignAccount,
  wormholeChainLabel,
  caip2ForWormholeChain,
  type SuiEventNode,
} from "../utils/bridge/wormhole.js";
import {
  operationByVaa,
  operationsByTxHash,
  wormholescanAvailable,
  type WormholescanOperation,
} from "../utils/bridge/wormholescan.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Events carry their decoded fields only over GraphQL — the gRPC `Event` has
 * no parsed JSON — so this one point lookup goes against GraphQL despite the
 * usual "point lookup by key uses gRPC" rule.
 */
const TX_EVENTS_QUERY = `
  query($digest: String!) {
    transaction(digest: $digest) {
      digest
      effects {
        events { nodes { contents { type { repr } json } } }
      }
    }
  }
`;

interface TxEventsResponse {
  transaction?: {
    digest?: string;
    effects?: { events?: { nodes?: SuiEventNode[] } };
  } | null;
}

/**
 * Render the destination half of an operation.
 *
 * `qualify` is false off mainnet. Wormhole reuses its chain numbers across
 * environments, so on testnet chain 2 means Sepolia, not Ethereum mainnet —
 * emitting `eip155:1` there would file a testnet address under a mainnet chain
 * and read as verified. The Wormhole number and label are still reported; only
 * the CAIP-2 claim is withheld.
 */
function renderDestination(op: WormholescanOperation, qualify: boolean) {
  const dest = op.destination;
  if (!dest) {
    return {
      status: "not_redeemed",
      meaning:
        "Wormholescan has no redemption for this VAA. Either the transfer is still in flight, or it was never completed on the destination chain.",
    };
  }

  const wormholeChain = dest.wormholeChain ?? op.transfer?.toChain ?? null;
  const rawAddress = dest.to ?? op.transfer?.toAddress ?? null;
  const account =
    qualify && wormholeChain !== null && rawAddress
      ? toForeignAccount(wormholeChain, rawAddress)
      : null;

  return {
    status: dest.status ?? "unknown",
    chain: qualify && wormholeChain !== null ? caip2ForWormholeChain(wormholeChain) : null,
    chain_label: wormholeChain === null ? null : wormholeChainLabel(wormholeChain),
    wormhole_chain_id: wormholeChain,
    // The CAIP-10 form drops straight into save_finding and manage_labels, so
    // the far side of the hop can be labeled and recorded without hand-editing.
    account,
    address: rawAddress,
    ...(account === null && rawAddress
      ? {
          address_note: qualify
            ? "Reported unqualified: this server has no address rule for that chain, so filing it under a chain id would be a guess."
            : "Reported unqualified: Wormhole reuses its chain numbers across environments, so a CAIP-2 id derived off mainnet would name the wrong chain.",
        }
      : {}),
    transaction: dest.txHash,
    timestamp: dest.timestamp,
  };
}

export function registerBridgeTools(server: McpServer) {
  server.tool(
    "resolve_bridge_transfer",
    "(Incident investigation) Follow funds across a bridge. Given a Sui transaction that emitted a Wormhole message, return the VAA identity read from chain data — (emitter chain, emitter address, sequence) — and, where Wormholescan has indexed a redemption, the destination chain, address and transaction. This is what lets a trace continue past a bridge instead of stopping there: the VAA identity is a shared identifier quoted on BOTH chains, so matching it is an identifier comparison rather than an amount-and-timing guess. Results are tiered by evidence: the VAA identity is chain-derived, the destination is asserted by Wormholescan's index and should be confirmed on the destination chain before being relied on.",
    {
      digest: z.string().describe("Sui transaction digest (Base58) to inspect for a bridge exit."),
      include_destination: boolArg()
        .optional()
        .describe(
          "Query Wormholescan for the redemption side (default true). Set false to stay strictly on-chain and return only the VAA identity.",
        ),
    },
    async ({ digest, include_destination }) => {
      let data: TxEventsResponse;
      try {
        data = await gqlQuery<TxEventsResponse>(TX_EVENTS_QUERY, { digest });
      } catch (err) {
        return errorResult(`Could not read transaction ${digest}: ${(err as Error).message}`);
      }

      if (!data.transaction) {
        return errorResult(
          `Transaction ${digest} not found on ${getNetwork()}. Check the digest and the network.`,
        );
      }

      const network = getNetwork();
      const indexed = wormholescanAvailable(network);
      // Every bridge's chain numbering — Wormhole's, Circle's domains, the
      // native bridge's — is reused across environments, so a CAIP-2 claim
      // derived from one is only meaningful on mainnet.
      const qualify = network === "mainnet";

      const events = data.transaction.effects?.events?.nodes ?? [];
      const messages = extractWormholeMessages(events);
      // Shared detector, so this tool and trace_funds agree on what counts as
      // a bridge exit rather than drifting apart.
      const eventTypes = events
        .map((e) => e?.contents?.type?.repr)
        .filter((t): t is string => typeof t === "string");
      const otherBridges = detectBridges([], eventTypes).filter(
        (h) =>
          h.protocol !== "Wormhole" && h.protocol !== "Sui Bridge" && h.protocol !== "Circle CCTP",
      );

      // CCTP: the burn event carries destination domain and recipient, so this
      // half is chain-derived. The paired MessageSent supplies the source
      // domain, which completes the transfer id.
      const cctpHeader = (() => {
        for (const e of events) {
          const t = e?.contents?.type?.repr;
          if (typeof t !== "string" || !t.endsWith(CCTP_MESSAGE_EVENT_SUFFIX)) continue;
          const msg = (e.contents?.json as { message?: unknown } | undefined)?.message;
          if (typeof msg === "string") {
            const header = parseMessageHeader(msg);
            if (header) return header;
          }
        }
        return null;
      })();

      const cctpTransfers = events
        .filter((e) => {
          const t = e?.contents?.type?.repr;
          return typeof t === "string" && t.endsWith(CCTP_DEPOSIT_EVENT_SUFFIX);
        })
        .map((e) => parseDepositForBurn(e.contents?.json, cctpHeader, qualify))
        .filter((t): t is NonNullable<typeof t> => t !== null);

      // Sui's native bridge carries its destination in the event, so this half
      // is chain-derived — no indexer is consulted for it at all.
      const nativeTransfers = events
        .filter((e) => {
          const t = e?.contents?.type?.repr;
          return typeof t === "string" && DEPOSIT_EVENT_SUFFIXES.some((sfx) => t.endsWith(sfx));
        })
        .map((e) => parseDepositEvent(e.contents?.json))
        .filter((t): t is NonNullable<typeof t> => t !== null);

      // Inbound claims are value ARRIVING on Sui. Reporting one as an exit
      // would send an investigator to the wrong chain entirely — but an entry
      // is still worth resolving, since the claim quotes the origin chain's own
      // transfer identity and a trace running backwards dead-ends without it.
      const nativeInboundClaims = events
        .filter((e) => {
          const t = e?.contents?.type?.repr;
          return typeof t === "string" && t.endsWith(CLAIM_EVENT_SUFFIX);
        })
        .map((e) => parseClaimEvent(e.contents?.json, qualify))
        .filter((cl): cl is NonNullable<typeof cl> => cl !== null);

      const bridgeSections = {
        ...(cctpTransfers.length
          ? {
              circle_cctp: cctpTransfers.map((t) => ({
                evidence: "chain-derived" as const,
                transfer_id: t.transferId,
                nonce: t.nonce,
                source_domain: t.sourceDomain,
                destination_chain: t.destinationAccount
                  ? t.destinationAccount.split(":").slice(0, 2).join(":")
                  : null,
                destination_chain_label: t.destinationChainLabel,
                destination_domain: t.destinationDomain,
                destination_account: t.destinationAccount,
                destination_address: t.destinationAddress,
                mint_recipient_raw: t.mintRecipientRaw,
                depositor: t.depositor,
                amount: t.amount,
                burn_token: t.burnToken,
                note: "Destination read from the burn event, not from an indexer. Confirm the mint on the destination chain against this transfer id to establish it was completed.",
              })),
            }
          : {}),
        ...(nativeTransfers.length
          ? {
              sui_native_bridge: nativeTransfers.map((t) => ({
                evidence: "chain-derived" as const,
                transfer_id: t.transferId,
                sequence: t.seqNum,
                destination_chain: t.targetAccount ? t.targetAccount.split(":").slice(0, 2).join(":") : null,
                destination_chain_label: t.targetChainLabel,
                destination_account: t.targetAccount,
                destination_address: t.targetAddress,
                sender: t.senderAddress,
                amount: t.amount,
                note: "Destination read from the deposit event, not from an indexer. Confirm the claim on the destination chain against this transfer id to establish it was completed.",
              })),
            }
          : {}),
        ...(nativeInboundClaims.length
          ? {
              sui_native_bridge_inbound: {
                direction: "inbound" as const,
                meaning:
                  "This transaction CLAIMED value arriving on Sui from the native bridge. That is an entry, not an exit — following it forward off-chain goes the wrong way. To trace the money BACK, look up the transfer id on the origin chain.",
                claims: nativeInboundClaims.map((cl) => ({
                  evidence: "chain-derived" as const,
                  transfer_id: cl.transferId,
                  sequence: cl.seqNum,
                  origin_chain: cl.sourceChainId,
                  origin_chain_label: cl.sourceChainLabel,
                  bridge_chain_id: cl.sourceChain,
                })),
              },
            }
          : {}),
      };

      if (messages.length === 0) {
        return ok({
          digest,
          network: getNetwork(),
          source_chain: caip2ForSuiNetwork(getNetwork()),
          wormhole_messages: [],
          ...bridgeSections,
          ...(nativeTransfers.length || cctpTransfers.length
            ? {
                ...(otherBridges.length ? { other_bridge_activity: otherBridges } : {}),
                note:
                  "No Wormhole message, but this transaction exited through " +
                  [
                    nativeTransfers.length ? "Sui's native bridge (sui_native_bridge)" : null,
                    cctpTransfers.length ? "Circle CCTP (circle_cctp)" : null,
                  ]
                    .filter(Boolean)
                    .join(" and ") +
                  ". Those destinations are read from chain data, so they are stronger evidence than an indexer-attested one.",
              }
            : otherBridges.length
              ? {
                  other_bridge_activity: otherBridges,
                  note: "No Wormhole message in this transaction, but another cross-chain protocol was used — see other_bridge_activity. The funds did leave; this tool just cannot follow that protocol yet.",
                }
              : nativeInboundClaims.length
                ? {
                    note: "No outbound transfer here. This transaction claimed value ARRIVING on Sui via the native bridge — see sui_native_bridge_inbound for the origin chain and transfer id.",
                  }
                : {
                    note: "No Wormhole message in this transaction. It did not exit through Wormhole.",
                  }),
        });
      }

      // One Wormholescan call covers every message in the transaction; they are
      // matched back by VAA id rather than by position, since the indexer makes
      // no ordering promise.
      const wantDestination = include_destination !== false && indexed;

      const byVaa = new Map<string, WormholescanOperation>();
      let destinationError: string | null = null;

      if (wantDestination) {
        try {
          for (const op of await operationsByTxHash(digest)) byVaa.set(op.id, op);

          // Fall back to the VAA triple for anything the transaction lookup
          // missed. The triple is read from chain data and is what the
          // guardians sign, so it is the more reliable key of the two — the
          // indexer may simply not associate the source hash the way we spell
          // it. Only messages still unresolved are looked up, so the common
          // case costs no extra request.
          for (const m of messages) {
            if (byVaa.has(m.vaaId)) continue;
            const op = await operationByVaa(WORMHOLE_CHAIN_SUI, m.emitter, m.sequence);
            if (op) byVaa.set(m.vaaId, op);
          }
        } catch (err) {
          // A dead indexer must not lose the chain-derived half, which is the
          // part that is actually evidence.
          destinationError = (err as Error).message;
        }
      }

      return ok({
        digest,
        network: getNetwork(),
        source_chain: caip2ForSuiNetwork(getNetwork()),
        evidence_tiers: EVIDENCE_TIER_MEANING,
        ...bridgeSections,
        wormhole_messages: messages.map((m) => {
          const op = byVaa.get(m.vaaId);
          return {
            vaa_id: m.vaaId,
            evidence: "chain-derived" as const,
            emitter_chain: WORMHOLE_CHAIN_SUI,
            emitter_address: m.emitter,
            sequence: m.sequence,
            nonce: m.nonce,
            consistency_level: m.consistencyLevel,
            emitted_by: m.eventType,
            destination:
              include_destination === false
                ? { status: "not_requested" }
                : !indexed
                  ? {
                      status: "no_index_for_network",
                      meaning: `Wormholescan does not index ${network}, so the redemption side cannot be resolved there. The VAA identity above is still chain-derived and valid.`,
                    }
                  : destinationError
                    ? { status: "lookup_failed", error: destinationError }
                    : op
                      ? { evidence: "indexer-attested" as const, ...renderDestination(op, qualify) }
                      : {
                          status: "not_indexed",
                          meaning:
                            "Wormholescan has no operation for this transaction or its VAA id. The VAA identity above is still chain-derived and valid — the transfer may be too recent to have been indexed, or still in flight.",
                        },
            ...(op?.transfer
              ? {
                  transfer: {
                    evidence: "indexer-attested" as const,
                    amount: op.transfer.amount,
                    token_address: op.transfer.tokenAddress,
                    token_chain: op.transfer.tokenChain,
                  },
                }
              : {}),
            ...(op?.appIds.length ? { protocols: op.appIds } : {}),
          };
        }),
        ...(otherBridges.length ? { other_bridge_activity: otherBridges } : {}),
        next_step:
          "Record the destination account with save_finding (it is already CAIP-10), and label it with manage_labels if you can attribute it. Confirm the destination transaction on that chain before treating it as established.",
      });
    },
  );
}

const ok = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});
