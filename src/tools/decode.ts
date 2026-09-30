import { z } from "zod";
import { bcs } from "@mysten/sui/bcs";
import { fromBase64 } from "@mysten/sui/utils";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { errorResult } from "../utils/errors.js";
import { guardiansFlagsForPackage } from "../utils/guardians.js";
import { flagPtbAnomalies, isSystemPackage, NO_MATCH_NOTE, PTB_CHECKS, SEVERITY_RANK, supersededWrites, type FormattedCommand } from "../utils/ptb-anomalies.js";
import { readSupersededChanges } from "../utils/superseded-diff.js";
import { lookupPackageTrust, prefetchProtocolCustody } from "../protocols/registry.js";
import { originIncomplete } from "../protocols/package-custody.js";
import { effectsPayouts, gasPaidOf } from "../utils/payouts.js";
import { readGrpcObjectChanges } from "../utils/object-flow.js";
import { gasSource } from "../utils/address-balance.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import { isDigest, invalidDigestMessage, normalizeDigest } from "../utils/digest.js";
import { formatStatus } from "../utils/formatting.js";
import {
  EXECUTED_OBJECT_PATHS,
  commandsOmittedView,
  executedObjects,
  ptbDataFromBcs,
  resolvePtb,
  selectCommands,
  type ExecutedObjects,
} from "../utils/ptb-resolve.js";
import { saveResult } from "../utils/store.js";
import { presignSends, readPresignContext } from "../utils/presign-context.js";
import { getNetwork } from "../config.js";
import { numArg } from "./args.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerDecodeTools(server: McpServer) {
  server.tool(
    "decode_ptb",
    "Decode a PTB without executing: pre-sign base64 BCS bytes BEFORE approving a wallet prompt, or an executed digest. Returns resolved commands/inputs, protocol annotations and heuristic checks for publish/upgrade, blocklisted/unvouched/unlisted or superseded packages, non-sender payouts, flash loans and multi-package composition. Unvouched means neither curated registry nor curated publishing key; MVR names confer no trust. That check is medium only with one-way value flow or another lead (digest: another address gained what sender lost, or sender got nothing back). Digest mode includes effects-based coin/object losses and input object versions/types. Bytes mode compares outgoing splits/whole coins/gas coin with sender balances now and reads recipients' first chain transaction (null if never affected). Pure values use declared types, with signed readings for high-bit u64/u128/u256; unreadable types stay bytes. A 32-byte address guess without value_type is evidence, not proof. Also decodes Result origins/return types, FundsWithdrawal amount/coin/Sender-or-Sponsor and coin vs address-balance gas. Checks are leads: checks_run with no matches clears nothing. Before signing, use simulate_transaction for effects. For these inputs/commands WITH executed effects/events, use get_transaction detail:'full'.",
    {
      transaction_bcs: z
        .string()
        .optional()
        .describe("Base64-encoded BCS transaction bytes. Pass this or `digest`, not both."),
      digest: z
        .string()
        .optional()
        .describe("Digest (Base58) of an executed transaction, to decode its PTB. Pass this or `transaction_bcs`, not both."),
      command_offset: numArg()
        .int()
        .min(0)
        .optional()
        .describe(
          "Start at this index, in order, ~30k chars/page. Default prioritizes anomaly commands (severity, then fewest indices), then non-framework Move calls. commands_omitted gives missing ranges and next_call.",
        ),
      commands: z
        .array(numArg().int().min(0))
        .max(100)
        .optional()
        .describe("Exact command indices instead of a page; each returned command carries its index."),
    },
    async ({ transaction_bcs, digest: rawDigest, command_offset, commands: pick }) => {
      if ((transaction_bcs === undefined) === (rawDigest === undefined)) {
        return errorResult("Pass exactly one of transaction_bcs (bytes to sign) or digest (an executed transaction).");
      }

      let bytes: Uint8Array;
      let executed: ExecutedObjects | undefined;
      let executedTx: GrpcTypes.ExecutedTransaction | undefined;
      if (rawDigest !== undefined) {
        const digest = normalizeDigest(rawDigest);
        if (!isDigest(digest)) return errorResult(invalidDigestMessage(digest));
        const res: GrpcTypes.GetTransactionResponse = await withArchiveFallback(
          (client) =>
            client.ledgerService.getTransaction({
              digest,
              readMask: { paths: ["digest", "transaction.bcs", "effects", "checkpoint", "balance_changes", ...EXECUTED_OBJECT_PATHS] },
            }),
          (r) => !r.transaction?.transaction?.bcs?.value,
        );
        executedTx = res.transaction;
        const value = executedTx?.transaction?.bcs?.value;
        if (!value) return errorResult(`Transaction ${digest} came back without its transaction bytes, so its PTB cannot be decoded. get_transaction reads the same digest.`);
        bytes = new Uint8Array(value);
        executed = executedObjects(executedTx);
      } else {
        bytes = fromBase64(transaction_bcs!.trim());
      }
      const { data, unread } = ptbDataFromBcs(bytes);
      if (!data) {
        return errorResult(
          unread
            ? `This transaction's PTB cannot be decoded. ${unread} get_transaction describes its effects.`
            : "This is a system transaction, not a programmable one, so it has no PTB commands or inputs to decode. get_transaction describes it.",
        );
      }
      if (transaction_bcs !== undefined) {
        // BCS parsing stops where the struct ends and ignores what follows, so
        // 10,000 base64 'A's decoded as a transaction from 0x0 with no commands.
        const used = bcs.TransactionData.serialize(bcs.TransactionData.parse(bytes)).toBytes().length;
        if (used !== bytes.length) {
          return errorResult(
            `Not one transaction: the first ${used} bytes decode as transaction data and ${bytes.length - used} bytes follow it.`,
          );
        }
      }

      const calledPackages = data.commands.flatMap((c) => (c.$kind === "MoveCall" ? [c.MoveCall.package] : []));
      const blocklistedPackages = new Set(
        [...new Set(calledPackages)].filter((p) => guardiansFlagsForPackage(p).length > 0),
      );

      const { inputs, commands, signatures_unavailable } = await resolvePtb(data, executed);
      // Who published each called version, and its lineage's newer versions:
      // the trust basis and the superseded-version check read them.
      const trustIncomplete = originIncomplete(await prefetchProtocolCustody(new Set(calledPackages.filter((p) => !isSystemPackage(p)))));
      // An executed transaction is judged at its own checkpoint; bytes not yet
      // signed, against the versions published now.
      const checkpoint = executedTx?.checkpoint !== undefined ? Number(executedTx.checkpoint) : null;
      const effects = executedTx
        ? effectsPayouts(
            data.sender ?? null,
            (executedTx.balanceChanges ?? []).map((b) => ({ address: b.address ?? "", coinType: b.coinType ?? "", amount: b.amount ?? "0" })),
            readGrpcObjectChanges(executedTx.effects?.changedObjects ?? []),
            gasPaidOf(executedTx.effects?.gasUsed, data.gasData.owner),
          )
        : undefined;
      const trust = (pkg: string) => lookupPackageTrust(pkg, checkpoint);
      const anomalies = flagPtbAnomalies(commands as FormattedCommand[], {
        sender: data.sender ?? undefined,
        blocklistedPackages,
        inputs,
        trust,
        supersededChanges: await readSupersededChanges(supersededWrites(commands as FormattedCommand[], inputs, trust)),
        effects,
      });
      // Null when the bytes carry no gas data yet, which says nothing about
      // where gas will come from.
      const gas = data.gasData.payment ? gasSource(data.gasData.payment) : null;
      // Before signing, what leaves for another address is set against the
      // sender's balances now, and each recipient's first appearance is read.
      const sends = !executedTx && data.sender ? presignSends(commands as FormattedCommand[], data.sender) : [];
      const presign = sends.length ? await readPresignContext(data.sender!, sends, gas?.coins ?? []) : null;
      const payout = presign ? anomalies.find((a) => a.code === "transfers-to-non-sender") : undefined;
      if (presign && payout) {
        const lines = [
          ...presign.coins
            .filter((c) => c.share_of_balance !== null)
            .map((c) =>
              c.share_of_balance! > 1
                ? `sends ${c.sent} raw ${c.coin_type}, more than the sender's balance now (${c.sender_balance} raw)`
                : `sends ${(c.share_of_balance! * 100).toFixed(2)}% of the sender's ${c.coin_type} balance now (${c.sent} of ${c.sender_balance} raw)`,
            ),
          ...presign.recipients
            .filter((r) => r.first_seen !== undefined)
            .map((r) => (r.first_digest === null ? `${r.address} has no transaction on chain yet` : `${r.address} first seen ${r.first_seen ?? "at an unknown time"} (${r.first_digest})`)),
        ];
        payout.evidence = [...lines.slice(0, 6), ...payout.evidence];
      }

      const body: Record<string, unknown> = {
        ...(executedTx ? { digest: executedTx.digest, status: formatStatus(executedTx.effects?.status) } : {}),
        sender: data.sender,
        gas_budget: data.gasData.budget,
        gas_price: data.gasData.price,
        // An empty payment list means gas comes out of the gas owner's
        // address balance rather than a coin object.
        ...(gas ? { gas_source: gas.source, ...(gas.coins.length ? { gas_coins: gas.coins } : {}) } : {}),
        expiration: data.expiration,
        command_count: commands.length,
        input_count: inputs.length,
        anomaly_count: anomalies.length,
        anomalies,
        checks_run: PTB_CHECKS,
        checks_note:
          NO_MATCH_NOTE +
          (executedTx
            ? ""
            : " Only the commands were read. Before signing, simulate_transaction shows the effects: where every coin and object would end up, whichever function moves it."),
        ...(presign ? { presign_context: presign } : {}),
        ...(trustIncomplete ? { trust_incomplete: trustIncomplete } : {}),
        ...(signatures_unavailable.length
          ? {
              signatures_unavailable,
              signatures_unavailable_note:
                "The signatures of these Move functions could not be read, so their pure arguments are shown as bytes and their results carry no declared type.",
            }
          : {}),
        commands,
        inputs,
      };
      // Anomalies are flagged over every command above; only the listing is
      // paged. A first page lists the flagged commands first: most severe
      // flag first, and among equals the flag naming the fewest commands.
      const first = [...anomalies]
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.commands?.length ?? 0) - (b.commands?.length ?? 0))
        .flatMap((a) => a.commands ?? []);
      const { page, omitted, missing } = selectCommands(commands, { offset: command_offset, indices: pick, first });
      const resultId = omitted ? saveResult(getNetwork(), "decode_ptb", { transaction_bcs, digest: rawDigest, command_offset }, body, { commands: page.map((c) => c.index as number) }) : null;
      const out = {
        ...(omitted ? { truncated: true } : {}),
        ...body,
        commands: page,
        ...(missing.length ? { commands_not_found: missing } : {}),
        ...(omitted ? { commands_omitted: commandsOmittedView(omitted, rawDigest === undefined ? null : normalizeDigest(rawDigest), resultId) } : {}),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );
}
