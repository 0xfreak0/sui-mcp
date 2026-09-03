import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { caip2ForSuiNetwork } from "../utils/chain-id.js";
import { errorResult } from "../utils/errors.js";
import {
  EVIDENCE_TIER_MEANING,
  WORMHOLE_CHAIN_SUI,
  extractWormholeMessages,
  toForeignAccount,
  wormholeChainLabel,
  caip2ForWormholeChain,
  type SuiEventNode,
} from "../utils/bridge/wormhole.js";
import { operationsByTxHash, type WormholescanOperation } from "../utils/bridge/wormholescan.js";
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
 * Other cross-chain protocols we can *detect* but not yet resolve.
 *
 * Reporting "no Wormhole message" on a transaction that plainly bridged
 * through Circle CCTP would read as "the funds did not leave", which is the
 * wrong conclusion to hand an investigator. Naming the protocol turns a dead
 * end into a next step.
 */
const OTHER_BRIDGE_MARKERS: Array<{ suffix: string; protocol: string; note: string }> = [
  {
    suffix: "::deposit_for_burn::DepositForBurn",
    protocol: "Circle CCTP",
    note: "CCTP transfers are identified by a Circle nonce and message hash rather than a Wormhole VAA. Not resolved by this tool yet.",
  },
  {
    suffix: "::send_message::MessageSent",
    protocol: "Circle CCTP (message)",
    note: "The CCTP message half of a burn. Its attestation is served by Circle, not Wormholescan.",
  },
];

function detectOtherBridges(events: SuiEventNode[]): Array<{ protocol: string; note: string }> {
  const found = new Map<string, string>();
  for (const e of events) {
    const repr = e?.contents?.type?.repr;
    if (typeof repr !== "string") continue;
    for (const marker of OTHER_BRIDGE_MARKERS) {
      if (repr.endsWith(marker.suffix)) found.set(marker.protocol, marker.note);
    }
  }
  return [...found].map(([protocol, note]) => ({ protocol, note }));
}

/** Render the destination half of an operation, chain-qualified where possible. */
function renderDestination(op: WormholescanOperation) {
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
  const account = wormholeChain !== null && rawAddress ? toForeignAccount(wormholeChain, rawAddress) : null;

  return {
    status: dest.status ?? "unknown",
    chain: wormholeChain === null ? null : (caip2ForWormholeChain(wormholeChain) ?? null),
    chain_label: wormholeChain === null ? null : wormholeChainLabel(wormholeChain),
    wormhole_chain_id: wormholeChain,
    // The CAIP-10 form drops straight into save_finding and manage_labels, so
    // the far side of the hop can be labeled and recorded without hand-editing.
    account,
    address: rawAddress,
    ...(account === null && rawAddress
      ? {
          address_note:
            "Reported unqualified: this server has no address rule for that chain, so filing it under a chain id would be a guess.",
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
      include_destination: z
        .boolean()
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

      const events = data.transaction.effects?.events?.nodes ?? [];
      const messages = extractWormholeMessages(events);
      const otherBridges = detectOtherBridges(events);

      if (messages.length === 0) {
        return ok({
          digest,
          network: getNetwork(),
          source_chain: caip2ForSuiNetwork(getNetwork()),
          wormhole_messages: [],
          ...(otherBridges.length
            ? {
                other_bridge_activity: otherBridges,
                note: "No Wormhole message in this transaction, but another cross-chain protocol was used — see other_bridge_activity. The funds did leave; this tool just cannot follow that protocol yet.",
              }
            : {
                note: "No Wormhole message in this transaction. It did not exit through Wormhole.",
              }),
        });
      }

      // One Wormholescan call covers every message in the transaction; they are
      // matched back by VAA id rather than by position, since the indexer makes
      // no ordering promise.
      let operations: WormholescanOperation[] = [];
      let destinationError: string | null = null;
      if (include_destination !== false) {
        try {
          operations = await operationsByTxHash(digest);
        } catch (err) {
          // A dead indexer must not lose the chain-derived half, which is the
          // part that is actually evidence.
          destinationError = (err as Error).message;
        }
      }

      const byVaa = new Map(operations.map((o) => [o.id, o]));

      return ok({
        digest,
        network: getNetwork(),
        source_chain: caip2ForSuiNetwork(getNetwork()),
        evidence_tiers: EVIDENCE_TIER_MEANING,
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
                : destinationError
                  ? { status: "lookup_failed", error: destinationError }
                  : op
                    ? { evidence: "indexer-attested" as const, ...renderDestination(op) }
                    : {
                        status: "not_indexed",
                        meaning:
                          "Wormholescan returned no operation for this transaction. The VAA identity above is still chain-derived and valid; look it up directly if the transfer is recent.",
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
