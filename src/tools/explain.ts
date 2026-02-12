import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { formatVisibility, formatSignature } from "./packages.js";
import { GrpcTypes } from "@mysten/sui/grpc";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function abilityName(a: GrpcTypes.Ability): string {
  switch (a) {
    case GrpcTypes.Ability.COPY: return "copy";
    case GrpcTypes.Ability.DROP: return "drop";
    case GrpcTypes.Ability.STORE: return "store";
    case GrpcTypes.Ability.KEY: return "key";
    default: return "unknown";
  }
}

export function registerExplainTools(server: McpServer) {
  server.tool(
    "explain_package",
    "Get a human-readable summary of a Sui Move package. Categorizes functions by visibility (entry, public, friend, private), lists key structs, and highlights the user-facing API.",
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

        const structs = m.datatypes.map((dt: GrpcTypes.DatatypeDescriptor) => {
          const abilities = dt.abilities.map(abilityName);
          return {
            name: dt.name,
            abilities,
            has_key: dt.abilities.includes(GrpcTypes.Ability.KEY),
            has_store: dt.abilities.includes(GrpcTypes.Ability.STORE),
          };
        });
        totalStructs += structs.length;

        const keyTypes = structs
          .filter((s) => s.has_key)
          .map((s) => s.name);

        return {
          name: m.name,
          struct_count: structs.length,
          structs: structs.map((s) => ({
            name: s.name,
            abilities: s.abilities,
          })),
          entry_functions: entryFunctions,
          public_functions: publicFunctions,
          friend_functions: friendFunctions,
          private_function_count: privateFunctions.length,
          key_types: keyTypes,
        };
      }) ?? [];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                package_id: pkg?.storageId,
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
}
