import { z } from "zod";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { fromBase64 } from "@mysten/sui/utils";
import { errorResult } from "../utils/errors.js";
import { lookupProtocolDisplay, lookupOperation, prefetchProtocolNames } from "../protocols/registry.js";
import { guardiansFlagsForPackage } from "../utils/guardians.js";
import { flagPtbAnomalies, type FormattedCommand } from "../utils/ptb-anomalies.js";
import { gasSource } from "../utils/address-balance.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A Pure input holding exactly 32 bytes, decoded as a Sui address. Null for any other length. A u256, an object ID (`ID`), and a 31-byte `vector<u8>`/`String` (a 0x1f length-prefix byte plus 31 content bytes) are also Pure and also exactly 32 raw bytes, so a result shows only that the input can be an address. */
function addressFromPureBytes(bytesB64: string): string | null {
  let raw: Uint8Array;
  try {
    raw = fromBase64(bytesB64);
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  return "0x" + Buffer.from(raw).toString("hex");
}

/** The address a TransferObjects/MoveCall argument resolves to, when it is a Pure 32-byte input. */
function resolveAddressInput(
  input: { $kind: string } & Record<string, unknown>,
  rawInputs: Array<({ $kind: string } & Record<string, unknown>) | undefined>,
): string | null {
  if (input.$kind !== "Input") return null;
  const raw = rawInputs[input.Input as number];
  if (!raw || raw.$kind !== "Pure") return null;
  const pure = raw.Pure as { bytes: string };
  return addressFromPureBytes(pure.bytes);
}

function formatInput(input: { $kind: string } & Record<string, unknown>): Record<string, unknown> {
  switch (input.$kind) {
    case "GasCoin":
      return { type: "GasCoin" };
    case "Input": {
      const idx = input.Input as number;
      return { type: "Input", index: idx };
    }
    case "Result": {
      const idx = input.Result as number;
      return { type: "Result", index: idx };
    }
    case "NestedResult": {
      const val = input.NestedResult as [number, number];
      return { type: "NestedResult", result: val[0], subresult: val[1] };
    }
    default:
      return { type: input.$kind };
  }
}

/**
 * A MoveCall argument, resolved to a plain address the same way a
 * TransferObjects recipient is: a Move function's `address`-typed parameter
 * is a Pure 32-byte input exactly like a TransferObjects recipient, so
 * `0x2::transfer::public_transfer`'s recipient (and the framework's other
 * transfer-shaped functions) can be read the same way. No argument is
 * type-checked here, so this attaches `address` to every argument that
 * happens to be 32 Pure bytes, including ones the function does not take as
 * an address.
 */
function formatMoveCallArgument(
  input: { $kind: string } & Record<string, unknown>,
  rawInputs: Array<({ $kind: string } & Record<string, unknown>) | undefined>,
): Record<string, unknown> {
  const resolved = resolveAddressInput(input, rawInputs);
  return resolved ? { ...formatInput(input), address: resolved } : formatInput(input);
}

function formatCommand(
  cmd: { $kind: string } & Record<string, unknown>,
  rawInputs: Array<({ $kind: string } & Record<string, unknown>) | undefined>,
): Record<string, unknown> {
  switch (cmd.$kind) {
    case "MoveCall": {
      const mc = cmd.MoveCall as {
        package: string;
        module: string;
        function: string;
        typeArguments?: string[];
        arguments?: Array<{ $kind: string } & Record<string, unknown>>;
      };
      const protocol = lookupProtocolDisplay(mc.package);
      const operation = lookupOperation(mc.module, mc.function);
      return {
        type: "MoveCall",
        target: `${mc.package}::${mc.module}::${mc.function}`,
        type_arguments: mc.typeArguments ?? [],
        arguments: mc.arguments?.map((a) => formatMoveCallArgument(a, rawInputs)) ?? [],
        ...(protocol ? { protocol: protocol.name, protocol_type: protocol.type } : {}),
        ...(operation ? { action: operation.action } : {}),
      };
    }
    case "TransferObjects": {
      const to = cmd.TransferObjects as {
        objects: Array<{ $kind: string } & Record<string, unknown>>;
        address: { $kind: string } & Record<string, unknown>;
      };
      // The recipient is what makes this a payment or a drain. Resolved to a
      // plain address when it is a Pure 32-byte input (the overwhelming
      // majority in practice), so the anomaly pass below can compare it to
      // the sender without re-decoding.
      const resolved = resolveAddressInput(to.address, rawInputs);
      return {
        type: "TransferObjects",
        objects: to.objects.map(formatInput),
        address: resolved ? { ...formatInput(to.address), address: resolved } : formatInput(to.address),
      };
    }
    case "SplitCoins": {
      const sc = cmd.SplitCoins as {
        coin: { $kind: string } & Record<string, unknown>;
        amounts: Array<{ $kind: string } & Record<string, unknown>>;
      };
      return {
        type: "SplitCoins",
        coin: formatInput(sc.coin),
        amounts: sc.amounts.map(formatInput),
      };
    }
    case "MergeCoins": {
      const mc = cmd.MergeCoins as {
        destination: { $kind: string } & Record<string, unknown>;
        sources: Array<{ $kind: string } & Record<string, unknown>>;
      };
      return {
        type: "MergeCoins",
        destination: formatInput(mc.destination),
        sources: mc.sources.map(formatInput),
      };
    }
    case "Publish": {
      const pub = cmd.Publish as { modules: unknown[]; dependencies: string[] };
      return {
        type: "Publish",
        module_count: pub.modules.length,
        dependencies: pub.dependencies,
      };
    }
    case "Upgrade": {
      const up = cmd.Upgrade as {
        modules: unknown[];
        dependencies: string[];
        package: string;
        ticket: { $kind: string } & Record<string, unknown>;
      };
      return {
        type: "Upgrade",
        package: up.package,
        module_count: up.modules.length,
        dependencies: up.dependencies,
        ticket: formatInput(up.ticket),
      };
    }
    case "MakeMoveVec": {
      const mmv = cmd.MakeMoveVec as {
        type: string | null;
        elements: Array<{ $kind: string } & Record<string, unknown>>;
      };
      return {
        type: "MakeMoveVec",
        element_type: mmv.type,
        elements: mmv.elements.map(formatInput),
      };
    }
    default:
      return { type: cmd.$kind, ...cmd };
  }
}

function formatPureInput(input: { $kind: string } & Record<string, unknown>): Record<string, unknown> {
  if (input.$kind === "Pure") {
    const pure = input.Pure as { bytes: string };
    const address = addressFromPureBytes(pure.bytes);
    // Exactly 32 bytes is address-shaped, but not proof: a u256, an object
    // ID (`ID`, such as a kiosk item id in a purchase/take call) and a 31-byte
    // vector<u8>/String (its 0x1f length-prefix byte plus 31 content bytes)
    // are all Pure and also exactly 32 raw bytes. Shown alongside the raw
    // bytes rather than replacing them, so the caller can tell which it is
    // from the calling function's declared parameter type.
    return { type: "Pure", bytes: pure.bytes, ...(address ? { possible_address: address } : {}) };
  }
  if (input.$kind === "Object") {
    const obj = input.Object as { $kind: string } & Record<string, unknown>;
    if (obj.$kind === "ImmOrOwnedObject") {
      const io = obj.ImmOrOwnedObject as { objectId: string; version: string; digest: string };
      return { type: "ImmOrOwnedObject", object_id: io.objectId };
    }
    if (obj.$kind === "SharedObject") {
      const so = obj.SharedObject as { objectId: string; initialSharedVersion: string; mutable: boolean };
      return { type: "SharedObject", object_id: so.objectId, mutable: so.mutable };
    }
    if (obj.$kind === "Receiving") {
      const ro = obj.Receiving as { objectId: string; version: string; digest: string };
      return { type: "Receiving", object_id: ro.objectId };
    }
    return { type: obj.$kind };
  }
  if (input.$kind === "FundsWithdrawal") {
    // A withdrawal from an address balance: the funds a drainer PTB takes are
    // named here and nowhere else in the bytes, so the amount is the number
    // that matters for triage.
    const fw = input.FundsWithdrawal as {
      reservation: { $kind: string; MaxAmountU64?: string };
      typeArg: { $kind: string; Balance?: string };
      withdrawFrom: { $kind: string };
    };
    return {
      type: "FundsWithdrawal",
      amount: fw.reservation.MaxAmountU64 ?? null,
      coin_type: fw.typeArg.Balance ?? null,
      withdraw_from: fw.withdrawFrom.$kind,
    };
  }
  return { type: input.$kind };
}

export function registerDecodeTools(server: McpServer) {
  server.tool(
    "decode_ptb",
    "(Developer) Decode a Programmable Transaction Block (PTB) from base64 BCS bytes — the pre-sign check: read this BEFORE approving a wallet prompt, not after. Returns the list of commands, inputs, protocol annotations, and a heuristic anomaly-triage pass (publishes/upgrades, calls into unrecognized or wallet-blocklisted packages, sending owned objects or split coins to an address other than the sender — whether through TransferObjects or a framework payout call (0x2::transfer::public_transfer, 0x2::pay::split_and_transfer, 0x2::pay::join_vec_and_transfer, 0x2::sui::transfer, 0x2::coin::send_funds, 0x2::balance::send_funds, 0x2::coin::mint_and_transfer, 0x2::token::transfer, or 0x2::party::single_owner building a party for transfer::public_party_transfer) — flash-loan patterns, multi-package composition) — without executing. A Pure input of exactly 32 bytes also carries `possible_address` (the hex address, alongside the raw bytes — a u256, an object ID (`ID`) and a 31-byte vector<u8>/String are also Pure and also 32 bytes, so this is evidence, not proof — check the calling function's declared parameter type), and a TransferObjects command's `address`, or a MoveCall argument at the same index, carries the resolved recipient the same way. A FundsWithdrawal input shows the amount, coin type and whose address balance it draws on (Sender or Sponsor), and `gas_source` says whether gas is paid from coins or from the gas owner's address balance. Use get_transaction with a digest instead if you want to inspect an already-executed transaction.",
    {
      transaction_bcs: z
        .string()
        .describe("Base64-encoded BCS transaction bytes"),
    },
    async ({ transaction_bcs }) => {
      // BCS parsing stops where the struct ends and ignores what follows, so
      // 10,000 base64 'A's decoded as a transaction from 0x0 with no commands.
      const bytes = fromBase64(transaction_bcs.trim());
      const used = bcs.TransactionData.serialize(bcs.TransactionData.parse(bytes)).toBytes().length;
      if (used !== bytes.length) {
        return errorResult(
          `Not one transaction: the first ${used} bytes decode as transaction data and ${bytes.length - used} bytes follow it.`,
        );
      }
      const tx = Transaction.from(bytes);
      const data = tx.getData();

      // The SDK's Transaction shape differs from the gRPC one, so package IDs
      // are collected here rather than via collectPackageIds.
      const calledPackages = data.commands.flatMap((c) => (c.$kind === "MoveCall" ? [c.MoveCall.package] : []));
      await prefetchProtocolNames(calledPackages);
      const blocklistedPackages = new Set(
        [...new Set(calledPackages)].filter((p) => guardiansFlagsForPackage(p).length > 0),
      );

      const rawInputs = data.inputs as Array<{ $kind: string } & Record<string, unknown>>;
      const commands = data.commands.map((c) => formatCommand(c, rawInputs));
      const inputs = data.inputs.map(formatPureInput);
      const anomalies = flagPtbAnomalies(commands as FormattedCommand[], { sender: data.sender ?? undefined, blocklistedPackages });
      // Null when the bytes carry no gas data yet, which says nothing about
      // where gas will come from.
      const gas = data.gasData.payment ? gasSource(data.gasData.payment) : null;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
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
                commands,
                inputs,
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
