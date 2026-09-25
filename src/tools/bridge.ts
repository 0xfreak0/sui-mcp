import { z } from "zod";
import { boolArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { caip2ForSuiNetwork } from "../utils/chain-id.js";
import { errorResult } from "../utils/errors.js";
import { readBridgeEvents, sameForeignAddress } from "../utils/bridge/exits.js";
import { detectBridges, type CallSite } from "../utils/bridge/detect.js";
import { layerZeroMessagesByTx, layerZeroScanAvailable, type LayerZeroScanMessage } from "../utils/bridge/layerzeroscan.js";
import { nttRedemptions, type PureInputNode } from "../utils/bridge/wormhole-inbound.js";
import { fetchEventJson } from "../utils/event-json.js";
import type { GqlCommandNode } from "../utils/gql-adapters.js";
import { COMMANDS_SELECTION, NESTED_PAGE_SIZE, readAllCommands, type GqlConnection } from "../utils/tx-connections.js";
import {
  EVIDENCE_TIER_MEANING,
  WORMHOLE_CHAIN_SUI,
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
 *
 * Events past the first page are read by `fetchEventJson`, commands by
 * `readAllCommands`. Commands are read because Meson emits no events at all;
 * pure inputs because an NTT redemption into Sui emits none either, and its
 * origin is only in the VAA bytes the transaction passes in.
 */
const TX_EVENTS_QUERY = `
  query($digest: String!) {
    transaction(digest: $digest) {
      digest
      effects {
        events(first: ${NESTED_PAGE_SIZE}) {
          pageInfo { hasNextPage }
          nodes { contents { type { repr } json } }
        }
      }
      kind {
        ... on ProgrammableTransaction {
          ${COMMANDS_SELECTION}
          inputs(first: ${NESTED_PAGE_SIZE}) { pageInfo { hasNextPage } nodes { __typename ... on MoveValue { type { repr } bcs } } }
        }
      }
    }
  }
`;

interface TxEventsResponse {
  transaction?: {
    digest?: string;
    effects?: { events?: { pageInfo?: { hasNextPage?: boolean }; nodes?: SuiEventNode[] } };
    kind?: {
      commands?: GqlConnection<GqlCommandNode> | null;
      inputs?: { pageInfo?: { hasNextPage?: boolean }; nodes?: PureInputNode[] } | null;
    } | null;
  } | null;
}

/** Protocols this tool reports in a section of their own; anything else detected goes to `other_bridge_activity`. */
const SECTIONED: Record<string, true> = {
  Wormhole: true,
  "Sui Bridge": true,
  "Circle CCTP": true,
  LayerZero: true,
  "Axelar ITS": true,
  "Allbridge Core": true,
  "Celer cBridge": true,
};

/**
 * Render the redemption half of an operation.
 *
 * `targetChain.to` is the contract the redemption transaction called: the
 * Token Bridge, an NTT manager, a relayer. It is reported as
 * `redeemed_via_contract` and never as the destination account, because the
 * funds went on from it to the beneficiary.
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
  const contractAccount =
    qualify && wormholeChain !== null && dest.to ? toForeignAccount(wormholeChain, dest.to) : null;

  return {
    status: dest.status ?? "unknown",
    chain: qualify && wormholeChain !== null ? caip2ForWormholeChain(wormholeChain) : null,
    chain_label: wormholeChain === null ? null : wormholeChainLabel(wormholeChain),
    wormhole_chain_id: wormholeChain,
    ...(dest.to
      ? {
          redeemed_via_contract: {
            address: dest.to,
            account: contractAccount,
            ...(contractAccount === null ? { address_note: unqualifiedNote(qualify) } : {}),
          },
        }
      : {}),
    ...(dest.from ? { redeemer: dest.from } : {}),
    transaction: dest.txHash,
    timestamp: dest.timestamp,
  };
}

/**
 * Wormholescan's own reading of the recipient, used only when the payload
 * could not be decoded on the Sui side.
 */
function indexerBeneficiary(op: WormholescanOperation | undefined, qualify: boolean) {
  const t = op?.transfer;
  if (!t?.toAddress || t.toChain === null) return null;
  const account = qualify ? toForeignAccount(t.toChain, t.toAddress) : null;
  return {
    evidence: "indexer-attested" as const,
    source: "wormholescan-standardized-properties",
    chain: qualify ? caip2ForWormholeChain(t.toChain) : null,
    chain_label: wormholeChainLabel(t.toChain),
    wormhole_chain_id: t.toChain,
    address: t.toAddress,
    account,
    ...(account === null ? { address_note: unqualifiedNote(qualify) } : {}),
  };
}

function unqualifiedNote(qualify: boolean): string {
  return qualify
    ? "Reported unqualified: this server has no address rule for that chain, so filing it under a chain id would be a guess."
    : "Reported unqualified: Wormhole reuses its chain numbers across environments, so a CAIP-2 id derived off mainnet would name the wrong chain.";
}

export function registerBridgeTools(server: McpServer) {
  server.tool(
    "resolve_bridge_transfer",
    "(Incident investigation) Follow funds across a bridge. Given a Sui transaction, return where each bridge transfer in it went, read from chain data wherever the protocol writes it on Sui: Wormhole (the VAA identity — emitter chain, emitter address, sequence — plus, where Wormholescan has indexed a redemption, the destination transaction), Sui's native bridge, Circle CCTP, LayerZero V2 (destination endpoint, GUID and destination OApp, plus LayerZero Scan's delivery transaction), Axelar ITS, Allbridge Core and Celer cBridge. `beneficiaries` names who the transfer pays on the far side, decoded from the Sui transaction itself for Wormhole Token Bridge (including the Token Bridge Relayer), Wormhole NTT, Mayan (MCTP and Swift), Circle CCTP, Sui's native bridge, LayerZero OFT, Axelar ITS, Allbridge Core and Celer cBridge; the contract a redemption or message was delivered to is reported separately (`redeemed_via_contract`, `destination_oapp`). Transfers ARRIVING on Sui (native-bridge claims, Wormhole Token Bridge and NTT redemptions) are reported as inbound with their origin identity. Meson is recognised but its destination is not in Sui data. This is what lets a trace continue past a bridge instead of stopping there: each identity is quoted on BOTH chains, so matching it is an identifier comparison rather than an amount-and-timing guess. Results are tiered by evidence: chain-derived values come from Sui; delivery is asserted by an indexer and should be confirmed on the destination chain before being relied on.",
    {
      digest: z.string().describe("Sui transaction digest (Base58) to inspect for a bridge transfer."),
      include_destination: boolArg()
        .optional()
        .describe(
          "Query Wormholescan and LayerZero Scan for the delivery side (default true). Set false to stay strictly on-chain.",
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

      const firstPage = data.transaction.effects?.events;
      let events: SuiEventNode[] = firstPage?.nodes ?? [];
      let eventsIncomplete = false;
      if (firstPage?.pageInfo?.hasNextPage) {
        const all = await fetchEventJson(digest);
        if (all) events = all.map((e) => ({ contents: { type: e.type ? { repr: e.type } : undefined, json: e.json } }));
        else eventsIncomplete = true;
      }
      const commands = await readAllCommands(digest, data.transaction.kind?.commands);
      const calls: CallSite[] = commands.nodes.flatMap((c) =>
        c.function
          ? [{ packageId: c.function.module.package.address, module: c.function.module.name, function: c.function.name }]
          : [],
      );
      const inputs = data.transaction.kind?.inputs;

      // Shared detector, so this tool and trace_funds agree on what counts as
      // a bridge exit rather than drifting apart.
      const eventTypes = events
        .map((e) => e?.contents?.type?.repr)
        .filter((t): t is string => typeof t === "string");
      const hits = detectBridges(calls, eventTypes);

      const {
        cctpTransfers,
        nativeTransfers,
        nativeInboundClaims,
        messages,
        decodedMessages,
        mayan,
        settlesForMayan,
        layerZero,
        axelar,
        allbridge,
        carriesAllbridge,
        celer,
        wormholeInbound: tokenBridgeInbound,
        beneficiaries,
      } = readBridgeEvents(events, qualify);
      const wormholeInbound = [...tokenBridgeInbound, ...nttRedemptions(inputs?.nodes ?? [], qualify)];
      // Mayan has no section: its order event only names the beneficiary.
      const mayanProtocols = [...new Set(mayan.map((b) => b.protocol))];
      const otherBridges = hits.filter((h) => !Object.hasOwn(SECTIONED, h.protocol) && !mayanProtocols.includes(h.protocol));

      const wantDestination = include_destination !== false;

      // LayerZero Scan, matched back by GUID. A dead indexer must not lose
      // the chain-derived half.
      const lzByGuid = new Map<string, LayerZeroScanMessage>();
      let lzError: string | null = null;
      if (layerZero.length && wantDestination && layerZeroScanAvailable(network)) {
        try {
          for (const m of await layerZeroMessagesByTx(digest)) lzByGuid.set(m.guid, m);
        } catch (err) {
          lzError = (err as Error).message;
        }
      }

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
                ...(settlesForMayan(t.destinationAddress)
                  ? {
                      role: "settlement_intermediate" as const,
                      note: "This burn mints to Mayan's settlement contract, which pays the order on the destination chain. The recipient is the Mayan beneficiary in `beneficiaries`, not this address.",
                    }
                  : carriesAllbridge(t.nonce)
                    ? {
                        carries: "Allbridge Core",
                        note: "This burn carries the Allbridge Core transfer with the same nonce. USDC is minted to this address (on Solana, the wallet's token account); the beneficiary is Allbridge's recipient wallet in `beneficiaries`.",
                      }
                    : {
                        note: "Destination read from the burn event, not from an indexer. Confirm the mint on the destination chain against this transfer id to establish it was completed.",
                      }),
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
        ...(layerZero.length
          ? {
              layerzero: layerZero.map((l) => {
                const scan = lzByGuid.get(l.guid);
                return {
                  evidence: "chain-derived" as const,
                  guid: l.guid,
                  nonce: l.nonce,
                  src_eid: l.src_eid,
                  dst_eid: l.dst_eid,
                  destination_chain: l.destination_chain,
                  destination_chain_label: l.destination_chain_label,
                  sender_oapp: l.sender_oapp,
                  destination_oapp: {
                    ...l.destination_oapp,
                    note: "The contract the message is delivered to, not the recipient of the funds.",
                  },
                  ...(l.oft ? { oft: l.oft } : {}),
                  ...(l.beneficiary
                    ? {}
                    : {
                        recipient_note:
                          "The sending app is not a LayerZero OFT this server can attribute, so its message format is its own and no recipient is read from it.",
                      }),
                  delivery: !wantDestination
                    ? { status: "not_requested" }
                    : !layerZeroScanAvailable(network)
                      ? { status: "no_index_for_network" }
                      : lzError
                        ? { status: "lookup_failed", error: lzError }
                        : scan
                          ? {
                              evidence: "indexer-attested" as const,
                              status: scan.status,
                              destination_status: scan.destination?.status ?? null,
                              transaction: scan.destination?.txHash ?? null,
                              timestamp: scan.destination?.timestamp ?? null,
                              ...(scan.appName ? { app: scan.appName } : {}),
                            }
                          : {
                              status: "not_indexed",
                              meaning:
                                "LayerZero Scan has no message for this transaction. The packet above is still chain-derived; the message may be too recent to have been indexed.",
                            },
                };
              }),
            }
          : {}),
        ...(axelar.length
          ? {
              axelar_its: axelar.map((a) => ({
                evidence: "chain-derived" as const,
                destination_chain: a.destination_chain,
                destination_chain_label: a.destination_chain_label,
                axelar_chain: a.axelar_chain,
                destination_account: a.beneficiary.account,
                destination_address: a.beneficiary.address,
                destination_address_raw: a.beneficiary.address_raw,
                token_id: a.token_id,
                coin_type: a.coin_type,
                amount: a.amount,
                source_channel: a.source_channel,
                note: "Destination read from the InterchainTransfer event. Axelar's own message id for this transfer is keyed by this Sui digest on axelarscan.io; confirm delivery there or on the destination chain.",
              })),
            }
          : {}),
        ...(allbridge.length
          ? {
              allbridge_core: allbridge.map((a) => ({
                evidence: "chain-derived" as const,
                route: a.route,
                nonce: a.nonce,
                destination_chain: a.destination_chain,
                destination_chain_label: a.destination_chain_label,
                allbridge_chain_id: a.allbridge_chain_id,
                recipient_wallet: a.beneficiary.account ?? a.beneficiary.address_raw,
                ...(a.route === "cctp" ? { mint_recipient: a.recipient ?? a.recipient_raw } : {}),
                amount: a.amount,
                sender: a.sender,
                ...(a.messenger ? { messenger: a.messenger } : {}),
              })),
            }
          : {}),
        ...(celer.length
          ? {
              celer_cbridge: celer.map((c) => ({
                evidence: "chain-derived" as const,
                transfer_id: c.transfer_id,
                destination_chain: c.destination_chain,
                destination_chain_label: c.destination_chain_label,
                celer_chain_id: c.celer_chain_id,
                destination_account: c.beneficiary.account,
                destination_address: c.beneficiary.address ?? c.beneficiary.address_raw,
                coin: c.coin,
                amount: c.amount,
                burner: c.burner,
                note: "Destination read from the burn event. cBridge's getTransferStatus API and the destination mint quote this transfer id.",
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
        ...(wormholeInbound.length
          ? {
              wormhole_inbound: {
                direction: "inbound" as const,
                meaning:
                  "This transaction REDEEMED a Wormhole transfer arriving on Sui. That is an entry, not an exit. To trace the money BACK, look up the VAA id on the origin chain (Wormholescan indexes it by that id).",
                redemptions: wormholeInbound,
              },
            }
          : {}),
        ...(inputs?.pageInfo?.hasNextPage
          ? { inputs_incomplete: "This transaction has more inputs than were read, so an NTT redemption's VAA may be missing." }
          : {}),
      };

      // Wormhole: one Wormholescan call covers every message in the
      // transaction; they are matched back by VAA id rather than by position,
      // since the indexer makes no ordering promise.
      const byVaa = new Map<string, WormholescanOperation>();
      let destinationError: string | null = null;

      if (messages.length && wantDestination && indexed) {
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

      // Wormholescan's recipient only for a message the Sui side could not
      // decode. When both exist and disagree, the chain-derived one is kept
      // and the indexer's value is reported beside it.
      const perMessage = messages.map((m, i) => {
        const op = byVaa.get(m.vaaId);
        const decoded = decodedMessages[i];
        const indexer = indexerBeneficiary(op, qualify);
        const chainDerived = decoded?.beneficiary ?? null;
        return { m, op, decoded, indexer, chainDerived };
      });
      const allBeneficiaries = [
        ...beneficiaries,
        ...perMessage.flatMap(({ m, chainDerived, indexer }) =>
          !chainDerived && indexer ? [{ ...indexer, protocol: "Wormhole", vaa_id: m.vaaId }] : [],
        ),
      ];

      const exits = [
        messages.length ? "Wormhole (wormhole_messages)" : null,
        nativeTransfers.length ? "Sui's native bridge (sui_native_bridge)" : null,
        cctpTransfers.length ? "Circle CCTP (circle_cctp)" : null,
        layerZero.length ? "LayerZero (layerzero)" : null,
        axelar.length ? "Axelar ITS (axelar_its)" : null,
        allbridge.length ? "Allbridge Core (allbridge_core)" : null,
        celer.length ? "Celer cBridge (celer_cbridge)" : null,
        ...mayanProtocols.map((p) => `${p} (beneficiaries)`),
      ].filter((s): s is string => s !== null);
      const inbound = nativeInboundClaims.length > 0 || wormholeInbound.length > 0;

      return ok({
        digest,
        network,
        source_chain: caip2ForSuiNetwork(network),
        ...(exits.length || inbound ? { evidence_tiers: EVIDENCE_TIER_MEANING } : {}),
        ...(eventsIncomplete ? { events_incomplete: EVENTS_INCOMPLETE } : {}),
        ...(commands.truncated ? { commands_incomplete: COMMANDS_INCOMPLETE } : {}),
        ...(allBeneficiaries.length ? { beneficiaries: allBeneficiaries } : {}),
        ...bridgeSections,
        wormhole_messages: perMessage.map(({ m, op, decoded, indexer, chainDerived }) => ({
          vaa_id: m.vaaId,
          evidence: "chain-derived" as const,
          emitter_chain: WORMHOLE_CHAIN_SUI,
          emitter_address: m.emitter,
          sequence: m.sequence,
          nonce: m.nonce,
          consistency_level: m.consistencyLevel,
          emitted_by: m.eventType,
          ...(decoded
            ? { payload: { evidence: "chain-derived" as const, kind: decoded.kind, to_chain: decoded.to_chain, to_raw: decoded.to_raw } }
            : {}),
          beneficiary: chainDerived
            ? {
                ...chainDerived,
                ...(indexer && !sameForeignAddress(indexer.address, chainDerived.address)
                  ? { indexer_reported_address: indexer.address }
                  : {}),
              }
            : indexer ?? null,
          destination: !wantDestination
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
        })),
        ...(otherBridges.length ? { other_bridge_activity: otherBridges } : {}),
        ...(exits.length
          ? {
              note: `This transaction exited through ${exits.join(", ")}.`,
              next_step: allBeneficiaries.length
                ? BENEFICIARY_NEXT_STEP
                : "No recipient could be read for this transfer. Its identity above is still chain-derived: look it up on the destination chain to find where it was delivered.",
            }
          : otherBridges.length
            ? {
                note: "Another cross-chain protocol was used — see other_bridge_activity. The funds did leave, but this tool cannot read that protocol's destination.",
                ...(allBeneficiaries.length ? { next_step: BENEFICIARY_NEXT_STEP } : {}),
              }
            : inbound
              ? {
                  note: "No outbound transfer here. This transaction received value ARRIVING on Sui — see the *_inbound sections for the origin chain and transfer identity.",
                }
              : {
                  note: "No bridge transfer in this transaction: none of the bridges this server recognises appears in its events or Move calls.",
                }),
      });
    },
  );
}

const BENEFICIARY_NEXT_STEP =
  "Record the beneficiary account with save_finding (`beneficiaries[].account` is already CAIP-10), and label it with manage_labels if you can attribute it. A `redeemed_via_contract`, a `destination_oapp`, or a CCTP leg marked `settlement_intermediate` is the bridge's own contract, not the recipient. Confirm the destination transaction on that chain before treating it as established.";

const EVENTS_INCOMPLETE =
  "This transaction has more events than could be read, so a bridge event may be missing from this result.";

const COMMANDS_INCOMPLETE =
  "This transaction has more Move calls than could be read, so a bridge detected only by its call (Meson) may be missing from this result.";

const ok = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});
