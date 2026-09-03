import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerNameTools(server: McpServer) {
  server.tool(
    "resolve_name",
    "Resolve a SuiNS name (.sui domain) to an address, or reverse-lookup an address to its SuiNS name. At least one of 'name' or 'address' must be provided.\n\nIDENTITY WARNING: a SuiNS name is a self-chosen handle that anyone can buy. It is not identity and it is not verified. Names matching an exchange, a project or a person can be — and are — registered by unrelated parties, including by someone who wants an investigator to draw a particular conclusion. Treat a name as a label the holder picked, never as evidence of who they are, and do not carry it to other platforms as a matching key without independent corroboration.",
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
