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
    "(Developer) Decode a Programmable Transaction Block (PTB) from base64 BCS bytes, or an executed transaction's PTB from its digest. With bytes it is the pre-sign check: read this BEFORE approving a wallet prompt, not after. With bytes, what the commands send to another address (a SplitCoins amount, a whole coin, the gas coin) is set against the sender's balances now, and each recipient's first transaction on chain is read (`presign_context`: share_of_balance per coin, first_seen per recipient, null when no transaction has ever affected it). Returns the list of commands with each argument resolved, the inputs, protocol annotations, and a heuristic anomaly-triage pass (publishes/upgrades; calls into wallet-blocklisted packages; calls into packages that neither the curated registry nor a curated protocol's publishing key vouches for, medium only when value moves through them one way (with `digest`: another address gained what the sender lost, or the sender got nothing back) or another lead fires, since a Move Registry name is display only; calls into lineages the registry does not list, and into a superseded version of a lineage; sending owned objects or split coins to an address other than the sender, whether through TransferObjects or a framework payout call (0x2::transfer::public_transfer, 0x2::pay::split_and_transfer, 0x2::pay::join_vec_and_transfer, 0x2::sui::transfer, 0x2::coin::send_funds, 0x2::balance::send_funds, 0x2::coin::mint_and_transfer, 0x2::token::transfer, or 0x2::party::single_owner building a party for transfer::public_party_transfer), and with `digest` the coins and objects its effects show the sender lost to another address; flash-loan patterns; multi-package composition) without executing. `checks_run` names every check, and one that matched nothing clears nothing: before signing, simulate_transaction shows where every coin and object would end up. A Pure input is decoded as the type the receiving Move function declares for it (`value_type`, `value`; an address-typed value is under `address`); a u64, u128 or u256 with its top bit set also carries `signed_value`, its two's-complement reading (signed quantities travel in unsigned integers); when no type can be read it stays as `bytes`, and 32 bytes also carry an address-shaped guess, under `possible_address` in `inputs` and under `address` with no `value_type` in `commands`; the guess is evidence, not proof (a u256, an `ID` and a 31-byte string are also 32 bytes). A Result or NestedResult argument names the command it came from (`from`); its declared type is that command's `returns`. With `digest`, each object input also carries the version the transaction read and the object's type. A FundsWithdrawal input shows the amount, coin type and whose address balance it draws on (Sender or Sponsor), and `gas_source` says whether gas is paid from coins or from the gas owner's address balance. get_transaction with detail: 'full' returns the same inputs and commands beside the transaction's effects and events.",
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
          "Continue from this command index: lists commands in index order from it while they fit about 30k characters. Without it, when the PTB does not fit, the first page keeps the commands an anomaly names first (each anomaly lists them in `commands`; most severe flag first, and among equals the one naming the fewest commands), then Move calls into non-framework packages; either way `commands_omitted` lists the exact index ranges left out and next_call the offset to continue from.",
        ),
      commands: z
        .array(numArg().int().min(0))
        .max(100)
        .optional()
        .describe("Exact command indices to list, e.g. [3, 7], instead of a page. Each listed command carries its `index`."),
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
        // BCS parsing stops where the struct ends and ignores what follows, so
        // 10,000 base64 'A's decoded as a transaction from 0x0 with no commands.
        const used = bcs.TransactionData.serialize(bcs.TransactionData.parse(bytes)).toBytes().length;
        if (used !== bytes.length) {
          return errorResult(
            `Not one transaction: the first ${used} bytes decode as transaction data and ${bytes.length - used} bytes follow it.`,
          );
        }
      }
      const data = ptbDataFromBcs(bytes);
      if (!data) {
        return errorResult("This is a system transaction, not a programmable one, so it has no PTB commands or inputs to decode. get_transaction describes it.");
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
