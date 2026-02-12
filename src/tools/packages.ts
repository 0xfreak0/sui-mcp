import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { GrpcTypes } from "@mysten/sui/grpc";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function formatVisibility(v?: GrpcTypes.FunctionDescriptor_Visibility): string {
  switch (v) {
    case GrpcTypes.FunctionDescriptor_Visibility.PUBLIC:
      return "public";
    case GrpcTypes.FunctionDescriptor_Visibility.PRIVATE:
      return "private";
    case GrpcTypes.FunctionDescriptor_Visibility.FRIEND:
      return "public(friend)";
    default:
      return "unknown";
  }
}

export function formatSignatureBody(body: GrpcTypes.OpenSignatureBody): string {
  switch (body.type) {
    case GrpcTypes.OpenSignatureBody_Type.TYPE_PARAMETER:
      return `T${body.typeParameter ?? 0}`;
    case GrpcTypes.OpenSignatureBody_Type.BOOL:
      return "bool";
    case GrpcTypes.OpenSignatureBody_Type.U8:
      return "u8";
    case GrpcTypes.OpenSignatureBody_Type.U16:
      return "u16";
    case GrpcTypes.OpenSignatureBody_Type.U32:
      return "u32";
    case GrpcTypes.OpenSignatureBody_Type.U64:
      return "u64";
    case GrpcTypes.OpenSignatureBody_Type.U128:
      return "u128";
    case GrpcTypes.OpenSignatureBody_Type.U256:
      return "u256";
    case GrpcTypes.OpenSignatureBody_Type.ADDRESS:
      return "address";
    case GrpcTypes.OpenSignatureBody_Type.VECTOR: {
      const inner = body.typeParameterInstantiation[0];
      return `vector<${inner ? formatSignatureBody(inner) : "?"}>`;
    }
    case GrpcTypes.OpenSignatureBody_Type.DATATYPE: {
      let name = body.typeName ?? "?";
      if (body.typeParameterInstantiation.length > 0) {
        name += `<${body.typeParameterInstantiation.map(formatSignatureBody).join(", ")}>`;
      }
      return name;
    }
    default:
      return "unknown";
  }
}

export function formatSignature(sig: GrpcTypes.OpenSignature): string {
  if (!sig.body) return "unknown";
  return formatSignatureBody(sig.body);
}

function formatTypeParam(tp: GrpcTypes.TypeParameter) {
  return { constraints: tp.constraints, is_phantom: tp.isPhantom };
}

function abilityName(a: GrpcTypes.Ability): string {
  switch (a) {
    case GrpcTypes.Ability.COPY: return "copy";
    case GrpcTypes.Ability.DROP: return "drop";
    case GrpcTypes.Ability.STORE: return "store";
    case GrpcTypes.Ability.KEY: return "key";
    default: return "unknown";
  }
}

export function registerPackageTools(server: McpServer) {
  server.tool(
    "get_package",
    "(Developer) Get a Sui Move package by its ID. Returns modules with structs categorized by abilities, and functions categorized by visibility (entry, public, friend, private).",
    {
      package_id: z.string().describe("Package ID (0x...)"),
    },
    async ({ package_id }) => {
      const { response: res } = await sui.movePackageService.getPackage({
        packageId: package_id,
      });
      const pkg = res.package;

      let totalEntryFns = 0;
      let totalPublicFns = 0;
      let totalPrivateFns = 0;
      let totalFriendFns = 0;
      let totalStructs = 0;

      const modules = pkg?.modules.map((m: GrpcTypes.Module) => {
        const entryFunctions: string[] = [];
        const publicFunctions: string[] = [];
        const friendFunctions: string[] = [];
        const privateFunctions: string[] = [];

        for (const f of m.functions) {
          const vis = formatVisibility(f.visibility);
          const params = f.parameters.map(formatSignature).join(", ");
          const returns = f.returns.map(formatSignature);
          const retStr = returns.length > 0 ? ` -> ${returns.join(", ")}` : "";
          const sig = `${f.name}(${params})${retStr}`;

          if (f.isEntry) {
            entryFunctions.push(sig);
            totalEntryFns++;
          } else if (vis === "public") {
            publicFunctions.push(sig);
            totalPublicFns++;
          } else if (vis === "public(friend)") {
            friendFunctions.push(sig);
            totalFriendFns++;
          } else {
            privateFunctions.push(sig);
            totalPrivateFns++;
          }
        }

        const structs = m.datatypes.map((dt: GrpcTypes.DatatypeDescriptor) => ({
          name: dt.name,
          abilities: dt.abilities.map(abilityName),
          type_parameters: dt.typeParameters.map(formatTypeParam),
        }));
        totalStructs += structs.length;

        return {
          name: m.name,
          struct_count: structs.length,
          structs,
          entry_functions: entryFunctions,
          public_functions: publicFunctions,
          friend_functions: friendFunctions,
          private_function_count: privateFunctions.length,
        };
      }) ?? [];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                package_id: pkg?.storageId,
                original_id: pkg?.originalId,
                version: pkg?.version?.toString(),
                summary: {
                  module_count: modules.length,
                  total_entry_functions: totalEntryFns,
                  total_public_functions: totalPublicFns,
                  total_friend_functions: totalFriendFns,
                  total_private_functions: totalPrivateFns,
                  total_structs: totalStructs,
                },
                modules,
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
    "get_move_function",
    "(Developer) Get a specific Move function signature from a Sui package. Returns parameters, type parameters, return type, and visibility.",
    {
      package_id: z.string().describe("Package ID (0x...)"),
      module_name: z.string().describe("Module name"),
      function_name: z.string().describe("Function name"),
    },
    async ({ package_id, module_name, function_name }) => {
      const res = await sui.getMoveFunction({
        packageId: package_id,
        moduleName: module_name,
        name: function_name,
      });
      const f = res.function;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                name: f.name,
                visibility: f.visibility,
                is_entry: f.isEntry,
                type_parameters: f.typeParameters.map((tp) => ({
                  constraints: tp.constraints,
                  is_phantom: tp.isPhantom,
                })),
                parameters: f.parameters.map(formatSdkSignature),
                returns: f.returns.map(formatSdkSignature),
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

import type { SuiClientTypes } from "@mysten/sui/client";

function formatSdkSignatureBody(body: SuiClientTypes.OpenSignatureBody): string {
  if ("vector" in body && body.$kind === "vector") {
    return `vector<${formatSdkSignatureBody(body.vector)}>`;
  }
  if ("datatype" in body && body.$kind === "datatype") {
    let name = body.datatype.typeName;
    if (body.datatype.typeParameters.length > 0) {
      name += `<${body.datatype.typeParameters.map(formatSdkSignatureBody).join(", ")}>`;
    }
    return name;
  }
  if ("typeParameter" in body && body.$kind === "typeParameter") {
    return `T${body.typeParameter}`;
  }
  return body.$kind;
}

function formatSdkSignature(sig: SuiClientTypes.OpenSignature): string {
  const ref = sig.reference;
  const body = formatSdkSignatureBody(sig.body);
  if (ref === "mutable") return `&mut ${body}`;
  if (ref === "immutable") return `&${body}`;
  return body;
}
