import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerNameTools(server: McpServer) {
  server.tool(
    "resolve_name",
    "Resolve a SuiNS name (.sui domain) to an address, or reverse-lookup an address to its SuiNS name. At least one of 'name' or 'address' must be provided.",
    {
      name: z
        .string()
        .optional()
        .describe("SuiNS name to resolve (e.g. 'example.sui')"),
      address: z
        .string()
        .optional()
        .describe("Address to reverse-lookup to a SuiNS name"),
    },
    async ({ name, address }) => {
      if (!name && !address) {
        return errorResult("At least one of 'name' or 'address' must be provided");
      }

      const result: Record<string, string | null> = {};
      const promises: Promise<void>[] = [];

      if (name) {
        promises.push(
          sui.nameService
            .lookupName({ name })
            .then(({ response }) => {
              result.address = response.record?.targetAddress ?? null;
            })
            .catch(() => {
              result.address = null;
            })
        );
      }

      if (address) {
        promises.push(
          sui.nameService
            .reverseLookupName({ address })
            .then(({ response }) => {
              result.name = response.record?.name ?? null;
            })
            .catch(() => {
              result.name = null;
            })
        );
      }

      await Promise.all(promises);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
