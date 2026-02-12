import { z } from "zod";
import { Transaction } from "@mysten/sui/transactions";
import { lookupProtocol, lookupOperation } from "../protocols/registry.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

function formatCommand(cmd: { $kind: string } & Record<string, unknown>): Record<string, unknown> {
  switch (cmd.$kind) {
    case "MoveCall": {
      const mc = cmd.MoveCall as {
        package: string;
        module: string;
        function: string;
        typeArguments?: string[];
        arguments?: Array<{ $kind: string } & Record<string, unknown>>;
      };
      const protocol = lookupProtocol(mc.package);
      const operation = lookupOperation(mc.module, mc.function);
      return {
        type: "MoveCall",
        target: `${mc.package}::${mc.module}::${mc.function}`,
        type_arguments: mc.typeArguments ?? [],
        arguments: mc.arguments?.map(formatInput) ?? [],
        ...(protocol ? { protocol: protocol.name, protocol_type: protocol.type } : {}),
        ...(operation ? { action: operation.action } : {}),
      };
    }
    case "TransferObjects": {
      const to = cmd.TransferObjects as {
        objects: Array<{ $kind: string } & Record<string, unknown>>;
        address: { $kind: string } & Record<string, unknown>;
      };
      return {
        type: "TransferObjects",
        objects: to.objects.map(formatInput),
        address: formatInput(to.address),
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
    return { type: "Pure", bytes: pure.bytes };
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
  return { type: input.$kind };
}

export function registerDecodeTools(server: McpServer) {
  server.tool(
    "decode_ptb",
    "(Developer) Decode a Programmable Transaction Block (PTB) from base64 BCS bytes. Returns the list of commands, inputs, and protocol annotations without executing. Use get_transaction with a digest instead if you want to inspect an already-executed transaction.",
    {
      transaction_bcs: z
        .string()
        .describe("Base64-encoded BCS transaction bytes"),
    },
    async ({ transaction_bcs }) => {
      const tx = Transaction.from(transaction_bcs);
      const data = tx.getData();

      const commands = data.commands.map(formatCommand);
      const inputs = data.inputs.map(formatPureInput);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                sender: data.sender,
                gas_budget: data.gasData.budget,
                gas_price: data.gasData.price,
                expiration: data.expiration,
                command_count: commands.length,
                input_count: inputs.length,
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
